import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus } from '@/lib/contracts/security';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { AuthorizationResult } from '@/security/security-gateway';
import { getPendingAction } from '@/lib/db/repositories/pendingAction';
import { getTask } from '@/lib/db/repositories/task';
import { AppError } from '@/lib/errors';
import { findTaskByPendingAction } from '../task-control';
import { recoverStandaloneWedge } from '../confirmation-recovery';
import type { ConfirmOptions, ConfirmationOutcome } from './contracts';

export function emitAll(events: readonly AgentStreamEvent[], opts?: ConfirmOptions): void {
  for (const event of events) opts?.onEvent?.(event);
}

export function effectiveTier(view: AuthorizationResult): RiskLevel {
  return view.requiresMfa ? 'RED' : view.tier;
}

/** A cancelled workflow cannot authorize a late decision. */
export async function cancelledPlanOutcome(
  actionId: string,
  sessionId: string,
): Promise<ConfirmationOutcome | undefined> {
  const located = await findTaskByPendingAction(sessionId, actionId);
  if (located === undefined) return undefined;
  const task = await getTask(located.taskId);
  if (task === null || task.status !== 'cancelled') return undefined;
  const row = await getPendingAction(actionId);
  return {
    ok: false,
    actionId,
    status: (row?.status as PendingActionStatus | undefined) ?? 'cancelled',
    tier: (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW',
    requiresMfa: row?.requiresMfa === true,
    message: `该操作所属的任务计划已取消（${located.taskId}），已拒绝执行。`,
    events: [],
  };
}

/** Converge a standalone wedge before reporting a repeated decision. */
export async function conflictOutcome(actionId: string, error: AppError): Promise<ConfirmationOutcome> {
  const recovered = await recoverStandaloneWedge(actionId, { selfHoldsLiveMarker: true });
  if (recovered !== undefined) return recovered;
  const row = await getPendingAction(actionId);
  return {
    ok: false,
    actionId,
    status: (row?.status as PendingActionStatus | undefined) ?? 'cancelled',
    tier: (row?.riskLevel as RiskLevel | undefined) ?? 'YELLOW',
    requiresMfa: row?.requiresMfa === true,
    message: error.message,
    events: [],
  };
}

/** Emit MFA only for an undecided action; terminal refusals cannot request another code. */
export function blockedOutcome(
  actionId: string,
  view: AuthorizationResult,
  opts?: ConfirmOptions,
): ConfirmationOutcome {
  const events: AgentStreamEvent[] = view.requiresMfa && (view.status === 'pending' || view.status === 'awaiting_mfa')
    ? [{ type: 'mfa_required', actionId, action: view.action?.summary }] : [];
  emitAll(events, opts);
  return {
    ok: false,
    actionId,
    status: view.status,
    tier: effectiveTier(view),
    requiresMfa: view.requiresMfa,
    message: view.message,
    events,
  };
}
