/**
 * review-takeover-barriers — EXECUTION-RIGHT TAKEOVER × CANCEL/PAUSE barrier suite.
 *
 * Real in-process route handlers (`POST /api/tasks/[id]`, `POST /api/actions/[id]/confirm`) + the REAL
 * planner executor + the REAL Security-Gateway-routed `runTool` + the REAL banking SDK + the REAL
 * isolated test SQLite. Only the model is absent; the ONLY blocking primitives are real barriers
 * (`deferred()`) and real SDK spies — never a fabricated return value.
 *
 * A plan run holds a PLAN-level execution claim (`AgentTask.executionToken`). A concurrent
 * `resume`/`retry` takes it over only when the owner looks stale (`EXECUTION_CLAIM_TTL_MS = 600000`,
 * REAL clock). This suite places a barrier at SIX distinct takeover/decision points and proves, at
 * each, that the exactly-once money invariant and the committed fact survive:
 *
 *   (a) TAKEOVER_AT_NODE_CLAIM   — barrier inside the awaited `running` node notification (past the
 *       node claim, before the tool). Old run launches ZERO tools, publishes ZERO stale progress,
 *       the winner commits exactly once.
 *   (b) TAKEOVER_BEFORE_WRITE    — barrier immediately before the tool WRITE (the zombie is past its
 *       claim, inside `runTool`, before its `executeGatedTool`); a real SDK spy counts the write.
 *       The fenced-out zombie write never reaches the DB twice — a single side effect at most, no
 *       duplicate, no stale progress.
 *   (c) CANCEL_FIRST             — barrier inside the real SDK write; a takeover then a `cancel`
 *       fences the blocked write before any side effect commits (ZERO rows).
 *   (d) BUSINESS_COMMITS_FIRST   — barrier AFTER the write commits; a `cancel` must RETAIN the
 *       committed side effect (no rollback, no re-run).
 *   (e) PAUSE_THEN_CONFIRM       — a parked gated node; `pause` then `confirm` executes the human
 *       decision but must NOT advance the plan (it stays `paused`); a later `resume` completes it.
 *   (f) CONCURRENT_TAKEOVER      — two concurrent control calls after the owner ages out yield
 *       EXACTLY ONE winner (the side-effecting node runs exactly once).
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import { pauseTask } from '@/agent/task-control';
import { banking } from '@/banking-sdk';
import * as executionFence from '@/agent/execution-fence';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());

/** A one-shot barrier: `release()` resolves `promise` (never rejects). */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** Await `p` with a real timeout guard, so a barrier that never engages fails LOUDLY (never hangs). */
async function bounded(p: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      p,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The gateway-routed per-node runner the planner uses (real `executeGatedTool`). */
const runner =
  (s: string) =>
  (toolName: string, args: Record<string, unknown>, ctx?: { taskId?: string; nodeId?: string }) =>
    executeGatedTool({
      sessionId: s,
      userId,
      toolName: toolName as never,
      args,
      userRequest: '核查接管屏障',
      taskId: ctx?.taskId,
      nodeId: ctx?.nodeId,
    });

/** Drive a real control action through the real route handler; returns the `TaskPlan` snapshot. */
async function task(id: string, action: string, s: string) {
  const res = await taskPost(
    new NextRequest(`http://localhost/api/tasks/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: JSON.stringify({ action }),
    }),
    { params: Promise.resolve({ id }) },
  );
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data;
}

/** Confirm a parked action through the real route handler. */
async function confirmRaw(id: string, s: string) {
  const res = await confirmPost(
    new NextRequest(`http://localhost/api/actions/${id}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: '{}',
    }),
    { params: Promise.resolve({ id }) },
  );
  return { status: res.status, body: await res.json() };
}

/** Age the plan's ownership past `EXECUTION_CLAIM_TTL_MS` (600_000ms, REAL clock) so a takeover wins. */
async function forceStale(planId: string) {
  await getTestPrisma().agentTask.update({
    where: { id: planId },
    data: { executionClaimedAt: new Date(Date.now() - 660000) },
  });
}

/** A claim timestamp 60s past the TTL — reclaimable by resume/retry (mirrors the reference specs). */
const expired = () => new Date(Date.now() - 660000);

/**
 * Build a plan whose lead `read` node pauses the plan (its `runTool` calls `pauseTask`), leaving the
 * caller's `node` `pending` and the plan persisted `paused` — the launchpad for a real takeover.
 */
async function pausedPlan(s: string, node: Record<string, unknown>): Promise<any> {
  const result = await runSubmitPlan(
    userId,
    {
      goal: '审查接管屏障',
      nodes: [
        { id: 'read', name: '读余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] },
        node as never,
      ],
    },
    {
      sessionId: s,
      runTool: async () => {
        const row = await getTestPrisma().agentTask.findFirst({ where: { sessionId: s }, orderBy: { createdAt: 'desc' } });
        await pauseTask(s, row!.id);
        return { ok: true, data: { balance: '23580.00' } };
      },
    },
  );
  return result.data;
}

// ---------------------------------------------------------------------------------------------
// (a) TAKEOVER_AT_NODE_CLAIM — barrier inside the awaited `running` notification (pre-tool).
// ---------------------------------------------------------------------------------------------
it('REVIEW_TAKEOVER_AT_NODE_CLAIM: a takeover while blocked in the running notification launches zero tools and publishes no stale progress', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  let planId = '';
  let oldToolCalls = 0;
  let callsAtBarrier = -1;
  let afterTakeover = false;
  const lateNodeUpdates: string[] = [];
  const latePlans: string[] = [];

  const oldRun = runSubmitPlan(
    userId,
    { goal: '屏障a：认领后通知阻塞', nodes: [{ id: 'budget', name: '屏障a预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障a预算', amount: '30' }, dependencies: [] }] },
    {
      sessionId: s,
      onNodeUpdate: async (node) => {
        if (afterTakeover) lateNodeUpdates.push(`${node.id}:${node.status}`);
        // BARRIER: the node is CLAIMED and marked `running`, but its tool has NOT been launched.
        if (node.id === 'budget' && node.status === 'running' && callsAtBarrier < 0) {
          planId = (await p.agentTask.findFirstOrThrow({ where: { sessionId: s } })).id;
          callsAtBarrier = oldToolCalls;
          reached.release();
          await release.promise;
        }
      },
      onPlanUpdate: (plan) => {
        if (afterTakeover) latePlans.push(plan.status);
      },
      runTool: async (tool, args, ctx) => {
        oldToolCalls++;
        return runner(s)(tool, args, ctx);
      },
    },
  );

  let takeover: any;
  let oldResult: any;
  try {
    await bounded(reached.promise);
    // (a-fired) The barrier really engaged with ZERO tool calls behind it.
    expect(callsAtBarrier).toBe(0);
    await forceStale(planId);
    takeover = await task(planId, 'resume', s);
    afterTakeover = true;
  } finally {
    release.release();
    oldResult = await oldRun;
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId }, include: { nodes: true } });
  const budgets = await p.budget.count({ where: { userId, name: '屏障a预算' } });
  console.log(
    'REVIEW_TAKEOVER_AT_NODE_CLAIM',
    JSON.stringify({ callsAtBarrier, oldToolCalls, lateNodeUpdates, latePlans, takeoverStatus: takeover.status, oldStatus: oldResult.data?.status, storedStatus: stored.status, nodeStatus: stored.nodes[0]?.status, budgets }),
  );

  expect(callsAtBarrier).toBe(0);
  expect(oldToolCalls).toBe(0); // the OLD run never launched a tool
  expect(lateNodeUpdates).toHaveLength(0); // no stale node progress after the takeover
  expect(latePlans).toHaveLength(0); // no stale plan snapshot after the takeover
  expect(takeover.status).toBe('success');
  expect(stored.status).toBe('success'); // DB equals the winner's committed state
  expect(stored.nodes[0]?.status).toBe('success');
  expect(budgets).toBe(1); // side effect exactly once
});

// ---------------------------------------------------------------------------------------------
// (b) TAKEOVER_BEFORE_WRITE — barrier immediately before the tool write (past claim, inside runTool).
// ---------------------------------------------------------------------------------------------
it('REVIEW_TAKEOVER_BEFORE_WRITE: a takeover fences the pre-write zombie so no duplicate side effect is ever committed', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  let planId = '';
  let blocked = false;
  let oldToolCalls = 0;
  let afterTakeover = false;
  const lateNodeUpdates: string[] = [];
  const latePlans: string[] = [];
  // Real SDK spy: counts every actual write attempt (never fabricates a value).
  const original = banking.budget.reserveBudget.bind(banking.budget);
  let sdkWrites = 0;
  const spy = vi.spyOn(banking.budget, 'reserveBudget').mockImplementation(async (input) => {
    sdkWrites++;
    return original(input);
  });

  const oldRun = runSubmitPlan(
    userId,
    { goal: '屏障b：写入前接管', nodes: [{ id: 'budget', name: '屏障b预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障b预算', amount: '40' }, dependencies: [] }] },
    {
      sessionId: s,
      onNodeUpdate: (node) => {
        if (afterTakeover) lateNodeUpdates.push(`${node.id}:${node.status}`);
      },
      onPlanUpdate: (plan) => {
        if (afterTakeover) latePlans.push(plan.status);
      },
      runTool: async (tool, args, ctx) => {
        oldToolCalls++;
        planId = ctx.taskId ?? planId;
        // BARRIER: past the node claim + ownership re-check, but BEFORE the SDK write is issued.
        if (!blocked) {
          blocked = true;
          reached.release();
          await release.promise;
        }
        return runner(s)(tool, args, ctx);
      },
    },
  );

  let takeover: any;
  let oldResult: any;
  let sdkAtBarrier = -1;
  let budgetsAtTakeover = 0;
  try {
    await bounded(reached.promise);
    sdkAtBarrier = sdkWrites;
    // (b-fired) The barrier engaged strictly BEFORE any SDK write.
    expect(sdkAtBarrier).toBe(0);
    expect(oldToolCalls).toBe(1);
    // The zombie HELD a live node claim at the barrier.
    const held = await p.agentTaskNode.findFirstOrThrow({ where: { taskId: planId, nodeId: 'budget' } });
    expect(held.executionToken).not.toBeNull();
    await forceStale(planId);
    takeover = await task(planId, 'resume', s);
    budgetsAtTakeover = await p.budget.count({ where: { userId, name: '屏障b预算' } });
    afterTakeover = true;
  } finally {
    release.release();
    oldResult = await oldRun;
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId }, include: { nodes: true } });
  const budgets = await p.budget.count({ where: { userId, name: '屏障b预算' } });
  const keys = (await p.budget.findMany({ where: { userId, name: '屏障b预算' }, select: { idempotencyKey: true } })).map((b) => b.idempotencyKey);
  console.log(
    'REVIEW_TAKEOVER_BEFORE_WRITE',
    JSON.stringify({ sdkAtBarrier, sdkWrites, oldToolCalls, budgetsAtTakeover, budgets, keys, lateNodeUpdates, latePlans, takeoverStatus: takeover.status, oldStatus: oldResult.data?.status, storedStatus: stored.status, nodeStatus: stored.nodes[0]?.status }),
  );

  // (b-fired) The barrier engaged strictly before any write; the winner then wrote exactly once.
  expect(sdkAtBarrier).toBe(0);
  expect(sdkWrites).toBeGreaterThanOrEqual(1);
  // The pre-write zombie's own (fenced) attempt never added a SECOND committed side effect: the
  // final count is EXACTLY the winner's one row.
  expect(budgets).toBe(1);
  expect(budgets).toBe(budgetsAtTakeover);
  // Any committed side effect carries the plan-node identity key (the winner's write).
  keys.forEach((k) => expect(k).toBe(`nxe:${planId}:budget`));
  // No stale progress published after the takeover.
  expect(lateNodeUpdates).toHaveLength(0);
  expect(latePlans).toHaveLength(0);
  spy.mockRestore();
});

// ---------------------------------------------------------------------------------------------
// (c) CANCEL_FIRST — barrier inside the real SDK write; takeover then cancel fences it (ZERO rows).
// ---------------------------------------------------------------------------------------------
it('REVIEW_CANCEL_FIRST: a taken-over then cancelled plan fences the blocked SDK write before any side effect', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  const original = banking.budget.reserveBudget.bind(banking.budget);
  let calls = 0;
  let planId = '';
  let oldResult: any;
  let takeover: any;
  let takeoverRun: Promise<any> | undefined;
  let cancelled: any;
  const spy = vi.spyOn(banking.budget, 'reserveBudget').mockImplementation(async (input) => {
    calls++;
    return original(input);
  });
  const capture = executionFence.buildAutomaticWriteFence;
  let capturedFences = 0;
  const captureSpy = vi.spyOn(executionFence, 'buildAutomaticWriteFence').mockImplementation(async (...args) => {
    const fence = await capture(...args);
    capturedFences++;
    reached.release();
    await release.promise;
    return fence;
  });

  const oldRun = runSubmitPlan(
    userId,
    { goal: '屏障c：取消优先', nodes: [{ id: 'budget', name: '屏障c预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障c预算', amount: '10' }, dependencies: [] }] },
    { sessionId: s, runTool: (tool, args, ctx) => { planId = ctx.taskId ?? planId; return runner(s)(tool, args, ctx); } },
  );
  try {
    await bounded(reached.promise);
    // Both executors stop after capturing their fences and before acquiring the bank writer.
    expect(capturedFences).toBe(1);
    expect(calls).toBe(0);
    expect(await p.budget.count({ where: { name: '屏障c预算' } })).toBe(0);
    const oldToken = (await p.agentTask.findUniqueOrThrow({ where: { id: planId } })).executionToken;
    await p.agentTask.update({ where: { id: planId }, data: { executionClaimedAt: expired() } });
    takeoverRun = task(planId, 'resume', s);
    // The takeover really rotates the durable token; do NOT await it before releasing the barrier.
    await bounded((async () => {
      for (;;) {
        const current = await p.agentTask.findUniqueOrThrow({ where: { id: planId } });
        if (current.executionToken !== null && current.executionToken !== oldToken) return;
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    })());
    cancelled = await task(planId, 'cancel', s);
    expect(cancelled.status).toBe('cancelled');
    expect(await p.budget.count({ where: { name: '屏障c预算' } })).toBe(0);
  } finally {
    release.release();
    oldResult = await oldRun;
    if (takeoverRun) takeover = await takeoverRun;
    spy.mockRestore();
    captureSpy.mockRestore();
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId } });
  const budgets = await p.budget.count({ where: { name: '屏障c预算' } });
  console.log(
    'REVIEW_CANCEL_FIRST',
    JSON.stringify({ sdkCalls: calls, cancelledStatus: cancelled.status, budgetsAfterRelease: budgets, winnerStatus: takeover, storedStatus: stored.status, oldStatus: oldResult.data?.status }),
  );

  // Cancel-first fenced the blocked write: ZERO side effects, before AND after release.
  expect(calls).toBe(0);
  expect(budgets).toBe(0);
  expect(stored.status).toBe('cancelled');
});

// ---------------------------------------------------------------------------------------------
// (d) BUSINESS_COMMITS_FIRST — barrier AFTER the write commits; a cancel must retain the fact.
// ---------------------------------------------------------------------------------------------
it('REVIEW_BUSINESS_COMMITS_FIRST: a cancel after the side effect committed retains the committed fact', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  const original = banking.budget.reserveBudget.bind(banking.budget);
  let commits = 0;
  let planId = '';
  let oldResult: any;
  let cancelled: any;
  let sdkWrites = 0;
  const spy = vi.spyOn(banking.budget, 'reserveBudget').mockImplementation(async (input) => {
    const result = await original(input);
    sdkWrites++;
    return result;
  });

  const oldRun = runSubmitPlan(
    userId,
    { goal: '屏障d：业务先提交', nodes: [{ id: 'budget', name: '屏障d预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障d预算', amount: '15' }, dependencies: [] }] },
    { sessionId: s, runTool: async (tool, args, ctx) => {
      planId = ctx.taskId ?? planId;
      const result = await runner(s)(tool, args, ctx);
      commits++;
      if (commits === 1) { reached.release(); await release.promise; }
      return result;
    } },
  );
  let budgetsAtBarrier = 0;
  try {
    await bounded(reached.promise);
    budgetsAtBarrier = await p.budget.count({ where: { userId, name: '屏障d预算' } });
    // (d-fired) The business fact COMMITTED before we cancel.
    expect(budgetsAtBarrier).toBe(1);
    cancelled = await task(planId, 'cancel', s);
    expect(cancelled.status).toBe('cancelled');
    // The committed fact is RETAINED by the cancellation (no rollback).
    expect(await p.budget.count({ where: { userId, name: '屏障d预算' } })).toBe(1);
  } finally {
    release.release();
    oldResult = await oldRun;
    spy.mockRestore();
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId } });
  const budgets = await p.budget.count({ where: { userId, name: '屏障d预算' } });
  console.log(
    'REVIEW_BUSINESS_COMMITS_FIRST',
    JSON.stringify({ budgetsAtBarrier, sdkWrites, cancelledStatus: cancelled.status, budgetsAfterRelease: budgets, storedStatus: stored.status, oldStatus: oldResult.data?.status }),
  );

  // The committed side effect is retained EXACTLY once (never rolled back, never re-run).
  expect(budgetsAtBarrier).toBe(1);
  expect(sdkWrites).toBe(1);
  expect(budgets).toBe(1);
  expect(stored.status).toBe('cancelled');
});

// ---------------------------------------------------------------------------------------------
// (e) PAUSE_THEN_CONFIRM — a paused plan must not advance when its parked node is confirmed.
// ---------------------------------------------------------------------------------------------
it('REVIEW_PAUSE_THEN_CONFIRM: confirming a parked node on a paused plan keeps the plan paused', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const submitted = await runSubmitPlan(
    userId,
    {
      goal: '屏障e：暂停后确认',
      nodes: [
        { id: 't', name: '转200', kind: 'tool', tool: 'transfer_money', args: { name: '张伟', amount: '200' }, dependencies: [] },
        { id: 'b', name: '预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障e预算', amount: '10' }, dependencies: ['t'] },
      ],
    },
    { sessionId: s, runTool: runner(s) },
  );
  const plan: any = submitted.data;
  expect(plan.status).toBe('waiting_confirmation');
  const actionId = plan.results[0].output.pendingActionId;

  const paused = await task(plan.id, 'pause', s);
  expect(paused.status).toBe('paused');

  const confirmed = await confirmRaw(actionId, s);
  const afterConfirm = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id } });
  const budgetsAfterConfirm = await p.budget.count({ where: { name: '屏障e预算' } });
  const balanceAfterConfirm = (await p.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor.toString();
  const debitsAfterConfirm = await p.transaction.count({ where: { userId, amountMinor: -20000n, counterpartyId: 'contact_zhangwei' } });

  const resumed = await task(plan.id, 'resume', s);
  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  const budgetsAfterResume = await p.budget.count({ where: { name: '屏障e预算' } });
  console.log(
    'REVIEW_PAUSE_THEN_CONFIRM',
    JSON.stringify({ confirmOk: confirmed.body.data?.ok, pausedStatus: paused.status, planAfterConfirm: afterConfirm.status, budgetsAfterConfirm, balanceAfterConfirm, debitsAfterConfirm, resumedStatus: resumed.status, storedStatus: stored.status, nodeStatuses: stored.nodes.map((n) => `${n.nodeId}:${n.status}`).sort(), budgetsAfterResume }),
  );

  // The human decision executed the transfer EXACTLY once…
  expect(confirmed.body.data?.ok).toBe(true);
  expect(debitsAfterConfirm).toBe(1);
  expect(balanceAfterConfirm).toBe('2338000');
  // …but the paused plan did NOT advance to the dependent budget node.
  expect(afterConfirm.status).toBe('paused');
  expect(budgetsAfterConfirm).toBe(0);
  // A subsequent resume completes the plan (the bookkeeping node runs exactly once).
  expect(resumed.status).toBe('success');
  expect(stored.status).toBe('success');
  expect(budgetsAfterResume).toBe(1);
});

// ---------------------------------------------------------------------------------------------
// (f) CONCURRENT_TAKEOVER — two concurrent control calls yield EXACTLY ONE winner.
// ---------------------------------------------------------------------------------------------
it('REVIEW_CONCURRENT_TAKEOVER: two concurrent resumes of one stale claim yield exactly one executor', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const plan = await pausedPlan(s, { id: 'budget', name: '屏障f预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障f预算', amount: '10' }, dependencies: ['read'] });

  // Simulate a CRASHED owner: a STALE token 60s past the 600_000ms TTL, so BOTH concurrent resumes
  // attempt the atomic `claimTaskExecution(..., { staleBefore })` takeover.
  await p.agentTask.update({ where: { id: plan.id }, data: { executionToken: 'stale-dead-owner', executionClaimedAt: expired() } });

  const replies = await Promise.all([task(plan.id, 'resume', s), task(plan.id, 'resume', s)]);
  const replyStatuses = replies.map((r: any) => r?.status);

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  const node = stored.nodes.find((n) => n.nodeId === 'budget');
  const budgets = await p.budget.count({ where: { userId, name: '屏障f预算' } });
  const keys = (await p.budget.findMany({ where: { userId, name: '屏障f预算' }, select: { idempotencyKey: true } })).map((b) => b.idempotencyKey);
  console.log(
    'REVIEW_CONCURRENT_TAKEOVER',
    JSON.stringify({ replyStatuses, planStatus: stored.status, nodeStatus: node?.status, budgets, keys }),
  );

  // Exactly ONE winner: the side effect happened once, the plan settled once.
  expect(replyStatuses.every((r) => r === 'success' || r === 'paused' || r === 'running')).toBe(true);
  expect(budgets).toBe(1);
  expect(keys).toEqual([`nxe:${plan.id}:budget`]);
  expect(stored.status).toBe('success');
  expect(node?.status).toBe('success');
});
