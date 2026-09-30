/**
 * MFA — mock strong verification for RED operations.
 *
 * The accepted code is the fixed demo `MFA_CODE` ('123456'). It is stored against the
 * pending action and is **NEVER returned** by any function of this module (not to the
 * UI, not to the model, not in `MfaChallengeView`). The demo value is disclosed only in
 * `README.md`, so verification still requires an out-of-band knowledge step.
 *
 * Failures feed the session circuit breaker (`./circuit-breaker`) and emit a
 * `MFA_FAILURE` SecurityEvent.
 */
import type { Result } from '../lib/errors';
import { MFA_MAX_ATTEMPTS } from '../lib/constants';

/** Safe, code-free view of a challenge handed to the caller/UI. */
export interface MfaChallengeView {
  actionId: string;
  /** Failed attempts so far. */
  attempts: number;
  /** `MFA_MAX_ATTEMPTS`. */
  maxAttempts: number;
  verified: boolean;
  createdAt: number;
  /** Generic delivery message — MUST NOT contain the code. */
  hint: string;
}

export interface MfaVerifyResult {
  ok: boolean;
  /** Remaining attempts before the circuit breaker trips. */
  attemptsLeft: number;
  /** Circuit-breaker state for the owning session after this attempt. */
  locked: boolean;
}

/**
 * Issue (or re-issue) a challenge for `actionId`. Stores `MFA_CODE` server-side and
 * returns a code-free `MfaChallengeView`.
 * Errors (e.g. unknown action) surface as a thrown `AppError`.
 */
export async function issueChallenge(actionId: string): Promise<MfaChallengeView> {
  throw new Error('not implemented');
}

/**
 * Verify a submitted code against the stored challenge.
 *  - correct code → mark verified, `recordSuccess` the breaker → `ok({ ok: true, ... })`.
 *  - wrong code   → increment attempts, `recordFailure` the breaker, emit `MFA_FAILURE`
 *                   → `ok({ ok: false, attemptsLeft, locked })`.
 *  - no challenge → `err(AppError('NOT_FOUND' | 'CONFLICT'))`.
 * Never swallows errors.
 */
export async function verify(actionId: string, code: string): Promise<Result<MfaVerifyResult>> {
  throw new Error('not implemented');
}

/** Read the code-free challenge view for `actionId`, or `null` if none exists. */
export async function getChallenge(actionId: string): Promise<MfaChallengeView | null> {
  throw new Error('not implemented');
}
