/**
 * Scenario Test 6 — "分析我这个月的消费" (GREEN spending analysis).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN auto → Banking SDK → audit.
 * Fixtures: booked spending includes the flagged Apple Store transaction; flagged amounts remain
 * separately visible, and investment principal movements are excluded from consumption.
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { afterAll, beforeEach, describe, it, expect } from 'vitest';
import { buildFauxAgent, callThen } from '../helpers/faux-agent';
import {
  runTurn,
  toolEventsOf,
  cardsOfType,
  newSessionId,
  type ScenarioResult,
} from '../helpers/scenario';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '../helpers/db';
import { MONTHLY_SPEND_TOTAL, buildCurrentMonthSpend } from '../helpers/fixtures';
import type { SpendingAnalysis } from '@/banking-sdk';
import { absoluteMinor, addMoney, moneyToCents } from '@/lib/money';

describe('Scenario 6 — 分析本月消费 (GREEN analyze_spending)', () => {
  beforeEach(async () => {
    await resetDatabase();
  }, 30000);
  afterAll(async () => {
    await disconnectTestPrisma();
  });

  /**
   * Drive one full pipeline turn: the scripted model calls the real `analyze_spending` tool
   * (GREEN → auto-executes inline through the gateway + Banking SDK) then narrates the facts.
   * A fresh, unique `sessionId` isolates the in-process circuit breaker.
   */
  async function analyzeThisMonth(): Promise<ScenarioResult> {
    const sessionId = newSessionId();
    const agent = buildFauxAgent({
      sessionId,
      script: callThen(
        'Booked monthly spending is CNY 12,799.00; flagged spending is CNY 6,999.00.',
        'analyze_spending',
        {}, // no `month` → defaults to the current month of the demo clock (2026-09)
      ),
    });
    return runTurn({ sessionId, message: '分析我这个月的消费', agent });
  }

  /** The raw `SpendingAnalysis` payload carried by the surfaced `spending` card. */
  function spendingData(res: ScenarioResult): SpendingAnalysis {
    const cards = cardsOfType(res, 'spending');
    expect(cards.length).toBeGreaterThanOrEqual(1);
    return cards[0].data as SpendingAnalysis;
  }

  it('analyze_spending auto-executes (GREEN) with no confirmation required', async () => {
    const res = await analyzeThisMonth();

    const events = toolEventsOf(res, 'analyze_spending');
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('success');

    // GREEN ⇒ no human gate was surfaced and no PendingAction was persisted.
    expect(res.confirmation).toBeUndefined();
    expect(res.mfa).toBeUndefined();
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });

  it('includes every booked expense and exposes flagged spending separately without hiding it', async () => {
    const res = await analyzeThisMonth();
    const analysis = spendingData(res);

    // The fixture constant is the canonical current-month ordinary spend.
    const fixtureTotal = buildCurrentMonthSpend().reduce(
      (sum, row) => sum + absoluteMinor(moneyToCents(row.amount)),
      0n,
    );
    expect(fixtureTotal).toBe(moneyToCents(MONTHLY_SPEND_TOTAL));

    expect(analysis.total).toBe(addMoney(MONTHLY_SPEND_TOTAL, '6999.00'));
    expect(analysis.bookedTotal).toBe(analysis.total);
    expect(analysis.flaggedTotal).toBe('6999.00');

    // …and it genuinely exists in the DB as a flagged anomaly row.
    const anomaly = await getTestPrisma().transaction.findUnique({
      where: { id: 'tx_anomaly_apple' },
    });
    expect(anomaly?.isAnomaly).toBe(true);
    expect(absoluteMinor(anomaly?.amountMinor ?? 0n)).toBe(699_900n);

    // Risk tagging does not remove this factual expense from the spending read model.
    expect(analysis.largest?.merchant).toBe('Apple Store');
  });

  it('byCategory includes 娱乐 with the expected amount', async () => {
    const res = await analyzeThisMonth();
    const analysis = spendingData(res);

    const entertainment = analysis.byCategory.find((entry) => entry.category === '娱乐');
    expect(entertainment).toBeDefined();
    expect(entertainment?.amount).toBe('2680.00');
    expect(moneyToCents(entertainment?.share)).toBeGreaterThan(0n);
  });

  it('topMerchant and monthlyTrend are populated in the result', async () => {
    const res = await analyzeThisMonth();
    const analysis = spendingData(res);

    // The largest booked merchant includes flagged expenses.
    expect(analysis.topMerchant).not.toBeNull();
    expect(analysis.topMerchant?.merchant).toBe('Apple Store');
    expect(analysis.topMerchant?.amount).toBe('6999.00');
    expect(analysis.topMerchant?.count).toBeGreaterThanOrEqual(1);

    // monthlyTrend: a 6-month rolling window, oldest → newest, ending on the current month.
    expect(analysis.monthlyTrend.length).toBe(6);
    expect(
      analysis.monthlyTrend.every(
        point => typeof point.month === 'string' && moneyToCents(point.amount) >= 0n,
      ),
    ).toBe(true);
    const current = analysis.monthlyTrend[analysis.monthlyTrend.length - 1];
    expect(current.amount).toBe(addMoney(MONTHLY_SPEND_TOTAL, '6999.00'));
  });

  it('a spending card is surfaced to the UI (no chain-of-thought text) and no error occurs', async () => {
    const res = await analyzeThisMonth();

    expect(cardsOfType(res, 'spending').length).toBeGreaterThanOrEqual(1);

    const eventTypes = res.events.map((event) => event.type as string);
    expect(eventTypes).toContain('card');
    expect(eventTypes).not.toContain('thinking');
    expect(eventTypes).not.toContain('reasoning');

    expect(res.text.length).toBeGreaterThan(0);
    expect(res.error).toBeUndefined();
  });
});
