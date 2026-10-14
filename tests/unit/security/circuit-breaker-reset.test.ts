/**
 * Unit: security/circuit-breaker — the GATED `resetSession()` unlock path + `SECURITY_RESET` event.
 *
 * Targets `@/security/circuit-breaker`: the async, audited `resetSession(actor, opts)` (the
 * security-center unlock entry point) must (a) clear the PERSISTED breaker state exactly like the
 * ungated `reset(actor)`, and (b) record a `SECURITY_RESET` `SecurityEvent` through the SAME
 * `./audit` recorder used for `CIRCUIT_BREAKER_TRIPPED` / `MFA_FAILURE`.
 *
 * UNLOCK GATE: unlocking a LOCKED owner requires EXTRA verification — the mock `MFA_CODE` OR an
 * elapsed cooldown (`now >= lockedAt + RESET_COOLDOWN_MS`) — otherwise `resetSession` throws
 * `AppError('CIRCUIT_OPEN')` and leaves the lock INTACT. A NON-locked owner clears benignly (no code)
 * and still records the event. This file pins BOTH sides of that gate.
 *
 * ── REAL-CLOCK COOLDOWN ──────────────────────────────────────────────────────────────────────
 * `recordFailure` stamps `lockedAt` with `realNow()` (the server wall clock) and the gate's DEFAULT
 * `now` is `realNow()` too — never the pinned `demoNow()` (a demo-clock lock could never elapse in
 * real time). So the cooldown boundary MUST be derived from the PERSISTED `lockedAt`, and this file
 * pins the elapsed/not-elapsed boundary through BOTH the injected `now` seam AND the DEFAULT server
 * clock (a directly-seeded back-dated lock for the elapsed side — waiting 60 s is impractical).
 *
 * ── ATOMIC UNLOCK + AUDIT ────────────────────────────────────────────────────────────────────
 * The state clear and its STRICT `SECURITY_RESET` event commit in ONE `prisma.$transaction`: a strict
 * audit failure ROLLS BACK and THROWS (the lock stays UNCHANGED), a lost CAS (concurrent unlock / a
 * newer RE-LOCK) is a benign no-op (no write, no duplicate event), and a concurrent unlock records
 * exactly ONE event.
 *
 * Breaker state is keyed by the breaker OWNER. The actor ids below (`newId('cbreset')`) have no
 * `AgentSession`/`User` row, so each is a distinct `session:<actor>` owner; `useFreshDatabase()`
 * clears `circuitBreakerState` between tests as well.
 */
import { describe, expect, it, vi } from 'vitest';
import { getState, isLocked, recordFailure, resetSession } from '@/security/circuit-breaker';
import { security } from '@/security';
import { securityEventStore } from '@/audit/security-events';
import { resetBreakerState } from '@/lib/db/repositories/circuitBreaker';
import { MFA_CODE, MFA_MAX_ATTEMPTS, RESET_COOLDOWN_MS } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';

useFreshDatabase();

/** A unique breaker owner per test (no `AgentSession` row → `session:<id>` key). */
const newSessionId = (): string => newId('cbreset');

/** The persisted breaker OWNER key for a test actor (no session/user row → `session:<actor>`). */
const keyFor = (sessionId: string): string => `session:${sessionId}`;

/** The `SECURITY_RESET` security-event rows persisted for a session. */
function resetEvents(sessionId: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind: 'SECURITY_RESET' },
  });
}

/** The RAW persisted breaker row for a test actor (`null` when none). */
function rawRow(sessionId: string) {
  return getTestPrisma().circuitBreakerState.findUnique({ where: { key: keyFor(sessionId) } });
}

/** Trip a fresh session's breaker by recording `MFA_MAX_ATTEMPTS` consecutive failures. */
async function tripBreaker(sessionId: string): Promise<void> {
  for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
    await recordFailure(sessionId);
  }
}

/**
 * Write a LOCKED breaker row DIRECTLY for a test actor. Used to seed a BACK-DATED `lockedAt` so the
 * real-clock cooldown can be exercised DETERMINISTICALLY (waiting a real 60 s is impractical).
 */
async function seedLockedState(sessionId: string, lockedAt: Date, failures = MFA_MAX_ATTEMPTS): Promise<void> {
  const key = keyFor(sessionId);
  await getTestPrisma().circuitBreakerState.upsert({
    where: { key },
    create: { key, failures, locked: true, lockedAt },
    update: { failures, locked: true, lockedAt },
  });
}

/** Parse the persisted JSON `detail` text of a security-event row. */
function detailOf(row: { detail: string | null }): Record<string, unknown> {
  return JSON.parse(row.detail ?? '{}') as Record<string, unknown>;
}

describe('circuit-breaker - resetSession (unlock + SECURITY_RESET event)', () => {
  it('is exposed on the security facade as security.circuitBreaker.resetSession', () => {
    expect(typeof security.circuitBreaker.resetSession).toBe('function');
  });

  it('unlocks a tripped session with the verification code and returns the cleared state (failures 0, locked false)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    expect(await isLocked(sessionId)).toBe(true);
    expect(await resetEvents(sessionId)).toHaveLength(0);

    const state = await resetSession(sessionId, { verificationCode: MFA_CODE });

    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(state.lockedAt).toBeUndefined();
    expect(await isLocked(sessionId)).toBe(false);
    expect((await getState(sessionId)).locked).toBe(false);
  });

  it('records exactly one SECURITY_RESET SecurityEvent with the sessionId + a human-readable message', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    await resetSession(sessionId, { verificationCode: MFA_CODE });

    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.sessionId).toBe(sessionId);
    expect(event.kind).toBe('SECURITY_RESET');
    expect(typeof event.severity).toBe('string');
    expect(typeof event.message).toBe('string');
    expect(event.message.length).toBeGreaterThan(0);
    // `detail.wasLocked` records that the session was actually tripped before the reset.
    expect(detailOf(event).wasLocked).toBe(true);
  });

  it('REFUSES to unlock a tripped session without the code: AppError CIRCUIT_OPEN, lock intact, no event', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    await expect(resetSession(sessionId)).rejects.toMatchObject({
      name: 'AppError',
      code: 'CIRCUIT_OPEN',
    });

    // The refusal must not have touched the persisted state.
    expect(await isLocked(sessionId)).toBe(true);
    const state = await getState(sessionId);
    expect(state.locked).toBe(true);
    expect(state.failures).toBe(MFA_MAX_ATTEMPTS);
    expect(typeof state.lockedAt).toBe('number');
    expect(await resetEvents(sessionId)).toHaveLength(0);
  });

  it('REFUSES to unlock a tripped session with a WRONG code: AppError CIRCUIT_OPEN, lock intact', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    await expect(resetSession(sessionId, { verificationCode: '000000' })).rejects.toMatchObject({
      name: 'AppError',
      code: 'CIRCUIT_OPEN',
    });

    expect(await isLocked(sessionId)).toBe(true);
    expect(await resetEvents(sessionId)).toHaveLength(0);
  });

  it('REFUSES before the cooldown elapses (injected now < lockedAt + RESET_COOLDOWN_MS)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    // Derive the boundary from the REAL-stamped, PERSISTED `lockedAt` — the lock is NOT on the demo
    // clock, so `demoNow()`-based expectations are meaningless here.
    const lockedAt = (await getState(sessionId)).lockedAt!;
    const justBefore = lockedAt + RESET_COOLDOWN_MS - 1;
    await expect(resetSession(sessionId, { now: justBefore })).rejects.toMatchObject({
      name: 'AppError',
      code: 'CIRCUIT_OPEN',
    });

    expect(await isLocked(sessionId)).toBe(true);
    expect(await resetEvents(sessionId)).toHaveLength(0);
  });

  it('unlocks WITHOUT a code once the cooldown has elapsed (injected now)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    // The lock is stamped on the REAL clock, so the elapsed boundary is derived from the persisted
    // `lockedAt` (injecting `demoNow() + RESET_COOLDOWN_MS` would be REFUSED — the sandbox real clock
    // is ahead of the pinned demo instant).
    const lockedAt = (await getState(sessionId)).lockedAt!;
    const afterCooldown = lockedAt + RESET_COOLDOWN_MS;
    const state = await resetSession(sessionId, { now: afterCooldown });

    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(await isLocked(sessionId)).toBe(false);
    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(detailOf(events[0]!).wasLocked).toBe(true);
  });

  it('is a safe no-op on a NON-locked session: state cleared and the reset event still recorded', async () => {
    const sessionId = newSessionId();
    await recordFailure(sessionId); // a single failure — not locked
    expect(await isLocked(sessionId)).toBe(false);

    const state = await resetSession(sessionId);

    expect(state.failures).toBe(0);
    expect(state.locked).toBe(false);
    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(detailOf(events[0]!).wasLocked).toBe(false);
  });

  it('a reset session can trip again from scratch (consecutive failures restart at 1)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    await resetSession(sessionId, { verificationCode: MFA_CODE });
    expect(await isLocked(sessionId)).toBe(false);

    const state = await recordFailure(sessionId);

    expect(state.failures).toBe(1);
    expect(state.locked).toBe(false);
  });
});

describe('circuit-breaker - resetSession real-clock cooldown (DEFAULT server clock)', () => {
  it('unlocks WITHOUT a code once the DEFAULT clock is past the cooldown (back-dated lock)', async () => {
    const sessionId = newSessionId();
    // A real 60 s wait is impractical, so seed a LOCKED row whose `lockedAt` is already a full cooldown
    // in the PAST — the standard deterministic way to exercise a REAL-clock gate. `resetSession` is
    // called with NO `now`, so the gate uses its default `realNow()`, which is >= lockedAt + cooldown.
    const lockedAt = new Date(Date.now() - RESET_COOLDOWN_MS - 1_000);
    await seedLockedState(sessionId, lockedAt);
    expect(await isLocked(sessionId)).toBe(true);

    const state = await resetSession(sessionId);

    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(await isLocked(sessionId)).toBe(false);
    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(detailOf(events[0]!).wasLocked).toBe(true);
    const row = await rawRow(sessionId);
    expect(row).toMatchObject({ failures: 0, locked: false, lockedAt: null });
  });

  it('REFUSES before the cooldown elapses on the DEFAULT clock (fresh lock), leaving the lock INTACT', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    const before = await getState(sessionId);

    // No injected clock: the default `realNow()` is only milliseconds past the fresh `lockedAt`, so
    // the cooldown has definitely NOT elapsed.
    await expect(resetSession(sessionId)).rejects.toMatchObject({
      name: 'AppError',
      code: 'CIRCUIT_OPEN',
    });

    const after = await getState(sessionId);
    expect(after.locked).toBe(true);
    expect(after.failures).toBe(before.failures);
    expect(after.lockedAt).toBe(before.lockedAt);
    expect(await isLocked(sessionId)).toBe(true);
    expect(await resetEvents(sessionId)).toHaveLength(0);
  });
});

describe('circuit-breaker - resetSession ATOMIC unlock + audit', () => {
  it('HAPPY PATH — clears state and writes exactly ONE SECURITY_RESET with a complete detail', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    const state = await resetSession(sessionId, { verificationCode: MFA_CODE });

    // Returned view.
    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(state.lockedAt).toBeUndefined();
    // Persisted row.
    expect(await rawRow(sessionId)).toMatchObject({ failures: 0, locked: false, lockedAt: null });
    // Exactly one machine-readable reset event.
    const events = await resetEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(detailOf(events[0]!)).toMatchObject({
      wasLocked: true,
      previousFailures: MFA_MAX_ATTEMPTS,
      actor: 'user',
    });
  });

  it('AUDIT FAILURE KEEPS THE LOCK — a strict reset-event failure rolls the clear back and throws', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    // Capture the pre-reset state AFTER the trip so the spy targets the RESET audit, not the trip audit.
    const before = await getState(sessionId);

    // Fail the NEXT security-event write only (the strict SECURITY_RESET), which must roll back the clear.
    // (Set up AFTER tripping so the CIRCUIT_BREAKER_TRIPPED write already succeeded.)
    const spy = vi
      .spyOn(securityEventStore, 'insertSecurityEvent')
      .mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      await expect(
        resetSession(sessionId, { verificationCode: MFA_CODE }),
      ).rejects.toThrow('audit unavailable');
    } finally {
      spy.mockRestore();
    }

    // The whole unlock transaction rolled back: the lock is UNCHANGED (no half-applied / false "unlocked").
    const after = await getState(sessionId);
    expect(after.locked).toBe(true);
    expect(after.failures).toBe(before.failures);
    expect(after.lockedAt).toBe(before.lockedAt);
    const row = await rawRow(sessionId);
    expect(row!.locked).toBe(true);
    expect(row!.lockedAt!.getTime()).toBe(before.lockedAt);
    expect(row!.failures).toBe(before.failures);
    expect(await resetEvents(sessionId)).toHaveLength(0);
  });

  it('CONCURRENT UNLOCK records EXACTLY ONE SECURITY_RESET (CAS: the loser is a benign no-op)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    // The native adapter has one connection and serializes transactions. The first CAS applies;
    // the second sees the cleared state and is a no-op.
    const [a, b] = await Promise.all([
      resetSession(sessionId, { verificationCode: MFA_CODE }),
      resetSession(sessionId, { verificationCode: MFA_CODE }),
    ]);

    expect(a.locked).toBe(false);
    expect(b.locked).toBe(false);
    expect(await isLocked(sessionId)).toBe(false);
    expect(await resetEvents(sessionId)).toHaveLength(1);
  });

  it('RE-LOCK PRESERVED — a stale CAS expectation cannot clobber a newer lock', async () => {
    const sessionId = newSessionId();
    const key = keyFor(sessionId);
    const oldLockedAt = new Date(Date.now() - 10 * RESET_COOLDOWN_MS);
    await seedLockedState(sessionId, oldLockedAt);

    // The owner RE-LOCKS with a distinct NEWER `lockedAt` (e.g. a fresh trip).
    const newerLockedAt = new Date(Date.now() - RESET_COOLDOWN_MS);
    await getTestPrisma().circuitBreakerState.update({
      where: { key },
      data: { locked: true, lockedAt: newerLockedAt, failures: MFA_MAX_ATTEMPTS },
    });

    // `resetBreakerState` is EXACTLY the CAS primitive `resetSession` uses; a stale `expect` (the OLD
    // lock snapshot) must be a no-op that leaves the newer lock intact. (`resetSession` always re-reads
    // the state before building its expectation, so it cannot itself produce a stale `expect` — this
    // pins the PRIMITIVE's guarantee, which protects against a concurrent unlock/re-lock.)
    const result = await resetBreakerState(key, {
      expect: { locked: true, lockedAt: oldLockedAt },
    });

    expect(result.applied).toBe(false);
    const row = await rawRow(sessionId);
    expect(row!.locked).toBe(true);
    expect(row!.lockedAt!.getTime()).toBe(newerLockedAt.getTime());
  });
});
