/**
 * `action-status.ts` — the single status vocabulary of a `PendingAction` used by the agent runtime.
 *
 * `locked` is TERMINAL. A locked operation (exhausted MFA attempts / open circuit) is a settled
 * refusal: it is never an open decision, never re-presented as a pending entry, never re-prompted
 * for a verification code, never resumed or retried, and never a legal source status of a status
 * transition. Every agent path that asks "is this still decidable?" or "may I transition from
 * here?" must use the predicates below instead of comparing status literals locally.
 */
import type { PendingActionStatus } from '@/lib/contracts/security';

/**
 * Statuses in which a `PendingAction` is an OPEN, still-decidable operation — the ONLY statuses a
 * decision prompt (confirmation / MFA) may be published for, and the only legal CAS sources for a
 * human decision.
 */
export const OPEN_ACTION_STATUSES: readonly PendingActionStatus[] = ['pending', 'awaiting_mfa'];

/**
 * Statuses that are TERMINAL: the operation is settled (succeeded, failed, cancelled, locked or
 * pending manual reconciliation). A terminal row is never re-activated and never a CAS source.
 */
export const TERMINAL_ACTION_STATUSES: readonly PendingActionStatus[] = [
  'executed',
  'failed',
  'cancelled',
  'locked',
  'needs_reconciliation',
];

/** Is the persisted status an OPEN, still-decidable operation status (`pending` / `awaiting_mfa`)? */
export function isOpenActionStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined
    && (OPEN_ACTION_STATUSES as readonly string[]).includes(status);
}

/** Is the persisted status TERMINAL (settled, including `locked`)? */
export function isTerminalActionStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined
    && (TERMINAL_ACTION_STATUSES as readonly string[]).includes(status);
}

/**
 * May a decision prompt (`confirmation_required` / `mfa_required`) be published for a row whose
 * persisted status is `status`? ONLY while the operation is still open: a `locked`, `executed`,
 * `failed`, `cancelled` or `needs_reconciliation` row must be skipped, never re-prompted.
 */
export function mayPromptForDecision(status: string | null | undefined): boolean {
  return isOpenActionStatus(status);
}
