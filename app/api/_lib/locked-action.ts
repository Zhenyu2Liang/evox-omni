/**
 * app/api/_lib/locked-action.ts — the app-layer TERMINAL-LOCK guard for the action decision routes.
 *
 * Contract:
 *  - MFA three-strike exhaustion (or an already-open session circuit breaker) makes the security
 *    gateway CAS a `PendingAction` into the TERMINAL `'locked'` status. A locked row is never
 *    executable, verifiable, cancellable or recoverable again, and it must never be written back to
 *    `pending` / `awaiting_mfa`.
 *  - This module WRITES NOTHING and imports no Prisma CLIENT: it only recognizes the terminal status
 *    on a row the route already read for its ownership guard, and builds the ONE structured refusal
 *    the decision routes serialize.
 *  - The refusal is a normal `200` DOMAIN outcome (`data.ok === false`), exactly like a wrong MFA
 *    code — not an HTTP error envelope. `code` / `failure` are the TYPED lock signals
 *    (`CIRCUIT_OPEN` / `mfa_session_locked`), so a client never has to parse the message.
 *  - The message is a FIXED, safe Chinese sentence: it never interpolates the raw internal status
 *    token, never contains a verification code, and — because the app layer must not import
 *    `security/` internals nor hardcode the attempt limit — carries no fabricated
 *    `attemptsLeft` / `maxAttempts` numbers.
 *
 * `_lib` is a Next.js private folder (leading underscore), so this module never becomes a route.
 * Nothing outside `app/api/**` should import it.
 */
import type { PendingAction as PendingActionRow } from '@/lib/db/prisma';
import type { SecurityFailure } from '@/lib/contracts/security';

/** The ONE terminal status this guard recognizes (see `PendingActionStatus`). */
const LOCKED_STATUS = 'locked';

/** Safe, code-free text for a refused decision on a security-locked (terminal) action. */
const LOCKED_ACTION_MESSAGE = '该操作已被安全锁定，无法继续执行；解锁后需要重新发起并重新确认。';

/** The structured refusal a decision route returns for a locked row. */
export interface LockedActionRefusal {
  code: 'CIRCUIT_OPEN';
  failure: SecurityFailure;
  message: string;
}

/**
 * True iff the persisted row is in the TERMINAL `'locked'` state.
 *
 * PURE READ: takes only the status column and grants/clears nothing. Callers use it after their
 * existence + ownership guards and BEFORE any delegation, so a locked row is never handed to a
 * domain mutation, recovery or replay path.
 */
export function isLockedPendingActionRow(row: Pick<PendingActionRow, 'status'>): boolean {
  return row.status === LOCKED_STATUS;
}

/**
 * Build the structured refusal for the TERMINAL locked row `row` of action `actionId`.
 *
 * `row` is asserted (not merely accepted) so this refusal cannot be fabricated for a row that is not
 * locked: the two decision routes stay thin, and the invariant is enforced in ONE place. A misuse is
 * a programming error and surfaces as such rather than producing a misleading "locked" response.
 */
export function lockedActionRefusal(
  actionId: string,
  row: Pick<PendingActionRow, 'status'>,
): LockedActionRefusal {
  if (!isLockedPendingActionRow(row)) {
    throw new Error('lockedActionRefusal called for a pending action that is not locked');
  }
  return {
    code: 'CIRCUIT_OPEN',
    failure: { code: 'CIRCUIT_OPEN', reason: 'mfa_session_locked', actionId },
    message: LOCKED_ACTION_MESSAGE,
  };
}
