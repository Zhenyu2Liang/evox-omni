/**
 * Scenario Test 6 — "分析我这个月的消费" (GREEN spending analysis).
 *
 * Pipeline: user message → Pi Agent (faux script) → banking tool → Security Gateway
 * (beforeToolCall) → GREEN auto → Banking SDK → audit.
 * Fixtures: demo user 李明; the current-month ordinary spend totals ¥5,800 (of which 娱乐 ¥2,680)
 * and EXCLUDES the ¥6,999 Apple Store anomaly (a separate `isAnomaly` row).
 * Helpers: ../helpers (fauxAgent/scenario), ../helpers/db, ../helpers/fixtures.
 */
import { describe, it, expect } from 'vitest';
import { buildFauxAgent, callThen } from '../helpers/faux-agent';
import {
  runTurn,
  toolEventsOf,
  cardsOfType,
  newSessionId,
  type ScenarioResult,
} from '../helpers/scenario';
import { useFreshDatabase, getTestPrisma } from '../helpers/db';
import { MONTHLY_SPEND_TOTAL, buildCurrentMonthSpend } from '../helpers/fixtures';
import type { SpendingAnalysis } from '@/banking-sdk';

describe('Scenario 6 — 分析本月消费 (GREEN analyze_spending)', () => {
  useFreshDatabase();

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
        '本月消费合计 ¥5,800.00，最大分类为娱乐 ¥2,680.00。',
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

  it('the result total is approximately ¥5,800 (MONTHLY_SPEND_TOTAL) for the current month', async () => {
    const res = await analyzeThisMonth();
    const analysis = spendingData(res);

    // The fixture constant is the canonical current-month ordinary spend.
    const fixtureTotal = buildCurrentMonthSpend().reduce(
      (sum, row) => sum + Math.abs(row.amount),
      0,
    );
    expect(fixtureTotal).toBe(MONTHLY_SPEND_TOTAL);

    expect(analysis.total).toBeCloseTo(MONTHLY_SPEND_TOTAL, 2);
    // The ¥6,999 Apple Store anomaly is EXCLUDED — the total must not absorb it.
    expect(analysis.total).not.toBeCloseTo(MONTHLY_SPEND_TOTAL + 6999, 2);

    // …and it genuinely exists in the DB as a flagged anomaly row.
    const anomaly = await getTestPrisma().transaction.findUnique({
      where: { id: 'tx_anomaly_apple' },
    });
    expect(anomaly?.isAnomaly).toBe(true);
    expect(Math.abs(anomaly?.amount ?? 0)).toBe(6999);

    // The largest ordinary spend is therefore NOT the anomaly.
    expect(analysis.largest?.merchant).not.toBe('Apple Store');
  });

  it('byCategory includes 娱乐 with the expected amount', async () => {
    const res = await analyzeThisMonth();
    const analysis = spendingData(res);

    const entertainment = analysis.byCategory.find((entry) => entry.category === '娱乐');
    expect(entertainment).toBeDefined();
    expect(entertainment?.amount).toBeCloseTo(2680, 2);
    expect(entertainment?.share).toBeGreaterThan(0);
  });

  it('topMerchant and monthlyTrend are populated in the result', async () => {
    const res = await analyzeThisMonth();
    const analysis = spendingData(res);

    // topMerchant: the merchant with the greatest ordinary spend (演唱会门票 ¥1,880).
    expect(analysis.topMerchant).not.toBeNull();
    expect(analysis.topMerchant?.merchant).toBe('演唱会门票');
    expect(analysis.topMerchant?.amount).toBeCloseTo(1880, 2);
    expect(analysis.topMerchant?.count).toBeGreaterThanOrEqual(1);

    // monthlyTrend: a 6-month rolling window, oldest → newest, ending on the current month.
    expect(analysis.monthlyTrend.length).toBe(6);
    expect(
      analysis.monthlyTrend.every(
        (point) => typeof point.month === 'string' && point.amount >= 0,
      ),
    ).toBe(true);
    const current = analysis.monthlyTrend[analysis.monthlyTrend.length - 1];
    expect(current.amount).toBeCloseTo(MONTHLY_SPEND_TOTAL, 2);
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
