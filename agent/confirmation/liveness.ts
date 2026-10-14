import {
  claimPendingActionLease,
  clearPendingActionLease,
  getPendingAction,
} from '@/lib/db/repositories/pendingAction';
import { newId } from '@/lib/ids';
import { AppError } from '@/lib/errors';
import { leaseExpiryFor, leaseNowMs, releaseAction, retainAction } from '../confirmation-recovery';
import type { ConfirmOptions, ConfirmationOutcome } from './contracts';
import { resolveTrustedIdentity } from './identity';
import { conflictOutcome } from './outcomes';
import { isManualCardCommand } from '@/lib/contracts/card-management';

async function beginExecutionLease(actionId: string): Promise<{ owner?: string; blocked: boolean }> {
  const owner = newId('lease');
  const now = leaseNowMs();
  const claimed = await claimPendingActionLease(actionId, {
    owner, now: new Date(now), expiresAt: leaseExpiryFor(now),
  });
  if (claimed) return { owner, blocked: false };
  const row = await getPendingAction(actionId);
  return { blocked: row?.status === 'pending' || row?.status === 'awaiting_mfa' };
}

/** Own both liveness markers until the decision returns; cleanup releases only our lease. */
export async function withLiveConfirmation(
  actionId: string,
  run: () => Promise<ConfirmationOutcome>,
  opts?: ConfirmOptions,
): Promise<ConfirmationOutcome> {
  await resolveTrustedIdentity(actionId, opts);
  const action = await getPendingAction(actionId);
  if (action && isManualCardCommand(action.toolName)) throw new AppError('SECURITY_DENIED', 'Use the card management page to confirm this change.');
  retainAction(actionId);
  let leaseOwner: string | undefined;
  try {
    const lease = await beginExecutionLease(actionId);
    leaseOwner = lease.owner;
    if (lease.blocked) {
      return await conflictOutcome(actionId, new AppError('CONFLICT', 'Another continuation owns this decision.'));
    }
    return await run();
  } finally {
    try {
      if (leaseOwner !== undefined) await clearPendingActionLease(actionId, { owner: leaseOwner });
    } finally {
      releaseAction(actionId);
    }
  }
}
