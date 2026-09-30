/**
 * Scenario Test 2 — "给张伟转200元，备注AA" (YELLOW transfer requires confirmation).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → YELLOW confirm → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, confirmAction, newSessionId, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { ACCOUNTS, CONTACTS } from '../helpers/fixtures';

describe('Scenario 2 — 给张伟转200元 (YELLOW confirm)', () => {
  it.todo('transfer_money of ¥200 is classified YELLOW and BLOCKED by beforeToolCall');
  it.todo('a PendingAction is persisted with status pending and summary 收款人 张伟 / 金额 ¥200.00');
  it.todo('a confirmation_required event and a confirmation card are surfaced');
  it.todo('NO Transaction row and no balance change exist while the action is pending');
  it.todo('confirm(actionId) executes the ORIGINAL validated args through the SDK authorized path');
  it.todo('after confirm: a DEBIT ¥200 Transaction is written and balance goes 23580 → 23380');
  it.todo('the audit row for the executed transfer has status success (riskLevel YELLOW)');
  it.todo('the agent narration states the factual 张伟 / ¥200 outcome (no hallucinated details)');
});
