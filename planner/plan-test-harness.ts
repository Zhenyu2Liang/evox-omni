/**
 * planner/plan-test-harness.ts — injected `PlanDeps` fixtures for the planner's PURE unit tests
 * (`planner/*.test.ts`).
 *
 * Modelled on `tests/unit/planner/executor.test.ts`: every side effect is a recording stub, so a
 * suite built on this harness needs NO database, NO Prisma client and NO network.
 */
import type { NodeExecutionContext, PlanDeps, PlanToolOutcome } from './executor';
import type { PlanNodeResult } from './failure';
import type { TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';

/** Fixed injected clock instant (distinct from the demo clock) for determinism. */
export const NOW = 1_234_567;

/** A `kind:'tool'` node with sensible defaults; override any field. */
export function toolNode(id: string, over: Partial<TaskNodeSpec> = {}): TaskNodeSpec {
  return { id, name: id.toUpperCase(), kind: 'tool', tool: `tool_${id}`, dependencies: [], ...over };
}

/** A fresh plan over `nodes`, optionally seeded with already-recorded `results`. */
export function makePlan(nodes: TaskNodeSpec[], results: PlanNodeResult[] = []): TaskPlan {
  return {
    id: 'plan_test',
    sessionId: 'session-1',
    goal: 'demo goal',
    status: 'pending',
    nodes,
    results,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** A recorded (non-terminal) node result, e.g. one parked on a gated action. */
export function parkedResult(id: string, over: Partial<PlanNodeResult> = {}): PlanNodeResult {
  return { id, name: id.toUpperCase(), tool: `tool_${id}`, status: 'waiting_confirmation', ...over };
}

/** The injected tool port: one outcome per call (or a throw, which the executor must contain). */
export type ToolHandler = (
  tool: string,
  args: Record<string, unknown>,
) => PlanToolOutcome | Promise<PlanToolOutcome>;

export interface PlanHarness {
  deps: PlanDeps;
  /** `onNodeUpdate` events, in order. */
  updates: PlanNodeResult[];
  /** `persistNode` rows, in order. */
  nodeRows: PlanNodeResult[];
  /** `persistPlan` snapshots, in order. */
  snapshots: TaskPlan[];
  /** `runTool` calls, in order (with the node identity the port received). */
  calls: Array<{ tool: string; args: Record<string, unknown>; ctx: NodeExecutionContext }>;
}

/** Build injected `PlanDeps` that record every side effect. */
export function planHarness(handler: ToolHandler): PlanHarness {
  const updates: PlanNodeResult[] = [];
  const nodeRows: PlanNodeResult[] = [];
  const snapshots: TaskPlan[] = [];
  const calls: PlanHarness['calls'] = [];
  const deps: PlanDeps = {
    async runTool(tool, args, ctx) {
      calls.push({ tool, args, ctx });
      return handler(tool, args);
    },
    onNodeUpdate(node) {
      updates.push(node);
    },
    persistNode: async (_planId, node) => {
      nodeRows.push(node);
    },
    persistPlan: async (plan) => {
      snapshots.push(plan);
    },
  };
  return { deps, updates, nodeRows, snapshots, calls };
}

/** The recorded result of node `id` in a plan snapshot (carrying the planner's structured fields). */
export function findResult(plan: TaskPlan, id: string): PlanNodeResult | undefined {
  return plan.results.find((r) => r.id === id) as PlanNodeResult | undefined;
}
