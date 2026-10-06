/**
 * index.ts — the `agent` node facade (public runtime surface). `app/api` routes and `tests/` import
 * ONLY from here.
 */
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
import type { PlanToolOutcome } from '@/planner';
import { getSession } from '@/lib/db/repositories/session';
import { AppError } from '@/lib/errors';
import { executeGatedTool } from './confirmation';
import {
  cancelTask as cancelTaskInternal,
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
export { toCards, errorCard, confirmationCard, mfaCard } from './card-emitter';
export { buildSystemPrompt, HALLUCINATION_RULE } from './system-prompt';
export type { SystemPromptContext } from './system-prompt';
export { newSession, loadSession, saveSession, getOrCreateSession } from './session';
export type { SessionSnapshot } from './session';
export { createToolRegistry } from './tools';
export type { ToolRegistry, ToolExecutionResult } from './tools';
export { resolveModel, providerId } from './providers';

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
export function resumeTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  return resumeTaskInternal(sessionId, taskId, { runTool: taskRunToolFor(sessionId) });
}

/** Cancel a task plan (ownership-checked); returns the cancelled snapshot. */
export function cancelTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  return cancelTaskInternal(sessionId, taskId);
}

/** Retry the failed nodes of a task plan (ownership-checked), then re-run it. */
export function retryTask(sessionId: string, taskId: string): Promise<TaskPlan> {
  return retryTaskInternal(sessionId, taskId, { runTool: taskRunToolFor(sessionId) });
}

/** Read a task plan as the frozen `TaskPlan` contract (ownership-checked). */
export function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan> {
  return getTaskPlanInternal(sessionId, taskId);
}
