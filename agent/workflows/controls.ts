import type { TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import { executor, lifecycle } from '@/planner';
import { newId } from '@/lib/ids';
import { claimTaskExecution, claimTaskStatus, releaseTaskExecution } from '@/lib/db/repositories/task';
import { assertNoOpenManualReview } from '@/lib/db/repositories/manualReview';
import { clearStaleNodeClaims, staleExecutionClaimBefore } from './claims';
import { toTaskPlan } from './persistence';
import { getTaskPlan, loadOwnedTask } from './ownership';
import { buildPlanDeps, UNUSED_RUN_TOOL } from './ports';
import { sweepCancelledPlan } from './cancellation';
import type { TaskControlDeps, TaskControlOptions } from './contracts';
import { settlePlanFromNodes } from '../task-fencing';

const PAUSABLE: TaskPlanStatus[] = ['pending', 'running', 'paused', 'waiting_confirmation'];
const RESUMABLE: TaskPlanStatus[] = ['running', 'paused', 'waiting_confirmation', 'pending', 'failed'];
const RETRYABLE: TaskPlanStatus[] = ['pending', 'paused', 'waiting_confirmation', 'failed'];

export async function pauseTask(sessionId: string, taskId: string, options: TaskControlOptions = {}): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  if (!(await claimTaskStatus(taskId, PAUSABLE, 'paused'))) return getTaskPlan(sessionId, taskId);
  const paused = { ...lifecycle.pausePlan(toTaskPlan(row), { now: options.now }), status: 'paused' as const };
  await executor.persistPlanSnapshot(buildPlanDeps(taskId, { runTool: UNUSED_RUN_TOOL, now: options.now }, undefined, { mode: 'control' }), paused);
  return getTaskPlan(sessionId, taskId);
}

export async function resumeTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  await assertNoOpenManualReview(taskId);
  if (!(await claimTaskStatus(taskId, RESUMABLE, 'running'))) return getTaskPlan(sessionId, taskId);
  const token = newId('taskclaim');
  if (!(await claimTaskExecution(taskId, token, { staleBefore: staleExecutionClaimBefore() }))) return getTaskPlan(sessionId, taskId);
  await clearStaleNodeClaims(taskId, token);
  try {
    await executor.runPlan(toTaskPlan(row), buildPlanDeps(taskId, deps, undefined, { planToken: token }), { now: deps.now, explicitResume: true });
    await sweepCancelledPlan(sessionId, taskId);
  } finally {
    await releaseTaskExecution(taskId, token);
    // A concurrent confirmation can settle a child after this walk captured its waiting result.
    await settlePlanFromNodes(taskId);
  }
  return getTaskPlan(sessionId, taskId);
}

export async function retryTask(sessionId: string, taskId: string, deps: TaskControlDeps): Promise<TaskPlan> {
  const row = await loadOwnedTask(sessionId, taskId);
  await assertNoOpenManualReview(taskId);
  if (!(await claimTaskStatus(taskId, RETRYABLE, 'running'))) return getTaskPlan(sessionId, taskId);
  const token = newId('taskclaim');
  if (!(await claimTaskExecution(taskId, token, { staleBefore: staleExecutionClaimBefore() }))) return getTaskPlan(sessionId, taskId);
  await clearStaleNodeClaims(taskId, token);
  try {
    const result = await lifecycle.retryPlan(toTaskPlan(row), buildPlanDeps(taskId, deps, undefined, { planToken: token, explicitRetry: true }), { now: deps.now });
    // No-op retries do not leave an admitted plan falsely marked as running.
    await claimTaskStatus(taskId, ['running'], result.status);
    await sweepCancelledPlan(sessionId, taskId);
  } finally {
    await releaseTaskExecution(taskId, token);
    await settlePlanFromNodes(taskId);
  }
  return getTaskPlan(sessionId, taskId);
}
