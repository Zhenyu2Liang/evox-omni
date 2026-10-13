import type { ScheduledTask } from '@prisma/client';
import { dbClient } from '../client';
import { toJson } from '../../json';

export interface CreateScheduledTaskInput {
  userId: string;
  name: string;
  kind: string;
  runAt: Date;
  payload?: Record<string, unknown> | null;
  requiresConfirmation?: boolean;
  status?: string;
}

export function listScheduledTasks(
  userId: string,
  status?: string,
): Promise<ScheduledTask[]> {
  return dbClient().scheduledTask.findMany({
    where: { userId, ...(status ? { status } : {}) },
    orderBy: { runAt: 'asc' },
  });
}

export function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  return dbClient().scheduledTask.findUnique({ where: { id } });
}

export function createScheduledTask(
  input: CreateScheduledTaskInput,
): Promise<ScheduledTask> {
  return dbClient().scheduledTask.create({
    data: {
      userId: input.userId,
      name: input.name,
      kind: input.kind,
      runAt: input.runAt,
      payload: input.payload == null ? null : toJson(input.payload),
      requiresConfirmation: input.requiresConfirmation ?? true,
      status: input.status ?? 'SCHEDULED',
    },
  });
}

export function updateScheduledTaskStatus(
  id: string,
  status: string,
): Promise<ScheduledTask> {
  return dbClient().scheduledTask.update({ where: { id }, data: { status } });
}

export function deleteScheduledTask(id: string): Promise<void> {
  return dbClient().scheduledTask.delete({ where: { id } }).then(() => undefined);
}
