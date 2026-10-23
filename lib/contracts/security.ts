import type { ErrorCode } from '../errors';
import type { RiskLevel } from './risk';
import type { ToolName } from './tools';
import type { MoneyAmount } from '../money';

export type SecurityDecisionKind = 'allow' | 'require_confirmation' | 'require_mfa' | 'deny';

/**
 * Why a security-governed operation was refused — TYPED, never inferred from message text.
 * `manual_review_hold` is NOT a security denial: the operation is intact and unexecuted; it is only
 * held while its owning workflow has an open manual review.
 */
export type SecurityFailureReason =
  | 'mfa_code_invalid'
  | 'mfa_attempts_exhausted'
  | 'mfa_session_locked'
  | 'circuit_open'
  | 'manual_review_hold'
  | 'denied';

/**
 * The structured failure every refusal carries: the public-facing error code, the machine-readable
 * reason and the facts a caller needs to render the refusal (which action, how many attempts are
 * left). It never carries the raw gateway payload.
 */
export interface SecurityFailure {
  code: ErrorCode;
  reason: SecurityFailureReason;
  actionId?: string;
  attemptsUsed?: number;
  attemptsLeft?: number;
  maxAttempts?: number;
}

export interface SecurityEvaluation {
  toolName: ToolName;
  tier: RiskLevel;
  requiresConfirmation: boolean;
  requiresMfa: boolean;
  reasons: string[];
  amount?: MoneyAmount;
  dailyTotal?: MoneyAmount;
  blocked: boolean;
  blockReason?: string;
}

export type PendingActionStatus =
  | 'pending'
  | 'awaiting_mfa'
  | 'confirmed'
  | 'executed'
  | 'failed'
  | 'cancelled'
  | 'locked'
  /**
   * TERMINAL, and the ONLY status that requires a HUMAN to settle it out-of-band: a gated side
   * effect that may HAVE committed but whose outcome could not be recorded, and which cannot be
   * safely recovered/replayed (a non-idempotent standalone write, or a committed side effect with
   * no durable result). It is deliberately NOT `failed` (the outcome is UNKNOWN, not a failure) and
   * NOT `confirmed` (that would dangle forever / imply a live decision). It is queryable and shown
   * to the user as a manual-reconciliation entry.
   */
  | 'needs_reconciliation';

/**
 * Statuses in which a `PendingAction` is an OPEN, still-decidable operation — the only statuses a
 * confirmation/verification prompt may be published for, and the only legal sources of a human
 * decision. `locked` is deliberately absent: a locked operation is a SETTLED refusal.
 *
 * Mirrors `OPEN_ACTION_STATUSES` in `agent/action-status.ts`. `lib/` must not depend on `agent/`,
 * so both layers own the same vocabulary and the two lists must stay identical; the agent layer
 * derives its predicates from `PendingActionStatus` declared above.
 */
export const OPEN_PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = ['pending', 'awaiting_mfa'];

/**
 * TERMINAL statuses: the operation is settled — executed, failed, cancelled, locked or awaiting
 * manual reconciliation. A terminal row is never re-activated, never re-prompted and never a legal
 * CAS source.
 *
 * Mirrors `TERMINAL_ACTION_STATUSES` in `agent/action-status.ts` (keep the two lists identical).
 * `locked` is TERMINAL and NEVER revived: it is the CAS target when the MFA attempt limit is
 * exhausted or the circuit opens, it stops surfacing as a pending decision and it is never
 * re-prompted for a verification code.
 */
export const TERMINAL_PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = [
  'executed',
  'failed',
  'cancelled',
  'locked',
  'needs_reconciliation',
];

/**
 * TERMINAL statuses that SETTLE the `ToolInvocation` they are linked to — every terminal status
 * does today, so this list coincides with `TERMINAL_PENDING_ACTION_STATUSES`; it is kept as its own
 * name because "the run repository may read this decision as final" is a distinct contract from
 * "the operation is over". `locked` belongs here: its invocation ends `failed` (`MFA_LOCKED`),
 * not `needs_reconciliation`, because a locked refusal is a KNOWN outcome.
 */
export const SETTLED_PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = TERMINAL_PENDING_ACTION_STATUSES;

/**
 * Statuses that still keep an agent run from finalizing: an open decision (`OPEN`), an authorized
 * command that is executing (`confirmed`), or an outcome only a human can settle
 * (`needs_reconciliation`). `locked` is ABSENT by construction — a locked refusal is itself a
 * settled fact, so the run it belonged to finalizes (`failed`) instead of hanging forever.
 */
export const RUN_BLOCKING_PENDING_ACTION_STATUSES: readonly PendingActionStatus[] = [
  ...OPEN_PENDING_ACTION_STATUSES,
  'confirmed',
  'needs_reconciliation',
];

export interface PendingActionSummary {
  actionId?: string;
  title: string;
  toolName: ToolName;
  tier: RiskLevel;
  fields: Array<{ label: string; value: string }>;
  amount?: MoneyAmount;
  requiresMfa: boolean;
  mfaHint?: string;
}

export interface PendingAction {
  id: string;
  sessionId: string;
  toolName: ToolName;
  args: Record<string, unknown>;
  tier: RiskLevel;
  requiresMfa: boolean;
  status: PendingActionStatus;
  summary: PendingActionSummary;
  /** The user's original natural-language request, carried through for audit. */
  userRequest?: string;
  /** Derived intent label, carried through for audit. */
  intent?: string;
  createdAt: number;
  updatedAt: number;
}

export interface SecurityDecision {
  kind: SecurityDecisionKind;
  tier: RiskLevel;
  evaluation: SecurityEvaluation;
  pendingActionId?: string;
  message: string;
}
