import { AppError } from '@/lib/errors';
import { getSession } from '@/lib/db/repositories/session';
import { getTask, type AgentTaskWithNodes } from '@/lib/db/repositories/task';
import type { TaskPlan } from '@/lib/contracts/task';
import { toTaskPlan } from './persistence';

export async function loadOwnedTaskWithOwner(sessionId: string, taskId: string): Promise<{ row: AgentTaskWithNodes; userId: string }> {
  const row = await getTask(taskId);
  if (row === null) throw new AppError('NOT_FOUND', `Task plan does not exist: ${taskId}`);
  if (row.sessionId !== sessionId) throw new AppError('SECURITY_DENIED', `Task plan ownership does not match: ${taskId}`);
  const session = await getSession(sessionId);
  if (session === null || session.userId !== row.userId) throw new AppError('SECURITY_DENIED', `Task plan ownership does not match: ${taskId}`);
  return { row, userId: row.userId };
}

export async function loadOwnedTask(sessionId: string, taskId: string): Promise<AgentTaskWithNodes> {
  return (await loadOwnedTaskWithOwner(sessionId, taskId)).row;
}

export async function getTaskPlan(sessionId: string, taskId: string): Promise<TaskPlan> {
  return toTaskPlan(await loadOwnedTask(sessionId, taskId));
}
