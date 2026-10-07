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
  TaskNodeStatus,
  TaskPlan,
  TaskPlanStatus,
} from '@/lib/contracts/task';
import { dag, executor, type NodeExecutionContext, type PlanToolOutcome } from '@/planner';
import { AppError } from '@/lib/errors';
import { demoNow } from '@/lib/clock';
import { newId } from '@/lib/ids';
import {
  claimTaskExecutionWithGeneration,
  createTask,
  createTaskNode,
  releaseTaskExecution,
} from '@/lib/db/repositories/task';
import {
  buildNodeClaimPorts,
  clearStaleNodeClaims,
  createTaskPersistence,
  defaultPollControls,
  getTaskPlan,
  planExecutionClaimHeld,
  sweepCancelledPlan,
} from '../task-control';
import type { ToolExecutionResult } from './index';

/**
 * Gateway-routed runner for a single plan node — supplied by the agent layer. MUST route through
 * `security.gateway` (a gated node returns `{ ok:false, requiresConfirmation:true, pendingActionId }`).
 * `ctx` identifies the node this call belongs to (`{ taskId, nodeId }`); the agent forwards it as the
 * node's at-most-once key (`@/lib/ledger#nodeExecutionKey`), so a replay of the SAME `(task, node)`
 * dedupes its side effect instead of applying it twice. It is threaded straight through to the
 * executor's `runTool` port (which already calls `runTool(tool, args, ctx)`).
 */
export type PlanRunTool = (
  toolName: ToolName,
  args: Record<string, unknown>,
  ctx: NodeExecutionContext,
) => Promise<PlanToolOutcome>;

/** Injection `submit_plan` needs to run its DAG (the agent supplies these; the model cannot). */
export interface SubmitPlanDeps {
  /** Session that owns the plan (persisted as `AgentTask`/`AgentTaskNode`). */
  sessionId: string;
  /** Gateway-routed per-node runner (see `PlanRunTool`). */
  runTool: PlanRunTool;
  /** Called on every node status change; the agent forwards it as the `plan_update` stream event. */
  onNodeUpdate?: (node: TaskNodeResult) => void;
  /**
   * Called on every node status change with the FULL plan snapshot composed so far (the executor's
   * `onNodeUpdate` carries only the changed node). The agent forwards it as the `plan_update` stream
   * event so the UI renders the DAG timeline live. Optional — no snapshot is built when absent.
   */
  onPlanUpdate?: (plan: TaskPlan) => void | Promise<void>;
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
 * Compose a full `TaskPlan` snapshot from the in-scope plan + the node results accumulated so far,
 * so a `onPlanUpdate` sink can forward coherent DAG progress after EACH node change (the executor's
 * `onNodeUpdate` only carries the changed node).
 *
 * Mirrors the executor's internal snapshot: not-yet-recorded nodes surface as `pending` stubs, and
 * the plan status is derived the same way (`waiting_confirmation` when any node is parked, then
 * `cancelled` / `failed`, then all-settled ⇒ `success`, else `running`).
 */
function composePlanSnapshot(
  plan: TaskPlan,
  results: ReadonlyMap<string, TaskNodeResult>,
  now: number,
): TaskPlan {
  const statuses = plan.nodes.map((node) => results.get(node.id)?.status);
  let status: TaskPlanStatus = 'running';
  if (statuses.some((s) => s === 'waiting_confirmation' || s === 'waiting_verification')) {
    status = 'waiting_confirmation';
  } else if (statuses.some((s) => s === 'cancelled')) {
    status = 'cancelled';
  } else if (statuses.some((s) => s === 'failed')) {
    status = 'failed';
  } else if (statuses.every((s) => s === 'success' || s === 'skipped')) {
    status = 'success';
  }
  return {
    id: plan.id,
    sessionId: plan.sessionId,
    goal: plan.goal,
    status,
    nodes: plan.nodes,
    results: plan.nodes.map((node) => {
      const recorded = results.get(node.id);
      if (recorded) return { ...recorded };
      return {
        id: node.id,
        name: node.name,
        status: 'pending' as TaskNodeStatus,
        tool: node.kind === 'tool' ? node.tool : undefined,
      };
    }),
    createdAt: plan.createdAt,
    generation: plan.generation,
    updatedAt: now,
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
 * `dag.buildPlan` → claim the plan's executor slot → `executor.runPlan` with the `task-control`
 * persistence ports (see below). Returns `ToolExecutionResult{ok:false}` when validation fails, a
 * concurrent run already owns the plan, or any node fails; a gated node surfaces via the plan
 * snapshot (`waiting_confirmation`/`waiting_verification`).
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
      generation: task.generation,
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

  // LIVE DAG progress: the executor notifies the changed node only, so accumulate node results and
  // forward a full plan snapshot to the optional `onPlanUpdate` sink after every change. Seeded from
  // the (empty) plan; the sink is what drives the UI's `plan_update` timeline.
  const nodeSink = deps.onNodeUpdate;
  const planSink = deps.onPlanUpdate;
  const planNow = deps.now ?? (() => demoNow());
  const accumulated = new Map<string, TaskNodeResult>();
  // The plan's executor slot token (minted just below, before the run starts): the SAME per-run token
  // this run fences its plan/node writes on, read by the both-sink publish gate AND the ATOMIC node
  // claim ports built just after the claim (see `buildNodeClaimPorts`).
  const claimToken = newId('taskclaim');
  const onNodeUpdate = async (node: TaskNodeResult): Promise<void> => {
    // PLAN-OWNERSHIP GATE (BOTH sinks): publish NOTHING while this run no longer owns the plan's
    // execution claim. A run whose claim was taken over (a concurrent resume/retry rotated
    // `AgentTask.executionToken`) must emit NEITHER a stale NODE event (`onNodeUpdate`) NOR a stale
    // PLAN snapshot (`onPlanUpdate`) — otherwise the UI's DAG timeline would show the obsolete
    // executor's progress over the takeover's completed run. Both sinks are published only after the
    // live-claim read confirms this run still owns the plan.
    if (nodeSink === undefined && planSink === undefined) return;
    if (!(await planExecutionClaimHeld(plan.id, claimToken))) return;
    await nodeSink?.(node);
    // RE-CHECK after the (arbitrarily long-blocking) node sink RETURNS: a takeover landing during
    // that wait must not let this run accumulate or publish a stale plan snapshot — the winning
    // executor owns the DAG timeline.
    if (!(await planExecutionClaimHeld(plan.id, claimToken))) return;
    if (planSink === undefined) return;
    accumulated.set(node.id, { ...node });
    await planSink(composePlanSnapshot(plan, accumulated, planNow()));
  };

  // INITIAL-RUN PLAN CLAIM: take the plan's executor slot BEFORE starting a run, so two concurrent
  // drives of the SAME task can never both launch an executor. The token is fresh per call (a NEW
  // unique value, never reused), and a LOST claim (`false`) means another live run already owns the
  // plan — return an explicit "already running" outcome and run NOTHING (no duplicate execution).
  // The slot is released in `finally`, so a later resume/retry can re-claim it.
  const claimed = await claimTaskExecutionWithGeneration(plan.id, claimToken);
  if (!claimed.won) {
    return {
      ok: false,
      error: '计划已在执行中',
      summary: `计划「${goal}」已在执行中，本次未重复启动`,
    };
  }
  // WON the slot: nothing to reclaim on a FRESH plan (every node is `pending` with a NULL token), but
  // calling it keeps the initial pass identical to resume/retry/confirm-continuation (see
  // `clearStaleNodeClaims`).
  // Stamp the plan with the EXECUTION GENERATION this claim established, so every published
  // `plan_update` — and the plan this run RETURNS — carries the version in effect for THIS run's
  // claim (a consumer can drop a stale, lower-generation event from a superseded executor).
  plan = { ...plan, generation: claimed.generation ?? plan.generation };
  await clearStaleNodeClaims(plan.id, claimToken);

  // PER-NODE PLAN-OWNERSHIP CLAIM (ATOMIC): the executor asks `claimNode` before EVERY node. With this
  // run's PLAN claim threaded in, `buildNodeClaimPorts` mints an ATOMIC per-node token through the
  // single-statement plan-ownership CAS `claimNodeOwnedByPlan`, so ownership is verified in the SAME
  // statement as the claim — there is NO TOCTOU window between the read and the tool launch, so a
  // concurrent takeover that rotates `AgentTask.executionToken` can no longer let this run launch a
  // successor tool. The same map handed to `createTaskPersistence` fences every node WRITE on the claim
  // this run handed out.
  const { claimNode, releaseNode, nodeTokens } = buildNodeClaimPorts(plan.id, claimToken);

  let result: TaskPlan;
  try {
    result = await executor.runPlan(
      plan,
      {
        runTool: deps.runTool,
        // EXECUTION-RIGHT re-check consulted by the executor AFTER every async node notification
        // resolves and BEFORE it launches the node's tool: a taken-over initial run returns the
        // `'owned'` back-off branch (ZERO writes, NO tool call) instead of launching its next node.
        // Without this wiring the port is dead code and a zombie keeps executing.
        isRunOwner: () => planExecutionClaimHeld(plan.id, claimToken),
        onNodeUpdate,
        // Durable cross-request steering: a pause/cancel persisted by `POST /api/tasks/[id]` is
        // observed at this run's next node checkpoint, so a LIVE plan really stops (the persisted
        // `AgentTask.status` is the source of truth — see `defaultPollControls`).
        controls: defaultPollControls(plan.id),
        // PER-NODE CLAIM + WRITE FENCES keyed on this run's PLAN claim: `claimNode` is the ATOMIC
        // plan-ownership node CAS, so a taken-over initial run fails its next claim and launches no
        // successor tool; `releaseNode` releases that node token (and renews the plan lease), and
        // `createTaskPersistence` fences every node write on the claim this run handed out — so a run
        // whose claim was taken over can neither launch a successor tool nor overwrite the takeover's
        // plan/node rows (a fenced executor write with NO claim is SKIPPED, never written unfenced).
        claimNode,
        releaseNode,
        ...createTaskPersistence(plan.id, {
          planToken: claimToken,
          nodeToken: (nodeId) => nodeTokens.get(nodeId),
        }),
      },
      { signal: deps.signal, now: deps.now },
    );

    // CANONICAL CANCEL SWEEP: a node inside this run can have minted a FRESH `PendingAction` (the
    // gateway parks a YELLOW/RED node call) at the very moment a concurrent `cancelTask` cancelled
    // the plan, so an executable action could outlive the cancellation. Re-load the durable row and,
    // when it is `cancelled`, revoke every still-parked action (a no-op otherwise — see
    // `sweepCancelledPlan`). This runs while the plan claim is still held.
    await sweepCancelledPlan(deps.sessionId, plan.id);
  } finally {
    await releaseTaskExecution(plan.id, claimToken);
  }

  // CLAIM-LOST RECONCILIATION: `executor.runPlan` returns a `'running'` plan ONLY because it backed
  // off — a concurrent takeover rotated this plan's owner (see `claimLost` in `planner/executor`). A
  // superseded run must never report stale in-memory facts that contradict the winner's COMMITTED
  // state, so reload the durable plan and adopt its plan-level status/generation. This run's own
  // (truthful) node results are KEPT: it launched no successor tool after the takeover, so it never
  // claims a node success the database does not have.
  if (result.status === 'running') {
    const persisted = await getTaskPlan(deps.sessionId, plan.id);
    result = {
      ...result,
      status: persisted.status,
      generation: persisted.generation ?? result.generation,
      updatedAt: persisted.updatedAt,
    };
  }

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
