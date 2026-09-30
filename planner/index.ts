/**
 * planner/index.ts — Facade for the DAG task planner.
 *
 * Consumers import from `planner` (this barrel): the `dag` graph operations,
 * the `executor` engine, and the `buildPlan` helper. Backs the agent's
 * `submit_plan` meta-tool.
 */
export * as dag from './dag';
export * as executor from './executor';

export { buildPlan } from './dag';
export type { BuildPlanInput } from './dag';

export type { PlanDeps, PlanToolOutcome, PlanControls, RunPlanOptions } from './executor';

// Re-export the frozen plan/node contracts consumed by planner callers.
export type { TaskPlan, TaskNodeSpec, TaskNodeResult, TaskCondition } from '@/lib/contracts/task';
