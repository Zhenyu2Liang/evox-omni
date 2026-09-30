/**
 * Scenario Test 6 — "分析我这个月的消费" (GREEN spending analysis).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN auto → Banking SDK → audit.
 * Fixtures: demo user 李明; assert the outcome named in each it.todo.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it } from 'vitest';

// import { buildFauxAgent, tool, final, callThen } from '../helpers/faux-agent';
// import { runTurn, toolEventsOf, cardsOfType } from '../helpers/scenario';
// import { useFreshDatabase, resetDatabase, getTestPrisma } from '../helpers/db';
// import { MONTHLY_SPEND_TOTAL, buildCurrentMonthSpend } from '../helpers/fixtures';

describe('Scenario 6 — 分析本月消费 (GREEN analyze_spending)', () => {
  it.todo('analyze_spending auto-executes (GREEN) with no confirmation required');
  it.todo('the result total is approximately ¥5,800 (MONTHLY_SPEND_TOTAL) for the current month');
  it.todo('byCategory includes 娱乐 with the expected amount');
  it.todo('topMerchant and monthlyTrend are populated in the result');
  it.todo('a spending card is surfaced to the UI (no chain-of-thought text)');
});
