/**
 * planner/dag.ts — Pure DAG operations for the task planner.
 *
 * No side effects, no I/O: validates, orders, and evaluates plan graphs.
 * Tool execution, persistence and the clock are injected by the caller
 * (see `executor.ts` / `PlanDeps`). Deterministic: `buildPlan` accepts an
 * injectable `now` and `id` so tests stay reproducible.
 *
 * Only depends on the frozen shared contracts (`lib/contracts/task`) and the
 * project error convention (`lib/errors`). Never imports banking-sdk / security
 * / agent / audit / prisma.
 */
import type { TaskCondition, TaskNodeResult, TaskNodeSpec, TaskPlan } from '../lib/contracts/task';
import type { Result } from '../lib/errors';

/**
 * Input to `buildPlan`. `now` and `id` are injectable for deterministic tests;
 * in production they default to a real clock and a generated id.
 */
export interface BuildPlanInput {
  sessionId: string;
  goal: string;
  nodes: TaskNodeSpec[];
  now?: () => number;
  id?: string;
}

/**
 * Validate a plan graph against the set of registered tool names.
 *
 * Detects (returning `err(new AppError('VALIDATION', ...))`):
 *  - duplicate node ids;
 *  - unknown tools referenced by `kind: 'tool'` nodes (not in `knownTools`);
 *  - malformed nodes (`tool` node without a tool, `condition` node without a condition);
 *  - dependencies pointing at non-existent node ids;
 *  - cycles in the dependency graph.
 *
 * Returns `ok(undefined)` for a well-formed, acyclic plan.
 */
export function validatePlan(nodes: TaskNodeSpec[], knownTools: Set<string>): Result<void> {
  throw new Error('not implemented');
}

/**
 * Return nodes in deterministic topological order (stable by declaration order
 * among nodes with equal readiness). Assumes the graph is acyclic — callers
 * validate first via `validatePlan`. Throws `AppError('VALIDATION')` on cycles.
 */
export function topologicalOrder(nodes: TaskNodeSpec[]): TaskNodeSpec[] {
  throw new Error('not implemented');
}

/**
 * Return the nodes that are ready to execute given the current `results`:
 * nodes not yet resolved (`pending`, or absent from `results`) whose every
 * dependency has reached a terminal success/skip state. Used by the executor
 * to walk the DAG incrementally and by retry logic to find re-runnable nodes.
 */
export function getReadyNodes(nodes: TaskNodeSpec[], results: TaskNodeResult[]): TaskNodeSpec[] {
  throw new Error('not implemented');
}

/**
 * Evaluate a `TaskCondition` against a scope built from prior node outputs.
 * `condition.path` is a dot-path (e.g. `analyze_entertainment.total`) resolved
 * against `scope`; missing paths resolve to `false`. Comparison uses `op`
 * (`> >= < <= == !=`) with numeric/string/boolean `value`. Pure and total.
 */
export function evaluateCondition(condition: TaskCondition, scope: Record<string, unknown>): boolean {
  throw new Error('not implemented');
}

/**
 * Assemble an initial `TaskPlan` from the LLM-proposed nodes:
 * status `pending`, empty `results`, `createdAt === updatedAt === now()`.
 * Does NOT validate — call `validatePlan` first (the `submit_plan` tool does).
 */
export function buildPlan(input: BuildPlanInput): TaskPlan {
  throw new Error('not implemented');
}
