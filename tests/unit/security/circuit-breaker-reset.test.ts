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
 * Breaker state is keyed by the breaker OWNER. The actor ids below (`newId('cbreset')`) have no
 * `AgentSession`/`User` row, so each is a distinct `session:<actor>` owner; `useFreshDatabase()`
 * clears `circuitBreakerState` between tests as well.
 */
import { describe, expect, it } from 'vitest';
import { getState, isLocked, recordFailure, resetSession } from '@/security/circuit-breaker';
import { security } from '@/security';
import { MFA_CODE, MFA_MAX_ATTEMPTS, RESET_COOLDOWN_MS } from '@/lib/constants';
import { demoNow } from '@/lib/clock';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';

useFreshDatabase();

/** A unique breaker owner per test (no `AgentSession` row → `session:<id>` key). */
const newSessionId = (): string => newId('cbreset');

/** The `SECURITY_RESET` security-event rows persisted for a session. */
function resetEvents(sessionId: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind: 'SECURITY_RESET' },
  });
}

/** Trip a fresh session's breaker by recording `MFA_MAX_ATTEMPTS` consecutive failures. */
async function tripBreaker(sessionId: string): Promise<void> {
  for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
    await recordFailure(sessionId);
  }
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

    const justBefore = demoNow() + RESET_COOLDOWN_MS - 1;
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

    const afterCooldown = demoNow() + RESET_COOLDOWN_MS;
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
