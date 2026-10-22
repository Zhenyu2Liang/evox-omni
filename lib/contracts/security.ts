import type { ErrorCode } from '../errors';
import type { RiskLevel } from './risk';
import type { ToolName } from './tools';
import type { MoneyAmount } from '../money';

export type SecurityDecisionKind = 'allow' | 'require_confirmation' | 'require_mfa' | 'deny';

/** Why a security-governed operation was refused — TYPED, never inferred from message text. */
export type SecurityFailureReason =
  | 'mfa_code_invalid'
  | 'mfa_attempts_exhausted'
  | 'mfa_session_locked'
  | 'circuit_open'
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
