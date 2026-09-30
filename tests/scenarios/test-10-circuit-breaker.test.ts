/**
 * Scenario Test 10 — 3 consecutive wrong MFA codes trip the circuit breaker (session lock).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → RED MFA (wrong code x3) → circuit breaker trips → audit/SecurityEvent.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, verifyAction, newSessionId, toolEventsOf } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { CONTACTS } from '../helpers/fixtures';

describe('Scenario 10 — 连续错误MFA触发熔断 (circuit breaker)', () => {
  it.todo('a UNIQUE sessionId is used so the breaker lock cannot leak into other suites');
  it.todo('3 consecutive wrong MFA codes ("000000") on a RED action increment the failure counter');
  it.todo('the circuit breaker TRIPS and locks high-risk operations for the session');
  it.todo('a CIRCUIT_BREAKER_TRIPPED SecurityEvent is emitted with severity high');
  it.todo('a subsequent RED attempt is refused with status "locked" and no execution occurs');
});
