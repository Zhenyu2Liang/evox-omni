/**
 * review-execution-barriers — EXECUTION-RIGHT (fencing) BARRIER regression suite.
 *
 * Real in-process route handlers + the REAL planner executor + the REAL isolated test SQLite.
 * A plan run holds a PLAN-level execution claim. A concurrent `POST /api/tasks/:id` `{action:'resume'}`
 * takes that claim over when the owner looks stale (`EXECUTION_CLAIM_TTL_MS = 600000`, REAL clock).
 *
 * This suite sets the barrier at THREE distinct points in the executor's node lifecycle and takes the
 * claim over at each, proving the superseded ("zombie") run:
 *   1. does NOT launch the successor tool,              (`REVIEW_BARRIER_PRE_TOOL`)
 *   2. does NOT launch any tool while parked in an async notification, (`REVIEW_BARRIER_NOTIFICATION`)
 *   3. does NOT apply a tool write after the claim is gone, (`REVIEW_BARRIER_PRE_WRITE`)
 * and, in every case, publishes NO stale `onNodeUpdate`/`onPlanUpdate` progress and leaves the DB
 * equal to the WINNER's committed state (side effect counted exactly once).
 *   4. a takeover attempt AFTER a committed gated side effect preserves the success fact and leaves
 *      exactly ONE execution audit / ONE side effect, and never resurrects a settled plan.
 *      (`REVIEW_COMMITTED_SIDE_EFFECT`)
 */
import { beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
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
      userRequest: '核查执行屏障',
      taskId: ctx?.taskId,
      nodeId: ctx?.nodeId,
    });

/** Drive a real control action through the real route handler. */
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

/** Confirm a pending action through the real route handler. */
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

/** Age the plan's ownership past `EXECUTION_CLAIM_TTL_MS` so a concurrent `resume` can take it over. */
async function forceStale(planId: string) {
  await getTestPrisma().agentTask.update({
    where: { id: planId },
    data: { executionClaimedAt: new Date(Date.now() - 660000) },
  });
}

// ---------------------------------------------------------------------------------------------
// BARRIER 1 — after the node CLAIM, BEFORE the tool starts (barrier in the `running` notification).
// ---------------------------------------------------------------------------------------------
it('a takeover at the pre-tool barrier stops the zombie before its successor tool and publishes no stale progress', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  let planId = '';
  let oldSuccessorCalls = 0;
  let oldFirstCalls = 0;
  let afterTakeover = false;
  let barrierToolCalls = -1;
  const lateNodeUpdates: string[] = [];
  const latePlans: string[] = [];

  const oldRun = runSubmitPlan(
    userId,
    {
      goal: '屏障一：工具前接管',
      nodes: [
        { id: 'first', name: '屏障一第一预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障一第一预算', amount: 10 }, dependencies: [] },
        { id: 'second', name: '屏障一第二预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障一第二预算', amount: 20 }, dependencies: ['first'] },
      ],
    },
    {
      sessionId: s,
      onNodeUpdate: async (node) => {
        if (afterTakeover) lateNodeUpdates.push(`${node.id}:${node.status}`);
        // BARRIER: the node is CLAIMED and marked `running`, but its tool has NOT been launched yet.
        if (node.id === 'first' && node.status === 'running' && barrierToolCalls < 0) {
          planId = (await p.agentTask.findFirstOrThrow({ where: { sessionId: s } })).id;
          barrierToolCalls = oldFirstCalls;
          reached.release();
          await release.promise;
        }
      },
      onPlanUpdate: (plan) => {
        if (afterTakeover) latePlans.push(plan.status);
      },
      runTool: async (tool, args, ctx) => {
        if (ctx.nodeId === 'first') oldFirstCalls++;
        else oldSuccessorCalls++;
        return runner(s)(tool, args, ctx);
      },
    },
  );

  let takeover: any;
  let oldResult: any;
  let budgetsAtTakeover = 0;
  try {
    await bounded(reached.promise);
    // The barrier engaged BEFORE any tool ran.
    expect(barrierToolCalls).toBe(0);
    await forceStale(planId);
    takeover = await task(planId, 'resume', s);
    budgetsAtTakeover = await p.budget.count({
      where: { userId, name: { in: ['屏障一第一预算', '屏障一第二预算'] } },
    });
    afterTakeover = true; // everything published from here on is STALE
  } finally {
    release.release();
    oldResult = await oldRun;
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId }, include: { nodes: true } });
  const storedNodeStatuses = stored.nodes.map((n) => `${n.nodeId}:${n.status}`).sort();
  const budgets = await p.budget.count({
    where: { userId, name: { in: ['屏障一第一预算', '屏障一第二预算'] } },
  });
  const oldResults: any[] = oldResult.data?.results ?? [];
  console.log(
    'REVIEW_BARRIER_PRE_TOOL',
    JSON.stringify({
      barrierToolCalls,
      oldFirstCalls,
      oldSuccessorCalls,
      lateNodeUpdates,
      latePlans,
      takeoverStatus: takeover?.status,
      oldStatus: oldResult.data?.status,
      storedStatus: stored.status,
      storedNodeStatuses,
      budgets,
      budgetsAtTakeover,
      winnerNodeStatuses: ((takeover?.results ?? []) as any[]).map((r) => `${r.id}:${r.status}`).sort(),
    }),
  );

  // (1) The barrier engaged before any tool call; the ZOMBIE never launched its successor tool.
  expect(barrierToolCalls).toBe(0);
  expect(oldSuccessorCalls).toBe(0);
  // (2) ZERO stale progress after the takeover (no node event, no plan snapshot).
  expect(lateNodeUpdates).toHaveLength(0);
  expect(latePlans).toHaveLength(0);
  // (3) The winner settled the plan; the zombie's own return adopted the persisted status.
  expect(takeover.status).toBe('success');
  expect(oldResult.data?.status).toBe('success');
  expect(stored.status).toBe('success');
  expect(storedNodeStatuses).toEqual(['first:success', 'second:success']);
  // (4) Side effects counted EXACTLY once each (no zombie duplicate).
  expect(budgets).toBe(2);
  expect(budgets).toBe(budgetsAtTakeover);
  // The zombie never claims a node success the DB does not have.
  oldResults
    .filter((r) => r.status === 'success')
    .forEach((r) => expect(storedNodeStatuses).toContain(`${r.id}:success`));
  // ...and in particular it never reports success for the successor it was FENCED OUT of.
  expect(oldResults.find((r) => r.id === 'second')?.status).not.toBe('success');
});

// ---------------------------------------------------------------------------------------------
// BARRIER 2 — during an async NOTIFICATION wait.
// ---------------------------------------------------------------------------------------------
it('a takeover during a blocked async notification leaves the zombie with ZERO tool calls and zero stale progress', async () => {
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
    {
      goal: '屏障二：通知阻塞接管',
      nodes: [
        { id: 'budget', name: '屏障二预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障二预算', amount: 30 }, dependencies: [] },
      ],
    },
    {
      sessionId: s,
      onNodeUpdate: async (node) => {
        if (afterTakeover) lateNodeUpdates.push(`${node.id}:${node.status}`);
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
  let budgetsAtTakeover = 0;
  try {
    await bounded(reached.promise);
    // The barrier really ENGAGED: the notification resolved with ZERO tool calls behind it.
    expect(callsAtBarrier).toBe(0);
    await forceStale(planId);
    takeover = await task(planId, 'resume', s);
    budgetsAtTakeover = await p.budget.count({ where: { userId, name: '屏障二预算' } });
    afterTakeover = true;
  } finally {
    release.release();
    oldResult = await oldRun;
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId }, include: { nodes: true } });
  const budgets = await p.budget.count({ where: { userId, name: '屏障二预算' } });
  console.log(
    'REVIEW_BARRIER_NOTIFICATION',
    JSON.stringify({
      callsAtBarrier,
      oldToolCalls,
      lateNodeUpdates,
      latePlans,
      takeoverStatus: takeover?.status,
      oldStatus: oldResult.data?.status,
      storedStatus: stored.status,
      storedNodeStatuses: stored.nodes.map((n) => `${n.nodeId}:${n.status}`).sort(),
      budgets,
      budgetsAtTakeover,
    }),
  );

  expect(callsAtBarrier).toBe(0);
  expect(oldToolCalls).toBe(0);
  expect(lateNodeUpdates).toHaveLength(0);
  expect(latePlans).toHaveLength(0);
  expect(takeover.status).toBe('success');
  expect(stored.status).toBe('success');
  expect(stored.nodes.map((n) => n.status)).toEqual(['success']);
  expect(budgets).toBe(1);
  expect(budgets).toBe(budgetsAtTakeover);
});

// ---------------------------------------------------------------------------------------------
// BARRIER 3 — immediately BEFORE the tool WRITE (the zombie is past its claim, inside `runTool`).
// ---------------------------------------------------------------------------------------------
it('a takeover between the node claim and the tool write fences the zombie write and keeps exactly one side effect', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  let planId = '';
  let blocked = false;
  let oldToolCalls = 0;
  let oldWriteCalls = 0;
  let writesAtBarrier = -1;
  let afterTakeover = false;
  const lateNodeUpdates: string[] = [];
  const latePlans: string[] = [];

  const oldRun = runSubmitPlan(
    userId,
    {
      goal: '屏障三：写入前接管',
      nodes: [
        { id: 'budget', name: '屏障三预算', kind: 'tool', tool: 'reserve_budget', args: { name: '屏障三预算', amount: 40 }, dependencies: [] },
      ],
    },
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
        // BARRIER: claimed + `running` + pre-tool ownership check PASSED, but the WRITE not yet issued.
        if (!blocked) {
          blocked = true;
          writesAtBarrier = oldWriteCalls;
          reached.release();
          await release.promise;
        }
        oldWriteCalls++; // the tool write path is reached here
        return executeGatedTool({
          sessionId: s,
          userId,
          toolName: tool as never,
          args,
          userRequest: '核查执行屏障',
          taskId: ctx.taskId,
          nodeId: ctx.nodeId,
        });
      },
    },
  );

  let takeover: any;
  let oldResult: any;
  let budgetsAtTakeover = 0;
  let nodeStatusAtTakeover: string | undefined;
  try {
    await bounded(reached.promise);
    // The barrier engaged with the zombie still BETWEEN its claim and the write.
    expect(oldToolCalls).toBe(1);
    expect(writesAtBarrier).toBe(0);
    const claimed = await p.agentTaskNode.findFirstOrThrow({ where: { taskId: planId, nodeId: 'budget' } });
    expect(claimed.executionToken).not.toBeNull(); // the zombie HELD a live node claim here
    await forceStale(planId);
    takeover = await task(planId, 'resume', s);
    nodeStatusAtTakeover = (await p.agentTaskNode.findFirstOrThrow({ where: { taskId: planId, nodeId: 'budget' } })).status;
    budgetsAtTakeover = await p.budget.count({ where: { userId, name: '屏障三预算' } });
    afterTakeover = true;
  } finally {
    release.release();
    oldResult = await oldRun;
  }

  const stored = await p.agentTask.findUniqueOrThrow({ where: { id: planId }, include: { nodes: true } });
  const node = stored.nodes[0];
  const budgets = await p.budget.count({ where: { userId, name: '屏障三预算' } });
  const budgetKeys = (await p.budget.findMany({ where: { userId, name: '屏障三预算' }, select: { idempotencyKey: true } })).map((b) => b.idempotencyKey);
  console.log(
    'REVIEW_BARRIER_PRE_WRITE',
    JSON.stringify({
      oldToolCalls,
      writesAtBarrier,
      oldWriteCalls,
      lateNodeUpdates,
      latePlans,
      nodeStatusAtTakeover,
      takeoverStatus: takeover?.status,
      oldStatus: oldResult.data?.status,
      storedStatus: stored.status,
      storedNodeStatus: node?.status,
      budgets,
      budgetsAtTakeover,
      budgetKeys,
    }),
  );

  // (1) Barrier engaged pre-write; the zombie did reach the tool write path ONLY because the
  //     ownership re-check (`ownerLost`) happens BEFORE `runTool` — so it must be FENCED downstream.
  expect(oldToolCalls).toBe(1);
  expect(writesAtBarrier).toBe(0);
  expect(oldWriteCalls).toBe(1);
  // (2) The zombie's write did NOT apply: exactly ONE side effect, and it carries the node identity
  //     key (the winner's write), so the DB reflects ONLY the winner.
  expect(budgets).toBe(1);
  expect(budgets).toBe(budgetsAtTakeover);
  expect(budgetKeys).toEqual([`nxe:${planId}:budget`]);
  // (3) The persisted node/plan are the WINNER's — the zombie's fenced node write was skipped.
  expect(node?.status).toBe('success');
  expect(stored.status).toBe('success');
  expect(takeover.status).toBe('success');
  // (4) No stale progress published after the takeover.
  expect(lateNodeUpdates).toHaveLength(0);
  expect(latePlans).toHaveLength(0);
});

// ---------------------------------------------------------------------------------------------
// BARRIER 4 — takeover ATTEMPT after a committed gated side effect (success + audit must survive).
// ---------------------------------------------------------------------------------------------
it('a takeover after a committed gated side effect preserves the success fact and never duplicates the side effect or its audit', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const card = await p.card.findFirstOrThrow({ where: { userId, type: 'CREDIT' } });

  const seeded = await runSubmitPlan(
    userId,
    {
      goal: '屏障四：已提交副作用保留',
      nodes: [
        { id: 'limit', name: '屏障四限额', kind: 'tool', tool: 'set_card_limit', args: { cardId: card.id, category: '娱乐', amount: 1500 }, dependencies: [] },
      ],
    },
    { sessionId: s, runTool: runner(s) },
  );
  const plan: any = seeded.data;
  const parked = await p.agentTaskNode.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'limit' } });
  const action = await p.pendingAction.findFirstOrThrow({ where: { sessionId: s, taskId: plan.id } });
  expect(parked.status).toBe('waiting_confirmation');
  expect(action.status).toBe('pending');

  // COMMIT the gated side effect through the real human-decision path.
  const confirmed = await confirmRaw(action.id, s);
  const afterConfirmAction = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const afterConfirmPlan = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });

  // TAKEOVER ATTEMPT after the commit: age any claim and drive a real `resume`.
  await forceStale(plan.id);
  const resumed = await task(plan.id, 'resume', s);
  // A DUPLICATE human decision must also not re-apply anything.
  const duplicate = await confirmRaw(action.id, s);

  const planRow = await p.agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
  const actionRow = await p.pendingAction.findUniqueOrThrow({ where: { id: action.id } });
  const limits = await p.cardLimit.findMany({ where: { cardId: card.id, category: '娱乐' } });
  const audits = await p.auditLog.findMany({ where: { sessionId: s, toolName: 'set_card_limit' } });
  const tasks = await p.agentTask.count({ where: { sessionId: s } });
  const actionsOfTask = await p.pendingAction.count({ where: { taskId: plan.id } });
  const node = planRow.nodes.find((n) => n.nodeId === 'limit');
  console.log(
    'REVIEW_COMMITTED_SIDE_EFFECT',
    JSON.stringify({
      confirmedOk: confirmed.body.data?.ok,
      confirmActionStatus: afterConfirmAction.status,
      confirmPlanStatus: afterConfirmPlan.status,
      confirmNodeStatus: afterConfirmPlan.nodes[0]?.status,
      resumedStatus: resumed.status,
      duplicateOk: duplicate.body.data?.ok,
      finalPlanStatus: planRow.status,
      finalNodeStatus: node?.status,
      actionStatus: actionRow.status,
      cardLimits: limits.map((l) => l.amount),
      auditCount: audits.length,
      auditStatuses: audits.map((a) => a.status),
      auditHasResult: audits.map((a) => a.toolResult !== null),
      tasksForSession: tasks,
      actionsOfTask,
    }),
  );

  // (1) The commit happened exactly once, through the human-decision path.
  expect(confirmed.body.data?.ok).toBe(true);
  expect(afterConfirmPlan.status).toBe('success');
  expect(afterConfirmPlan.nodes[0]?.status).toBe('success');
  expect(afterConfirmAction.status).toBe('executed');
  // (2) The takeover attempt (and a duplicate confirm) NEVER flip the settled success fact.
  expect(planRow.status).toBe('success');
  expect(node?.status).toBe('success');
  expect(actionRow.status).toBe('executed');
  // (3) The side effect occurred EXACTLY once.
  expect(limits).toHaveLength(1);
  expect(limits[0]?.amount).toBe(1500);
  // (4) EXACTLY ONE execution audit for the committed action, with its real result.
  expect(audits).toHaveLength(1);
  expect(audits[0]?.status).toBe('success');
  expect(audits[0]?.toolResult).not.toBeNull();
  expect(JSON.parse(audits[0]!.toolResult!).ok).toBe(true);
  // (5) No plan/action was minted by the late attempts.
  expect(tasks).toBe(1);
  expect(actionsOfTask).toBe(1);
});
