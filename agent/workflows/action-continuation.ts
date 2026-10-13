import type { TaskPlan } from '@/lib/contracts/task';
import { lifecycle, type PlanToolOutcome, type PlanDeps } from '@/planner';
import { getPendingActionPlanLink } from '@/lib/db/repositories/pendingAction';
import { getTask, claimTaskExecution, releaseTaskExecution } from '@/lib/db/repositories/task';
import { newId } from '@/lib/ids';
import { recordDecidedNodeFenced, settlePlanFromNodes } from '../task-fencing';
import { clearStaleNodeClaims, staleExecutionClaimBefore } from './claims';
import { toTaskPlan } from './persistence';
import { getTaskPlan } from './ownership';
import { buildPlanDeps, PAUSE_NOW_CONTROLS } from './ports';
import { sweepCancelledPlan } from './cancellation';
import type { TaskControlDeps } from './contracts';

export async function findTaskByPendingAction(sessionId: string, actionId: string): Promise<{ taskId: string; nodeId: string } | undefined> {
  const link = await getPendingActionPlanLink(actionId);
  if (link?.taskId && link.nodeId) {
    const task = await getTask(link.taskId);
    if (task?.sessionId === sessionId) return { taskId: link.taskId, nodeId: link.nodeId };
  }
  return undefined;
}

/** A human decision records one node even if a live executor still holds the plan claim. */
export async function resumeTaskForAction(sessionId: string, actionId: string, outcome: PlanToolOutcome,
  deps: TaskControlDeps): Promise<{ taskId: string; nodeId: string; plan: TaskPlan } | undefined> {
  const located = await findTaskByPendingAction(sessionId, actionId);
  if (located === undefined) return undefined;
  const row = await getTask(located.taskId);
  if (row === null) return undefined;
  if (row.status === 'cancelled') return { ...located, plan: toTaskPlan(row) };
  const planToken = newId('taskclaim');
  if (!(await claimTaskExecution(located.taskId, planToken, { staleBefore: staleExecutionClaimBefore() }))) {
    await recordDecidedNodeFenced({ ...located, outcome, now: deps.now });
    await sweepCancelledPlan(sessionId, located.taskId);
    return { ...located, plan: await getTaskPlan(sessionId, located.taskId) };
  }
  await clearStaleNodeClaims(located.taskId, planToken);
  try {
    const baseDeps = buildPlanDeps(located.taskId, deps, undefined, { mode: 'executor', planToken });
    const planDeps: PlanDeps = row.status === 'paused' ? { ...baseDeps, controls: PAUSE_NOW_CONTROLS } : baseDeps;
    await lifecycle.resumePlan(toTaskPlan(row), { nodeId: located.nodeId, outcome }, planDeps, { now: deps.now });
    await sweepCancelledPlan(sessionId, located.taskId);
  } finally {
    await releaseTaskExecution(located.taskId, planToken);
    await settlePlanFromNodes(located.taskId);
  }
  return { ...located, plan: await getTaskPlan(sessionId, located.taskId) };
}
