/**
 * Unit: banking-sdk/investment — INVESTMENT-FLOW LEDGER regression (the subscribe/redeem
 * account-flow `Transaction` row).
 *
 * WHAT it pins down (all through the SDK barrel `@/banking-sdk` + the test SQLite):
 *   1. Ledger CONSISTENCY — a subscribe writes its account-flow row (`category =
 *      INVESTMENT_FLOW_CATEGORY`, DEBIT, `-amount`, merchant `认购<product>`, channel `APP`) in the
 *      SAME transaction as the funding-account debit + the new holding; a redeem writes the mirrored
 *      CREDIT row (`+marketValue`, merchant `赎回`) together with the credit + HOLDING→REDEEMED flip.
 *   2. CLASSIFICATION — a flow row is NOT consumption (never in `analyzeSpending`: 本月 stays
 *      ¥5,800, no `投资` category, never `largest`), is NOT income/大额消费 (`detect_anomaly` still
 *      reports ONLY the Apple Store row even when the flow magnitude exceeds the ¥5,000 threshold)
 *      and does NOT count toward the ¥1,000 daily-transfer limit (`channel: 'APP'`, so
 *      `computeDailyTransferTotal` is unmoved).
 *   3. AT-MOST-ONCE — a repeated call and two CONCURRENT calls with the SAME idempotency key debit/
 *      credit the account exactly once (one holding / one flow row each); a DISTINCT or absent key on
 *      an already-redeemed holding is `CONFLICT` (never a second credit, never a new flow row).
 *   4. ATOMICITY — a forced failure of the flow-row insert rolls the balance + holding back with it
 *      (nothing partial, error surfaced, typed `AppError` code intact).
 *
 * Fixtures: 活期 ¥23,580, the single holding `holding_wenjiana` (marketValue ¥5,050), 稳健理财A.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { InvestResult, TransactionView } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { ANOMALY_AMOUNT_THRESHOLD } from '@/lib/constants';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { absoluteMinor, addMoney, centsToMoney, moneyToCents } from '@/lib/money';
import { compareDecimal } from '@/lib/decimal';
import { computeDailyTransferTotal } from '@/security/risk-engine';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { ANOMALY_TRANSACTION, DEMO_USER_ID, MONTHLY_SPEND_TOTAL } from '../../helpers/fixtures';
import { withInjectedWriteFailure } from '../../helpers/write-failure';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

/** Funding account every subscribe/redeem moves (fixture balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START = '23580.00';
/** The single seeded HOLDING (marketValue ¥5,050) — the redeem target. */
const SEEDED_HOLDING = 'holding_wenjiana';
const HOLDING_MARKET_VALUE = '5050.00';
/** 稳健理财A — minAmount ¥1,000. */
const PRODUCT = 'prod_wenjiana';

function db() {
  return getTestPrisma();
}

async function checkingBalance(): Promise<string> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (!account) throw new Error(`${CHECKING} missing from fixtures`);
  return centsToMoney(account.balanceMinor);
}

function holdingCount(): Promise<number> {
  return db().investmentHolding.count({ where: { userId: DEMO_USER_ID } });
}

/** EVERY ledger row of the user — proves no orphan `Transaction` row of any kind was written. */
function allLedgerCount(): Promise<number> {
  return db().transaction.count({ where: { userId: DEMO_USER_ID } });
}

/** The investment-flow rows (the account-flow ledger rows this spec is about), newest first. */
function flowRows(): Promise<TransactionView[]> {
  return banking.transaction.listTransactions(DEMO_USER_ID, { category: INVESTMENT_FLOW_CATEGORY });
}

function subscribe(idempotencyKey?: string) {
  return banking.investment.subscribeInvestment({
    userId: DEMO_USER_ID,
    productId: PRODUCT,
    amount: '5000.00',
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

function redeem(idempotencyKey?: string) {
  return banking.investment.redeemInvestment({
    userId: DEMO_USER_ID,
    holdingId: SEEDED_HOLDING,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

/** Await `fn`, returning whatever it rejected with; fails loudly if it unexpectedly resolves. */
async function rejectionOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** Resolve the settled values of concurrent calls, asserting every one succeeded. */
function fulfilledValues<T>(results: readonly PromiseSettledResult<T>[]): T[] {
  const values: T[] = [];
  for (const result of results) {
    expect(result.status).toBe('fulfilled');
    if (result.status === 'fulfilled') values.push(result.value);
  }
  return values;
}

describe('banking-sdk/investment · flow ledger row (consistency)', () => {
  it('subscribe writes the DEBIT 投资 flow row in the SAME unit as the debit + the holding', async () => {
    expect(await checkingBalance()).toBe(CHECKING_START);
    expect(await flowRows()).toHaveLength(0);

    const result = await subscribe();

    expect(result.success).toBe(true);
    expect(result.newBalance).toBe('18580.00');
    expect(await checkingBalance()).toBe('18580.00');

    // The holding really landed…
    const holding = await db().investmentHolding.findUnique({ where: { id: result.holdingId } });
    expect(holding).toMatchObject({ productId: PRODUCT, principalAmountMinor: 500_000n, status: 'HOLDING' });

    // …and so did exactly one ledger row mirroring the debit, in the investment-flow category.
    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: '-5000.00',
      direction: 'DEBIT',
      category: INVESTMENT_FLOW_CATEGORY,
      merchant: '认购稳健理财A',
      channel: 'APP',
      occurredAt: demoNow(),
      isAnomaly: false,
    });
  });

  it('redeem writes the mirrored CREDIT 投资 flow row together with the credit + HOLDING→REDEEMED', async () => {
    const result = await redeem();

    expect(result.amount).toBe(HOLDING_MARKET_VALUE);
    expect(result.newBalance).toBe('28630.00');
    expect(await checkingBalance()).toBe('28630.00');

    const holding = await db().investmentHolding.findUnique({ where: { id: SEEDED_HOLDING } });
    expect(holding?.status).toBe('REDEEMED');

    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: HOLDING_MARKET_VALUE, // credited by marketValue, not principal
      direction: 'CREDIT',
      category: INVESTMENT_FLOW_CATEGORY,
      merchant: '赎回',
      channel: 'APP',
      occurredAt: demoNow(),
      isAnomaly: false,
    });
  });
});

describe('banking-sdk/investment · flow ledger row (classification)', () => {
  it('a >¥5,000 flow in BOTH directions is excluded from spending, anomalies and the daily-transfer limit', async () => {
    expect(ANOMALY_AMOUNT_THRESHOLD).toBe('5000.00');
    // Before any flow: the day's transfer total is 0 (the seeded ¥500 转账 is dated Sep 4, not today).
    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe('0.00');

    // A ¥6,000 subscribe (magnitude ABOVE the ¥5,000 anomaly threshold) and a ¥5,050 redeem.
    const subscribed = await banking.investment.subscribeInvestment({
      userId: DEMO_USER_ID,
      productId: PRODUCT,
      amount: '6000.00',
    });
    expect(subscribed.newBalance).toBe('17580.00');
    await redeem();

    const flow = await flowRows();
    expect(flow.map((row) => row.amount).sort(compareDecimal)).toEqual(['-6000.00', HOLDING_MARKET_VALUE]);
    expect(flow.every((row) => row.category === INVESTMENT_FLOW_CATEGORY)).toBe(true);
    // `channel: 'APP'` is what keeps the flow out of the ¥1,000 daily-TRANSFER window.
    expect(flow.every((row) => row.channel === 'APP')).toBe(true);
    expect(absoluteMinor(moneyToCents(flow[0].amount))).toBeGreaterThan(moneyToCents(ANOMALY_AMOUNT_THRESHOLD));

    // NOT consumption: 本月 stays anchored at ¥5,800 and no 投资 category / 认购 merchant appears.
    const spend = await banking.transaction.analyzeSpending(DEMO_USER_ID);
    expect(spend.total).toBe(addMoney(MONTHLY_SPEND_TOTAL, centsToMoney(absoluteMinor(moneyToCents(ANOMALY_TRANSACTION.amount)))));
    expect(spend.byCategory.map((entry) => entry.category)).not.toContain(INVESTMENT_FLOW_CATEGORY);
    expect(spend.largest?.merchant).not.toBe('认购稳健理财A');

    // NOT salary / 大额消费: only the seeded Apple Store row is an anomaly.
    const report = await banking.transaction.detectAnomaly(DEMO_USER_ID);
    expect(report.anomalies.map((item) => item.transaction.id)).toEqual([ANOMALY_TRANSACTION.id]);

    // NOT a transfer: the day's transfer total is still 0 despite a ¥6,000 account-flow debit.
    expect(await computeDailyTransferTotal(DEMO_USER_ID)).toBe('0.00');
  });
});

describe('banking-sdk/investment · at-most-once (idempotency)', () => {
  it('a repeated subscribe with the SAME key replays the holding and debits ONCE', async () => {
    const KEY = 'plan:task_subscribe:node_1';

    const first = await subscribe(KEY);
    const replay = await subscribe(KEY);

    expect(first.newBalance).toBe('18580.00');
    expect(replay).toEqual(first);
    // Debited exactly once: the balance is unchanged by the replay…
    expect(await checkingBalance()).toBe('18580.00');
    // …exactly ONE holding carries the key, and exactly ONE flow row was written.
    expect(await db().investmentHolding.count({ where: { idempotencyKey: KEY } })).toBe(1);
    expect(await flowRows()).toHaveLength(1);
  });

  it('two CONCURRENT subscribes with the SAME key debit ONCE (one holding, one flow row)', async () => {
    const KEY = 'plan:task_subscribe_race:node_1';

    const values = fulfilledValues(
      await Promise.allSettled([subscribe(KEY), subscribe(KEY)]),
    );

    expect(values[0].holdingId).toBe(values[1].holdingId);
    expect(values.map((value: InvestResult) => value.amount)).toEqual(['5000.00', '5000.00']);
    expect(await checkingBalance()).toBe('18580.00');
    expect(await db().investmentHolding.count({ where: { idempotencyKey: KEY } })).toBe(1);
    expect(await flowRows()).toHaveLength(1);
  });

  it('two CONCURRENT redeems with the SAME key credit ONCE and write ONE flow row', async () => {
    const KEY = 'plan:task_redeem_race:node_2';

    const values = fulfilledValues(
      await Promise.allSettled([redeem(KEY), redeem(KEY)]),
    );

    // Both report the ORIGINAL redemption (the loser replays it), and it was applied once.
    expect(values.map((value: InvestResult) => value.amount)).toEqual([
      HOLDING_MARKET_VALUE,
      HOLDING_MARKET_VALUE,
    ]);
    expect(values.map((value: InvestResult) => value.holdingId)).toEqual([
      SEEDED_HOLDING,
      SEEDED_HOLDING,
    ]);
    expect(await checkingBalance()).toBe('28630.00');
    expect(await flowRows()).toHaveLength(1);
  });

  it('an absent or DISTINCT key on an already-redeemed holding → CONFLICT with no extra credit/flow row', async () => {
    await redeem('plan:task_redeem:node_1');
    expect(await checkingBalance()).toBe('28630.00');
    expect(await flowRows()).toHaveLength(1);

    const absent = await rejectionOf(() => redeem());
    expect(absent).toBeInstanceOf(AppError);
    expect((absent as AppError).code).toBe('CONFLICT');

    const distinct = await rejectionOf(() => redeem('plan:task_other:node_9'));
    expect(distinct).toBeInstanceOf(AppError);
    expect((distinct as AppError).code).toBe('CONFLICT');

    // Never a second credit, never a second flow row.
    expect(await checkingBalance()).toBe('28630.00');
    expect(await flowRows()).toHaveLength(1);
  });
});

describe('banking-sdk/investment · flow ledger row (atomicity)', () => {
  it('a failing flow-row insert rolls back balance + holding, surfacing the bare error', async () => {
    const holdingsBefore = await holdingCount();
    const ledgerBefore = await allLedgerCount();
    expect(await checkingBalance()).toBe(CHECKING_START);

    const error = await rejectionOf(() =>
      withInjectedWriteFailure('transaction', 'create', () => subscribe()),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected failure/);

    // Balance + holding + flow commits or rolls back TOGETHER: no partial write survived.
    expect(await checkingBalance()).toBe(CHECKING_START);
    expect(await holdingCount()).toBe(holdingsBefore);
    expect(await allLedgerCount()).toBe(ledgerBefore);
    expect(await flowRows()).toHaveLength(0);
  });

  it('a TYPED AppError from the flow-row insert rolls back too and keeps its code', async () => {
    const holdingsBefore = await holdingCount();
    const ledgerBefore = await allLedgerCount();

    const error = await rejectionOf(() =>
      withInjectedWriteFailure(
        'transaction',
        'create',
        () => subscribe(),
        () => {
          throw new AppError('INTERNAL', 'flow write failed');
        },
      ),
    );

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL');
    expect((error as AppError).message).toBe('flow write failed');

    expect(await checkingBalance()).toBe(CHECKING_START);
    expect(await holdingCount()).toBe(holdingsBefore);
    expect(await allLedgerCount()).toBe(ledgerBefore);
    expect(await flowRows()).toHaveLength(0);
  });
});
