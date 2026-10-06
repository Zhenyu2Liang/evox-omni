/**
 * Banking SDK — scheduled tasks (reminders / future payments / transfers).
 * `listScheduledTasks` is a GREEN read; `createScheduledTask` / `cancelScheduledTask` execute only
 * (tier policy lives in `security/`).
 *
 * The repository persists `payload` as JSON TEXT (see `lib/db/repositories/scheduledTask.ts`) and
 * returns the raw column on read, so it is parsed back with `safeParse` here.
 *
 * `createScheduledTask` accepts an OPTIONAL `idempotencyKey`: a repeat with the SAME key replays the
 * already-persisted task instead of creating a second row (see `./idempotent.ts`).
 */
import type { ScheduledTask } from '@prisma/client';
import { scheduledTasks } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { createIdempotent, normalizeIdempotencyKey } from './idempotent';
import { safeParse, toJson } from '../lib/json';
import type {
  CreateScheduledTaskInput,
  ScheduledTaskKind,
  ScheduledTaskStatus,
  ScheduledTaskView,
} from './types';

/** The only scheduled-task kinds the SDK accepts. */
const SCHEDULED_TASK_KINDS: readonly ScheduledTaskKind[] = ['REMINDER', 'PAYMENT', 'TRANSFER'];

function isScheduledTaskKind(value: string): value is ScheduledTaskKind {
  return (SCHEDULED_TASK_KINDS as readonly string[]).includes(value);
}

/** Maps a `ScheduledTask` row to its public view model (parsing the JSON `payload` text). */
function toScheduledTaskView(row: ScheduledTask): ScheduledTaskView {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ScheduledTaskKind,
    payload: safeParse<Record<string, unknown> | null>(row.payload, null) ?? undefined,
    runAt: row.runAt.getTime(),
    status: row.status as ScheduledTaskStatus,
    requiresConfirmation: row.requiresConfirmation,
    createdAt: row.createdAt.getTime(),
  };
}

/**
 * Create a scheduled task; returns the created task.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeated call with the
 * SAME key replays the persisted task (same `id`, no second row). Absent → unchanged behavior.
 */
export async function createScheduledTask(
  input: CreateScheduledTaskInput,
): Promise<ScheduledTaskView> {
  if (typeof input.name !== 'string' || input.name.trim() === '') {
    throw new AppError('VALIDATION', '任务名称不能为空', { name: input.name });
  }
  if (!isScheduledTaskKind(input.kind)) {
    throw new AppError('VALIDATION', `不支持的任务类型：${String(input.kind)}`, {
      kind: input.kind,
    });
  }
  if (!Number.isFinite(input.runAt)) {
    throw new AppError('VALIDATION', '任务执行时间无效', { runAt: input.runAt });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key !== undefined) {
    const replayed = await createIdempotent<ScheduledTask>({
      key,
      find: (tx) => tx.scheduledTask.findUnique({ where: { idempotencyKey: key } }),
      create: (tx, replayKey) =>
        tx.scheduledTask.create({
          data: {
            userId: input.userId,
            name: input.name,
            kind: input.kind,
            runAt: new Date(input.runAt),
            payload: input.payload == null ? null : toJson(input.payload),
            requiresConfirmation: input.requiresConfirmation ?? true,
            status: 'SCHEDULED',
            idempotencyKey: replayKey,
          },
        }),
    });
    return toScheduledTaskView(replayed);
  }

  const row = await scheduledTasks.createScheduledTask({
    userId: input.userId,
    name: input.name,
    kind: input.kind,
    runAt: new Date(input.runAt),
    payload: input.payload,
    requiresConfirmation: input.requiresConfirmation ?? true,
  });
  return toScheduledTaskView(row);
}

/** All scheduled tasks owned by the user. */
export async function listScheduledTasks(userId: string): Promise<ScheduledTaskView[]> {
  const rows = await scheduledTasks.listScheduledTasks(userId);
  return rows.map(toScheduledTaskView);
}

/** Cancel a scheduled task (status → CANCELLED); returns the updated task. */
export async function cancelScheduledTask(id: string): Promise<ScheduledTaskView> {
  const existing = await scheduledTasks.getScheduledTask(id);
  if (existing === null) {
    throw new AppError('NOT_FOUND', `计划任务不存在：${id}`, { id });
  }

  const row = await scheduledTasks.updateScheduledTaskStatus(id, 'CANCELLED');
  return toScheduledTaskView(row);
}
