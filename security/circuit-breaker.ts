/**
 * Circuit Breaker — session-scoped consecutive-failure breaker for high-risk operations.
 *
 * State lives in-process keyed by `sessionId` (NOT in the DB): 3 consecutive MFA
 * failures (`MFA_MAX_ATTEMPTS`) lock high-risk operations for the session. When the
 * breaker trips it emits a `CIRCUIT_BREAKER_TRIPPED` `SecurityEvent` (severity `high`).
 *
 * Consecutive semantics: any success (`recordSuccess`) resets the failure counter.
 * The breaker is a hard gate the LLM can never reset — only `resetSession(sessionId)` (a
 * user/admin action, which also records a `SECURITY_RESET` event) clears it. The synchronous
 * `reset` (no I/O) stays available for tests.
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

/** In-process breaker state per session (NOT persisted). */
interface BreakerEntry {
  failures: number;
  locked: boolean;
  lockedAt?: number;
}

const entries = new Map<string, BreakerEntry>();

export function getState(sessionId: string): CircuitBreakerState {
  const entry = entries.get(sessionId);
  if (!entry) {
    return { sessionId, failures: 0, max: MFA_MAX_ATTEMPTS, locked: false };
  }
  return {
    sessionId,
    failures: entry.failures,
    max: MFA_MAX_ATTEMPTS,
    locked: entry.locked,
    ...(entry.lockedAt !== undefined ? { lockedAt: entry.lockedAt } : {}),
  };
}

export function isLocked(sessionId: string): boolean {
  return entries.get(sessionId)?.locked ?? false;
}

/**
 * Record a failure. Increments the consecutive counter; when it reaches `max` the
 * session is locked and a `CIRCUIT_BREAKER_TRIPPED` SecurityEvent is emitted.
 */
export async function recordFailure(sessionId: string): Promise<CircuitBreakerState> {
  const current = entries.get(sessionId);
  // Already tripped: idempotent — stay locked, do NOT recount and do NOT re-emit.
  if (current?.locked) {
    return getState(sessionId);
  }

  const entry: BreakerEntry = current ?? { failures: 0, locked: false };
  entry.failures += 1;

  if (entry.failures >= MFA_MAX_ATTEMPTS) {
    entry.locked = true;
    entry.lockedAt = Date.now();
    entries.set(sessionId, entry);
    await recordSecurityEvent({
      sessionId,
      kind: 'CIRCUIT_BREAKER_TRIPPED',
      severity: 'high',
      message: `连续验证失败，会话已被锁定（连续 ${entry.failures} 次失败，高风险操作已暂停）。`,
      detail: { failures: entry.failures, max: MFA_MAX_ATTEMPTS },
    });
    return getState(sessionId);
  }

  entries.set(sessionId, entry);
  return getState(sessionId);
}

/** Record a success — resets the consecutive failure counter (does NOT unlock a tripped breaker). */
export function recordSuccess(sessionId: string): CircuitBreakerState {
  const entry: BreakerEntry = entries.get(sessionId) ?? { failures: 0, locked: false };
  entry.failures = 0;
  entries.set(sessionId, entry);
  return getState(sessionId);
}

/**
 * Clear (unlock) a session's breaker state AND record a `SECURITY_RESET` SecurityEvent — the async
 * entry point for the security center's unlock action. The synchronous `reset` (no I/O) stays
 * available for tests; this wrapper performs the audit write through `./audit` (never fire-and-forget).
 * The emitted event carries the session id, kind, a human-readable message and a detail payload;
 * its `timestamp` defaults to the demo clock inside `recordSecurityEvent`.
 */
export async function resetSession(sessionId: string): Promise<CircuitBreakerState> {
  const before = getState(sessionId);
  reset(sessionId);
  await recordSecurityEvent({
    sessionId,
    kind: 'SECURITY_RESET',
    severity: 'medium',
    message: before.locked
      ? '会话安全熔断已解除，高风险操作已恢复。'
      : '已清除该会话的安全限制状态。',
    detail: { wasLocked: before.locked, previousFailures: before.failures },
  });
  return getState(sessionId);
}

/** Clear all state for a session (used by admin/security-center reset and tests). */
export function reset(sessionId: string): void {
  entries.delete(sessionId);
}
