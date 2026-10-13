/**
 * index.ts — the `agent` node facade (public runtime surface). `app/api` routes and `tests/` import
 * ONLY from here.
 */
import type { TaskPlan } from '@/lib/contracts/task';
export { getManualReviewInbox, openManualReview, resolveManualReview } from './manual-review';
export { rollbackTask } from './task-rollback';
export { nextPlanDecision } from './task-decision';
export { tickScheduledTasks, getScheduleInbox } from './scheduled-dispatcher';
import { synchronizeScheduledWorkflow } from './scheduled-dispatcher';
import type { ToolName } from '@/lib/contracts/tools';
import type { PlanToolOutcome } from '@/planner';
import { getSession } from '@/lib/db/repositories/session';
import { AppError } from '@/lib/errors';
import { prisma } from '@/lib/db/client';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import {
  getPendingAction,
  getPendingActionOwnership,
  getPendingActionPlanLink,
} from '@/lib/db/repositories/pendingAction';
import { executeGatedTool } from './confirmation';
import type { ConfirmationOutcome } from './confirmation';
import {
  hasActiveLease,
  leaseNowMs,
  recoverStandaloneWedge,
  settlePendingAction,
  type ConfirmableActionRow,
} from './confirmation-recovery';
import { buildRecoveryAudit, convergenceAuditKey, decideConvergence } from './execution-convergence';
import {
  cancelTask as cancelTaskInternal,
  findTaskByPendingAction,
  getTaskPlan as getTaskPlanInternal,
  pauseTask as pauseTaskInternal,
  resumeTask as resumeTaskInternal,
  retryTask as retryTaskInternal,
  type TaskControlDeps,
  type TaskControlOptions,
  type TaskNodeOutput,
  type TaskPersistence,
  type TaskRunTool,
} from './task-control';

export { createBankingAgent } from './banking-agent';
export type { BankingAgentOptions, BankingAgentRuntime, BeforeToolCallHook, AfterToolCallHook } from './banking-agent';
export { runTurn, resumeTurn } from './run-turn';
export type { RunTurnDeps, ResumeTurnInput } from './run-turn';
export { confirmAction, verifyAction, cancelAction, executeGatedTool } from './confirmation';
// Aliases the `app/api/actions/[id]/{confirm,verify,cancel}` routes import by name.
export { confirmAction as confirm, verifyAction as verify, cancelAction as cancel } from './confirmation';
export type { ConfirmationOutcome, ConfirmOptions, GatedToolOutcome } from './confirmation';
// The `confirmed`-action classifier + the durable execution-lease helpers (`./confirmation-recovery`),
// re-exported so `app/api` routes reach them through THIS facade (never a subpath import).
export {
  classifyConfirmedAction,
  hasActiveLease,
  isRecoverableStandaloneTool,
  leaseNowMs,
} from './confirmation-recovery';
export type { ConfirmedActionClass, ConfirmableActionRow } from './confirmation-recovery';
export { toCards, errorCard, confirmationCard, mfaCard } from './card-emitter';
export { buildSystemPrompt, HALLUCINATION_RULE } from './system-prompt';
export type { SystemPromptContext } from './system-prompt';
export { newSession, loadSession, saveSession, getOrCreateSession } from './session';
export type { SessionSnapshot } from './session';
export { createToolRegistry } from './tools';
export type { ToolRegistry, ToolExecutionResult } from './tools';
export { resolveProvider, resolveModel, providerId } from './providers';
export type { ModelRuntime } from './providers/types';

// --- standalone-wedge recovery entry point (`./confirmation-recovery`) ---------------------------

/**
 * Options for {@link recoverAction}: identity ASSERTIONS (never grants) plus an optional event sink.
 */
export interface RecoverOptions {
  /** Expected owner ASSERTION; a mismatch against the PERSISTED owner FAILS CLOSED. */
  userId?: string;
  /** Expected owning-session ASSERTION; same fail-closed semantics as `userId`. */
  sessionId?: string;
  /** Optional streaming hook: forwarded every recovery event. */
  onEvent?: (event: AgentStreamEvent) => void;
}

/** A plan link is USABLE only when BOTH ids are present (mirrors `confirmation-recovery`). */
function isPlanLinked(link: { taskId: string | null; nodeId: string | null } | null): boolean {
  const taskId = link?.taskId?.trim();
  const nodeId = link?.nodeId?.trim();
  return taskId !== undefined && taskId !== '' && nodeId !== undefined && nodeId !== '';
}

/** The persisted fields the honest no-op message reads (a structural slice of `PendingAction`). */
type RecoverableActionRow = ConfirmableActionRow & { riskLevel: string; requiresMfa: boolean };

/**
 * Resolve the TRUSTED owner of a pending action from PERSISTED state — never from the request
 * (the `confirmation.ts#resolveTrustedIdentity` contract, re-applied for the recovery entry point).
 * The row supplies the owning `sessionId`; the owning `userId` comes from that session row. Any
 * request-supplied `userId`/`sessionId` is an ASSERTION: a mismatch FAILS CLOSED with
 * `SECURITY_DENIED`. An unknown action is `NOT_FOUND`; ownership that cannot be established (no
 * owning session / no user) also FAILS CLOSED.
 */
async function resolveActionOwner(actionId: string, opts?: RecoverOptions): Promise<string> {
  const row = await getPendingActionOwnership(actionId);
  if (row === null) throw new AppError('NOT_FOUND', `未找到待处理的操作: ${actionId}`);
  if (opts?.sessionId !== undefined && opts.sessionId !== row.sessionId) {
    throw new AppError('SECURITY_DENIED', `无权恢复该待处理操作: ${actionId}`);
  }
  const session = await getSession(row.sessionId);
  const userId = session?.userId;
  if (userId === undefined || userId === '') {
    throw new AppError('SECURITY_DENIED', `无法解析待处理操作的所有者会话: ${row.sessionId}`);
  }
  if (opts?.userId !== undefined && opts.userId !== userId) {
    throw new AppError('SECURITY_DENIED', `无权恢复该待处理操作: ${actionId}`);
  }
  return userId;
}

/**
 * The honest, read-only "nothing here to recover" message for a row `recoverStandaloneWedge`
 * DECLINED: a plan-linked wedge (settled by the plan-resume path), a row a live continuation still
 * owns, or an already-settled row. Never a fabricated outcome.
 */
function noRecoveryMessage(
  row: RecoverableActionRow | null,
  link: { taskId: string | null; nodeId: string | null } | null,
): string {
  if (isPlanLinked(link)) {
    return '该操作属于任务计划：其持久化恢复由计划续跑路径处理，请恢复（resume）所属计划。';
  }
  if (row !== null && row.status === 'confirmed' && hasActiveLease(row, leaseNowMs())) {
    return '该操作正在处理中，请稍后刷新查看结果。';
  }
  return '该操作当前无需恢复。';
}

/**
 * RECOVERY ENTRY POINT for a STRANDED standalone wedge — a gated action left `confirmed` with NO
 * persisted result (its SDK side effect committed but the result+status write never landed). A
 * plain refresh surfaces such a row (`GET /api/actions`), but — unlike a `pending` action — it can
 * never be re-confirmed (the gateway's exactly-once CAS no longer matches `pending`); this entry
 * point settles it WITHOUT the user having to know the hidden action id from another screen.
 *
 * The owner is re-resolved from PERSISTED state (the row's session plus that session's `userId`); a
 * request-supplied `userId`/`sessionId` is an ASSERTION that FAILS CLOSED on mismatch. The recovery
 * itself is delegated to `recoverStandaloneWedge` — receipt-first: a committed receipt settles
 * `executed` WITHOUT re-invoking the tool; otherwise an idempotent replay for a proven-idempotent
 * tool, else the queryable `needs_reconciliation` state.
 *
 * A PLAN-LINKED wedge (a `confirmed`, result-less action belonging to a task-plan node) is settled
 * by RESUMING its owning plan: the plan-resume executor backfills the node from the PERSISTED result
 * (`recoverExecutedPlanAction`) or settles it `failed` / manual-reconciliation — the tool is NEVER
 * re-invoked on a guess.
 *
 * When there is nothing to recover it returns an honest `ok:false` outcome carrying the row's
 * CURRENT persisted status — NEVER a fabricated success and NEVER a re-run.
 */
export async function recoverAction(
  actionId: string,
  opts?: RecoverOptions,
): Promise<ConfirmationOutcome> {
  await resolveActionOwner(actionId, opts);

  // Historical executions may already be terminal while their audit is missing. Repair only the
  // audit/result from verified evidence; never re-run the SDK or downgrade a successful action.
  const initial = await getPendingAction(actionId);
  let repairedAudit = false;
  if (initial?.status === 'executed' && await prisma.auditLog.findUnique({ where: { dedupeKey: `exec:${actionId}` } }) === null) {
    const decision = await decideConvergence(initial);
    if (decision.status === 'executed' && decision.result?.ok === true) {
      repairedAudit = await settlePendingAction({
        actionId, status: 'executed', result: decision.result, from: ['executed'],
        audit: buildRecoveryAudit(initial, decision), dedupeKey: `exec:${actionId}`,
      });
    }
  }

  const recovered = await recoverStandaloneWedge(actionId);
  if (recovered !== undefined) {
    const emit = opts?.onEvent;
    if (emit !== undefined) for (const event of recovered.events) emit(event);
    return recovered;
  }

  const [row, link] = await Promise.all([
    getPendingAction(actionId),
    getPendingActionPlanLink(actionId),
  ]);
  const status = (row?.status as PendingActionStatus | undefined) ?? 'cancelled';
  const tier = (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW';
  const requiresMfa = row?.requiresMfa === true;

  // A PLAN-LINKED wedge is settled by RESUMING its owning plan: the plan-resume path backfills the
  // node from the PERSISTED result (or settles it `failed` / manual-reconciliation) — the tool is
  // never re-run on a mere guess.
  if (row !== null && isPlanLinked(link)) {
    // Evidence-based convergence at the recovery ENTRY POINT: a plan-linked row whose side effect is
    // PROVEN committed (a durable `ExecutionReceipt`, or a persisted result) is recorded `executed`
    // on the ACTION first — the tool is NEVER re-invoked — so an irreversible posted effect is
    // never left dangling `confirmed`. The owning plan is then resumed (below) so the NODE backfills
    // its REAL outcome from that persisted result without re-applying the side effect.
    const decision = await decideConvergence(row);
    if (decision.write && row.status === 'confirmed' &&
        ['executed', 'failed', 'needs_reconciliation'].includes(decision.status)) {
      await settlePendingAction({
        actionId,
        status: decision.status,
        result: decision.result,
        from: ['confirmed'],
        audit: buildRecoveryAudit(row, decision),
        dedupeKey: convergenceAuditKey(actionId, decision.status),
      });
    }
    const located = await findTaskByPendingAction(row.sessionId, actionId);
    if (located !== undefined) {
      try {
        const plan = await resumeTask(row.sessionId, located.taskId);
        const after = await getPendingAction(actionId);
        const settledStatus = (after?.status as PendingActionStatus | undefined) ?? status;
        const manualReview = settledStatus === 'needs_reconciliation';
        const unsuccessful = manualReview || ['failed', 'cancelled', 'locked'].includes(settledStatus) ||
          (plan.status === 'failed' && settledStatus !== 'executed');
        const events: AgentStreamEvent[] = [{ type: 'plan_update', plan }];
        const emit = opts?.onEvent;
        if (emit !== undefined) for (const event of events) emit(event);
        return {
          ok: !unsuccessful,
          actionId,
          status: settledStatus,
          tier,
          requiresMfa,
          message: manualReview ? '操作执行证据存在矛盾或缺失，已进入人工核对，请勿重复执行。'
            : unsuccessful ? `所属任务计划未成功完成（${located.taskId}），请核对操作状态。`
            : `已恢复所属任务计划（${located.taskId}）。`,
          events,
        };
      } catch (error) {
        const reason = error instanceof AppError ? error.message : '请稍后重试。';
        return {
          ok: false,
          actionId,
          status: ((await getPendingAction(actionId))?.status as PendingActionStatus | undefined) ?? status,
          tier,
          requiresMfa,
          message: `恢复所属任务计划失败：${reason}`,
          events: [],
        };
      }
    }
  }

  return {
    ok: repairedAudit,
    actionId,
    status,
    tier,
    requiresMfa,
    message: repairedAudit ? '已从持久化执行证据补齐审计，未重新执行操作。' : noRecoveryMessage(row, link),
    events: [],
  };
}

// --- durable DAG persistence + control/resume glue (`./task-control`, `submit_plan` backing) ------
export {
  createTaskPersistence,
  defaultPollControls,
  findTaskByPendingAction,
  readPendingActionId,
  resumeTaskForAction,
  toTaskPlan,
} from './task-control';
export type {
  TaskControlDeps,
  TaskControlOptions,
  TaskNodeOutput,
  TaskPersistence,
  TaskPersistenceMode,
  TaskPersistenceOptions,
  TaskRunTool,
} from './task-control';
// The FENCED write primitives (`./task-fencing`), incl. the confirm-continuation's LOST-claim
// decision recorder.
export { isMissingNodeError, jsonNodeOutput, recordDecidedNodeFenced, toNodeUpdate } from './task-fencing';
export type { DecidedNodeInput } from './task-fencing';

/**
 * Default `runTool` adapter for the agent-level task controls: every node routes through the
 * gateway-authorized execution path (`executeGatedTool`), so a gated node parks for a human decision
 * instead of executing. The owner is resolved from the SESSION row — never from model text.
 */
function taskRunToolFor(sessionId: string): TaskRunTool {
  return async (toolName, args, ctx): Promise<PlanToolOutcome> => {
    const session = await getSession(sessionId);
    const userId = session?.userId;
    if (userId === undefined || userId === '') {
      throw new AppError('SECURITY_DENIED', `无法解析会话所有者: ${sessionId}`);
    }
    return executeGatedTool({
      sessionId,
      userId,
      toolName: toolName as ToolName,
      args,
      userRequest: '',
      taskId: ctx.taskId,
      nodeId: ctx.nodeId,
    });
  };
}

/** Pause a task plan (ownership-checked); returns the paused snapshot. */
export function pauseTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  return pauseTaskInternal(sessionId, taskId);
}

/** Resume (re-run) a paused/parked task plan (ownership-checked). */
export async function resumeTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  const plan = await resumeTaskInternal(sessionId, taskId, { runTool: taskRunToolFor(sessionId) });
  await synchronizeScheduledWorkflow(taskId);
  return plan;
}

/** Cancel a task plan (ownership-checked); returns the cancelled snapshot. */
export async function cancelTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  const plan = await cancelTaskInternal(sessionId, taskId);
  await synchronizeScheduledWorkflow(taskId);
  return plan;
}

/** Retry the failed nodes of a task plan (ownership-checked), then re-run it. */
export async function retryTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  const plan = await retryTaskInternal(sessionId, taskId, { runTool: taskRunToolFor(sessionId) });
  await synchronizeScheduledWorkflow(taskId);
  return plan;
}

/** Read a task plan as the frozen `TaskPlan` contract (ownership-checked). */
export function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan> {
  return getTaskPlanInternal(sessionId, taskId);
}
