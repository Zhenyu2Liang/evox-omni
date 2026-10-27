/**
 * planner/index.ts — Facade for the DAG task planner.
 *
 * Consumers import from `planner` (this barrel): the `dag` graph operations, the
 * `executor` engine, the durable `lifecycle` entry points (pause/cancel/retry/
 * resume), and the `buildPlan` helper. Backs the agent's `submit_plan` meta-tool.
 */
export * as dag from './dag';
export * as executor from './executor';
export * as lifecycle from './lifecycle';
export * as failure from './failure';

export {
  isLockedRefusal,
  mayDriveNode,
  mayResetNode,
  publicFailureText,
  sealReason,
  toPlanFailure,
} from './failure';
export type { PlanFailure, PlanNodeResult, SealReason } from './failure';

export { buildPlan, transitiveDependents } from './dag';
export type { BuildPlanInput } from './dag';

export { isTerminalStatus, persistPlanSnapshot, persistPlanSnapshotGuarded } from './executor';
export type {
  GuardedPersistOptions,
  NodeExecutionContext,
  PlanControlCommand,
  PlanControlPort,
  PlanControls,
  PlanDeps,
  PlanToolOutcome,
  RunPlanOptions,
} from './executor';

export { cancelPlan, compensationReport, pausePlan, resumePlan, retryPlan } from './lifecycle';
export type {
  CancelPlanOptions,
  CompensationReport,
  PausePlanOptions,
  PlanCancellation,
  ResumeInput,
  RetryPlanOptions,
} from './lifecycle';

// Re-export the frozen plan/node contracts consumed by planner callers.
export type { TaskPlan, TaskNodeSpec, TaskNodeResult, TaskCondition } from '@/lib/contracts/task';
