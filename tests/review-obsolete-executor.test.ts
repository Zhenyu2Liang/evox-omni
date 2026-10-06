/**
 * review-obsolete-executor.test.ts — frozen acceptance criteria for the OBSOLETE-EXECUTOR STOP.
 *
 * When a plan executor LOSES its plan execution claim (its `AgentTask.executionToken` is rotated by a
 * concurrent `resume`/`retry` takeover, because the owner aged past `EXECUTION_CLAIM_TTL_MS`), the
 * obsolete executor must STOP advancing. This file locks the four observable consequences, each driven
 * through the REAL route handlers (`POST /api/tasks/[id]`), the REAL gateway-routed `runTool` port, the
 * REAL executor, and the REAL test SQLite (only a race-barrier, never a mocked return value).
 *
 *  it(...) #1  NO RECLAIM OF A COMPLETED SUCCESSOR — after a takeover, the obsolete executor must NOT
 *              re-enter the plan and launch the successor node (its successor tool is never called),
 *              and the takeover-completed successor node stays `success`.
 *  it(...) #2  NO LATE PLAN-PROGRESS EVENT — the obsolete executor must emit ZERO `onPlanUpdate`
 *              snapshots AFTER the takeover succeeded (no stale `plan_update` reaches the UI).
 *  it(...) #3  NO LATE FAILURE FLIP — the obsolete executor's late FAILURE must NOT flip a
 *              takeover-completed dependency node to `failed`, nor `skipped` a downstream node.
 *  it(...) #4  ONE WINNER — two concurrent takeovers of the same stale claim yield EXACTLY ONE executor
 *              (the side-effecting node runs exactly once).
 *
 * NOTE: this is a TARGET-behavior spec. The obsolete-executor stop is being hardened in `./agent` in
 * parallel, so #1/#2 may be RED until that lands. Assertions are never weakened to pass.
 *
 * The stale-claim horizon is computed from the REAL clock (`EXECUTION_CLAIM_TTL_MS` = 600_000ms), so
 * the synthetic stale token uses `Date.now() - 660000` (60s past the TTL), never the demo clock.
 */
import { beforeEach, afterAll, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan, type PlanRunTool } from '@/agent/tools/planning';
import * as taskControl from '@/agent/task-control';
import { POST as taskPost } from '@/app/api/tasks/[id]/route';
import { getTestPrisma, resetDatabase, disconnectTestPrisma } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase());
afterAll(() => disconnectTestPrisma());

/** A resume-able promise pair — the controllable race barrier (release the blocked executor later). */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** A 7s timeout race so a broken barrier fails LOUDLY instead of hanging the suite. */
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

/** Gateway-authorized node runner (the same port `resumeTask`/`runSubmitPlan` are driven with). */
const runner =
  (s: string) =>
  (toolName: string, args: Record<string, unknown>, ctx?: { taskId?: string; nodeId?: string }) =>
    executeGatedTool({ sessionId: s, userId, toolName: toolName as any, args, userRequest: '过期执行者停走核查', taskId: ctx?.taskId, nodeId: ctx?.nodeId });

/** Drive the REAL `POST /api/tasks/[id]` control route with cookie identity; returns the plan snapshot. */
async function task(id: string, action: string, s: string) {
  const res = await taskPost(
    new NextRequest(`http://localhost/api/tasks/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: `banking_session=${s}` }, body: JSON.stringify({ action }) }),
    { params: Promise.resolve({ id }) },
  );
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.data;
}

/** A claim timestamp older than `EXECUTION_CLAIM_TTL_MS` (600s) — reclaimable by resume/retry. */
const expired = () => new Date(Date.now() - 660000);

/** `runTool` that, on its FIRST node, PAUSES the owning plan and returns a fabricated balance. */
const pauseOnRead = (s: string): PlanRunTool => async () => {
  const row = (await getTestPrisma().agentTask.findFirst({ where: { sessionId: s }, orderBy: { createdAt: 'desc' } }))!;
  await taskControl.pauseTask(s, row.id);
  return { ok: true, data: { balance: 23580 } };
};

it('an obsolete/replaced executor must not reclaim and overwrite a completed successor node', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  // Plan: read balance → first budget → second budget (the successor). The lead `read` node pauses the
  // plan, so `first`/`second` are still `pending` when the obsolete executor resumes it.
  const plan: any = (
    await runSubmitPlan(
      userId,
      {
        goal: '过期执行者不得重占后续节点',
        nodes: [
          { id: 'read', name: '读余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] },
          { id: 'first', name: '第一预算', kind: 'tool', tool: 'reserve_budget', args: { name: '过期执行者第一预算', amount: 10 }, dependencies: ['read'] },
          { id: 'second', name: '第二预算', kind: 'tool', tool: 'reserve_budget', args: { name: '过期执行者第二预算', amount: 20 }, dependencies: ['first'] },
        ],
      },
      { sessionId: s, runTool: pauseOnRead(s) },
    )
  ).data;

  const reached = deferred();
  const release = deferred();
  let obsoleteSuccessorCalls = 0;
  // The obsolete executor: it resumes the plan, runs `first`, then STALLS inside that node while a
  // concurrent resume TAKES OVER the plan claim. When released it must STOP — it must not advance
  // into the successor `second`.
  const obsoleteRun = taskControl.resumeTask(s, plan.id, {
    runTool: async (tool, args, ctx) => {
      const value = await runner(s)(tool, args, ctx);
      if (ctx.nodeId === 'first') {
        reached.release();
        await release.promise;
        return value;
      }
      // Any node reached AFTER the barrier is a successor the obsolete executor should never touch.
      obsoleteSuccessorCalls++;
      return { ok: false, error: 'review: obsolete executor successor failure' };
    },
  });

  let takeover: any;
  try {
    await bounded(reached.promise);
    // Age the plan + the stalled node claim past the TTL so the concurrent resume may take over.
    await p.agentTask.update({ where: { id: plan.id }, data: { executionClaimedAt: expired() } });
    await p.agentTaskNode.updateMany({ where: { taskId: plan.id, status: 'running' }, data: { executionClaimedAt: expired() } });
    takeover = await task(plan.id, 'resume', s);
  } finally {
    release.release();
    await obsoleteRun;
  }

  const stored = await p.agentTask.findUnique({ where: { id: plan.id }, include: { nodes: true } });
  const second = stored?.nodes.find((n) => n.nodeId === 'second');
  const budgets = await p.budget.count({ where: { userId, name: { in: ['过期执行者第一预算', '过期执行者第二预算'] } } });
  console.log('REVIEW_OBSOLETE_SUCCESSOR_RECLAIM', JSON.stringify({ takeoverStatus: takeover?.status, finalStatus: stored?.status, secondStatus: second?.status, obsoleteSuccessorCalls, budgets }));

  expect(takeover.status).toBe('success');
  // The obsolete executor never launched the successor tool call…
  expect(obsoleteSuccessorCalls).toBe(0);
  // …and the takeover's completed successor node stands.
  expect(second?.status).toBe('success');
  // No duplicate side effect from a re-run.
  expect(budgets).toBe(2);
});

it('an obsolete initial executor must publish no late plan-progress event after takeover success', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const reached = deferred();
  const release = deferred();
  let planId = '';
  let afterTakeover = false;
  const lateUpdates: any[] = [];
  // The obsolete initial executor (`submit_plan`): it runs its single budget node, then STALLS inside
  // it while a concurrent resume takes over. Its `onPlanUpdate` sink forwards the DAG timeline to the
  // UI — after the takeover wins, the obsolete executor must forward NOTHING.
  const obsoleteRun = runSubmitPlan(
    userId,
    { goal: '过期进度事件', nodes: [{ id: 'budget', name: '预算', kind: 'tool', tool: 'reserve_budget', args: { name: '过期事件预算', amount: 10 }, dependencies: [] }] },
    {
      sessionId: s,
      onPlanUpdate: async (plan) => {
        if (afterTakeover) lateUpdates.push(plan);
      },
      runTool: async (tool, args, ctx) => {
        planId = ctx.taskId;
        await runner(s)(tool, args, ctx);
        reached.release();
        await release.promise;
        return { ok: false, error: 'review: obsolete executor late failure' };
      },
    },
  );

  let takeover: any;
  try {
    await bounded(reached.promise);
    await p.agentTask.update({ where: { id: planId }, data: { executionClaimedAt: expired() } });
    takeover = await task(planId, 'resume', s);
    afterTakeover = true;
  } finally {
    release.release();
    await obsoleteRun;
  }

  const stored = await p.agentTask.findUnique({ where: { id: planId }, include: { nodes: true } });
  console.log('REVIEW_OBSOLETE_PROGRESS_EVENT', JSON.stringify({ takeoverStatus: takeover?.status, persistedStatus: stored?.nodes[0]?.status, lateStatuses: lateUpdates.map((x) => x.results.find((r: any) => r.id === 'budget')?.status) }));

  expect(takeover.status).toBe('success');
  expect(stored?.nodes[0]?.status).toBe('success');
  // ZERO late snapshots: the obsolete executor emitted no `plan_update` after losing the claim.
  expect(lateUpdates).toHaveLength(0);
});

it("an obsolete executor's late failure must not flip a takeover-completed dependency node to failed or skipped", async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  // Plan: read balance → budget (the dependency node the takeover completes) → tail (note, downstream).
  const plan: any = (
    await runSubmitPlan(
      userId,
      {
        goal: '过期执行者晚失败不得改写下游',
        nodes: [
          { id: 'read', name: '读余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] },
          { id: 'budget', name: '预算', kind: 'tool', tool: 'reserve_budget', args: { name: '过期失败依赖预算', amount: 10 }, dependencies: ['read'] },
          { id: 'tail', name: '收尾', kind: 'note', dependencies: ['budget'] },
        ],
      },
      { sessionId: s, runTool: pauseOnRead(s) },
    )
  ).data;

  const reached = deferred();
  const release = deferred();
  // The obsolete executor resumes at `budget`, runs its tool, then STALLS; a concurrent resume takes
  // over and settles `budget` + `tail`. When released, the obsolete executor returns a FAILURE for
  // `budget` — which must not mark the completed dependency `failed` nor the downstream `tail` skipped.
  const obsoleteRun = taskControl.resumeTask(s, plan.id, {
    runTool: async (tool, args, ctx) => {
      await runner(s)(tool, args, ctx);
      reached.release();
      await release.promise;
      return { ok: false, error: 'review: obsolete failure blocks dependency' };
    },
  });

  let takeover: any;
  try {
    await bounded(reached.promise);
    await p.agentTask.update({ where: { id: plan.id }, data: { executionClaimedAt: expired() } });
    await p.agentTaskNode.updateMany({ where: { taskId: plan.id, status: 'running' }, data: { executionClaimedAt: expired() } });
    takeover = await task(plan.id, 'resume', s);
  } finally {
    release.release();
    await obsoleteRun;
  }

  const stored = await p.agentTask.findUnique({ where: { id: plan.id }, include: { nodes: true } });
  const budget = stored?.nodes.find((x) => x.nodeId === 'budget');
  const tail = stored?.nodes.find((x) => x.nodeId === 'tail');
  console.log('REVIEW_OBSOLETE_FAILURE_FLIP', JSON.stringify({ takeoverStatus: takeover?.status, finalStatus: stored?.status, budgetStatus: budget?.status, budgetError: budget?.error, tailStatus: tail?.status }));

  expect(takeover.status).toBe('success');
  expect(stored?.status).toBe('success');
  // The completed dependency node is NOT flipped to `failed`…
  expect(budget?.status).toBe('success');
  expect(budget?.error ?? '').not.toContain('obsolete failure');
  // …and the downstream node is NOT flipped to `skipped`.
  expect(tail?.status).toBe('success');
});

it('two concurrent takeovers of one stale claim yield exactly one executor (node runs once)', async () => {
  const s = (await getOrCreateSession(userId)).sessionId;
  const p = getTestPrisma();
  const plan: any = (
    await runSubmitPlan(
      userId,
      {
        goal: '并发接管唯一赢家',
        nodes: [
          { id: 'read', name: '读余额', kind: 'tool', tool: 'get_balance', args: {}, dependencies: [] },
          { id: 'budget', name: '预算', kind: 'tool', tool: 'reserve_budget', args: { name: '并发接管唯一预算', amount: 10 }, dependencies: ['read'] },
        ],
      },
      { sessionId: s, runTool: pauseOnRead(s) },
    )
  ).data;

  // Simulate a CRASHED owner: a STALE token whose `executionClaimedAt` is 60s past the 600_000ms TTL,
  // so BOTH concurrent resumes attempt the atomic `claimTaskExecution(..., { staleBefore })` takeover.
  await p.agentTask.update({ where: { id: plan.id }, data: { executionToken: 'stale-dead-owner', executionClaimedAt: expired() } });

  await Promise.all([task(plan.id, 'resume', s), task(plan.id, 'resume', s)]);

  const stored = await p.agentTask.findUnique({ where: { id: plan.id } });
  const node = await p.agentTaskNode.findFirst({ where: { taskId: plan.id, nodeId: 'budget' } });
  const count = await p.budget.count({ where: { userId, name: '并发接管唯一预算' } });
  console.log('REVIEW_OBSOLETE_CONCURRENT_WINNER', JSON.stringify({ planStatus: stored?.status, budgetNodeStatus: node?.status, budgets: count }));

  // Exactly ONE winner re-stamped the fresh claim; the loser's stale-horizon CAS matched 0 rows, so
  // the side-effecting node ran exactly once and the plan settled.
  expect(count).toBe(1);
  expect(stored?.status).toBe('success');
  expect(node?.status).toBe('success');
});
