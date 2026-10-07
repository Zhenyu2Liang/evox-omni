/**
 * Unit: planner/executor — EXECUTION-RIGHT after a plan TAKEOVER (DB-backed).
 *
 * A plan run holds a PLAN-level execution claim (`AgentTask.executionToken`). A concurrent
 * takeover rotates that token. This suite proves the SUPERSEDED ("zombie") run STOPS at every
 * async boundary without touching the winner's state:
 *
 *   - the node CLAIM is plan-ownership-aware (`buildNodeClaimPorts#claimNode` → the atomic
 *     `claimNodeOwnedByPlan` CAS), so a run whose plan claim was taken over never (re)claims a node;
 *   - `deps.isRunOwner` (`planExecutionClaimHeld`) is re-checked AFTER the `running` notification
 *     resolves and BEFORE the tool launch, and AGAIN after each SETTLEMENT notification resolves —
 *     a lost claim returns the `'owned'`/`claimLost` back-off (ZERO further writes, NO tool call).
 *
 * In every case the zombie publishes NO stale settlement progress, never launches a tool, and the
 * committed success fact of an already-run node is preserved untouched.
 *
 * DB-backed: real `AgentTask`/`AgentTaskNode` rows + the REAL production ports
 * (`buildNodeClaimPorts`, `planExecutionClaimHeld`). Clock, tools and persistence are injected.
 * No network, no real clock.
 */
import { describe, it, expect, vi } from 'vitest';

import { runPlan } from '@/planner/executor';
import type { NodeExecutionContext, PlanDeps, PlanToolOutcome } from '@/planner/executor';
import type { TaskNodeResult, TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';
import { newId } from '@/lib/ids';
import {
  claimTaskExecution,
  createTask,
  createTaskNode,
  updateTaskNode,
} from '@/lib/db/repositories/task';
import { buildNodeClaimPorts, planExecutionClaimHeld } from '@/agent/task-control';

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
    goal: 'execution right',
    status: 'pending',
    nodes,
    results: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/**
 * Seed an `AgentTask` (id = the plan id) with one `AgentTaskNode` per declared node, mirroring how
 * `submit_plan` mints the durable rows before `executor.runPlan` addresses them.
 */
async function seedTask(
  nodes: TaskNodeSpec[],
): Promise<{ taskId: string; sessionId: string }> {
  const sessionId = newId('execright_sess');
  const task = await createTask({ sessionId, userId: DEMO_USER_ID, goal: 'execution right' });
  for (const [order, node] of nodes.entries()) {
    await createTaskNode({
      taskId: task.id,
      nodeId: node.id,
      name: node.name,
      kind: node.kind,
      order,
      tool: node.kind === 'tool' ? (node.tool ?? null) : null,
      dependencies: node.dependencies,
    });
  }
  return { taskId: task.id, sessionId };
}

/** Read the persisted node row by its logical `(taskId, nodeId)` pair. */
function readNode(taskId: string, nodeId: string) {
  return getTestPrisma().agentTaskNode.findFirst({ where: { taskId, nodeId } });
}

/** Read the persisted plan row (token + status). */
function readTask(taskId: string) {
  return getTestPrisma().agentTask.findUnique({ where: { id: taskId } });
}

/** A minimal deferred so a test can block the zombie mid-notification and take over. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A tool port that always succeeds; the spy records every call. */
function okRunTool(): PlanDeps['runTool'] {
  return vi.fn(
    async (
      _tool: string,
      _args: Record<string, unknown>,
      _ctx: NodeExecutionContext,
    ): Promise<PlanToolOutcome> => ({ ok: true, data: {} }),
  );
}

/**
 * Simulate a concurrent TAKEOVER: rotate the plan's `executionToken` away from the zombie's token
 * (what a stale-claim `resume`/`retry` does to the owner it preempts).
 */
async function takeover(taskId: string, winnerToken: string): Promise<void> {
  await getTestPrisma().agentTask.update({
    where: { id: taskId },
    data: { executionToken: winnerToken, executionClaimedAt: new Date() },
  });
}

describe('planner/executor · execution-right after a plan takeover', () => {
  it('(a) node-claim barrier: a run whose plan claim was taken over refuses the node claim — ZERO notifications, ZERO tools, node untouched', async () => {
    const nodeId = 'n1';
    const { taskId, sessionId } = await seedTask([toolNode(nodeId)]);
    const planToken = 'zombie-plan-token';
    expect(await claimTaskExecution(taskId, planToken)).toBe(true);

    // Takeover BEFORE the walk starts: the plan token no longer matches the zombie's.
    await takeover(taskId, 'winner-plan-token');

    const runTool = okRunTool();
    const onNodeUpdate = vi.fn((_node: TaskNodeResult): void => {});
    const persistNode = vi.fn(async (_planId: string, _node: TaskNodeResult): Promise<void> => {});
    const persistPlan = vi.fn(async (_plan: TaskPlan): Promise<void> => {});

    const { claimNode, releaseNode } = buildNodeClaimPorts(taskId, planToken);
    const deps: PlanDeps = {
      runTool,
      onNodeUpdate,
      persistNode,
      persistPlan,
      claimNode,
      releaseNode,
      isRunOwner: () => planExecutionClaimHeld(taskId, planToken),
    };

    const out = await runPlan(makePlan(taskId, sessionId, [toolNode(nodeId)]), deps, { now: () => NOW });

    // The plan-ownership-aware node CAS refused the claim → no node write, no tool, no notification.
    expect(runTool).not.toHaveBeenCalled();
    expect(onNodeUpdate).not.toHaveBeenCalled();
    expect(persistNode).not.toHaveBeenCalled();

    // The walk HALTED: the plan is not settled and the node is not settled.
    expect(out.status).toBe('running');
    expect(out.results.find((r) => r.id === nodeId)?.status).toBe('pending');

    // The only plan write is the up-front `running` snapshot — never a settlement.
    expect(persistPlan.mock.calls.map(([p]) => p.status)).toEqual(['running']);

    // The zombie wrote nothing: the node row is untouched and the takeover still owns the plan.
    expect((await readNode(taskId, nodeId))?.status).toBe('pending');
    expect((await readNode(taskId, nodeId))?.executionToken).toBeNull();
    expect((await readTask(taskId))?.executionToken).toBe('winner-plan-token');
  });

  it('(b) running-notification barrier: a takeover during the `running` notification stops the run BEFORE the tool call', async () => {
    const nodeId = 'n1';
    const { taskId, sessionId } = await seedTask([toolNode(nodeId)]);
    const planToken = 'zombie-plan-token';
    expect(await claimTaskExecution(taskId, planToken)).toBe(true);

    const entered = deferred();
    const gate = deferred();
    const callLog: string[] = [];
    let blocked = false;

    const runTool = okRunTool();
    const onNodeUpdate = vi.fn(async (node: TaskNodeResult): Promise<void> => {
      callLog.push(`node:${node.id}:${node.status}`);
      if (node.id === nodeId && node.status === 'running' && !blocked) {
        blocked = true;
        entered.resolve();
        await gate.promise;
      }
    });
    const persistPlan = vi.fn(async (_plan: TaskPlan): Promise<void> => {});

    const { claimNode, releaseNode } = buildNodeClaimPorts(taskId, planToken);
    const deps: PlanDeps = {
      runTool,
      onNodeUpdate,
      persistPlan,
      claimNode,
      releaseNode,
      isRunOwner: () => planExecutionClaimHeld(taskId, planToken),
    };

    const runP = runPlan(makePlan(taskId, sessionId, [toolNode(nodeId)]), deps, { now: () => NOW });
    await entered.promise;
    // The zombie is parked INSIDE the `running` notification when the takeover lands.
    await takeover(taskId, 'winner-plan-token');
    gate.resolve();
    const out = await runP;

    // The ownership check AFTER the notification rejected the run: NO tool, NO settlement notice.
    expect(runTool).not.toHaveBeenCalled();
    expect(callLog).toEqual([`node:${nodeId}:running`]);

    expect(out.status).toBe('running');
    expect(out.results.find((r) => r.id === nodeId)?.status).not.toBe('success');

    // Only the up-front `running` plan snapshot was written — never a settlement.
    expect(persistPlan.mock.calls.map(([p]) => p.status)).toEqual(['running']);

    // The zombie never re-owned the plan.
    expect((await readTask(taskId))?.executionToken).toBe('winner-plan-token');
  });

  it('(c) pre-tool-write barrier: a takeover between the `running` notification and the tool launch yields ZERO tool calls', async () => {
    const nodeId = 'n1';
    const { taskId, sessionId } = await seedTask([toolNode(nodeId)]);
    const planToken = 'zombie-plan-token';
    expect(await claimTaskExecution(taskId, planToken)).toBe(true);

    const callLog: string[] = [];
    let taken = false;

    const runTool = okRunTool();
    const onNodeUpdate = vi.fn((node: TaskNodeResult): void => {
      callLog.push(`node:${node.id}:${node.status}`);
    });
    // `setNode` dispatches the notification THEN persists the node; the takeover lands in this gap,
    // i.e. strictly AFTER the `running` notification and BEFORE the tool launch.
    const persistNode = vi.fn(async (_planId: string, node: TaskNodeResult): Promise<void> => {
      if (!taken) {
        taken = true;
        await takeover(taskId, 'winner-plan-token');
      }
      void node;
    });
    const persistPlan = vi.fn(async (_plan: TaskPlan): Promise<void> => {});

    const { claimNode, releaseNode } = buildNodeClaimPorts(taskId, planToken);
    const deps: PlanDeps = {
      runTool,
      onNodeUpdate,
      persistNode,
      persistPlan,
      claimNode,
      releaseNode,
      isRunOwner: () => planExecutionClaimHeld(taskId, planToken),
    };

    const out = await runPlan(makePlan(taskId, sessionId, [toolNode(nodeId)]), deps, { now: () => NOW });

    // The `running` notification fired, but the pre-tool ownership check rejected the launch.
    expect(callLog).toEqual([`node:${nodeId}:running`]);
    expect(runTool).not.toHaveBeenCalled();
    expect(out.status).toBe('running');
    expect(out.results.find((r) => r.id === nodeId)?.status).toBe('running');
    expect(persistPlan.mock.calls.map(([p]) => p.status)).toEqual(['running']);
    expect((await readTask(taskId))?.executionToken).toBe('winner-plan-token');
  });

  it('(d) settlement-notification barrier: a takeover during a node`s `success` notice stops the successor AND preserves the committed success fact', async () => {
    const first = 'n1';
    const second = 'n2';
    const nodes = [toolNode(first), toolNode(second, { dependencies: [first] })];
    const { taskId, sessionId } = await seedTask(nodes);
    const planToken = 'zombie-plan-token';
    expect(await claimTaskExecution(taskId, planToken)).toBe(true);

    const entered = deferred();
    const gate = deferred();
    const callLog: string[] = [];
    let blocked = false;

    const toolCalls: string[] = [];
    const runTool = vi.fn(
      async (tool: string, _args: Record<string, unknown>, _ctx: NodeExecutionContext): Promise<PlanToolOutcome> => {
        toolCalls.push(tool);
        return { ok: true, data: {} };
      },
    );
    const onNodeUpdate = vi.fn(async (node: TaskNodeResult): Promise<void> => {
      callLog.push(`node:${node.id}:${node.status}`);
      if (node.id === first && node.status === 'success' && !blocked) {
        blocked = true;
        entered.resolve();
        await gate.promise;
      }
    });
    // Persist node statuses to the real DB so the committed fact is observable.
    const persistNode = vi.fn(async (planId: string, node: TaskNodeResult): Promise<void> => {
      await updateTaskNode(planId, node.id, { status: node.status });
    });
    const persistPlan = vi.fn(async (_plan: TaskPlan): Promise<void> => {});

    const { claimNode, releaseNode } = buildNodeClaimPorts(taskId, planToken);
    const deps: PlanDeps = {
      runTool,
      onNodeUpdate,
      persistNode,
      persistPlan,
      claimNode,
      releaseNode,
      isRunOwner: () => planExecutionClaimHeld(taskId, planToken),
    };

    const runP = runPlan(makePlan(taskId, sessionId, nodes), deps, { now: () => NOW });
    await entered.promise;
    await takeover(taskId, 'winner-plan-token');
    gate.resolve();
    const out = await runP;

    // Only the FIRST node's tool ran — the takeover stopped the walk before the successor.
    expect(toolCalls).toEqual([`tool_${first}`]);
    // No successor notification was ever published (no stale progress).
    expect(callLog).toEqual([`node:${first}:running`, `node:${first}:success`]);

    // The walk backed off: the plan is `running`, the successor is untouched.
    expect(out.status).toBe('running');
    expect(out.results.find((r) => r.id === first)?.status).toBe('success');
    expect(out.results.find((r) => r.id === second)?.status).toBe('pending');

    // The committed success fact survives in the DB — never rolled back or cosmetically reverted.
    expect((await readNode(taskId, first))?.status).toBe('success');
    expect((await readNode(taskId, second))?.status).toBe('pending');

    expect(persistPlan.mock.calls.map(([p]) => p.status)).toEqual(['running']);
    expect((await readTask(taskId))?.executionToken).toBe('winner-plan-token');
  });
});
