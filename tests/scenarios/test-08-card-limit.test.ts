/**
 * Scenario Test 8 — "把信用卡娱乐限额调整到1500" (YELLOW card-limit change requires confirmation).
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

describe('Scenario 8 — 信用卡娱乐限额调整到1500 (YELLOW confirm)', () => {
  it.todo('set_card_limit for the 娱乐 category is classified YELLOW and BLOCKED by beforeToolCall');
  it.todo('a PendingAction plus a confirmation_required event are produced');
  it.todo('NO CardLimit row exists (no 娱乐 limit ¥1500) until the user confirms');
  it.todo('after confirm the 娱乐 limit is persisted as ¥1500');
  it.todo('the audit row has riskLevel YELLOW and status success');
});
