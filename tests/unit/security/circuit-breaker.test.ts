/**
 * Unit: security/circuit-breaker — session-scoped consecutive-failure breaker (in-process state).
 *
 * Targets `@/security/circuit-breaker`: getState(sessionId), isLocked(sessionId),
 * recordFailure(sessionId), recordSuccess(sessionId), reset(sessionId) (+ type CircuitBreakerState).
 *
 * State lives IN-PROCESS keyed by sessionId (NOT the DB) → EVERY test MUST use a UNIQUE sessionId,
 * otherwise tests leak state into one another. `recordFailure` emits a SecurityEvent via ./audit →
 * requires test SQLite; `getState` / `isLocked` / `recordSuccess` / `reset` are otherwise pure.
 */
import { describe, it } from 'vitest';

// import { getState, isLocked, recordFailure, recordSuccess, reset } from '@/security/circuit-breaker';   // <- uncomment in Phase 2
// import { MFA_MAX_ATTEMPTS } from '@/lib/constants';

describe('circuit-breaker · fresh state (unique sessionId per test)', () => {
  it.todo('a brand-new sessionId → getState: failures 0, max MFA_MAX_ATTEMPTS, locked false, lockedAt undefined');
  it.todo('isLocked(newSessionId) → false');
});

describe('circuit-breaker · consecutive failures / trip', () => {
  it.todo('after 1 failure → failures 1, still not locked');
  it.todo('after 2 consecutive failures → failures 2, still not locked');
  it.todo('after 3 consecutive failures (MFA_MAX_ATTEMPTS) → locked true and lockedAt set');
  it.todo('tripping emits a CIRCUIT_BREAKER_TRIPPED SecurityEvent with severity "high" (needs test SQLite)');
  it.todo('further failures after trip keep locked true (idempotent trip)');
});

describe('circuit-breaker · success / reset semantics', () => {
  it.todo('recordSuccess after 2 failures resets the consecutive counter to 0');
  it.todo('recordSuccess does NOT unlock an already-tripped breaker (locked stays true)');
  it.todo('reset(sessionId) clears all state → failures 0, locked false (used by admin / security-center reset)');
});

describe('circuit-breaker · session isolation', () => {
  it.todo('two distinct sessionIds are independent: tripping A does not lock B');
  it.todo('failures are counted per sessionId (interleaved A/B failures do not sum)');
});
