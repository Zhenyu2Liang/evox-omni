/**
 * Scenario Test 7 — "看看有没有异常交易" (GREEN anomaly detection).
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
// import { ANOMALY_TRANSACTION, ANOMALY_OCCURRED_AT } from '../helpers/fixtures';
// import { ANOMALY_AMOUNT_THRESHOLD } from '@/lib/constants';

describe('Scenario 7 — 异常交易检测 (GREEN detect_anomaly)', () => {
  it.todo('detect_anomaly auto-executes (GREEN) with no confirmation required');
  it.todo('the Apple Store ¥6,999 anomaly is flagged (amount > ANOMALY_AMOUNT_THRESHOLD ¥5,000)');
  it.todo('the anomaly occurred at the fixed time 2026-09-20 18:32 (ANOMALY_OCCURRED_AT)');
  it.todo('an anomaly card carries the exact merchant / amount / time');
  it.todo('the audit row has riskLevel GREEN and status success');
});
