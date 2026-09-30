/**
 * Unit: security/circuit-breaker — session-scoped consecutive-failure breaker (in-process state).
 *
 * Targets `@/security/circuit-breaker`: getState(sessionId), isLocked(sessionId),
 * recordFailure(sessionId), recordSuccess(sessionId), reset(sessionId) (+ type CircuitBreakerState).
 *
 * State lives IN-PROCESS keyed by sessionId (NOT the DB) → EVERY test MUST use a UNIQUE sessionId,
 * otherwise tests leak state into one another. `recordFailure` emits a SecurityEvent via ./audit
 * (only on the tripping call) → trips are verified against the test SQLite; `getState`/`isLocked`/
 * `recordSuccess`/`reset` are otherwise pure.
 */
import { describe, it, expect } from 'vitest';
import { getState, isLocked, recordFailure, recordSuccess, reset } from '@/security/circuit-breaker';
import { MFA_MAX_ATTEMPTS } from '@/lib/constants';
import { newId } from '@/lib/ids';
import { useFreshDatabase, getTestPrisma } from '../../helpers/db';

// Trip persistence writes a `SecurityEvent` row → give the suite a fresh, isolated test DB.
useFreshDatabase();

/** A unique sessionId per test — breaker state is in-process keyed by sessionId. */
const newSessionId = (): string => newId('cb');

/** The `CIRCUIT_BREAKER_TRIPPED` security-event rows persisted for a session. */
function tripEvents(sessionId: string) {
  return getTestPrisma().securityEvent.findMany({
    where: { sessionId, kind: 'CIRCUIT_BREAKER_TRIPPED' },
  });
}

/** Trip a fresh session's breaker by recording `MFA_MAX_ATTEMPTS` consecutive failures. */
async function tripBreaker(sessionId: string): Promise<void> {
  for (let i = 0; i < MFA_MAX_ATTEMPTS; i += 1) {
    await recordFailure(sessionId);
  }
}

describe('circuit-breaker · fresh state (unique sessionId per test)', () => {
  it('a brand-new sessionId → getState: failures 0, max MFA_MAX_ATTEMPTS, locked false, lockedAt undefined', () => {
    const sessionId = newSessionId();

    const state = getState(sessionId);

    expect(MFA_MAX_ATTEMPTS).toBe(3);
    expect(state.sessionId).toBe(sessionId);
    expect(state.failures).toBe(0);
    expect(state.max).toBe(MFA_MAX_ATTEMPTS);
    expect(state.locked).toBe(false);
    expect(state.lockedAt).toBeUndefined();
  });

  it('isLocked(newSessionId) → false', () => {
    const sessionId = newSessionId();

    expect(isLocked(sessionId)).toBe(false);
  });
});

describe('circuit-breaker · consecutive failures / trip', () => {
  it('after 1 failure → failures 1, still not locked', async () => {
    const sessionId = newSessionId();

    const state = await recordFailure(sessionId);

    expect(state.failures).toBe(1);
    expect(state.locked).toBe(false);
    expect(state.lockedAt).toBeUndefined();
    expect(isLocked(sessionId)).toBe(false);
    // A single failure writes no security event.
    expect(await tripEvents(sessionId)).toHaveLength(0);
  });

  it('after 2 consecutive failures → failures 2, still not locked', async () => {
    const sessionId = newSessionId();

    await recordFailure(sessionId);
    const state = await recordFailure(sessionId);

    expect(state.failures).toBe(2);
    expect(state.locked).toBe(false);
    expect(isLocked(sessionId)).toBe(false);
    expect(getState(sessionId).failures).toBe(2);
    expect(await tripEvents(sessionId)).toHaveLength(0);
  });

  it('after 3 consecutive failures (MFA_MAX_ATTEMPTS) → locked true and lockedAt set', async () => {
    const sessionId = newSessionId();

    await recordFailure(sessionId);
    await recordFailure(sessionId);
    const state = await recordFailure(sessionId);

    expect(state.failures).toBe(MFA_MAX_ATTEMPTS);
    expect(state.locked).toBe(true);
    expect(typeof state.lockedAt).toBe('number');
    expect(isLocked(sessionId)).toBe(true);
  });

  it('tripping emits a CIRCUIT_BREAKER_TRIPPED SecurityEvent with severity "high" (needs test SQLite)', async () => {
    const sessionId = newSessionId();

    await recordFailure(sessionId);
    await recordFailure(sessionId);
    expect(await tripEvents(sessionId)).toHaveLength(0); // no event before the trip

    await recordFailure(sessionId);

    const events = await tripEvents(sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe(sessionId);
    expect(events[0]!.kind).toBe('CIRCUIT_BREAKER_TRIPPED');
    expect(events[0]!.severity).toBe('high');
  });

  it('further failures after trip keep locked true (idempotent trip)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    expect(isLocked(sessionId)).toBe(true);

    const state = await recordFailure(sessionId);

    expect(state.locked).toBe(true);
    expect(state.failures).toBe(MFA_MAX_ATTEMPTS); // not recounted
    expect(isLocked(sessionId)).toBe(true);
    // The trip is emitted exactly once — a 4th failure must NOT re-emit.
    expect(await tripEvents(sessionId)).toHaveLength(1);
  });
});

describe('circuit-breaker · success / reset semantics', () => {
  it('recordSuccess after 2 failures resets the consecutive counter to 0', async () => {
    const sessionId = newSessionId();
    await recordFailure(sessionId);
    await recordFailure(sessionId);
    expect(getState(sessionId).failures).toBe(2);

    const state = recordSuccess(sessionId);

    expect(state.failures).toBe(0);
    expect(state.locked).toBe(false);
    expect(getState(sessionId).failures).toBe(0);
    expect(isLocked(sessionId)).toBe(false);
  });

  it('recordSuccess does NOT unlock an already-tripped breaker (locked stays true)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    expect(isLocked(sessionId)).toBe(true);

    const state = recordSuccess(sessionId);

    expect(state.failures).toBe(0);
    expect(state.locked).toBe(true);
    expect(isLocked(sessionId)).toBe(true);
  });

  it('reset(sessionId) clears all state → failures 0, locked false (used by admin / security-center reset)', async () => {
    const sessionId = newSessionId();
    await tripBreaker(sessionId);
    expect(isLocked(sessionId)).toBe(true);

    reset(sessionId);

    const state = getState(sessionId);
    expect(state.failures).toBe(0);
    expect(state.locked).toBe(false);
    expect(state.lockedAt).toBeUndefined();
    expect(isLocked(sessionId)).toBe(false);
  });
});

describe('circuit-breaker · session isolation', () => {
  it('two distinct sessionIds are independent: tripping A does not lock B', async () => {
    const sessionA = newSessionId();
    const sessionB = newSessionId();

    await tripBreaker(sessionA);

    expect(isLocked(sessionA)).toBe(true);
    expect(isLocked(sessionB)).toBe(false);
    expect(getState(sessionB).failures).toBe(0);
    expect(await tripEvents(sessionA)).toHaveLength(1);
    expect(await tripEvents(sessionB)).toHaveLength(0);
  });

  it('failures are counted per sessionId (interleaved A/B failures do not sum)', async () => {
    const sessionA = newSessionId();
    const sessionB = newSessionId();

    await recordFailure(sessionA);
    await recordFailure(sessionB);
    await recordFailure(sessionA);

    const stateA = getState(sessionA);
    const stateB = getState(sessionB);

    expect(stateA.failures).toBe(2);
    expect(stateA.locked).toBe(false);
    expect(stateB.failures).toBe(1);
    expect(stateB.locked).toBe(false);
    expect(isLocked(sessionA)).toBe(false);
    expect(isLocked(sessionB)).toBe(false);
  });
});
