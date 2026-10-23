import type { TaskPlan, TaskPlanStatus } from '@/lib/contracts/task';
import type { PlanDeps, PlanNodeResult } from '@/planner';
import { executor, lifecycle } from '@/planner';
import { demoNow } from '@/lib/clock';
import { newId } from '@/lib/ids';
import { claimTaskExecution, claimTaskStatus, releaseTaskExecution } from '@/lib/db/repositories/task';
import { assertNoOpenManualReview } from '@/lib/db/repositories/manualReview';
import { clearStaleNodeClaims, staleExecutionClaimBefore } from './claims';
import { toTaskPlan } from './persistence';
import { getTaskPlan, loadOwnedTask } from './ownership';
import { buildPlanDeps, UNUSED_RUN_TOOL } from './ports';
import { sweepCancelledPlan } from './cancellation';
import { assertParkedActionsNotTerminal, sealedParkedNodes, type SealedParkedNode } from './parked-actions';
import type { TaskControlDeps, TaskControlOptions } from './contracts';
import { settlePlanFromNodes } from '../task-fencing';

const PAUSABLE: TaskPlanStatus[] = ['pending', 'running', 'paused', 'waiting_confirmation'];
const RESUMABLE: TaskPlanStatus[] = ['running', 'paused', 'waiting_confirmation', 'pending', 'failed'];
const RETRYABLE: TaskPlanStatus[] = ['pending', 'paused', 'waiting_confirmation', 'failed'];

/**
 * A sealed node's recorded output WITHOUT the now-dead `pendingActionId`: nothing else is dropped, and
 * an output that carried nothing else becomes absent, so the node can never be re-read as parked.
 */
function withoutPendingActionId(output: unknown): Record<string, unknown> | undefined {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const rest: Record<string, unknown> = { ...(output as Record<string, unknown>) };
  delete rest.pendingActionId;
  return Object.keys(rest).length === 0 ? undefined : rest;
}

/**
 * SEAL every node whose parked decision is already settled: record the terminal status the seal
 * PROJECTS (`SealedParkedNode.nodeStatus` — a completed node for an operation the server really
 * executed, a failed one with its catalog sentence otherwise), drop the dead `pendingActionId`, so the
 * executor sees a TERMINAL node (no tool call, no new pending action, no verification entry) while the
 * plan's remaining nodes keep advancing.
 *
 * The write goes through the EXISTING node-persistence port of the same leased plan run, so it is
 * fenced by this run's execution token and cannot clobber a terminally settled row.
 */
async function sealSettledNodes(
  plan: TaskPlan,
  sealed: readonly SealedParkedNode[],
  deps: TaskControlDeps,
  persistNode: PlanDeps['persistNode'],
): Promise<TaskPlan> {
  const byNode = new Map(sealed.map(entry => [entry.nodeId, entry]));
  const endedAt = (deps.now ?? demoNow)();
  const results: PlanNodeResult[] = plan.results.map(result => {
    const seal = byNode.get(result.id);
    if (seal === undefined) return result;
    return {
      ...result,
      status: seal.nodeStatus,
      output: withoutPendingActionId(result.output),
      error: seal.error,
      endedAt,
    };
  });
  for (const result of results) {
    if (!byNode.has(result.id)) continue;
    await persistNode?.(plan.id, result);
  }
  return { ...plan, results };
}

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
  const plan = toTaskPlan(row);
  // A settled (above all `locked`) parked decision is SEALED, never resurrected. The lookup is the
  // read-only query from `./parked-actions`, taken BEFORE any claim; the node is then recorded with the
  // status that decision projects (a completed node for an executed operation, a failed one for a
  // refusal) instead of being driven again. A plan whose every node is sealed simply returns with
  // nothing left to advance — that is a normal return, not a refusal.
  const sealed = await sealedParkedNodes(plan);
  if (!(await claimTaskStatus(taskId, RESUMABLE, 'running'))) return getTaskPlan(sessionId, taskId);
  const token = newId('taskclaim');
  if (!(await claimTaskExecution(taskId, token, { staleBefore: staleExecutionClaimBefore() }))) return getTaskPlan(sessionId, taskId);
  await clearStaleNodeClaims(taskId, token);
  const planDeps = buildPlanDeps(taskId, deps, undefined, { planToken: token });
  try {
    const resumable = sealed.length === 0 ? plan : await sealSettledNodes(plan, sealed, deps, planDeps.persistNode);
    await executor.runPlan(resumable, planDeps, { now: deps.now, explicitResume: true });
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
  const plan = toTaskPlan(row);
  // An explicit retry keeps the STRUCTURED refusal: a settled parked decision must never be reset to
  // `pending` and re-driven, so it is refused BEFORE any status or lease is claimed.
  await assertParkedActionsNotTerminal(plan);
  if (!(await claimTaskStatus(taskId, RETRYABLE, 'running'))) return getTaskPlan(sessionId, taskId);
  const token = newId('taskclaim');
  if (!(await claimTaskExecution(taskId, token, { staleBefore: staleExecutionClaimBefore() }))) return getTaskPlan(sessionId, taskId);
  await clearStaleNodeClaims(taskId, token);
  try {
    const result = await lifecycle.retryPlan(plan, buildPlanDeps(taskId, deps, undefined, { planToken: token, explicitRetry: true }), { now: deps.now });
    // No-op retries do not leave an admitted plan falsely marked as running.
    await claimTaskStatus(taskId, ['running'], result.status);
    await sweepCancelledPlan(sessionId, taskId);
  } finally {
    await releaseTaskExecution(taskId, token);
    await settlePlanFromNodes(taskId);
  }
  return getTaskPlan(sessionId, taskId);
}
