/**
 * Scenario Test 3 — "给张伟转5000元" (RED transfer requires MFA, code 123456).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → RED MFA → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, confirmAction, verifyAction, newSessionId, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { ACCOUNTS, CONTACTS } from '../helpers/fixtures';
// import { MFA_CODE } from '@/lib/constants';

describe('Scenario 3 — 给张伟转5000元 (RED MFA)', () => {
  it.todo('transfer_money of ¥5000 exceeds the >1000 threshold and is classified RED by the policy table');
  it.todo('the turn is BLOCKED by beforeToolCall and an mfa_required event / MFA card is surfaced');
  it.todo('a PendingAction is persisted (status pending) and NO Transaction row is written yet');
  it.todo('confirm without an MFA code does NOT execute the transfer (still pending / no Transaction)');
  it.todo('verifyAction(actionId, "123456") executes the transfer successfully');
  it.todo('the audit row records mfaRequired true and mfaResult success (riskLevel RED)');
  it.todo('the agent narration reports the factual 张伟 / ¥5000 executed outcome');
});
