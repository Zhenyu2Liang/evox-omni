/**
 * Scenario Test 5 — transfer failure must be reported truthfully (no hallucinated success).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN/YELLOW decision → Banking SDK returns success:false → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { ACCOUNTS } from '../helpers/fixtures';

describe('Scenario 5 — 转账失败如实上报 (INSUFFICIENT_FUNDS)', () => {
  it.todo('the scripted transfer_money tool returns success:false with error code INSUFFICIENT_FUNDS');
  it.todo('the transfer emits an error tool event carrying the failure (not a success payload)');
  it.todo('the agent REPORTS FAILURE truthfully and does NOT hallucinate a successful transfer');
  it.todo('the audit row for the failed attempt has status failed');
  it.todo('no Transaction is written and the account balance is unchanged');
});
