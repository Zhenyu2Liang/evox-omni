/**
 * Circuit Breaker — OWNER-scoped consecutive-failure breaker for high-risk operations.
 *
 * State is DURABLE: it lives in the DB (`CircuitBreakerState`) keyed by the OWNER, NOT in process
 * memory and NOT keyed by the raw session id. The owner key is derived from the actor:
 *   `getSession(actor)` → `user:<userId>`; else `getUser(actor)` → `user:<id>`; else `session:<actor>`.
 * Because a real user's key is shared by ALL of that user's sessions, a NEW SESSION (and a NEW
 * PROCESS — state is read from the DB) can NEVER bypass a lock. 3 consecutive MFA failures
 * (`MFA_MAX_ATTEMPTS`) lock the owner; the trip emits a `CIRCUIT_BREAKER_TRIPPED` `SecurityEvent`
 * (severity `high`, carrying `userId`).
 *
 * Consecutive semantics: any success (`recordSuccess`) resets the consecutive-failure counter.
 *
 * ── HARD GATE: A TRIPPED BREAKER DENIES *ALL* TIERS — INCLUDING 🟢 GREEN READS ───────────
 * The gateway computes `blocked = locked || tier !== 'GREEN'` (see `security-gateway.ts` →
 * `gatewayEvaluate`). Once the breaker is tripped the owner is frozen for EVERY tool call,
 * including low-risk GREEN reads such as `get_balance`. This is intended: an owner that just
 * produced three consecutive failed strong-verifications is treated as compromised, so the
 * safest response is to stop acting entirely (fail-closed) until a human deliberately unlocks
 * it. It is deliberately broader than "only high-risk ops locked" because a compromised
 * session must not even be able to probe balances.
 *
 * ── UNLOCK CONDITIONS (explicit — the model/LLM can NEVER unlock) ────────────────────────
 * A locked owner may be cleared ONLY by the deliberate, audited `resetSession(actor, opts)` action,
 * which records a complete `SECURITY_RESET` `SecurityEvent`. Concretely:
 *   - The model/LLM can NEVER unlock the breaker: no tool, no tool argument and no model text can
 *     clear it (no tool exposed to the model touches this state).
 *   - Unlocking a TRIPPED breaker requires EXTRA verification: the mock `MFA_CODE` OR an elapsed
 *     cooldown (`now >= lockedAt + RESET_COOLDOWN_MS`). A bare session cookie is REFUSED.
 *   - `recordSuccess` does NOT unlock a tripped breaker. A correct MFA code on a NON-locked path
 *     only resets the consecutive-failure counter; `locked` stays true.
 *   - A correct MFA code submitted WHILE locked is rejected and does NOT unlock: `mfa.verify`
 *     checks the lock FIRST ("locked wins") and fails regardless of the submitted code.
 *   - Unlock clears ALL breaker state for the owner — `failures` back to 0, `locked` false,
 *     `lockedAt` cleared — so a subsequent trip counts from scratch.
 *   - Unlock does NOT itself re-authorize an action. Undecided actions need confirm/MFA; a
 *     result-less confirmed transfer must pass recovery authorization again. Terminal/manual
 *     outcomes are not made executable by unlocking.
 *
 * NOTE: every mutation is async because persistence is REQUIRED (a process restart must see the
 * same lock) and because emitting a SecurityEvent writes through `./audit` (never fire-and-forget).
 */
import { AppError } from '../lib/errors';
import { MFA_CODE, MFA_MAX_ATTEMPTS, RESET_COOLDOWN_MS } from '../lib/constants';
import { demoNow } from '../lib/clock';
import {
  getBreakerState,
  upsertFailure,
  recordSuccessState,
  resetBreakerState,
  type BreakerSnapshot,
} from '../lib/db/repositories/circuitBreaker';
import { getSession } from '../lib/db/repositories/session';
import { getUser } from '../lib/db/repositories/user';
import { recordSecurityEvent } from '../audit';

export interface CircuitBreakerState {
  /** The acting session/user id the caller passed in (NOT the internal owner key). */
  sessionId: string;
  /** Consecutive failures since the last success/reset. */
  failures: number;
  /** Trip threshold (`MFA_MAX_ATTEMPTS`). */
  max: number;
  locked: boolean;
  /** Epoch ms when the breaker tripped, if locked. */
  lockedAt?: number;
}

/** The owner identity a breaker entry is keyed by. */
export interface BreakerOwner {
  /** `user:<userId>` when the actor resolves to a user, else `session:<actor>`. */
  key: string;
  /** The resolved user id, when known (persisted for per-user audit). */
  userId?: string;
}

/** Options for the audited {@link resetSession} unlock action. */
export interface ResetSessionOptions {
  /** Who initiated the unlock (audit attribution). Defaults to `'user'`. */
  actor?: string;
  /** Why the unlock happened (audit attribution). Defaults to a generic Chinese reason. */
  reason?: string;
  /** Mock strong-verification code — accepted unlock when it equals `MFA_CODE`. */
  verificationCode?: string;
  /** Explicit clock (epoch ms or `Date`) for the cooldown gate. Defaults to the demo clock. */
  now?: number | Date;
}

/** Default audit actor when `resetSession` is called without one. */
const DEFAULT_RESET_ACTOR = 'user';

/** Default audit reason when `resetSession` is called without one. */
const DEFAULT_RESET_REASON = '用户通过安全中心主动解除所属账户的安全限制。';

/**
 * Resolve the OWNER a breaker mutation applies to. Prefers the persisted session's user so the lock
 * is shared across a user's sessions and survives a process restart; falls back to the user id,
 * then to a synthesized session key for unpersisted actors (e.g. test ids).
 */
export async function resolveBreakerOwner(actor: string): Promise<BreakerOwner> {
  const session = await getSession(actor);
  if (session?.userId) return { key: `user:${session.userId}`, userId: session.userId };
  const user = await getUser(actor);
  if (user?.id) return { key: `user:${user.id}`, userId: user.id };
  return { key: `session:${actor}` };
}

/** Map a raw snapshot to the public state view (null → fresh/unlocked). */
function toState(actor: string, snapshot: BreakerSnapshot | null): CircuitBreakerState {
  return {
    sessionId: actor,
    failures: snapshot?.failures ?? 0,
    max: MFA_MAX_ATTEMPTS,
    locked: snapshot?.locked ?? false,
    ...(snapshot?.lockedAt ? { lockedAt: snapshot.lockedAt.getTime() } : {}),
  };
}

/** Read the persisted breaker state for the actor's owner. */
export async function getState(actor: string): Promise<CircuitBreakerState> {
  const { key } = await resolveBreakerOwner(actor);
  const row = await getBreakerState(key);
  return toState(actor, row);
}

/** Whether the actor's owner is currently locked (fail-closed gate read). */
export async function isLocked(actor: string): Promise<boolean> {
  const { key } = await resolveBreakerOwner(actor);
  const row = await getBreakerState(key);
  return row?.locked ?? false;
}

/**
 * Record a failure. Increments the consecutive counter; when it reaches `max` the owner is locked
 * and a `CIRCUIT_BREAKER_TRIPPED` SecurityEvent (with `userId`) is emitted.
 *
 * The trip is idempotent: while locked, further failures neither recount nor re-emit — an owner
 * emits `CIRCUIT_BREAKER_TRIPPED` EXACTLY ONCE per trip. The event detail is a complete audit
 * record: `failures`, `max` and the explicit `result` marker.
 */
export async function recordFailure(actor: string): Promise<CircuitBreakerState> {
  const { key, userId } = await resolveBreakerOwner(actor);
  const snapshot = await upsertFailure({
    key,
    userId,
    max: MFA_MAX_ATTEMPTS,
    now: new Date(demoNow()),
  });

  if (snapshot.didLock) {
    await recordSecurityEvent({
      sessionId: actor,
      ...(userId !== undefined ? { userId } : {}),
      kind: 'CIRCUIT_BREAKER_TRIPPED',
      severity: 'high',
      message: `连续验证失败，账户已被锁定（连续 ${snapshot.failures} 次失败，所有操作已暂停，含查询类）。`,
      detail: { failures: snapshot.failures, max: MFA_MAX_ATTEMPTS, result: 'session_locked' },
    });
  }

  return toState(actor, snapshot);
}

/** Record a success — resets the consecutive failure counter (does NOT unlock a tripped breaker). */
export async function recordSuccess(actor: string): Promise<CircuitBreakerState> {
  const { key } = await resolveBreakerOwner(actor);
  const snapshot = await recordSuccessState(key);
  return toState(actor, snapshot);
}

/**
 * Clear (unlock) an owner's breaker state AND record a COMPLETE `SECURITY_RESET` SecurityEvent —
 * the async, AUDITED entry point for the security center's unlock action.
 *
 * UNLOCK GATE (see the file header): when the owner is LOCKED, clearing it requires EXTRA
 * verification — a correct `verificationCode` (`MFA_CODE`) OR an elapsed cooldown
 * (`now >= lockedAt + RESET_COOLDOWN_MS`). Otherwise this throws `AppError('CIRCUIT_OPEN')` and the
 * lock is LEFT INTACT: a bare session cookie can never unlock. When the owner is NOT locked there is
 * nothing to unlock, so the benign counter clear proceeds without a code.
 *
 * Unlock clears ALL breaker state (failures → 0, locked → false, lockedAt cleared) so the failure
 * counter restarts from scratch; it does NOT itself grant execution.
 *
 * The emitted event detail is a COMPLETE audit record: `actor`, `reason`, `wasLocked`,
 * `previousFailures` and, when it was set, `priorLockedAt`.
 */
export async function resetSession(
  actor: string,
  opts?: ResetSessionOptions,
): Promise<CircuitBreakerState> {
  const { key, userId } = await resolveBreakerOwner(actor);
  const before = await getBreakerState(key);

  if (before?.locked) {
    const now = opts?.now === undefined ? demoNow() : opts.now instanceof Date ? opts.now.getTime() : opts.now;
    const lockedAt = before.lockedAt?.getTime();
    const codeAccepted = opts?.verificationCode !== undefined && opts.verificationCode === MFA_CODE;
    const cooldownElapsed = lockedAt !== undefined && now >= lockedAt + RESET_COOLDOWN_MS;
    if (!codeAccepted && !cooldownElapsed) {
      throw new AppError(
        'CIRCUIT_OPEN',
        '解除熔断需要额外的安全验证：请输入 6 位验证码，或等待冷却期结束。',
      );
    }
  }

  const actorName = opts?.actor?.trim() ? opts.actor.trim() : DEFAULT_RESET_ACTOR;
  const reason = opts?.reason?.trim() ? opts.reason.trim() : DEFAULT_RESET_REASON;

  await resetBreakerState(key);

  await recordSecurityEvent({
    sessionId: actor,
    ...(userId !== undefined ? { userId } : {}),
    kind: 'SECURITY_RESET',
    severity: 'medium',
    message: before?.locked
      ? `账户安全熔断已由「${actorName}」解除，所有操作已恢复。原因：${reason}`
      : `已清除该账户的安全限制状态。原因：${reason}`,
    detail: {
      actor: actorName,
      reason,
      wasLocked: before?.locked ?? false,
      previousFailures: before?.failures ?? 0,
      ...(before?.lockedAt ? { priorLockedAt: before.lockedAt.getTime() } : {}),
    },
  });

  return getState(actor);
}

/**
 * Clear all state for an actor (used by admin/security-center reset and tests). Deliberately
 * ungated and unaudited: this is the low-level clear, reachable from NO route and NO tool. The
 * gated, audited unlock is {@link resetSession}.
 */
export async function reset(actor: string): Promise<void> {
  const { key } = await resolveBreakerOwner(actor);
  await resetBreakerState(key);
}
