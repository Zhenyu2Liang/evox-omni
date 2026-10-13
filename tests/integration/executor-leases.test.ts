/**
 * integration/executor-leases.test.ts — reference ports for the PLAN EXECUTION CLAIM fencing in
 * `agent/task-control.ts` (the DB exactly-once guard behind `resumeTask`).
 *
 * Two invariants are locked, asserting on PERSISTED DB STATE via `getTestPrisma()`:
 *
 *  1. CONCURRENT TAKEOVER → EXACTLY ONE WINNER. When a plan's `executionToken` is STALE (its owner
 *     crashed before its `finally`), two concurrent resumes race the atomic
 *     `claimTaskExecution(..., { staleBefore })` compare-and-set. The winner re-stamps a FRESH
 *     `executionClaimedAt` in the same statement, so the loser's stale-horizon predicate re-evaluates
 *     against the new timestamp and matches 0 rows — it returns the persisted plan with NO second
 *     executor. The side-effecting node therefore runs exactly once.
 *
 *  2. A LIVE, HEARTBEATING OWNER IS NOT WRONGLY PREEMPTED. While a real executor is mid-run (blocked
 *     inside a node) its claim is FRESH (renewed at the node boundary), so a concurrent resume's stale
 *     horizon cannot match it: the owner keeps its token and the concurrent resume starts no second
 *     executor. Liveness is NOT achieved by clearing the token or extending the TTL.
 *
 * These drive the REAL route handler + REAL executor + REAL test SQLite (only the model is absent).
 * The stale horizon is computed from the REAL clock (`Date.now()`), so the synthetic stale token uses
 * `Date.now() - 660000` (60s past the 600_000ms TTL), never the demo clock.
 */
import { beforeEach, afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { pauseTask, resumeTask } from '@/agent/task-control';
import { runSubmitPlan } from '@/agent/tools/planning';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterAll(() => disconnectTestPrisma());

async function session() {
  return (await getOrCreateSession(userId)).sessionId;
}

/** Drive a REAL route handler with cookie identity; returns the HTTP status + the JSON body. */
async function post(handler: any, id: string, body: unknown, s: string, path?: string) {
  const res = await handler(
    new NextRequest('http://localhost' + (path ?? `/api/tasks/${id}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
  return { httpStatus: res.status, ...(await res.json()) };
}

/** Gateway-authorized node runner (the same port `resumeTask` is driven with). */
const runner =
  (s: string) =>
  (toolName: string, args: Record<string, unknown>, ctx?: { taskId?: string; nodeId?: string }) =>
    executeGatedTool({
      sessionId: s,
      userId,
      toolName: toolName as any,
      args,
      userRequest: '审查围栏',
      taskId: ctx?.taskId,
      nodeId: ctx?.nodeId,
    });

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

async function bounded(p: Promise<unknown>) {
  let timer: any;
  try {
    await Promise.race([
      p,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('review barrier timeout')), 7000))),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const readNode = {
  id: 'read',
  name: '读余额',
  kind: 'tool' as const,
  tool: 'get_balance',
  args: {},
  dependencies: [] as string[],
};
const budgetNode = {
  id: 'budget',
  name: '预算',
  kind: 'tool' as const,
  tool: 'reserve_budget',
  args: { name: '围栏预算', amount: '10' },
  dependencies: ['read'],
};

/**
 * Build a plan paused after its first node: the lead `read` node runs (its `runTool` pauses the plan
 * as a side effect and returns a fabricated balance), so the caller's `node` is left `pending` and the
 * plan is persisted `paused` — exactly the launchpad `resumeTask`/takeover operate on.
 */
async function pausedPlan(s: string, node: any) {
  const result = await runSubmitPlan(
    userId,
    { goal: '审查围栏', nodes: [readNode, node] },
    {
      sessionId: s,
      runTool: async () => {
        const row = await getTestPrisma().agentTask.findFirst({
          where: { sessionId: s },
          orderBy: { createdAt: 'desc' },
        });
        await pauseTask(s, row!.id);
        return { ok: true, data: { balance: '23580.00' } };
      },
    },
  );
  return result.data as any;
}

it('two concurrent takeovers of a stale plan claim yield exactly one winner (node runs once)', async () => {
  const s = await session();
  const plan = await pausedPlan(s, budgetNode);

  // Simulate a CRASHED owner: a STALE token whose `executionClaimedAt` is 60s past the 600_000ms TTL.
  // The REAL clock is the time basis here (see `staleExecutionClaimBefore`), never `demoNow()`.
  await getTestPrisma().agentTask.update({
    where: { id: plan.id },
    data: { executionToken: 'stale-dead-owner', executionClaimedAt: new Date(Date.now() - 660000) },
  });

  const replies = await Promise.all([
    post(taskPost, plan.id, { action: 'resume' }, s),
    post(taskPost, plan.id, { action: 'resume' }, s),
  ]);

  const p = getTestPrisma();
  const count = await p.budget.count({ where: { userId, name: '围栏预算' } });
  const stored = await p.agentTask.findUnique({ where: { id: plan.id } });
  const node = await p.agentTaskNode.findFirst({ where: { taskId: plan.id, nodeId: 'budget' } });
  console.log(
    'REVIEW_EXECUTION_FENCING concurrent_takeover',
    JSON.stringify({
      statuses: replies.map((r) => r.httpStatus),
      count,
      planStatus: stored?.status,
      budgetNodeStatus: node?.status,
      executionToken: stored?.executionToken ?? null,
    }),
  );

  // Exactly ONE winner: the side effect happened once, the plan settled, no interleaved partial state.
  expect(replies.every((r) => r.httpStatus === 200)).toBe(true);
  expect(count).toBe(1);
  expect(stored?.status).toBe('success');
  expect(node?.status).toBe('success');
});

it('a live, heartbeating owner keeps its fresh claim: a concurrent resume starts no second executor', async () => {
  const s = await session();
  const plan = await pausedPlan(s, budgetNode);

  const reached = deferred();
  const release = deferred();
  // A REAL executor pass: it holds the plan claim and is blocked INSIDE the budget node (its
  // `runTool` already ran the side effect) while the node-boundary lease keeps the claim FRESH.
  const first = resumeTask(s, plan.id, {
    runTool: async (tool, args, ctx) => {
      const outcome = await runner(s)(tool, args, ctx);
      if (ctx.nodeId === 'budget') {
        reached.release();
        await release.promise;
      }
      return outcome;
    },
  });

  await bounded(reached.promise);

  const p = getTestPrisma();
  const held = await p.agentTask.findUnique({ where: { id: plan.id } });
  const beforeToken = held?.executionToken ?? null;
  // The owner still HOLDS its claim while alive: liveness is NOT achieved by clearing the token.
  expect(beforeToken).not.toBeNull();

  const midCount = await p.budget.count({ where: { userId, name: '围栏预算' } });
  const concurrent = await post(taskPost, plan.id, { action: 'resume' }, s);
  const afterRows = await p.agentTask.findUnique({ where: { id: plan.id } });

  release.release();
  await first;

  const count = await p.budget.count({ where: { userId, name: '围栏预算' } });
  const stored = await p.agentTask.findUnique({ where: { id: plan.id } });
  const node = await p.agentTaskNode.findFirst({ where: { taskId: plan.id, nodeId: 'budget' } });
  console.log(
    'REVIEW_EXECUTION_FENCING live_owner_not_preempted',
    JSON.stringify({
      concurrentStatus: concurrent.httpStatus,
      concurrentPlanStatus: concurrent.data?.status,
      tokenHeld: beforeToken !== null,
      tokenUnchanged: afterRows?.executionToken === beforeToken,
      midCount,
      count,
      planStatus: stored?.status,
      budgetNodeStatus: node?.status,
    }),
  );

  expect(concurrent.httpStatus).toBe(200);
  // The live claim was NOT taken over: the fresh `executionClaimedAt` did not satisfy the stale
  // horizon, so the concurrent resume's CAS matched 0 rows and left the owner's token in place.
  expect(afterRows?.executionToken).toBe(beforeToken);
  expect(midCount).toBe(1);
  expect(count).toBe(1);
  expect(stored?.status).toBe('success');
  expect(node?.status).toBe('success');
});
