/**
 * planning — `submit_plan` (META, not risk-gated)
 *
 * The single non-banking, meta tool: the model proposes a DAG of `TaskNodeSpec` nodes; this module
 * VALIDATES it via `@/planner`'s `dag.validatePlan`, assembles a `TaskPlan` via `dag.buildPlan`,
 * then EXECUTES it via `executor.runPlan` in topological order.
 *
 * META = NOT risk-gated itself (it never moves money directly). Individual money-moving nodes are
 * gated: `runPlan` receives a `deps.runTool` supplied by the AGENT RUNTIME that MUST route through
 * the Security Gateway (the agent passes its gateway-authorized execution path — `executeGatedTool`
 * — see parent `../CONTEXT.md`). A gated node returns
 * `{ ok:false, requiresConfirmation:true, pendingActionId }` and parks in
 * `waiting_confirmation`/`waiting_verification`; the human decision resumes the plan.
 *
 * Because node execution needs injected context the other tools do not, `submit_plan` is the ONE
 * tool whose runner requires `SubmitPlanDeps` (`sessionId` + `runTool`). `index.ts`'s
 * `createToolRegistry` receives those deps through its optional `opts` (see `./index.ts`).
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolName } from '@/lib/contracts/tools';
import type { TaskNodeResult } from '@/lib/contracts/task';
import type { PlanToolOutcome } from '@/planner';
import type { ToolExecutionResult } from './index';

/**
 * Gateway-routed runner for a single plan node — supplied by the agent layer. MUST route through
 * `security.gateway` (a gated node returns `{ ok:false, requiresConfirmation:true, pendingActionId }`).
 */
export type PlanRunTool = (
  toolName: ToolName,
  args: Record<string, unknown>,
) => Promise<PlanToolOutcome>;

/** Injection `submit_plan` needs to run its DAG (the agent supplies these; the model cannot). */
export interface SubmitPlanDeps {
  /** Session that owns the plan (persisted as `AgentTask`/`AgentTaskNode`). */
  sessionId: string;
  /** Gateway-routed per-node runner (see `PlanRunTool`). */
  runTool: PlanRunTool;
  /** Called on every node status change; the agent forwards it as the `plan_update` stream event. */
  onNodeUpdate?: (node: TaskNodeResult) => void;
  /** Abort signal for the run. */
  signal?: AbortSignal;
  /** Injectable clock for deterministic tests (`dag.buildPlan` `now`). */
  now?: () => number;
}

/**
 * Registered name of the `submit_plan` meta-tool — pinned to the frozen `ToolName` union. The tool
 * object is produced by `createSubmitPlanTool` (it needs `SubmitPlanDeps`), so the name lives here.
 */
export const SUBMIT_PLAN_TOOL_NAME = 'submit_plan' as const satisfies ToolName;

/** `submit_plan` params — the proposed DAG (validated against the frozen `TaskNodeSpec` shape). */
export const SubmitPlanParams = Type.Object({
  goal: Type.String({ description: '任务目标（自然语言）' }),
  nodes: Type.Array(
    Type.Object({
      id: Type.String({ description: '节点唯一 id' }),
      name: Type.String({ description: '节点名称' }),
      dependencies: Type.Array(Type.String(), { description: '依赖的节点 id 列表' }),
      kind: Type.String({ description: '节点类型：tool | condition | note' }),
      tool: Type.Optional(Type.String({ description: 'kind=tool 时调用的工具名' })),
      args: Type.Optional(Type.Object({}, { description: 'kind=tool 时工具参数' })),
      condition: Type.Optional(Type.Object({}, { description: 'kind=condition 时的判断条件' })),
    }),
    { description: 'DAG 节点列表' },
  ),
});
export type SubmitPlanArgs = Static<typeof SubmitPlanParams>;

/**
 * Build the `submit_plan` tool bound to `userId` + `deps`. Kept as a factory (rather than a
 * module-level constant) because it needs the agent-supplied `SubmitPlanDeps`. `createToolRegistry`
 * uses it internally; the agent may also construct a deps-bound instance directly.
 */
export function createSubmitPlanTool(
  userId: string,
  deps: SubmitPlanDeps,
): AgentTool<SubmitPlanArgs> {
  throw new Error('not implemented');
}

/**
 * Model-free runner: `dag.validatePlan(nodes, knownTools)` → `dag.buildPlan({ sessionId, goal,
 * nodes })` → `executor.runPlan(plan, { runTool: deps.runTool, onNodeUpdate: deps.onNodeUpdate })`.
 * Returns `ToolExecutionResult{ok:false}` when validation fails or any node fails; a gated node
 * surfaces via the plan snapshot (`waiting_confirmation`/`waiting_verification`).
 */
export async function runSubmitPlan(
  userId: string,
  args: Record<string, unknown>,
  deps: SubmitPlanDeps,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}
