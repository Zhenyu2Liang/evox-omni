/**
 * Scenario Test 9 — "买5000元稳健理财A" (RED investment subscription requires MFA).
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
// import { PRODUCTS, ACCOUNTS } from '../helpers/fixtures';
// import { MFA_CODE } from '@/lib/constants';

describe('Scenario 9 — 买5000元稳健理财A (RED MFA)', () => {
  it.todo('subscribe_investment is STATICALLY classified RED and BLOCKED by beforeToolCall');
  it.todo('an mfa_required event / MFA card is surfaced and a PendingAction is persisted');
  it.todo('confirm without an MFA code does NOT execute the subscription');
  it.todo('verifyAction(actionId, "123456") creates an InvestmentHolding of ¥5000 for 稳健理财A');
  it.todo('the funding account (活期) is debited by ¥5000');
  it.todo('the audit row records mfaRequired true and mfaResult success (riskLevel RED)');
});
