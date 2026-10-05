/**
 * Unit: planner/executor — node-execution DE-DUP SCOPE (DB-backed).
 *
 * Proves that the NODE executor's exactly-once claim is scoped by the STABLE `(taskId, nodeId)`
 * identity via the DB compare-and-set (`claimNodeExecution` / `releaseNodeExecution` in
 * `@/lib/db/repositories/task`) — it does NOT rely on any in-process single-flight Map.
 *
 * Two layers:
 *   Part A — the CAS primitive driven DIRECTLY: one winner, later claims lost until the OWNER
 *            releases; a non-owner release is a no-op; two different taskIds sharing a nodeId are
 *            independently claimable.
 *   Part B — two SEPARATE executor invocations of the SAME `(taskId, nodeId)` with SEPARATE dep
 *            objects: while a first (still-live) run holds the DB claim, a second `runPlan` backs
 *            off with ZERO node side effects and writes no plan settlement; after the holder
 *            releases, a fresh run executes the node EXACTLY once.
 *
 * DB-backed: needs real `AgentTask`/`AgentTaskNode` rows for the CAS. Every "now"/tool/port is
 * injected; the post state is read back through Prisma. No network, no real clock.
 */
import { describe, it, expect, vi } from 'vitest';

import { runPlan } from '@/planner/executor';
import type { NodeExecutionContext, PlanDeps, PlanToolOutcome } from '@/planner/executor';
import type { TaskNodeResult, TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';
import { newId } from '@/lib/ids';
import { nodeExecutionKey } from '@/lib/ledger';
import {
  claimNodeExecution,
  createTask,
  createTaskNode,
  releaseNodeExecution,
} from '@/lib/db/repositories/task';

import { useFreshDatabase, getTestPrisma } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

/** Fixed injected clock instant (distinct from the demo clock) for determinism. */
const NOW = 1_234_567;

useFreshDatabase();

/** A `kind:'tool'` node with sensible defaults; override any field. */
function toolNode(id: string, over: Partial<TaskNodeSpec> = {}): TaskNodeSpec {
  return { id, name: id.toUpperCase(), kind: 'tool', tool: `tool_${id}`, dependencies: [], ...over };
}

/** A fresh pending `TaskPlan` whose `id` equals the owning `AgentTask.id`. */
function makePlan(taskId: string, sessionId: string, nodes: TaskNodeSpec[]): TaskPlan {
  return {
    id: taskId,
    sessionId,
    goal: 'node claim scope',
    status: 'pending',
    nodes,
    results: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * Seed one `AgentTask` (id = the plan id) + one `AgentTaskNode` (`nodeId` = the plan node id),
 * mirroring how the durable plan executor addresses a node by its logical `(taskId, nodeId)` pair.
 */
async function seedTask(nodeId: string): Promise<{ taskId: string; sessionId: string }> {
  const sessionId = newId('claimscope_sess');
  const task = await createTask({ sessionId, userId: DEMO_USER_ID, goal: 'node claim scope' });
  await createTaskNode({
    taskId: task.id,
    nodeId,
    name: nodeId.toUpperCase(),
    kind: 'tool',
    order: 0,
    tool: `tool_${nodeId}`,
  });
  return { taskId: task.id, sessionId };
}

/** Read the persisted node row by its logical `(taskId, nodeId)` pair. */
function readNode(taskId: string, nodeId: string) {
  return getTestPrisma().agentTaskNode.findFirst({ where: { taskId, nodeId } });
}

describe('planner/executor · node-claim CAS (db primitive)', () => {
  it('(taskId,nodeId) claim is exactly-once: one winner, later claims lost until the OWNER releases', async () => {
    const { taskId } = await seedTask('n1');

    // Exactly-once: the first claim wins; a concurrent claim on the SAME identity loses.
    expect(await claimNodeExecution(taskId, 'n1', 'token-A')).toBe(true);
    expect(await claimNodeExecution(taskId, 'n1', 'token-B')).toBe(false);
    expect((await readNode(taskId, 'n1'))?.executionToken).toBe('token-A');

    // A NON-owner release is a no-op: the owner still holds the claim.
    await releaseNodeExecution(taskId, 'n1', 'token-B');
    expect(await claimNodeExecution(taskId, 'n1', 'token-C')).toBe(false);
    expect((await readNode(taskId, 'n1'))?.executionToken).toBe('token-A');

    // The OWNER release clears the token; a fresh claim now wins.
    await releaseNodeExecution(taskId, 'n1', 'token-A');
    expect((await readNode(taskId, 'n1'))?.executionToken).toBeNull();
    expect(await claimNodeExecution(taskId, 'n1', 'token-C')).toBe(true);
    expect((await readNode(taskId, 'n1'))?.executionToken).toBe('token-C');
  });

  it('two DIFFERENT taskIds sharing the SAME nodeId are independently claimable', async () => {
    const { taskId: taskA } = await seedTask('n1');
    const { taskId: taskB } = await seedTask('n1');
    expect(taskA).not.toBe(taskB);

    // Each plan's node wins its OWN claim (the identity includes taskId).
    expect(await claimNodeExecution(taskA, 'n1', 'a-token')).toBe(true);
    expect(await claimNodeExecution(taskB, 'n1', 'b-token')).toBe(true);
    expect((await readNode(taskA, 'n1'))?.executionToken).toBe('a-token');
    expect((await readNode(taskB, 'n1'))?.executionToken).toBe('b-token');

    // Re-claiming either identity is still lost while its token is held.
    expect(await claimNodeExecution(taskA, 'n1', 'a2')).toBe(false);
    expect(await claimNodeExecution(taskB, 'n1', 'b2')).toBe(false);

    // Releasing A's claim does not touch B's.
    await releaseNodeExecution(taskA, 'n1', 'a-token');
    expect((await readNode(taskA, 'n1'))?.executionToken).toBeNull();
    expect((await readNode(taskB, 'n1'))?.executionToken).toBe('b-token');
  });
});

describe('planner/executor · node claim scope across SEPARATE executor runs (no in-process Map)', () => {
  it('a second run of the SAME (taskId,nodeId) backs off with ZERO side effects; after release exactly one run executes it', async () => {
    const nodeId = 'n1';
    const { taskId, sessionId } = await seedTask(nodeId);
    // The SAME plan object is driven by BOTH runs — only the (taskId, nodeId) identity guards it.
    const plan = makePlan(taskId, sessionId, [toolNode(nodeId, { tool: 'tool_n1' })]);

    // A first, still-live run holds the DB claim (no in-process Map is involved anywhere).
    expect(await claimNodeExecution(taskId, nodeId, 'run-1-token')).toBe(true);

    // ---- run B: a SEPARATE invocation whose dep object is entirely its own ----------------
    const runToolB = vi.fn(
      async (
        _tool: string,
        _args: Record<string, unknown>,
        _ctx: NodeExecutionContext,
      ): Promise<PlanToolOutcome> => ({ ok: true, data: {} }),
    );
    const onNodeUpdateB = vi.fn((_node: TaskNodeResult): void => {});
    const persistNodeB = vi.fn(async (_planId: string, _node: TaskNodeResult): Promise<void> => {});
    const persistPlanB = vi.fn(async (_plan: TaskPlan): Promise<void> => {});
    const depsB: PlanDeps = {
      runTool: runToolB,
      onNodeUpdate: onNodeUpdateB,
      persistNode: persistNodeB,
      persistPlan: persistPlanB,
      claimNode: (t, n, token) => claimNodeExecution(t, n, token),
      releaseNode: (t, n, token) => releaseNodeExecution(t, n, token),
    };

    const outB = await runPlan(plan, depsB, { now: () => NOW });

    // It performed NO node side effect and emitted NO node write (never set to running/success).
    expect(runToolB).not.toHaveBeenCalled();
    expect(onNodeUpdateB).not.toHaveBeenCalled();
    expect(persistNodeB).not.toHaveBeenCalled();

    // The walk HALTED: the plan is NOT settled and the node is NOT settled.
    expect(outB.status).toBe('running');
    expect(outB.results.find((r) => r.id === nodeId)?.status).not.toBe('success');
    expect(outB.results.find((r) => r.id === nodeId)?.status).toBe('pending');

    // The full-snapshot settlement write was skipped: the ONLY snapshot write is the up-front
    // `status:'running'` one — never a settled status.
    expect(persistPlanB.mock.calls.map(([p]) => p.status)).toEqual(['running']);

    // Nothing was written to the DB: the row is untouched and the first run still owns the claim.
    const rowAfterB = await readNode(taskId, nodeId);
    expect(rowAfterB?.status).toBe('pending');
    expect(rowAfterB?.executionToken).toBe('run-1-token');

    // ---- the first run's holder releases, then a FRESH run (its own dep object) executes it ----
    await releaseNodeExecution(taskId, nodeId, 'run-1-token');

    const runToolC = vi.fn(
      async (
        _tool: string,
        _args: Record<string, unknown>,
        _ctx: NodeExecutionContext,
      ): Promise<PlanToolOutcome> => ({ ok: true, data: {} }),
    );
    const onNodeUpdateC = vi.fn((_node: TaskNodeResult): void => {});
    const depsC: PlanDeps = {
      runTool: runToolC,
      onNodeUpdate: onNodeUpdateC,
      claimNode: (t, n, token) => claimNodeExecution(t, n, token),
      releaseNode: (t, n, token) => releaseNodeExecution(t, n, token),
    };

    const outC = await runPlan(plan, depsC, { now: () => NOW });

    // EXACTLY-ONCE without any in-process single-flight Map: the earlier invocation did not run
    // the node, so the node's side effect happens exactly once across the two separate runs.
    expect(runToolC).toHaveBeenCalledTimes(1);
    expect(outC.status).toBe('success');
    expect(outC.results.find((r) => r.id === nodeId)?.status).toBe('success');

    // The runTool node identity is STABLE across runs → the side-effect key is the same.
    const [toolName, , ctx] = runToolC.mock.calls[0];
    expect(toolName).toBe('tool_n1');
    expect(ctx).toEqual({ taskId, nodeId });
    expect(nodeExecutionKey(ctx.taskId, ctx.nodeId)).toBe(nodeExecutionKey(taskId, nodeId));

    // The winning run released its claim on settlement.
    expect((await readNode(taskId, nodeId))?.executionToken).toBeNull();
  });
});
