import type { ScheduledTask } from '@prisma/client';

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
  throw new Error('not implemented');
}

export function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  throw new Error('not implemented');
}

export function createScheduledTask(
  input: CreateScheduledTaskInput,
): Promise<ScheduledTask> {
  throw new Error('not implemented');
}

export function updateScheduledTaskStatus(
  id: string,
  status: string,
): Promise<ScheduledTask> {
  throw new Error('not implemented');
}

export function deleteScheduledTask(id: string): Promise<void> {
  throw new Error('not implemented');
}
