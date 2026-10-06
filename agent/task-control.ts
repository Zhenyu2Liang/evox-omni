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
 * The gateway-routed `runTool` port is INJECTED by the caller (`confirmation.ts` / `index.ts`), so
 * this module never imports `./confirmation` (no import cycle) and never executes a tool on its own
 * authority. It does import `@/security` for exactly ONE thing: revoking a cancelled plan's parked
 * `PendingAction`s through the gateway's atomic claim (`gateway.cancelAction`), so a later
 * confirm/verify can never move money out of a plan the user just cancelled. Tier/permission
 * decisions stay in `security/` — this module computes no tier and grants nothing.
 *
 * CONCURRENCY: every state-changing control path claims its transition with a single atomic
 * compare-and-set, and a RUNNING plan additionally holds a DB EXECUTION CLAIM
 * (`claimTaskExecution`: `AgentTask.executionToken` is claimed before `executor.runPlan` and released
 * in a `finally`), so two concurrent resumes/retries can never both RUN the same plan. A terminal
 * status (`cancelled`/`success`) is never resurrected. `cancelTask` revokes EVERY action of the plan
 * in ONE atomic bulk update (`revokePendingActionsByTask`) as its PRIMARY guarantee, and after every
 * run the CANONICAL CANCEL SWEEP (`sweepCancelledPlan`) revokes any `PendingAction` that a node
 * minted DURING the run while the plan was being cancelled concurrently.
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
import type {
  NodeExecutionContext,
  PlanControlCommand,
  PlanControlPort,
  PlanDeps,
  PlanToolOutcome,
} from '@/planner';
import { executor, lifecycle } from '@/planner';
import { security } from '@/security';
import { recordSecurityEvent } from '@/audit';
import { AppError, type ErrorCode } from '@/lib/errors';
import { newId } from '@/lib/ids';
import { safeParse } from '@/lib/json';
import { prisma } from '@/lib/db/client';
import { getSession } from '@/lib/db/repositories/session';
import {
  getPendingActionPlanLink,
  revokePendingActionsByTask,
} from '@/lib/db/repositories/pendingAction';
import {
  claimNodeExecution,
  claimTaskExecution,
  claimTaskStatus,
  getTask,
  listTasksBySession,
  releaseNodeExecution,
  releaseTaskExecution,
  updateTaskNode,
  updateTaskStatus,
  type AgentTaskWithNodes,
} from '@/lib/db/repositories/task';

/**
 * The gateway's runtime entry, used ONLY to revoke a cancelled plan's parked `PendingAction`s. The
 * `gateway` namespace's sole runtime member is the exported `securityGateway` object.
 */
const gateway = security.gateway.securityGateway;

/**
 * The plan statuses `pauseTask` may act on: every NON-TERMINAL status. `success`/`failed`/`cancelled`
 * are terminal and must never be resurrected by a pause; `'paused'` is included so a repeated pause
 * is an idempotent no-op instead of a lost update.
 */
const PAUSABLE_PLAN_STATUSES: TaskPlanStatus[] = [
  'pending',
  'running',
  'paused',
  'waiting_confirmation',
];

/**
 * The plan statuses `resumeTask` may act on: every NON-TERMINAL status, INCLUDING `'running'`.
 *
 * `'running'` is deliberately present so a second resume of an already-running plan is not starved by
 * the status CAS. The EXACTLY-ONCE guarantee is NOT the status CAS: it is the PLAN-level DB execution
 * claim (`claimTaskExecution` on `AgentTask.executionToken`), acquired BEFORE the run and released in
 * a `finally`, so a resume that loses the claim returns the persisted plan WITHOUT starting a second
 * executor. `'cancelled'`/`'success'` are terminal and are NEVER resumed — a terminal row is absent
 * from the from-set, so the CAS claims 0 rows and the caller returns the persisted plan without running.
 */
const RESUMABLE_PLAN_STATUSES: TaskPlanStatus[] = [
  'running',
  'paused',
  'waiting_confirmation',
  'pending',
  'failed',
];

/**
 * Every plan status EXCEPT the terminal `'cancelled'`.
 *
 * This is the compare-and-set from-set used to persist a plan CHECKPOINT (`persistPlan`): a
 * checkpoint may update any live/parked/settled plan, but it must NEVER resurrect a plan the user
 * cancelled — a `'cancelled'` row is absent from this set, so the guarded write claims 0 rows and the
 * cancellation stays authoritative. (`'cancelled'` itself is written unconditionally, since a
 * cancellation always wins — see `createTaskPersistence`.)
 */
const NON_CANCELLED_PLAN_STATUSES: TaskPlanStatus[] = [
  'pending',
  'running',
  'paused',
  'waiting_confirmation',
  'success',
  'failed',
];

/**
 * The plan statuses `retryTask` may act on. `'running'` is DELIBERATELY EXCLUDED — the mirror image
 * of `resumeTask`'s from-set, which KEEPS it — so a retry whose re-run was already started by a
 * concurrent retry cannot be started twice: the first retry claims (e.g. `failed` → `running`) and
 * runs, while the loser's guarded compare-and-set claims 0 rows and returns the persisted plan
 * WITHOUT running. The PLAN-level DB execution claim (`claimTaskExecution`) is the additional fence
 * against a concurrent resume/confirm-continuation still holding the executor slot. `'cancelled'` is
 * also excluded (terminal — a retry can never resurrect a cancelled plan). `'waiting_verification'`
 * is a NODE status only: a plan parked on a RED node persists as the PLAN status `'waiting_confirmation'`.
 */
const RETRYABLE_PLAN_STATUSES: TaskPlanStatus[] = [
  'pending',
  'paused',
  'waiting_confirmation',
  'failed',
];

/**
 * A control port that ALWAYS answers `{ kind: 'pause' }`.
 *
 * Used by `resumeTaskForAction` when the owning plan was explicitly PAUSED: it makes the planner's
 * `runPlan` record the one human-decided node and then stop at its FIRST checkpoint, so no downstream
 * node is launched and the plan stays `'paused'` (pause retention — see `resumeTaskForAction`).
 */
const PAUSE_NOW_CONTROLS: PlanControlPort = {
  pollControls: (): PlanControlCommand[] => [{ kind: 'pause' }],
};

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
  ctx: NodeExecutionContext,
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
      // A `'cancelled'` status is TERMINAL and authoritative: write it unconditionally (a
      // cancellation always wins over a racing checkpoint).
      if (plan.status === 'cancelled') {
        await updateTaskStatus(plan.id, 'cancelled');
        return;
      }
      // Every other checkpoint is applied through an ATOMIC compare-and-set whose from-set EXCLUDES
      // `'cancelled'` (see `NON_CANCELLED_PLAN_STATUSES`): a plan the user cancelled CONCURRENTLY —
      // while this run was inside `runTool` — stays cancelled, so the post-run CANCEL SWEEP
      // (`sweepCancelledPlan`) still observes `'cancelled'` and revokes any action the run just
      // parked. An UNGUARDED write here would resurrect the cancelled plan and leave that freshly
      // minted `PendingAction` executable.
      await claimTaskStatus(plan.id, NON_CANCELLED_PLAN_STATUSES, plan.status);
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

/**
 * The durable cross-request control source for a RUNNING plan: map the PERSISTED `AgentTask.status`
 * to the planner's out-of-band control commands, so a `POST /api/tasks/[id]` (pause / cancel) issued
 * while a plan is executing is observed at that run's next node checkpoint.
 *
 * The mapping is a PURE READ of the durable row and never clears anything: the durable status IS the
 * source of truth, so it stays stable across the checkpoints of a pass (and across passes) —
 * `'paused'` keeps yielding `{ kind:'pause' }` until `resumeTask` flips the row back to `'running'`,
 * and a `'cancelled'` row keeps yielding `{ kind:'cancel' }` (a cancelled plan is terminal).
 * Every other status (`'pending'`/`'running'`/`'waiting_confirmation'`/`'success'`/`'failed'`) yields
 * nothing, so a normal run is never interrupted by its own persisted status.
 */
export function defaultPollControls(planId: string): PlanControlPort {
  return {
    async pollControls(id: string): Promise<PlanControlCommand[]> {
      // The executor passes the plan id; the bound id is the fallback for a caller that omits it.
      const row = await getTask(id || planId);
      if (row === null) return [];
      if (row.status === 'paused') return [{ kind: 'pause' }];
      if (row.status === 'cancelled') return [{ kind: 'cancel' }];
      return [];
    },
  };
}

/** Assemble the full `PlanDeps` the planner entry points expect (persistence + runner + controls). */
function buildPlanDeps(
  planId: string,
  deps: TaskControlDeps,
  onNodeUpdate: (node: TaskNodeResult) => void = () => {},
): PlanDeps {
  return {
    runTool: deps.runTool,
    onNodeUpdate,
    // Per-node DB claim: the planner executor claims each node BEFORE running it and releases it in a
    // `finally` (even for a parked node), so a node's side effect can never run twice across two
    // overlapping executor passes of the same plan. `'running'` node status is never used as a lock.
    claimNode: (taskId, nodeId, token) => claimNodeExecution(taskId, nodeId, token),
    releaseNode: (taskId, nodeId, token) => releaseNodeExecution(taskId, nodeId, token),
    // Durable steering: a pause/cancel persisted by a control request stops THIS run at its next
    // checkpoint (see `defaultPollControls`).
    controls: defaultPollControls(planId),
    ...createTaskPersistence(planId),
  };
}

/** A task row plus the owner resolved from its persisted SESSION row (never from model text). */
interface OwnedTask {
  row: AgentTaskWithNodes;
  /** The verified owner: `row.userId`, cross-checked against the persisted session row. */
  userId: string;
}

/**
 * Load a task, verify it belongs to `sessionId` (and to that session's user) and return BOTH the row
 * and the TRUSTED owner id.
 *
 * Ownership is a SERVER-SIDE check: `sessionId` comes from the session, never from model text. A
 * mismatch is `SECURITY_DENIED`; an unknown task is `NOT_FOUND`. The returned `userId` is the only
 * identity this module may act with (see `revokeParkedActions`).
 */
async function loadOwnedTaskWithOwner(sessionId: string, taskId: string): Promise<OwnedTask> {
  const row = await getTask(taskId);
  if (row === null) throw new AppError('NOT_FOUND', `任务计划不存在: ${taskId}`);
  if (row.sessionId !== sessionId) {
    throw new AppError('SECURITY_DENIED', `无权访问该任务计划: ${taskId}`);
  }
  const session = await getSession(sessionId);
  if (session === null || session.userId !== row.userId) {
    throw new AppError('SECURITY_DENIED', `无权访问该任务计划: ${taskId}`);
  }
  return { row, userId: row.userId };
}

/** `loadOwnedTaskWithOwner` for the callers that do not need the owner id. */
async function loadOwnedTask(sessionId: string, taskId: string): Promise<AgentTaskWithNodes> {
  return (await loadOwnedTaskWithOwner(sessionId, taskId)).row;
}

/**
 * Re-read a plan (ownership-checked) as the frozen `TaskPlan`.
 *
 * Used by a control path that must NOT run the plan (a lost compare-and-set, or a terminal no-op):
 * the caller returns the CURRENT persisted state instead of a fabricated one.
 */
async function reloadPlan(sessionId: string, taskId: string): Promise<TaskPlan> {
  return toTaskPlan(await loadOwnedTask(sessionId, taskId));
}

/** Read a task plan as the frozen `TaskPlan` contract (ownership-checked). */
export async function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan> {
  return toTaskPlan(await loadOwnedTask(sessionId, taskId));
}

/**
 * Mark a task plan PAUSED.
 *
 * The DURABLE row carries the pause: `AgentTask.status` becomes `'paused'` (the source of truth
 * `defaultPollControls` reads, so a plan that is STILL RUNNING in another request stops at its next
 * checkpoint) and the returned snapshot says `'paused'` too, so a read agrees with the row.
 * Already-`success` nodes keep their recorded result and the un-run nodes stay `pending`, so
 * `resumeTask` continues exactly where the pause landed.
 *
 * ATOMIC: the transition is a single compare-and-set from a NON-TERMINAL status, so (a) two
 * concurrent pauses move the row exactly once and (b) a terminal (`cancelled`/`success`/`failed`)
 * plan is never resurrected by a pause. A LOST claim is a no-op that returns the persisted plan.
 */
export async function pauseTask(
  sessionId: string,
  taskId: string,
  opts: TaskControlOptions = {},
): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);

  const claimed = await claimTaskStatus(taskId, PAUSABLE_PLAN_STATUSES, 'paused');
  if (!claimed) return reloadPlan(sessionId, taskId); // terminal / lost race — never resurrect

  // `lifecycle.pausePlan` is PURE and returns a resumable snapshot; the status is upgraded here
  // because the durable row is what truly holds the pause.
  const paused: TaskPlan = {
    ...lifecycle.pausePlan(toTaskPlan(row), { now: opts.now }),
    status: 'paused',
  };
  await executor.persistPlanSnapshot(
    buildPlanDeps(taskId, { runTool: UNUSED_RUN_TOOL, now: opts.now }),
    paused,
  );
  return paused;
}

/**
 * Resume (re-run) a paused/parked task plan.
 *
 * The durable row is loaded FIRST, so `toTaskPlan(row)` may still carry the stale `'paused'` status;
 * the run is therefore driven with `explicitResume: true` — the planner's ONLY hook for advancing an
 * in-memory `'paused'` snapshot (a bare `runPlan(paused, …)` returns it unchanged). Independently,
 * `claimTaskStatus(taskId, RESUMABLE_PLAN_STATUSES, 'running')` flips the DURABLE row to `'running'`
 * BEFORE the run, because a durable `'paused'` row is exactly what `defaultPollControls` maps to a
 * pause command — leaving it would re-pause this very run at its first checkpoint.
 *
 * ATOMIC: that same compare-and-set from a RESUMABLE status to `'running'` gates the run, and the
 * PLAN-level DB execution claim (`claimTaskExecution`) is the EXACTLY-ONCE guarantee: the run only
 * starts when this caller wins the token, and a losing concurrent resume returns the persisted plan
 * WITHOUT a second executor. `'running'` is deliberately KEPT in the status from-set (unlike
 * `retryTask`'s, which EXCLUDES it). A `cancelled` plan is never resurrected (its status is absent
 * from the from-set). `runPlan` skips every terminal node (idempotency) and each node additionally
 * claims its own DB slot (`claimNode`), so an already-`success` node is NEVER re-executed and a
 * re-parked gated node stays parked for the next human decision.
 *
 * After the run the CANONICAL CANCEL SWEEP revokes any `PendingAction` a node minted while a
 * concurrent `cancelTask` cancelled the plan (see `sweepCancelledPlan`).
 */
export async function resumeTask(
  sessionId: string,
  taskId: string,
  deps: TaskControlDeps,
): Promise<TaskPlan> {
  // Ownership is verified BEFORE any mutation, so a foreign caller gets SECURITY_DENIED and the row
  // is left untouched.
  const row = await loadOwnedTask(sessionId, taskId);

  const claimed = await claimTaskStatus(taskId, RESUMABLE_PLAN_STATUSES, 'running');
  if (!claimed) return reloadPlan(sessionId, taskId); // already running / terminal — never double-run

  // PLAN-level DB claim: the ONE executor slot for this plan. A concurrent resume that loses this
  // atomic claim does NOT start a second executor — it returns the persisted plan. The claim is
  // released in the `finally`, so the next legitimate resume can take it.
  const token = newId('taskclaim');
  if (!(await claimTaskExecution(taskId, token))) return reloadPlan(sessionId, taskId);

  try {
    const result = await executor.runPlan(toTaskPlan(row), buildPlanDeps(taskId, deps), {
      now: deps.now,
      explicitResume: true,
    });
    await sweepCancelledPlan(sessionId, taskId);
    return result;
  } finally {
    await releaseTaskExecution(taskId, token);
  }
}

/** Gateway error codes that mean "already settled / gone" — there is nothing left to revoke. */
const ALREADY_SETTLED_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>(['CONFLICT', 'NOT_FOUND']);

/** Net outcome of revoking a cancelled plan's parked `PendingAction`s. */
export interface RevokeSummary {
  /** Action ids atomically claimed `pending`/`awaiting_mfa` → `cancelled`. */
  revoked: string[];
  /** Action ids that were ALREADY settled (executed / cancelled / gone) — nothing left to revoke. */
  alreadySettled: string[];
  /** Action ids that could NOT be revoked for an unexpected reason (message names the failure). */
  failed: { actionId: string; message: string }[];
}

/**
 * Revoke EVERY `PendingAction` the plan's nodes are parked on, using the TRUSTED identity only
 * (`userId` = the session-verified owner, `sessionId` = the task's own session — never model text).
 *
 * The gateway claims each action ATOMICALLY (`pending`/`awaiting_mfa` → `cancelled`), so a later
 * confirm/verify fails (`CONFLICT`) instead of moving money out of a plan the user just cancelled.
 * Each action is revoked INDEPENDENTLY — one failure never aborts the others — and the net outcome is
 * returned so the caller can surface it. An already-settled action is reported, never undone: work
 * that already executed is irreversible under the simulated backend and is NEVER pretended to be
 * rolled back.
 */
async function revokeParkedActions(
  userId: string,
  sessionId: string,
  row: AgentTaskWithNodes,
): Promise<RevokeSummary> {
  const summary: RevokeSummary = { revoked: [], alreadySettled: [], failed: [] };
  for (const node of row.nodes) {
    const actionId = readPendingActionId(safeParse(node.output, undefined));
    if (actionId === undefined) continue;
    try {
      await gateway.cancelAction(actionId, { userId, sessionId });
      summary.revoked.push(actionId);
    } catch (error) {
      const appError = AppError.from(error);
      if (ALREADY_SETTLED_CODES.has(appError.code)) {
        summary.alreadySettled.push(actionId);
        continue;
      }
      summary.failed.push({ actionId, message: appError.message });
    }
  }
  return summary;
}

/**
 * Durably record an UNEXPECTED revocation failure as a `SecurityEvent`.
 *
 * The cancelled plan is ALREADY persisted `cancelled`, so a failed revoke must be surfaced in the
 * audit trail WITHOUT turning the control API response into a 5xx (which would make the client discard
 * the response and keep a stale `等待确认` badge). The human-readable message names the plan id and each
 * `actionId(message)`; the structured failure list goes into `detail`. `SecurityEventKind` has no
 * dedicated "revoke failed" member, so the closest existing kind is used (`HIGH_RISK_BLOCKED`,
 * severity `high`): a surviving executable action after a cancellation is a high-risk incident.
 */
async function recordRevokeFailure(
  sessionId: string,
  taskId: string,
  failed: { actionId: string; message: string }[],
  bulkRevoked?: number,
): Promise<void> {
  await recordSecurityEvent({
    sessionId,
    kind: 'HIGH_RISK_BLOCKED',
    severity: 'high',
    message:
      `计划「${taskId}」已取消（批量撤销 ${bulkRevoked ?? 0} 个待确认操作），` +
      `但有 ${failed.length} 个未能撤销: ` +
      failed.map((entry) => `${entry.actionId}(${entry.message})`).join('; '),
    detail: { taskId, failed, bulkRevoked: bulkRevoked ?? 0 },
  });
}

/**
 * CANONICAL CANCEL SWEEP — the post-run guard against a `PendingAction` minted DURING a run.
 *
 * `executor.runPlan` can be CANCELLED by a concurrent `cancelTask` while one of its nodes is inside
 * `runTool`: that call can mint a FRESH `PendingAction` (the gateway parks a YELLOW/RED node call)
 * AFTER the cancellation already revoked the plan's then-known actions. When the run then settles,
 * the fresh action is still `pending`/`awaiting_mfa` — i.e. still EXECUTABLE — even though the plan
 * is cancelled.
 *
 * Every run path therefore calls this AFTER its run (the resume/retry paths here, and
 * `tools/planning.ts#runSubmitPlan` for a turn-time plan): re-load the `AgentTask` and, when its
 * persisted status is `'cancelled'`, revoke EVERY still-parked action of the plan
 * (`revokeParkedActions`) so no executable action survives the cancellation.
 *
 * Idempotent and cheap: an absent or non-`cancelled` plan is a no-op. An UNEXPECTED revocation
 * failure is NOT thrown — it is durably recorded as a `SecurityEvent` via `recordRevokeFailure` and
 * the summary is still returned, so a control API response never becomes a 5xx that would hide the
 * already-persisted `cancelled` state from the client.
 */
export async function sweepCancelledPlan(
  sessionId: string,
  taskId: string,
): Promise<RevokeSummary> {
  const row = await getTask(taskId);
  if (row === null || row.status !== 'cancelled') {
    return { revoked: [], alreadySettled: [], failed: [] };
  }
  if (row.sessionId !== sessionId) {
    throw new AppError('SECURITY_DENIED', `无权访问该任务计划: ${taskId}`);
  }
  const summary = await revokeParkedActions(row.userId, row.sessionId, row);
  if (summary.failed.length > 0) {
    await recordRevokeFailure(sessionId, taskId, summary.failed);
  }
  return summary;
}

/**
 * Cancel a task plan.
 *
 * The settle itself is ATOMIC: phase 1 bulk-revokes every parked action of the plan, then phase 2
 * re-revokes anything parked in the meantime AND writes the plan row `cancelled` in ONE `$transaction`,
 * so a between-phases action is never left `pending` while the row is not yet `cancelled` (the gateway's
 * `authorizeAction` does not read the plan status). The numbered steps below give the revoke-then-cancel
 * order.
 *
 * 1. REVOKE the parked `PendingAction`(s) FIRST (atomic claim → `cancelled`), so any later
 *    confirm/verify fails (`CONFLICT`/`NOT_FOUND`) and can never move money out of the cancelled plan.
 * 2. THEN cancel the plan: already-`success` nodes keep their result (irreversible — executed work is
 *    never pretended to be rolled back), every remaining non-terminal node becomes `cancelled`, and
 *    the snapshot is persisted.
 *
 * An already-`cancelled` plan is TERMINAL: re-cancelling is a no-op that returns the persisted
 * snapshot (no revoke, no rewrite). An already-settled action is not a failure (it is terminal, so
 * nothing can be revoked and no confirm can succeed). An UNEXPECTED revocation failure is NOT thrown —
 * it is durably recorded as a `SecurityEvent` via `recordRevokeFailure` and the cancelled plan is still
 * returned: the cancellation itself is never withheld, so the API response stays consistent with the
 * already-persisted `cancelled` row, and the failure is never swallowed (it is recorded above).
 */
export async function cancelTask(
  sessionId: string,
  taskId: string,
  opts: TaskControlOptions = {},
): Promise<TaskPlan> {
  const { row, userId } = await loadOwnedTaskWithOwner(sessionId, taskId);

  // A cancelled plan is terminal — never re-cancel, never rewrite it.
  if (row.status === 'cancelled') return toTaskPlan(row);

  // PHASE 1 — bulk revoke: revoke EVERY action of the plan in ONE atomic bulk update (`pending` /
  // `awaiting_mfa` → `cancelled`), so no executable gated call survives the cancellation regardless
  // of which node parked it. Race-safe by construction (a single `updateMany`).
  const bulkRevoked = await revokePendingActionsByTask(taskId, ['pending', 'awaiting_mfa']);

  // FALLBACK: also revoke via the parked-node scan (`node.output.pendingActionId`) for an action the
  // bulk update could not address (defensive — the bulk path already covers every `taskId`-linked row).
  const revoke = await revokeParkedActions(userId, row.sessionId, row);

  // PHASE 2 — ATOMIC SETTLE: re-revoke whatever got parked while phase 1 was in flight AND write the
  // plan row `cancelled` in ONE `$transaction`, so the revocation and the cancellation are never
  // observable separately. As two DISTINCT statements they left a gap: a gated call parked between
  // them stayed `pending` while the row was not yet `cancelled` — i.e. still authorizable, since
  // `security/security-gateway.ts#authorizeAction` does NOT read the plan status (only
  // `confirmation.ts#cancelledPlanOutcome`, which may already have run, does). Both writes MUST go
  // through the SAME `tx` client — neither `updateTaskStatus` nor `claimTaskStatus` accepts one, hence
  // the inline `tx.agentTask.update`. Irreversible work is never compensated: the revoke only matches
  // `pending`/`awaiting_mfa`, so an already-executed transfer is left exactly where it is.
  const settledRevoked = await prisma.$transaction(async (tx) => {
    const revoked = await revokePendingActionsByTask(taskId, ['pending', 'awaiting_mfa'], tx);
    await tx.agentTask.update({ where: { id: taskId }, data: { status: 'cancelled' } });
    return revoked;
  });

  // THEN cancel the plan: already-`success` nodes keep their result (irreversible — executed work is
  // never pretended to be rolled back), every remaining non-terminal node becomes `cancelled`, and the
  // snapshot is persisted (its `'cancelled'` status write is idempotent with phase 2).
  const cancelled = await lifecycle.cancelPlan(
    toTaskPlan(row),
    buildPlanDeps(taskId, { runTool: UNUSED_RUN_TOOL, now: opts.now }),
    { now: opts.now },
  );

  // Surface anything that could not be settled (never swallowed): an unexpected failure is durably
  // recorded as a `SecurityEvent`, with the bulk-revoke count for the audit trail.
  if (revoke.failed.length > 0) {
    await recordRevokeFailure(row.sessionId, taskId, revoke.failed, bulkRevoked + settledRevoked);
  }
  return cancelled;
}

/**
 * Retry the `failed` nodes (plus their not-yet-satisfied descendants), then re-run the plan.
 *
 * ATOMIC: a single compare-and-set from a NON-TERMINAL status to `'running'` gates the run. The
 * from-set EXCLUDES `'running'` (see `RETRYABLE_PLAN_STATUSES`) — the deliberate ASYMMETRY with
 * `resumeTask`, whose from-set KEEPS it: two concurrent retries must execute each reset node exactly
 * once (the loser returns the persisted plan WITHOUT running). The PLAN-level DB execution claim
 * (`claimTaskExecution`) additionally fences a concurrent resume/confirm-continuation. A `cancelled`
 * plan is NEVER retried (excluded from the from-set). After the run the CANONICAL CANCEL SWEEP
 * revokes any action left parked by a concurrent cancellation.
 */
export async function retryTask(
  sessionId: string,
  taskId: string,
  deps: TaskControlDeps,
): Promise<TaskPlan> {
  // Ownership is verified BEFORE any mutation (see `resumeTask`).
  const row = await loadOwnedTask(sessionId, taskId);

  const claimed = await claimTaskStatus(taskId, RETRYABLE_PLAN_STATUSES, 'running');
  if (!claimed) return reloadPlan(sessionId, taskId); // cancelled / lost race — never retry

  // PLAN-level DB claim: the ONE executor slot. A concurrent retry that loses the status CAS above
  // already returns early; this token additionally fences a resume/confirm-continuation that is still
  // holding the slot. The claim is released in the `finally`.
  const token = newId('taskclaim');
  if (!(await claimTaskExecution(taskId, token))) return reloadPlan(sessionId, taskId);

  try {
    const result = await lifecycle.retryPlan(toTaskPlan(row), buildPlanDeps(taskId, deps), {
      now: deps.now,
    });

    // `retryPlan` returns the input plan UNCHANGED — without persisting — when there is nothing to
    // retry, which would leave the row dangling in the `'running'` we just claimed. Restore the
    // truthful status with a CAS `'running' → result.status`: it is a no-op when the run already
    // persisted its own final status, and it never clobbers a concurrent `'paused'`/`'cancelled'`
    // (neither of which is `'running'`).
    await claimTaskStatus(taskId, ['running'], result.status);

    await sweepCancelledPlan(sessionId, taskId);
    return result;
  } finally {
    await releaseTaskExecution(taskId, token);
  }
}

/**
 * Reverse lookup: which task/node is parked on `actionId`?
 *
 * PREFERS the action's PERSISTED plan link (`PendingAction.taskId`/`nodeId`, written at gate time),
 * verified against the owning task's session; FALLS BACK to scanning the session's tasks and reading
 * each node's `output` (see `TaskNodeOutput`) for a pre-link action.
 */
export async function findTaskByPendingAction(
  sessionId: string,
  actionId: string,
): Promise<{ taskId: string; nodeId: string } | undefined> {
  // PRIMARY: the action's persisted plan link, verified so a link to a foreign/absent task is ignored
  // rather than trusted.
  const link = await getPendingActionPlanLink(actionId);
  if (link !== null && link.taskId !== null && link.nodeId !== null) {
    const linked = await getTask(link.taskId);
    if (linked !== null && linked.sessionId === sessionId) {
      return { taskId: link.taskId, nodeId: link.nodeId };
    }
  }

  // FALLBACK: scan the session's tasks and read each node's `output` (see `TaskNodeOutput`) — for an
  // action persisted before the plan link existed (or whose link is null).
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
 *
 * A `cancelled` owning plan is TERMINAL: the decision is a no-op returning the persisted plan (never
 * recording a node into a cancelled plan, which would let the planner's resume path resurrect it).
 *
 * PAUSE RETENTION: when the owning plan was explicitly PAUSED, this ONE decision must ONLY record
 * this node's result — it must NOT flip the plan to `'running'` and must NOT launch downstream nodes.
 * `lifecycle.resumePlan` always continues via `runPlan`, so the resume is given a control port that
 * forces `{ kind:'pause' }` (see `PAUSE_NOW_CONTROLS`): `runPlan` records the decided node and stops
 * at its FIRST checkpoint, leaving the plan `'paused'` with no downstream execution. The plan then
 * stays `'paused'` until an explicit `resumeTask`.
 *
 * After the resume the CANONICAL CANCEL SWEEP revokes any action a downstream node minted while a
 * concurrent `cancelTask` cancelled the plan.
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

  // A cancelled plan is terminal — the human decision is a no-op returning the persisted plan.
  if (row.status === 'cancelled') {
    return { taskId: located.taskId, nodeId: located.nodeId, plan: toTaskPlan(row) };
  }

  const baseDeps = buildPlanDeps(located.taskId, deps);
  const planDeps: PlanDeps =
    row.status === 'paused' ? { ...baseDeps, controls: PAUSE_NOW_CONTROLS } : baseDeps;

  const plan = await lifecycle.resumePlan(
    toTaskPlan(row),
    { nodeId: located.nodeId, outcome },
    planDeps,
    { now: deps.now },
  );

  await sweepCancelledPlan(sessionId, located.taskId);
  return { taskId: located.taskId, nodeId: located.nodeId, plan };
}
