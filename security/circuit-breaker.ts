/**
 * Circuit Breaker — session-scoped consecutive-failure breaker for high-risk operations.
 *
 * State lives in-process keyed by `sessionId` (NOT in the DB): 3 consecutive MFA
 * failures (`MFA_MAX_ATTEMPTS`) lock high-risk operations for the session. When the
 * breaker trips it emits a `CIRCUIT_BREAKER_TRIPPED` `SecurityEvent` (severity `high`).
 *
 * Consecutive semantics: any success (`recordSuccess`) resets the failure counter.
 * The breaker is a hard gate the LLM can never reset — only `reset(sessionId)` (a
 * user/admin action) clears it.
 *
 * NOTE: `recordFailure` is async because emitting the SecurityEvent writes through
 * `./audit` (never fire-and-forget — errors must not be swallowed).
 */
import { MFA_MAX_ATTEMPTS } from '../lib/constants';
import { recordSecurityEvent } from '../audit';

export interface CircuitBreakerState {
  sessionId: string;
  /** Consecutive failures since the last success/reset. */
  failures: number;
  /** Trip threshold (`MFA_MAX_ATTEMPTS`). */
  max: number;
  locked: boolean;
  /** Epoch ms when the breaker tripped, if locked. */
  lockedAt?: number;
}

export function getState(sessionId: string): CircuitBreakerState {
  throw new Error('not implemented');
}

export function isLocked(sessionId: string): boolean {
  throw new Error('not implemented');
}

/**
 * Record a failure. Increments the consecutive counter; when it reaches `max` the
 * session is locked and a `CIRCUIT_BREAKER_TRIPPED` SecurityEvent is emitted.
 */
export async function recordFailure(sessionId: string): Promise<CircuitBreakerState> {
  throw new Error('not implemented');
}

/** Record a success — resets the consecutive failure counter (does NOT unlock a tripped breaker). */
export function recordSuccess(sessionId: string): CircuitBreakerState {
  throw new Error('not implemented');
}

/** Clear all state for a session (used by admin/security-center reset and tests). */
export function reset(sessionId: string): void {
  throw new Error('not implemented');
}
