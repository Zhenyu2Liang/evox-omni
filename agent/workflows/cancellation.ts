import type { TaskPlan } from '@/lib/contracts/task';
import { lifecycle } from '@/planner';
import { security } from '@/security';
import { recordSecurityEvent } from '@/audit';
import { AppError, type ErrorCode } from '@/lib/errors';
import { demoNow } from '@/lib/clock';
import { prisma } from '@/lib/db/client';
import { getTask, type AgentTaskWithNodes } from '@/lib/db/repositories/task';
import { listPendingActionsByTask, revokePendingActionsByTask } from '@/lib/db/repositories/pendingAction';
import { restoreCommittedCancellationNodes } from '../cancellation-evidence';
import { loadOwnedTaskWithOwner, getTaskPlan } from './ownership';
import { toTaskPlan } from './persistence';
import { buildPlanDeps, UNUSED_RUN_TOOL } from './ports';
import type { TaskControlOptions } from './contracts';

const ALREADY_SETTLED_CODES: ReadonlySet<ErrorCode> = new Set(['CONFLICT', 'NOT_FOUND']);
export interface RevokeSummary {
  revoked: string[];
  alreadySettled: string[];
  failed: { actionId: string; message: string }[];
}

async function revokeParkedActions(userId: string, sessionId: string, row: AgentTaskWithNodes): Promise<RevokeSummary> {
  const summary: RevokeSummary = { revoked: [], alreadySettled: [], failed: [] };
  for (const action of await listPendingActionsByTask(row.id)) {
    try {
      await security.gateway.securityGateway.cancelAction(action.id, { userId, sessionId });
      summary.revoked.push(action.id);
    } catch (error) {
      const failure = AppError.from(error);
      if (ALREADY_SETTLED_CODES.has(failure.code)) summary.alreadySettled.push(action.id);
      else summary.failed.push({ actionId: action.id, message: failure.message });
    }
  }
  return summary;
}

async function recordRevokeFailure(sessionId: string, taskId: string, failed: RevokeSummary['failed'], bulkRevoked = 0): Promise<void> {
  await recordSecurityEvent({
    sessionId, kind: 'HIGH_RISK_BLOCKED', severity: 'high',
    message: `Cancelled task ${taskId} has ${failed.length} actions requiring revocation review`,
    detail: { taskId, failed, bulkRevoked },
  });
}

/** Sweep after every executor pass, including actions created concurrently with cancellation. */
export async function sweepCancelledPlan(sessionId: string, taskId: string): Promise<RevokeSummary> {
  const row = await getTask(taskId);
  if (row === null || row.status !== 'cancelled') return { revoked: [], alreadySettled: [], failed: [] };
  if (row.sessionId !== sessionId) throw new AppError('SECURITY_DENIED', `Task plan ownership does not match: ${taskId}`);
  const summary = await revokeParkedActions(row.userId, row.sessionId, row);
  if (summary.failed.length > 0) await recordRevokeFailure(sessionId, taskId, summary.failed);
  return summary;
}

export async function cancelTask(sessionId: string, taskId: string, options: TaskControlOptions = {}): Promise<TaskPlan> {
  const { row, userId } = await loadOwnedTaskWithOwner(sessionId, taskId);
  if (row.status === 'cancelled') return toTaskPlan(row);
  const bulkRevoked = await revokePendingActionsByTask(taskId, ['pending', 'awaiting_mfa']);
  const revoke = await revokeParkedActions(userId, row.sessionId, row);
  // Revocation and cancellation are committed together; money already committed remains settled.
  const settledRevoked = await prisma.$transaction(async tx => {
    const revoked = await revokePendingActionsByTask(taskId, ['pending', 'awaiting_mfa'], tx);
    await tx.agentTask.update({ where: { id: taskId }, data: { status: 'cancelled' } });
    await restoreCommittedCancellationNodes(tx, taskId, userId, (options.now ?? demoNow)());
    return revoked;
  });
  await lifecycle.cancelPlan(toTaskPlan(row),
    buildPlanDeps(taskId, { runTool: UNUSED_RUN_TOOL, now: options.now }, undefined, { mode: 'control' }),
    { now: options.now });
  if (revoke.failed.length > 0) await recordRevokeFailure(row.sessionId, taskId, revoke.failed, bulkRevoked + settledRevoked);
  return getTaskPlan(sessionId, taskId);
}
