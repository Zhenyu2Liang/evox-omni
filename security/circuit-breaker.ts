/**
 * Circuit Breaker — session-scoped consecutive-failure breaker for high-risk operations.
 *
 * State lives in-process keyed by `sessionId` (NOT in the DB): 3 consecutive MFA
 * failures (`MFA_MAX_ATTEMPTS`) lock the session. When the breaker trips it emits a
 * `CIRCUIT_BREAKER_TRIPPED` `SecurityEvent` (severity `high`).
 *
 * Consecutive semantics: any success (`recordSuccess`) resets the consecutive-failure counter.
 *
 * ── HARD GATE: A TRIPPED BREAKER DENIES *ALL* TIERS — INCLUDING 🟢 GREEN READS ───────────
 * The gateway computes `blocked = locked || tier !== 'GREEN'` (see `security-gateway.ts` →
 * `gatewayEvaluate`). Once the breaker is tripped the session is frozen for EVERY tool call,
 * including low-risk GREEN reads such as `get_balance`. This is intended: a session that just
 * produced three consecutive failed strong-verifications is treated as compromised, so the
 * safest response is to stop acting entirely (fail-closed) until a human deliberately unlocks
 * it. It is deliberately broader than "only high-risk ops locked" because a compromised
 * session must not even be able to probe balances.
 *
 * ── UNLOCK CONDITIONS (explicit — the model/LLM can NEVER unlock) ────────────────────────
 * A locked session may be cleared ONLY by the deliberate, audited security-center action
 * `resetSession(sessionId, { actor, reason })`, which records a complete `SECURITY_RESET`
 * `SecurityEvent`. Concretely:
 *   - The model/LLM can NEVER unlock the breaker: no tool, no tool argument and no model text
 *     can clear it (no tool exposed to the model touches this state).
 *   - `recordSuccess` does NOT unlock a tripped breaker. A correct MFA code on a NON-locked
 *     path only resets the consecutive-failure counter; `locked` stays true.
 *   - A correct MFA code submitted WHILE locked is rejected and does NOT unlock: `mfa.verify`
 *     checks the lock FIRST ("locked wins") and fails regardless of the submitted code.
 *   - Unlock clears ALL breaker state for the session — `failures` back to 0, `locked` false,
 *     `lockedAt` cleared — so a subsequent trip counts from scratch.
 *   - Unlock does NOT re-authorize a previously blocked action: the blocked `PendingAction`
 *     must be re-created (and re-confirmed/re-verified) after unlocking.
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

/** Options for the audited {@link resetSession} unlock action. */
export interface ResetSessionOptions {
  /** Who initiated the unlock (audit attribution). Defaults to `'user'`. */
  actor?: string;
  /** Why the unlock happened (audit attribution). Defaults to a generic Chinese reason. */
  reason?: string;
}

/** Default audit actor when `resetSession` is called without one. */
const DEFAULT_RESET_ACTOR = 'user';

/** Default audit reason when `resetSession` is called without one. */
const DEFAULT_RESET_REASON = '用户通过安全中心主动解除会话安全限制。';

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
 *
 * The trip is idempotent: while locked, further failures neither recount nor re-emit —
 * a session emits `CIRCUIT_BREAKER_TRIPPED` EXACTLY ONCE per trip. The event detail is a
 * complete audit record: `failures`, `max` and the explicit `result` marker.
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
      message: `连续验证失败，会话已被锁定（连续 ${entry.failures} 次失败，所有操作已暂停，含查询类）。`,
      detail: { failures: entry.failures, max: MFA_MAX_ATTEMPTS, result: 'session_locked' },
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
 * Clear (unlock) a session's breaker state AND record a COMPLETE `SECURITY_RESET` SecurityEvent —
 * the async, AUDITED entry point for the security center's unlock action.
 *
 * UNLOCK CONDITIONS (see the file header): this is the ONLY way to clear a tripped breaker.
 * The model/LLM can NEVER unlock it; `recordSuccess` and a correct MFA code do NOT unlock it.
 * Unlock clears ALL breaker state (failures → 0, locked → false, lockedAt cleared) so the
 * failure counter restarts from scratch; it does NOT re-authorize a previously blocked action
 * (that `PendingAction` must be re-created and re-confirmed/re-verified).
 *
 * The synchronous `reset` (no I/O, test-only) performs only the state clear; this wrapper adds
 * the `./audit` write (never fire-and-forget). The emitted event detail is a COMPLETE audit
 * record: `actor`, `reason`, `wasLocked`, `previousFailures` and, when it was set, `priorLockedAt`.
 * Remains 100% backward-compatible: `resetSession(sessionId)` still works (defaults apply).
 */
export async function resetSession(
  sessionId: string,
  opts?: ResetSessionOptions,
): Promise<CircuitBreakerState> {
  const before = getState(sessionId);
  const actor = opts?.actor?.trim() ? opts.actor.trim() : DEFAULT_RESET_ACTOR;
  const reason = opts?.reason?.trim() ? opts.reason.trim() : DEFAULT_RESET_REASON;

  reset(sessionId);

  await recordSecurityEvent({
    sessionId,
    kind: 'SECURITY_RESET',
    severity: 'medium',
    message: before.locked
      ? `会话安全熔断已由「${actor}」解除，所有操作已恢复。原因：${reason}`
      : `已清除该会话的安全限制状态。原因：${reason}`,
    detail: {
      actor,
      reason,
      wasLocked: before.locked,
      previousFailures: before.failures,
      ...(before.lockedAt !== undefined ? { priorLockedAt: before.lockedAt } : {}),
    },
  });

  return getState(sessionId);
}

/** Clear all state for a session (used by admin/security-center reset and tests). */
export function reset(sessionId: string): void {
  entries.delete(sessionId);
}
