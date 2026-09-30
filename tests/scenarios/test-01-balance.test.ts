/**
 * Scenario Test 1 — "查询我的余额" (GREEN auto-execute balance read).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN auto → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, text, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, newSessionId, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { DEMO_USER_ID, ACCOUNTS } from '../helpers/fixtures';
// import { getTestPrisma } from '../helpers/db';

describe('Scenario 1 — 查询余额 (GREEN auto-execute)', () => {
  it.todo('seeds the demo world and scripts a get_balance call for "查询我的余额"');
  it.todo('get_balance executes inline with NO confirmation (no PendingAction created)');
  it.todo('the get_balance tool event reports status success and riskLevel GREEN');
  it.todo('a balance card is surfaced showing 活期账户 ¥23,580.00 (ACCOUNTS[checking])');
  it.todo('an audit row is written with riskLevel GREEN and status allowed/success');
  it.todo('the assistant narration restates the factual balance from the tool result');
});
