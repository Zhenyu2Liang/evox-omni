/** Human decisions authorize persisted arguments; model prose never grants execution. */
import type { PendingAction, PendingActionStatus } from '@/lib/contracts/security';
import { security } from '@/security';
import { recordAudit } from '@/audit';
import { demoNow } from '@/lib/clock';
import { getPendingAction, getPendingActionPlanLink } from '@/lib/db/repositories/pendingAction';
import { AppError } from '@/lib/errors';
import type { AuthorizationResult } from '@/security/security-gateway';
import type { ConfirmOptions, ConfirmationOutcome } from './confirmation/contracts';
import { resolveTrustedIdentity } from './confirmation/identity';
import {
  blockedOutcome,
  cancelledPlanOutcome,
  conflictOutcome,
  unappliedCancelOutcome,
} from './confirmation/outcomes';
import { withLiveConfirmation } from './confirmation/liveness';
import { executeAuthorizedAction } from './confirmation/authorized-execution';

export type { ConfirmOptions, ConfirmationOutcome, GatedToolOutcome } from './confirmation/contracts';
export { executeGatedTool } from './confirmation/gated-execution';

const gateway = security.gateway.securityGateway;

/**
 * Confirmation and MFA share ownership, cancellation and execution checks. A refused authorization
 * that carries a DOMAIN code (`CONFLICT`: the action is no longer decidable; `MANUAL_REVIEW_HOLD`:
 * its workflow is taken over by an open manual review) becomes a domain outcome — never an HTTP
 * error — so the caller keeps the persisted status plus the typed `code`/`failure`.
 */
async function authorizeAndExecute(
  actionId: string, opts?: ConfirmOptions, mfaCode?: string,
): Promise<ConfirmationOutcome> {
  const identity = await resolveTrustedIdentity(actionId, opts);
  const cancelled = await cancelledPlanOutcome(actionId, identity.sessionId);
  if (cancelled !== undefined) return cancelled;
  let auth: AuthorizationResult;
  try {
    auth = await gateway.authorizeAction(actionId, {
      userId: identity.userId, sessionId: identity.sessionId,
      ...(mfaCode !== undefined ? { mfaCode } : {}),
    });
  } catch (error) {
    if (error instanceof AppError && (error.code === 'CONFLICT' || error.code === 'MANUAL_REVIEW_HOLD')) return conflictOutcome(actionId, error);
    throw error;
  }
  if (!auth.ok) return blockedOutcome(actionId, auth, opts);
  return executeAuthorizedAction(actionId, auth, identity, opts);
}

export function confirmAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome> {
  return withLiveConfirmation(actionId, () => authorizeAndExecute(actionId, opts), opts);
}

export function verifyAction(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome> {
  return withLiveConfirmation(actionId, () => authorizeAndExecute(actionId, opts, code), opts);
}

/** Cancellation records a decision without executing or narrating a tool. */
export async function cancelAction(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome> {
  const identity = await resolveTrustedIdentity(actionId, opts);
  const cancelled = await cancelledPlanOutcome(actionId, identity.sessionId);
  if (cancelled !== undefined) return cancelled;
  let action: PendingAction;
  try { action = await gateway.cancelAction(actionId, identity); }
  catch (error) {
    if (error instanceof AppError && (error.code === 'CONFLICT' || error.code === 'MANUAL_REVIEW_HOLD')) return conflictOutcome(actionId, error);
    throw error;
  }
  // Success must be PROVEN against the persisted row: a cancel that never settled must not be
  // reported as a successful cancellation and must not write a cancelled audit. The persisted
  // status is carried as a typed field, never interpolated into the public message.
  const settled = await getPendingAction(actionId);
  if (settled === null || settled.status !== 'cancelled') {
    return unappliedCancelOutcome(
      actionId,
      (settled?.status as PendingActionStatus | undefined) ?? action.status,
      action.tier,
      action.requiresMfa === true,
    );
  }
  const link = await getPendingActionPlanLink(actionId);
  await recordAudit({
    timestamp: demoNow(), sessionId: action.sessionId, userId: identity.userId, userRequest: action.userRequest ?? '',
    intent: action.intent, toolName: action.toolName, riskLevel: action.tier,
    confirmationRequired: true, confirmed: false, mfaRequired: action.requiresMfa, status: 'cancelled',
    toolArgs: action.args, taskId: link?.taskId ?? undefined, nodeId: link?.nodeId ?? undefined,
  });
  return {
    ok: true, actionId, status: 'cancelled', tier: action.tier,
    requiresMfa: action.requiresMfa === true, message: '操作已取消。', events: [],
  };
}
