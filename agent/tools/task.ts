/**
 * task — `list_scheduled_tasks`, `create_scheduled_task`
 *
 * Scheduled-task reads and creation. TypeBox param schemas; `execute` calls the Banking SDK and
 * returns native Pi success or failure content. The `run<X>(userId, args, opts?)` runners are the model-free path
 * used by `executeDirect`; they CATCH and return `ToolExecutionResult{ok:false,error}`.
 *
 * Tiers: `list_scheduled_tasks` 🟢 GREEN; `create_scheduled_task` 🟡 YELLOW (requires confirmation).
 * Tier is decided by `security/`, NOT here. `userId` is SERVER-INJECTED; the model never supplies it.
 */
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type, type Static } from '@earendil-works/pi-ai';
import { banking } from '@/banking-sdk';
import type {
  CreateScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskStatus,
} from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { scheduledTime } from '@/lib/scheduled-time';
import type { ToolExecutionResult, ToolRunOptions } from './index';
import { toModelToolResult, toolFailure } from './result';

/** Chinese labels for a scheduled-task kind (for user-facing summaries). */
const KIND_LABELS: Record<ScheduledTaskKind, string> = {
  REMINDER: '提醒',
  PAYMENT: '缴费',
  TRANSFER: '转账',
};

/** Chinese labels for a scheduled-task status (for user-facing summaries). */
const STATUS_LABELS: Record<ScheduledTaskStatus, string> = {
  SCHEDULED: '待执行',
  DISPATCHING: 'Dispatching',
  AWAITING_CONFIRMATION: 'Awaiting user authorization',
  DONE: '已完成',
  FAILED: 'Failed',
  CANCELLED: '已取消',
};

/* ---------------------------------------------------- list_scheduled_tasks */

/** `list_scheduled_tasks` params — none. */
export const ListScheduledTasksParams = Type.Object({});
export type ListScheduledTasksArgs = Static<typeof ListScheduledTasksParams>;

/** Build the `list_scheduled_tasks` tool bound to `userId` (🟢 GREEN — auto-executes). */
export function createListScheduledTasksTool(
  userId: string,
): AgentTool<typeof ListScheduledTasksParams> {
  return {
    name: 'list_scheduled_tasks',
    label: '定时任务',
    description: '列出当前用户的定时/计划任务（提醒、缴费、转账）及其状态。',
    parameters: ListScheduledTasksParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runListScheduledTasks(userId, params as Record<string, unknown>));
    },
  };
}

/** Model-free runner — `banking.task.listScheduledTasks(userId)`. */
export async function runListScheduledTasks(
  userId: string,
  args: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  try {
    const tasks = await banking.task.listScheduledTasks(userId);
    const summary =
      tasks.length === 0
        ? '当前没有定时任务'
        : `共 ${tasks.length} 个定时任务：${tasks
            .map((task) => {
              const kind = KIND_LABELS[task.kind] ?? task.kind;
              const status = STATUS_LABELS[task.status] ?? task.status;
              return `${task.name}（${kind}，${formatDateTime(task.runAt)}，${status}）`;
            })
            .join('；')}`;
    return { ok: true, data: tasks, summary };
  } catch (e) {
    return toolFailure(e);
  }
}

/* --------------------------------------------------- create_scheduled_task */

/** `create_scheduled_task` params (SDK `CreateScheduledTaskInput` minus the server-injected `userId`). */
export const CreateScheduledTaskParams = Type.Object({
  name: Type.String({ minLength: 1, description: 'Scheduled intent name.' }),
  kind: Type.Union([Type.Literal('REMINDER'), Type.Literal('PAYMENT'), Type.Literal('TRANSFER')]),
  runAt: Type.Optional(Type.Integer({ description: 'Explicit future UTC epoch milliseconds, supplied as an integer.' })),
  runAtLocal: Type.Optional(Type.String({ description: '北京时间，例如 2026-10-15T09:00。保留用户明确指定的年份、月份和时间。' })),
  payload: Type.Optional(Type.Object({}, { description: '任务载荷（JSON）' })),
});
export type CreateScheduledTaskArgs = Static<typeof CreateScheduledTaskParams>;

/** Build the `create_scheduled_task` tool bound to `userId` (🟡 YELLOW — confirmation enforced by `security/`). */
export function createCreateScheduledTaskTool(
  userId: string,
): AgentTool<typeof CreateScheduledTaskParams> {
  return {
    name: 'create_scheduled_task',
    label: '创建定时任务',
    description: '创建一个定时/计划任务（提醒、缴费或转账，需要用户确认）。',
    parameters: CreateScheduledTaskParams,
    execute: async (_toolCallId, params) => {
      return toModelToolResult(await runCreateScheduledTask(userId, params));
    },
  };
}

/**
 * Model-free runner — `banking.task.createScheduledTask({ userId, name, kind, runAt, payload,
 * idempotencyKey })`.
 *
 * The trusted gateway or plan node supplies the execution identity. Model arguments never select it.
 */
export async function runCreateScheduledTask(
  userId: string,
  args: Record<string, unknown>,
  opts?: ToolRunOptions,
): Promise<ToolExecutionResult> {
  const input = args as unknown as CreateScheduledTaskArgs;
  const idempotencyKey = opts?.idempotencyKey;
  try {
    const request: CreateScheduledTaskInput = {
      userId,
      name: input.name,
      kind: input.kind as ScheduledTaskKind,
      runAt: scheduledTime(args),
      payload: input.payload as Record<string, unknown> | undefined,
      idempotencyKey,
    };
    const task = await banking.task.createScheduledTask(request);
    const kind = KIND_LABELS[task.kind] ?? task.kind;
    return {
      ok: true,
      data: task,
      summary: `已创建${kind}任务「${task.name}」，执行时间 ${formatDateTime(task.runAt)}`,
    };
  } catch (e) {
    return toolFailure(e);
  }
}
