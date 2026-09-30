/**
 * planner/executor.ts — Deterministic plan execution engine.
 *
 * Walks a validated `TaskPlan` in topological order, executing `kind:'tool'`
 * nodes through an injected `runTool` port and evaluating `kind:'condition'`
 * nodes to skip dependent branches. All side effects (tool calls, persistence,
 * clock) live behind `PlanDeps` — the executor itself holds no banking,
 * security, or DB logic.
 *
 * The `runTool` port is supplied by the agent layer and routes through the
 * Security Gateway, so a node that needs human confirmation surfaces
 * `requiresConfirmation`/`pendingActionId` instead of executing — the executor
 * then parks the node in `waiting_confirmation` (see `planner/CONTEXT.md`).
 */
import type { TaskNodeResult, TaskPlan } from '../lib/contracts/task';

/**
 * Outcome of one tool invocation, as reported by the injected `runTool` port.
 * A gated tool call must NOT execute here — it returns
 * `{ ok:false, requiresConfirmation:true, pendingActionId }` so the executor can
 * transition the node to `waiting_confirmation`/`waiting_verification`.
 */
export interface PlanToolOutcome {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  requiresConfirmation?: boolean;
  pendingActionId?: string;
}

/** Side-effect ports the executor depends on. */
export interface PlanDeps {
  /** Execute one banking tool. Routes through the Security Gateway in production. */
  runTool(toolName: string, args: Record<string, unknown>): Promise<PlanToolOutcome>;
  /** Emitted on every node status change; the agent forwards it as `plan_update`. */
  onNodeUpdate(node: TaskNodeResult): void | Promise<void>;
  /** Optional persistence of the plan snapshot (AgentTask/AgentTaskNode). */
  persist?(plan: TaskPlan): Promise<void>;
}

/** Out-of-band controls handed to the caller so a running plan can be steered. */
export interface PlanControls {
  pause(): void;
  resume(): void;
  cancel(): void;
  retry(nodeId: string): void;
}

export interface RunPlanOptions {
  /** Abort signal; aborting cancels the plan and marks the running node `cancelled`. */
  signal?: AbortSignal;
  /** Injectable clock for deterministic timestamps; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Receives the `PlanControls` object once execution starts, so callers
   * (`POST /api/tasks/:id/...`) can pause/resume/cancel/retry a running plan.
   */
  onControls?: (controls: PlanControls) => void;
}

/**
 * Execute a plan to settlement and return its final snapshot.
 *
 * - Node statuses transition `pending → running → success | failed |
 *   waiting_confirmation | waiting_verification | cancelled | skipped`.
 * - A `condition` node evaluating `false` marks its transitive dependents `skipped`.
 * - A failing node is recorded as `failed`; the executor NEVER throws on a single
 *   node failure and continues independent branches.
 * - `deps.persist` is called after each mutation when provided.
 */
export function runPlan(plan: TaskPlan, deps: PlanDeps, opts?: RunPlanOptions): Promise<TaskPlan> {
  throw new Error('not implemented');
}
