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

/**
 * Statuses a `PendingAction` may be CLAIMED FROM into another status: the still-decidable open
 * statuses plus `confirmed` (already authorized, executing). `locked` is absent by construction —
 * a locked operation is a settled refusal and is NEVER a legal claim source.
 */
export const CLAIMABLE_ACTION_STATUSES: readonly PendingActionStatus[] = [
  ...OPEN_ACTION_STATUSES,
  'confirmed',
];

/**
 * Every status a `PendingAction` can hold — the complete representation set (claimable + terminal).
 * Derived from the two literals above so a status can never be representable in one place only.
 */
export const ALL_ACTION_STATUSES: readonly PendingActionStatus[] = [
  ...CLAIMABLE_ACTION_STATUSES,
  ...TERMINAL_ACTION_STATUSES,
];

/**
 * Statuses in which a stored `PendingAction` still REPRESENTS its plan node: a decision is still to be
 * taken (`CLAIMABLE_ACTION_STATUSES`) or the recorded outcome stands for the node (`executed`,
 * `needs_reconciliation` — recovered, never re-executed).
 *
 * `failed` / `locked` / `cancelled` are ABSENT by construction: a settled refusal or a dead operation
 * is not an authorization, so an explicit user retry must mint a NEW `PendingAction`, and a locked row
 * is never re-activated.
 */
export const REPRESENTED_ACTION_STATUSES: readonly PendingActionStatus[] = [
  ...CLAIMABLE_ACTION_STATUSES,
  'executed',
  'needs_reconciliation',
];

/**
 * Narrow a PERSISTED status (a database column, a stored JSON field, an IPC boundary value) to the
 * shared vocabulary. An unknown value yields `undefined` — callers must treat a status outside this
 * vocabulary as "no typed status", never as an authorization.
 */
export function asPendingActionStatus(status: string | null | undefined): PendingActionStatus | undefined {
  if (status === null || status === undefined) return undefined;
  return (ALL_ACTION_STATUSES as readonly string[]).includes(status) ? status as PendingActionStatus : undefined;
}

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

/** May a status write CLAIM the row from `status` (`OPEN_ACTION_STATUSES` + `confirmed`)? */
export function isClaimableActionStatus(status: string | null | undefined): boolean {
  return status !== null && status !== undefined
    && (CLAIMABLE_ACTION_STATUSES as readonly string[]).includes(status);
}

/**
 * Is `from` a LEGAL expected source status of a status write to `to`?
 *
 *  - every `CLAIMABLE_ACTION_STATUSES` member is legal;
 *  - an IDEMPOTENT repair — re-writing the SAME terminal status to land a missing result/audit
 *    without reactivating or downgrading the row — is legal;
 *  - `locked` is NEVER a legal source in any direction, and no source may jump OUT of a terminal
 *    status into a different one (that would resurrect a settled refusal).
 */
export function isLegalActionSourceStatus(
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (isClaimableActionStatus(from)) return true;
  if (from === null || from === undefined || from !== to) return false;
  return isTerminalActionStatus(from) && from !== 'locked';
}
