/**
 * Unit: security/circuit-breaker — `resetSession()` unlock path + `SECURITY_RESET` event.
 *
 * Targets `@/security/circuit-breaker`: the async `resetSession(sessionId)` (the security-center
 * unlock entry point) must (a) clear the in-memory breaker state exactly like the synchronous
 * `reset`, and (b) record a `SECURITY_RESET` `SecurityEvent` through the SAME `./audit` recorder
 * used for `CIRCUIT_BREAKER_TRIPPED` / `MFA_FAILURE`.
 *
 * Breaker state is IN-PROCESS keyed by sessionId -> EVERY test uses a UNIQUE sessionId so one
 * test's trip cannot leak into another. Event persistence needs the test SQLite (`useFreshDatabase()`).
 */
import { describe, expect, it } from 'vitest';
import { getState, isLocked, recordFailure, resetSession } from '@/security/circuit-breaker';
import { security } from '@/security';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';

useFreshDatabase();

/** A unique sessionId per test — breaker state is in-process keyed by sessionId. */
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

  it('unlocks a tripped session and returns the cleared state (failures 0, locked false)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    expect(isLocked(sessionId)).toBe(true);
    expect(await resetEvents(sessionId)).toHaveLength(0);

    const state = await resetSession(sessionId);

    expect(state.locked).toBe(false);
    expect(state.failures).toBe(0);
    expect(state.lockedAt).toBeUndefined();
    expect(isLocked(sessionId)).toBe(false);
    expect(getState(sessionId).locked).toBe(false);
  });

  it('records exactly one SECURITY_RESET SecurityEvent with the sessionId + a human-readable message', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);

    await resetSession(sessionId);

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

  it('is a safe no-op on a NON-locked session: state cleared and the reset event still recorded', async () => {
    const sessionId = newSessionId();
    await recordFailure(sessionId); // a single failure — not locked
    expect(isLocked(sessionId)).toBe(false);

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
    await resetSession(sessionId);
    expect(isLocked(sessionId)).toBe(false);

    const state = await recordFailure(sessionId);

    expect(state.failures).toBe(1);
    expect(state.locked).toBe(false);
  });
});