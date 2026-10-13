/**
 * Unit: banking-sdk/transaction — ANOMALY DETECTION regression (issue 3).
 *
 * `detectAnomaly`'s AUTOMATIC heuristic flags EXPENSE (DEBIT) rows only: a row is reported when it
 * was explicitly flagged (`isAnomaly`) OR it is a DEBIT whose magnitude exceeds
 * `ANOMALY_AMOUNT_THRESHOLD` (¥5,000) and which is not an investment-flow row
 * (`INVESTMENT_FLOW_CATEGORY`). Large INCOME / refunds / 工资 CREDITS are therefore never
 * misreported as 大额消费, and the same `INVESTMENT_FLOW_CATEGORY` exclusion keeps a large 认购 debit
 * out of the report.
 *
 * WHAT it pins down:
 *   - the seeded salary income (`tx_sep_salary`, +¥11,000, 工资) is a CREDIT and is NOT flagged;
 *   - the Apple Store ¥6,999 anomaly IS still flagged (and is the ONLY automatic finding);
 *   - a large refund CREDIT is not flagged; an operator-flagged (`isAnomaly: true`) row still is;
 *   - a >¥5,000 DEBIT is still flagged (the heuristic has not been disabled);
 *   - a >¥5,000 投资 (investment-flow) DEBIT is NOT flagged.
 *
 * The probe rows are inserted TEST-LOCALLY (never in the shared fixtures), so the fixture world's
 * anomaly count — asserted by `tests/scenarios/test-07-anomaly.test.ts` (`anomalies).toHaveLength(1)`)
 * — stays exactly 1.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { AnomalyItem } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { ANOMALY_AMOUNT_THRESHOLD } from '@/lib/constants';
import { demoNow } from '@/lib/clock';
import { absoluteMinor, addMoney, centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import {
  ANOMALY_TRANSACTION,
  DEMO_USER_ID,
  MONTHLY_SPEND_TOTAL,
  SALARY_TRANSACTION_ID,
} from '../../helpers/fixtures';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

const CHECKING = 'acct_checking';
/** The salary income row the DEBIT-only rule is exercised against (fixture: +¥11,000, 工资). */
const SALARY_AMOUNT = '11000.00';

function db() {
  return getTestPrisma();
}

/** A LOCAL, current-month instant for probe rows (never `Date.now()`) — 21st @ 14:00. */
function probeAt(): Date {
  const now = new Date(demoNow());
  return new Date(now.getFullYear(), now.getMonth(), 21, 14, 0);
}

/** Insert a ledger row directly (test-local dataset — the shared fixtures stay untouched). */
function insertRow(row: {
  id: string;
  amount: string;
  direction: 'DEBIT' | 'CREDIT';
  category: string;
  merchant: string;
  isAnomaly?: boolean;
  anomalyReason?: string;
}): Promise<unknown> {
  const { amount, ...fields } = row;
  return db().transaction.create({
    data: {
      accountId: CHECKING,
      userId: DEMO_USER_ID,
      currency: 'CNY',
      occurredAt: probeAt(),
      channel: 'APP',
      ...fields,
      amountMinor: moneyToCents(amount),
    },
  });
}

/** The anomaly ids reported for the demo user, in report order. */
async function anomalyIds(): Promise<string[]> {
  const report = await banking.transaction.detectAnomaly(DEMO_USER_ID);
  return report.anomalies.map((item) => item.transaction.id);
}

describe('banking-sdk/transaction · detectAnomaly flags EXPENSE rows only', () => {
  it('the seeded salary income (+¥11,000, 工资) is a CREDIT and is NOT flagged', async () => {
    // Fixture sanity: the probe row really exists in the world being scanned (not vacuously absent).
    const salary = await db().transaction.findUnique({ where: { id: SALARY_TRANSACTION_ID } });
    expect(salary).toMatchObject({ amountMinor: moneyToCents(SALARY_AMOUNT), direction: 'CREDIT', category: '工资' });

    const report = await banking.transaction.detectAnomaly(DEMO_USER_ID);

    expect(report.scanned).toBeGreaterThan(0);
    expect(report.anomalies.map((item) => item.transaction.id)).toEqual([ANOMALY_TRANSACTION.id]);
    expect(report.anomalies.some((item) => item.transaction.merchant === '工资')).toBe(false);
  });

  it('the salary CREDIT also stays out of the 本月 consumption analysis', async () => {
    const spend = await banking.transaction.analyzeSpending(DEMO_USER_ID);

    expect(spend.total).toBe(addMoney(MONTHLY_SPEND_TOTAL, centsToMoney(absoluteMinor(moneyToCents(ANOMALY_TRANSACTION.amount)))));
    expect(spend.flaggedTotal).toBe(centsToMoney(absoluteMinor(moneyToCents(ANOMALY_TRANSACTION.amount))));
    expect(spend.byCategory.map((entry) => entry.category)).not.toContain('工资');
    expect(spend.largest?.merchant).not.toBe('工资');
  });

  it('the Apple Store ¥6,999 anomaly is STILL detected (unchanged severity + reason)', async () => {
    const report = await banking.transaction.detectAnomaly(DEMO_USER_ID);

    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]).toMatchObject({
      transaction: {
        id: ANOMALY_TRANSACTION.id,
        merchant: ANOMALY_TRANSACTION.merchant,
        amount: centsToMoney(moneyToCents(ANOMALY_TRANSACTION.amount)),
        direction: 'DEBIT',
        occurredAt: ANOMALY_TRANSACTION.occurredAt,
      },
      reason: ANOMALY_TRANSACTION.anomalyReason,
      severity: 'low',
    });
  });

  it('a large refund CREDIT (>¥5,000) is not misreported as an anomaly', async () => {
    await insertRow({
      id: 'tx_probe_refund',
      amount: '6000.00',
      direction: 'CREDIT',
      category: '退款',
      merchant: '商户退款',
    });

    expect(await anomalyIds()).toEqual([ANOMALY_TRANSACTION.id]);
  });

  it('an operator-flagged row (isAnomaly: true) is surfaced regardless of direction', async () => {
    await insertRow({
      id: 'tx_probe_flagged_credit',
      amount: '7000.00',
      direction: 'CREDIT',
      category: '其他',
      merchant: '人工标记',
      isAnomaly: true,
      anomalyReason: '人工复核标记',
    });

    const report = await banking.transaction.detectAnomaly(DEMO_USER_ID);

    expect(report.anomalies).toHaveLength(2);
    const flagged = report.anomalies.find(
      (item) => item.transaction.id === 'tx_probe_flagged_credit',
    );
    expect(flagged).toMatchObject({
      transaction: { direction: 'CREDIT', amount: '7000.00' },
      reason: '人工复核标记',
    });
  });

  it('a >¥5,000 DEBIT is still flagged, and the TEST-LOCAL probe leaves the fixture count at 1', async () => {
    expect(ANOMALY_AMOUNT_THRESHOLD).toBe('5000.00');
    expect(await anomalyIds()).toEqual([ANOMALY_TRANSACTION.id]);

    await insertRow({
      id: 'tx_probe_large_debit',
      amount: '-8000.00',
      direction: 'DEBIT',
      category: '购物',
      merchant: '家电城',
    });

    const report = await banking.transaction.detectAnomaly(DEMO_USER_ID);
    expect(report.anomalies).toHaveLength(2);
    const probe = report.anomalies.find((item) => item.transaction.id === 'tx_probe_large_debit');
    expect(probe).toMatchObject({
      transaction: { amount: '-8000.00', direction: 'DEBIT', category: '购物' },
      severity: 'medium', // |−8000| > threshold × 1.5 (¥7,500)
    });
    expect(probe?.reason).toContain('Large consumption');

    // Removing the probe restores the canonical count — proving the extra row is test-local and the
    // shared fixture world (asserted by test-07) still has exactly ONE anomaly.
    await db().transaction.delete({ where: { id: 'tx_probe_large_debit' } });
    expect(await anomalyIds()).toEqual([ANOMALY_TRANSACTION.id]);
  });

  it('a >¥5,000 投资 (investment-flow) DEBIT is NOT flagged as 大额消费', async () => {
    // A real subscribe writes a −¥6,000 DEBIT in the investment-flow category: ABOVE the ¥5,000
    // automatic threshold, yet it must be excluded by category.
    const subscribed = await banking.investment.subscribeInvestment({
      userId: DEMO_USER_ID,
      productId: 'prod_wenjiana',
      amount: '6000.00',
    });
    expect(subscribed.newBalance).toBe('17580.00');

    const flow = await db().transaction.findFirst({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY, direction: 'DEBIT' },
    });
    expect(flow).toMatchObject({ amountMinor: -600_000n, channel: 'APP' });
    expect(absoluteMinor(flow?.amountMinor ?? 0n)).toBeGreaterThan(moneyToCents(ANOMALY_AMOUNT_THRESHOLD));

    expect(await anomalyIds()).toEqual([ANOMALY_TRANSACTION.id]);
  });

  it('listAnomalies (persisted isAnomaly rows) reports only the Apple Store row', async () => {
    const flagged: AnomalyItem[] = await banking.transaction.listAnomalies(DEMO_USER_ID);

    expect(flagged.map((item) => item.transaction.id)).toEqual([ANOMALY_TRANSACTION.id]);
  });
});
