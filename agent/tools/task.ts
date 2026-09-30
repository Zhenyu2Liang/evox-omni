/**
 * task — `list_scheduled_tasks`, `create_scheduled_task`
 *
 * Scheduled-task reads and creation. TypeBox param schemas; `execute` is meant to call the Banking
 * SDK and THROW `AppError` on failure. The `run<X>(userId, args)` runners are the model-free path
 * used by `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_scheduled_tasks` 🟢 GREEN; `create_scheduled_task` 🟡 YELLOW (requires confirmation).
 * Tier is decided by `security/`, NOT here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { ToolExecutionResult } from './index';

/* ---------------------------------------------------- list_scheduled_tasks */

/** `list_scheduled_tasks` params — none. */
export const ListScheduledTasksParams = Type.Object({});
export type ListScheduledTasksArgs = Static<typeof ListScheduledTasksParams>;

/** Registered AgentTool for `list_scheduled_tasks` (🟢 GREEN). */
export const listScheduledTasksTool: AgentTool<ListScheduledTasksArgs> = {
  name: 'list_scheduled_tasks',
  label: '定时任务',
  description: '列出当前用户的定时/计划任务（提醒、缴费、转账）及其状态。',
  parameters: ListScheduledTasksParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.task.listScheduledTasks(userId)`. */
export async function runListScheduledTasks(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}

/* --------------------------------------------------- create_scheduled_task */

/** `create_scheduled_task` params (SDK `CreateScheduledTaskInput` minus the server-injected `userId`). */
export const CreateScheduledTaskParams = Type.Object({
  name: Type.String({ description: '任务名称' }),
  kind: Type.String({ description: '任务类型：REMINDER | PAYMENT | TRANSFER' }),
  runAt: Type.Number({ description: '执行时间（epoch ms）' }),
  payload: Type.Optional(Type.Object({}, { description: '任务载荷（JSON）' })),
  requiresConfirmation: Type.Optional(Type.Boolean({ description: '执行前是否需要确认，默认 true' })),
});
export type CreateScheduledTaskArgs = Static<typeof CreateScheduledTaskParams>;

/** Registered AgentTool for `create_scheduled_task` (🟡 YELLOW). */
export const createScheduledTaskTool: AgentTool<CreateScheduledTaskArgs> = {
  name: 'create_scheduled_task',
  label: '创建定时任务',
  description: '创建一个定时/计划任务（提醒、缴费或转账，需要用户确认）。',
  parameters: CreateScheduledTaskParams,
  execute: async () => {
    throw new Error('not implemented');
  },
};

/** Model-free runner — `banking.task.createScheduledTask({ userId, ... })`. */
export async function runCreateScheduledTask(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  throw new Error('not implemented');
}
