/**
 * task-control.ts — durable DAG persistence + control/resume glue for the `submit_plan` meta-tool.
 *
 * It is the ONLY module that knows how a `TaskPlan` (the frozen planner contract) is spelled in the
 * database, and the ONLY place that documents the two facts the rest of the node relies on:
 *
 * 1. PLAN-ID ↔ AGENTTASK-ID. `dag.buildPlan` mints a provisional `id: newId('plan')`, but the row
 *    that survives a process restart is the Prisma `AgentTask` (id = cuid, minted by `createTask`).
 *    The persisted `AgentTask.id` IS the canonical plan id: `tools/planning.ts#runSubmitPlan` mints
 *    the task row FIRST and then overrides `plan.id = task.id`, so
 *    `plan.id === AgentTask.id === the taskId` used by every control path here. `loadPlan(taskId)` is
 *    therefore just `getTask(taskId)` mapped through `toTaskPlan`.
 *
 * 2. NODE-OUTPUT JSON SHAPE. A parked (gated) node records the human decision it is waiting on INSIDE
 *    `AgentTaskNode.output` as `{ pendingActionId: string }` (`TaskNodeOutput` below) — there is no
 *    `pendingActionId` column on `AgentTaskNode`, and `TaskNodeResult` has no such field. The planner
 *    already writes this shape; `readPendingActionId` is the single reader, and
 *    `findTaskByPendingAction` is the single reverse lookup (pendingActionId → owning task/node).
 *
 * No security/agent import: the gateway-routed `runTool` port is INJECTED by the caller
 * (`confirmation.ts` / `index.ts`), so this module never imports `./confirmation` (no import cycle)
 * and never executes a tool on its own authority.
 */
import type {
  TaskCondition,
  TaskNodeKind,
  TaskNodeResult,
  TaskNodeSpec,
  TaskNodeStatus,
  TaskPlan,
  TaskPlanStatus,
} from '@/lib/contracts/task';
import type { PlanDeps, PlanToolOutcome } from '@/planner';
import { executor, lifecycle } from '@/planner';
import { AppError } from '@/lib/errors';
import { safeParse } from '@/lib/json';
import { getSession } from '@/lib/db/repositories/session';
import {
  getTask,
  listTasksBySession,
  updateTaskNode,
  updateTaskStatus,
  type AgentTaskWithNodes,
} from '@/lib/db/repositories/task';

/**
 * The JSON payload a parked (gated) node stores in `AgentTaskNode.output`.
 *
 * `pendingActionId` is present iff the node is `waiting_confirmation`/`waiting_verification` and the
 * human decision is still outstanding. This is the ONLY durable join from a `PendingAction` back to
 * its owning plan node — there is no `pendingActionId` column.
 */
export interface TaskNodeOutput {
  pendingActionId?: string;
}

/** Read `pendingActionId` out of a (decoded) `AgentTaskNode.output`; `undefined` when absent. */
export function readPendingActionId(output: unknown): string | undefined {
  if (output === null || typeof output !== 'object') return undefined;
  const candidate = (output as { pendingActionId?: unknown }).pendingActionId;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Gateway-routed runner for a single plan node. Matches `planner`'s `PlanDeps.runTool` port; supplied
 * by the caller (the agent passes its gateway-authorized execution path — `executeGatedTool`).
 */
export type TaskRunTool = (
  toolName: string,
  args: Record<string, unknown>,
) => Promise<PlanToolOutcome>;

/** Options shared by every task-control entry point. */
export interface TaskControlOptions {
  /** Injectable clock for deterministic tests; defaults to the demo clock. */
  now?: () => number;
}

/** What the resume/retry paths need: the gateway-routed node runner (+ optional clock). */
export interface TaskControlDeps extends TaskControlOptions {
  runTool: TaskRunTool;
}

/** The planner persistence ports this module implements, bound to one plan id. */
export interface TaskPersistence {
  persistPlan(plan: TaskPlan): Promise<void>;
  persistNode(planId: string, node: TaskNodeResult): Promise<void>;
  loadPlan(planId: string): Promise<TaskPlan | undefined>;
}

/**
 * Placeholder `runTool` for the control paths that NEVER execute a node (pause / cancel / get): the
 * planner's pause/cancel helpers hold no tool-execution side effect, so this is never invoked. It
 * throws when it ever is, so a future misuse fails LOUDLY instead of silently doing nothing.
 */
const UNUSED_RUN_TOOL: TaskRunTool = async (toolName) => {
  throw new AppError('INTERNAL', `runTool 未注入；控制路径不应执行工具: ${toolName}`);
};

/** `updateTaskNode` throws this exact plain `Error` when the `(taskId, nodeId)` row is missing. */
function isMissingNodeError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('AgentTaskNode not found');
}

/** Map one persisted node row to a `TaskNodeSpec` (the plan's declared node shape). */
function toNodeSpec(node: AgentTaskWithNodes['nodes'][number]): TaskNodeSpec {
  return {
    id: node.nodeId,
    name: node.name,
    dependencies: safeParse<string[]>(node.dependencies, []),
    kind: node.kind as TaskNodeKind,
    tool: node.tool ?? undefined,
    args: safeParse<Record<string, unknown> | undefined>(node.args, undefined),
    condition: safeParse<TaskCondition | undefined>(node.condition, undefined),
  };
}

/** Map one persisted node row to a `TaskNodeResult` (the plan's runtime outcome shape). */
function toNodeResult(node: AgentTaskWithNodes['nodes'][number]): TaskNodeResult {
  return {
    id: node.nodeId,
    name: node.name,
    status: node.status as TaskNodeStatus,
    tool: node.tool ?? undefined,
    output: safeParse(node.output, undefined),
    error: node.error ?? undefined,
    startedAt: node.startedAt?.getTime(),
    endedAt: node.endedAt?.getTime(),
  };
}

/**
 * Map a persisted `AgentTask` (+ its ordered nodes) to the frozen `TaskPlan` contract. Mirrors the
 * read-side mapping in `app/api/_lib/task-plans.ts` (`./app` is not writable here) so `getTaskPlan`
 * and the HTTP read model agree byte-for-byte; the JSON columns are decoded with `safeParse`.
 */
export function toTaskPlan(row: AgentTaskWithNodes): TaskPlan {
  return {
    id: row.id,
    sessionId: row.sessionId,
    goal: row.goal,
    status: row.status as TaskPlanStatus,
    nodes: row.nodes.map(toNodeSpec),
    results: row.nodes.map(toNodeResult),
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

/**
 * Persistence ports bound to `planId` (= `AgentTask.id`): the plan snapshot updates the task status,
 * each node result updates its row, and loading re-reads the task. Implemented as planner
 * `PlanDeps` partials so `runSubmitPlan` can spread them straight into `executor.runPlan`.
 */
export function createTaskPersistence(planId: string): TaskPersistence {
  void planId; // the id is carried per call so these ports stay usable against any plan id
  return {
    async persistPlan(plan: TaskPlan): Promise<void> {
      await updateTaskStatus(plan.id, plan.status);
    },
    async persistNode(planId: string, node: TaskNodeResult): Promise<void> {
      try {
        await updateTaskNode(planId, node.id, {
          status: node.status,
          output: node.output ?? null,
          error: node.error ?? null,
          startedAt: node.startedAt === undefined ? undefined : new Date(node.startedAt),
          endedAt: node.endedAt === undefined ? undefined : new Date(node.endedAt),
        });
      } catch (error) {
        // A plan built outside `submit_plan` has no node rows; that is not a persistence failure.
        if (isMissingNodeError(error)) return;
        throw error; // every other failure surfaces — never swallowed
      }
    },
    async loadPlan(id: string): Promise<TaskPlan | undefined> {
      const row = await getTask(id);
      return row === null ? undefined : toTaskPlan(row);
    },
  };
}

/** Assemble the full `PlanDeps` the planner entry points expect (persistence + injected runner). */
function buildPlanDeps(
  planId: string,
  deps: TaskControlDeps,
  onNodeUpdate: (node: TaskNodeResult) => void = () => {},
): PlanDeps {
  return { runTool: deps.runTool, onNodeUpdate, ...createTaskPersistence(planId) };
}

/**
 * Load a task and verify it belongs to `sessionId` (and to that session's user).
 *
 * Ownership is a SERVER-SIDE check: `sessionId` comes from the session, never from model text. A
 * mismatch is `SECURITY_DENIED`; an unknown task is `NOT_FOUND`.
 */
async function loadOwnedTask(sessionId: string, taskId: string): Promise<AgentTaskWithNodes> {
  const row = await getTask(taskId);
  if (row === null) throw new AppError('NOT_FOUND', `任务计划不存在: ${taskId}`);
  if (row.sessionId !== sessionId) {
    throw new AppError('SECURITY_DENIED', `无权访问该任务计划: ${taskId}`);
  }
  const session = await getSession(sessionId);
  if (session === null || session.userId !== row.userId) {
    throw new AppError('SECURITY_DENIED', `无权访问该任务计划: ${taskId}`);
  }
  return row;
}

/** Read a task plan as the frozen `TaskPlan` contract (ownership-checked). */
export async function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan> {
  return toTaskPlan(await loadOwnedTask(sessionId, taskId));
}

/**
 * Mark a task plan PAUSED. `TaskPlanStatus` has no `'paused'`, so the paused snapshot lands
 * `pending` (a paused plan resumes by re-running); the task row's status is persisted to match.
 */
export async function pauseTask(
  sessionId: string,
  taskId: string,
  opts: TaskControlOptions = {},
): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  const paused = lifecycle.pausePlan(toTaskPlan(row), { now: opts.now });
  await executor.persistPlanSnapshot(
    buildPlanDeps(taskId, { runTool: UNUSED_RUN_TOOL, now: opts.now }),
    paused,
  );
  return paused;
}

/**
 * Resume (re-run) a paused/parked task plan. `runPlan` skips every terminal node (idempotency), so a
 * paused plan continues and a re-parked gated node stays parked for the next human decision.
 */
export async function resumeTask(
  sessionId: string,
  taskId: string,
  deps: TaskControlDeps,
): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  return executor.runPlan(toTaskPlan(row), buildPlanDeps(taskId, deps), { now: deps.now });
}

/**
 * Cancel a task plan: already-`success` nodes keep their result (irreversible), every remaining
 * non-terminal node becomes `cancelled`, and the snapshot is persisted.
 */
export async function cancelTask(
  sessionId: string,
  taskId: string,
  opts: TaskControlOptions = {},
): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  return lifecycle.cancelPlan(
    toTaskPlan(row),
    buildPlanDeps(taskId, { runTool: UNUSED_RUN_TOOL, now: opts.now }),
    { now: opts.now },
  );
}

/** Retry the `failed` nodes (plus their not-yet-satisfied descendants), then re-run the plan. */
export async function retryTask(
  sessionId: string,
  taskId: string,
  deps: TaskControlDeps,
): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  return lifecycle.retryPlan(toTaskPlan(row), buildPlanDeps(taskId, deps), { now: deps.now });
}

/**
 * Reverse lookup: which task/node is parked on `actionId`? Scans the session's tasks and reads each
 * node's `output` (see `TaskNodeOutput` — there is no `pendingActionId` column).
 */
export async function findTaskByPendingAction(
  sessionId: string,
  actionId: string,
): Promise<{ taskId: string; nodeId: string } | undefined> {
  const tasks = await listTasksBySession(sessionId);
  for (const task of tasks) {
    const row = await getTask(task.id);
    if (row === null) continue;
    for (const node of row.nodes) {
      if (readPendingActionId(safeParse(node.output, undefined)) === actionId) {
        return { taskId: task.id, nodeId: node.nodeId };
      }
    }
  }
  return undefined;
}

/**
 * Apply a HUMAN decision to the plan node parked on `actionId` and continue the plan.
 *
 * Returns `undefined` when the action is not a gated plan node (a plain transfer, say) — nothing to
 * resume. The REAL `PlanToolOutcome` is passed through, so the planner records the true result and
 * continues only on success; a re-parked node waits for the next decision.
 */
export async function resumeTaskForAction(
  sessionId: string,
  actionId: string,
  outcome: PlanToolOutcome,
  deps: TaskControlDeps,
): Promise<{ taskId: string; nodeId: string; plan: TaskPlan } | undefined> {
  const located = await findTaskByPendingAction(sessionId, actionId);
  if (located === undefined) return undefined;

  const row = await getTask(located.taskId);
  if (row === null) return undefined;

  const plan = await lifecycle.resumePlan(
    toTaskPlan(row),
    { nodeId: located.nodeId, outcome },
    buildPlanDeps(located.taskId, deps),
    { now: deps.now },
  );
  return { taskId: located.taskId, nodeId: located.nodeId, plan };
}
