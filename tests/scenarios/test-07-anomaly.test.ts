/**
 * Scenario Test 7 — "看看有没有异常交易" (GREEN anomaly detection).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN auto → Banking SDK → audit.
 * Fixtures: demo user 李明; the seeded Apple Store ¥6,999 anomaly @ 2026-09-20 18:32.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, expect, it } from 'vitest';
import type { AnomalyItem, AnomalyReport } from '@/banking-sdk';
import { ANOMALY_AMOUNT_THRESHOLD } from '@/lib/constants';
import { absoluteMinor, moneyToCents, normalizeMoney } from '@/lib/money';
import { security } from '@/security';
import { buildFauxAgent, final, tool } from '../helpers/faux-agent';
import { cardsOfType, newSessionId, runTurn, toolEventsOf } from '../helpers/scenario';
import type { ScenarioResult } from '../helpers/scenario';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { ANOMALY_OCCURRED_AT, ANOMALY_TRANSACTION, DEMO_USER_ID } from '../helpers/fixtures';

useFreshDatabase();

const PROMPT = '看看有没有异常交易';
const NARRATION = '已检查账户，发现异常交易。';

/** Drive one GREEN `detect_anomaly` turn (scripted model: tool call + factual narration). */
async function runAnomalyTurn(): Promise<{ sessionId: string; res: ScenarioResult }> {
  const sessionId = newSessionId();
  const agent = buildFauxAgent({
    sessionId,
    script: [tool('detect_anomaly', {}), final(NARRATION)],
  });
  const res = await runTurn({ sessionId, message: PROMPT, agent });
  return { sessionId, res };
}

/** The single `AnomalyReport` carried by the anomaly card (the card payload IS the SDK DTO). */
function anomalyReportOf(res: ScenarioResult): AnomalyReport | undefined {
  return cardsOfType(res, 'anomaly')[0]?.data as AnomalyReport | undefined;
}

/** The seeded Apple Store anomaly inside a report, or `undefined` when it is not flagged. */
function appleAnomaly(report: AnomalyReport | undefined): AnomalyItem | undefined {
  return report?.anomalies.find(
    (item) => item.transaction.merchant === ANOMALY_TRANSACTION.merchant,
  );
}

describe('Scenario 7 — 异常交易检测 (GREEN detect_anomaly)', () => {
  it('detect_anomaly auto-executes (GREEN) with no confirmation required', async () => {
    const { sessionId, res } = await runAnomalyTurn();

    // No human decision was required: the tool ran inline.
    expect(res.error).toBeUndefined();
    expect(res.confirmation).toBeUndefined();
    expect(res.mfa).toBeUndefined();

    const events = toolEventsOf(res, 'detect_anomaly');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('success');

    // A GREEN read never parks a PendingAction.
    const pending = await getTestPrisma().pendingAction.count({ where: { sessionId } });
    expect(pending).toBe(0);
  });

  it('the Apple Store ¥6,999 anomaly is flagged (amount > ANOMALY_AMOUNT_THRESHOLD ¥5,000)', async () => {
    expect(ANOMALY_AMOUNT_THRESHOLD).toBe('5000.00');

    const { res } = await runAnomalyTurn();
    const apple = appleAnomaly(anomalyReportOf(res));

    expect(apple).toBeDefined();
    expect(apple?.transaction.id).toBe(ANOMALY_TRANSACTION.id);
    expect(apple?.transaction.amount).toBe(normalizeMoney(ANOMALY_TRANSACTION.amount));
    expect(absoluteMinor(moneyToCents(apple?.transaction.amount))).toBe(699_900n);
    expect(absoluteMinor(moneyToCents(apple?.transaction.amount))).toBeGreaterThan(moneyToCents(ANOMALY_AMOUNT_THRESHOLD));
    expect(apple?.severity).toBe('low');
  });

  it('the anomaly occurred at the fixed time 2026-09-20 18:32 (ANOMALY_OCCURRED_AT)', async () => {
    const { res } = await runAnomalyTurn();
    const apple = appleAnomaly(anomalyReportOf(res));

    expect(apple?.transaction.occurredAt).toBe(ANOMALY_OCCURRED_AT);

    const occurredAt = new Date(apple?.transaction.occurredAt ?? 0);
    expect(occurredAt.getFullYear()).toBe(2026);
    expect(occurredAt.getMonth()).toBe(8); // September (0-indexed)
    expect(occurredAt.getDate()).toBe(20);
    expect(occurredAt.getHours()).toBe(18);
    expect(occurredAt.getMinutes()).toBe(32);
  });

  it('an anomaly card carries the exact merchant / amount / time', async () => {
    const { res } = await runAnomalyTurn();

    const cards = cardsOfType(res, 'anomaly');
    expect(cards.length).toBeGreaterThan(0);

    const report = cards[0].data as AnomalyReport;
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({
      transaction: {
        id: ANOMALY_TRANSACTION.id,
        merchant: ANOMALY_TRANSACTION.merchant,
        amount: normalizeMoney(ANOMALY_TRANSACTION.amount),
        occurredAt: ANOMALY_OCCURRED_AT,
      },
    });
    expect(report.scanned).toBeGreaterThan(0);
  });

  it('is not confirmation-gated: the gateway auto-allows detect_anomaly and no audit row is written', async () => {
    const { sessionId, res } = await runAnomalyTurn();
    expect(res.confirmation).toBeUndefined();

    // The GREEN security facts, asserted through the public security façade.
    const evaluation = await security.gateway.securityGateway.evaluate({
      sessionId,
      userId: DEMO_USER_ID,
      toolName: 'detect_anomaly',
      args: {},
      userRequest: PROMPT,
    });
    expect(evaluation.tier).toBe('GREEN');
    expect(evaluation.blocked).toBe(false);
    expect(evaluation.requiresConfirmation).toBe(false);
    expect(evaluation.requiresMfa).toBe(false);

    // GREEN reads are not gated, so no audit row is written for them: audit rows are recorded on
    // HUMAN decisions (confirm/verify/cancel), not for inline GREEN execution.
    const rows = await getTestPrisma().auditLog.findMany({ where: { sessionId } });
    expect(rows).toHaveLength(0);
  });
});
