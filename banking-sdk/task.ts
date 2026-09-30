/**
 * Banking SDK — scheduled tasks (reminders / future payments / transfers).
 * `listScheduledTasks` is a GREEN read; `createScheduledTask` / `cancelScheduledTask` execute only
 * (tier policy lives in `security/`).
 */
import type { CreateScheduledTaskInput, ScheduledTaskView } from './types';

/** Create a scheduled task; returns the created task. */
export async function createScheduledTask(
  input: CreateScheduledTaskInput,
): Promise<ScheduledTaskView> {
  throw new Error('not implemented');
}

/** All scheduled tasks owned by the user. */
export async function listScheduledTasks(userId: string): Promise<ScheduledTaskView[]> {
  throw new Error('not implemented');
}

/** Cancel a scheduled task (status → CANCELLED); returns the updated task. */
export async function cancelScheduledTask(id: string): Promise<ScheduledTaskView> {
  throw new Error('not implemented');
}
