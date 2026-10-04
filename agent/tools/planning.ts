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
import type {
  TaskCondition,
  TaskNodeKind,
  TaskNodeResult,
  TaskNodeSpec,
  TaskPlan,
} from '@/lib/contracts/task';
import { dag, executor, type PlanToolOutcome } from '@/planner';
import { AppError } from '@/lib/errors';
import { createTask, createTaskNode } from '@/lib/db/repositories/task';
import { createTaskPersistence } from '../task-control';
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

/**
 * The 25 non-meta registered banking tool names a plan node may reference.
 *
 * Declared LOCALLY (instead of importing the runtime value `TOOL_NAMES` from `./index`) on purpose:
 * `index.ts` imports this module, so importing its value back would create a runtime import cycle.
 * `submit_plan` itself is deliberately EXCLUDED — a plan must never recurse into `submit_plan`.
 */
const KNOWN_TOOL_NAMES: readonly ToolName[] = [
  'get_balance',
  'get_transactions',
  'search_contact',
  'analyze_spending',
  'detect_anomaly',
  'get_cards',
  'list_subscriptions',
  'list_investments',
  'compare_investments',
  'get_investment_holdings',
  'get_dashboard_summary',
  'list_scheduled_tasks',
  'reserve_budget',
  'transfer_money',
  'set_card_limit',
  'cancel_subscription',
  'freeze_card',
  'apply_virtual_card',
  'set_subscription_reminder',
  'create_scheduled_task',
  'subscribe_investment',
  'redeem_investment',
  'report_lost_card',
  'unfreeze_card',
  'change_password',
];

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

/** One model-proposed node as it arrives in `submit_plan` params. */
type IncomingPlanNode = SubmitPlanArgs['nodes'][number];

/**
 * Adapt a loose model-proposed node to the exact `TaskNodeSpec` field names/shape. `kind`, `args`
 * and `condition` arrive from the TypeBox schema as `string` / `{}` (the schema keeps them open so
 * the model can pass family-specific args); `dag.validatePlan` then rejects malformed nodes.
 */
function toTaskNodeSpec(node: IncomingPlanNode): TaskNodeSpec {
  return {
    id: node.id,
    name: node.name,
    dependencies: node.dependencies,
    kind: node.kind as TaskNodeKind,
    tool: node.tool,
    args: node.args as Record<string, unknown> | undefined,
    condition: node.condition as TaskCondition | undefined,
  };
}

/**
 * Build the `submit_plan` tool bound to `userId` + `deps`. Kept as a factory (rather than a
 * module-level constant) because it needs the agent-supplied `SubmitPlanDeps`. `createToolRegistry`
 * uses it internally; the agent may also construct a deps-bound instance directly.
 */
export function createSubmitPlanTool(
  userId: string,
  deps: SubmitPlanDeps,
): AgentTool<typeof SubmitPlanParams> {
  return {
    name: SUBMIT_PLAN_TOOL_NAME,
    label: '提交任务计划',
    description:
      '提交并执行一个由多个银行工具节点组成的任务计划（DAG），节点按依赖顺序执行。' +
      '涉及敏感操作的节点会先请求用户确认，不会直接执行。',
    parameters: SubmitPlanParams,
    execute: async (_toolCallId, params) => {
      const result = await runSubmitPlan(
        userId,
        params as unknown as Record<string, unknown>,
        deps,
      );
      if (!result.ok) {
        throw new AppError('TOOL_FAILED', result.error ?? 'submit_plan failed');
      }
      return {
        content: [{ type: 'text', text: result.summary ?? '计划已执行' }],
        details: result.data,
      };
    },
  };
}

/**
 * Model-free runner: `dag.validatePlan` → mint the durable `AgentTask`/`AgentTaskNode` rows →
 * `dag.buildPlan` → `executor.runPlan` with the `task-control` persistence ports (see below).
 * Returns `ToolExecutionResult{ok:false}` when validation fails or any node fails; a gated node
 * surfaces via the plan snapshot (`waiting_confirmation`/`waiting_verification`).
 */
export async function runSubmitPlan(
  userId: string,
  args: Record<string, unknown>,
  deps: SubmitPlanDeps,
): Promise<ToolExecutionResult> {
  // `userId` (the owner) is used below to mint the durable AgentTask row; each node then executes
  // through the gateway-routed `deps.runTool`, which the agent already bound to this user.
  // (see `task-control.ts` for the plan-id ↔ AgentTask-id contract).

  const goal = typeof args.goal === 'string' ? args.goal : '';
  if (!goal) {
    return { ok: false, error: '缺少任务目标（goal）' };
  }
  if (!Array.isArray(args.nodes)) {
    return { ok: false, error: '缺少计划节点（nodes）' };
  }

  const nodes = (args.nodes as IncomingPlanNode[]).map(toTaskNodeSpec);

  const knownTools = new Set<string>(KNOWN_TOOL_NAMES);
  const validation = dag.validatePlan(nodes, knownTools);
  if (!validation.ok) {
    return { ok: false, error: validation.error.message };
  }

  // PLAN-ID ↔ AGENTTASK-ID: mint the DURABLE task row FIRST and adopt its id as the canonical plan
  // id, so the plan survives a refresh (`plan.id === AgentTask.id` for every control path). The node
  // rows are persisted up-front too, so the incremental `persistNode` updates below address real rows.
  let plan: TaskPlan;
  try {
    const task = await createTask({ sessionId: deps.sessionId, userId, goal });
    plan = {
      ...dag.buildPlan({ sessionId: deps.sessionId, goal, nodes, now: deps.now }),
      id: task.id,
    };
    for (const [order, node] of plan.nodes.entries()) {
      await createTaskNode({
        taskId: task.id,
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        order,
        tool: node.tool ?? null,
        args: node.args ?? null,
        condition: node.condition ?? null,
        dependencies: node.dependencies,
        status: 'pending',
      });
    }
  } catch (e) {
    // A persistence failure is a real `submit_plan` failure — reported as a value, never swallowed.
    return { ok: false, error: AppError.from(e).message };
  }

  const result = await executor.runPlan(
    plan,
    {
      runTool: deps.runTool,
      onNodeUpdate: deps.onNodeUpdate ?? (() => {}),
      ...createTaskPersistence(plan.id),
    },
    { signal: deps.signal, now: deps.now },
  );

  const done = result.results.filter((r) => r.status === 'success').length;
  const waiting = result.results.filter(
    (r) => r.status === 'waiting_confirmation' || r.status === 'waiting_verification',
  ).length;
  const failed = result.results.filter((r) => r.status === 'failed').length;
  const skipped = result.results.filter((r) => r.status === 'skipped').length;
  const firstFailed = result.results.find((r) => r.status === 'failed');

  // A gated node (waiting_confirmation/waiting_verification) is NOT a failure — it surfaces via the
  // plan snapshot and is resolved by a human decision. Only a hard `failed` plan status is `ok:false`.
  const ok = result.status !== 'failed';
  const summary =
    `计划${ok ? '已执行' : '执行失败'}：目标「${goal}」，` +
    `成功 ${done} 个，等待确认 ${waiting} 个，失败 ${failed} 个，跳过 ${skipped} 个` +
    (waiting > 0 ? '（涉及敏感操作的节点需用户确认后继续）' : '');

  return {
    ok,
    data: result,
    summary,
    error: firstFailed?.error ?? (ok ? undefined : '计划执行失败'),
  };
}
