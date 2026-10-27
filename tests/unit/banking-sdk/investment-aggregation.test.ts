/**
 * Unit: banking-sdk/investment — AGGREGATION of a buy-more purchase into an EXISTING holding.
 *
 * Targets `@/banking-sdk` → `banking.investment.subscribeInvestment` and pins the SDK's buy-more
 * contract (verified at HEAD against `banking-sdk/investment.ts`):
 *   - a purchase of a product the user does NOT hold CREATES a HOLDING (`addedToExisting: false`),
 *     records the CREATING purchase as `purchaseHistory[0]` (also persisted as `subscribeResult`),
 *     and writes exactly one `投资` (INVESTMENT_FLOW_CATEGORY) DEBIT row;
 *   - a purchase of a product the user ALREADY HOLDS AGGREGATES into that SAME row
 *     (`addedToExisting: true`, `lastPurchaseAt`), grows the principal, values the new principal at
 *     cost (`newMV = oldMV ?? centsToMoney(oldPrincipal) + centsToMoney(amount)`, time base = the
 *     purchase instant) and APPENDS a record — never a second holding;
 *   - after a full redemption the (REDEEMED) holding is NOT reused: the next purchase opens a NEW
 *     holding (`addedToExisting: false`);
 *   - an AGGREGATING purchase repeated with the SAME idempotency key replays its original outcome —
 *     no second debit, no second history record.
 *
 * Fixtures: 活期 ¥23,580; the single HOLDING `holding_wenjiana` (稳健理财A, principal ¥5,000,
 * estimatedMarketValue `5050`); `prod_huobi` (货币基金, min ¥100) is NOT held.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { InvestResult } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { demoNow } from '@/lib/clock';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

/** The funding account every subscribe moves (fixture balance ¥23,580). */
const CHECKING = 'acct_checking';
/** The single seeded HOLDING (稳健理财A, principal ¥5,000, estimatedMarketValue `5050`). */
const SEEDED_HOLDING = 'holding_wenjiana';
/** 稳健理财A — seeded HOLDING, minAmount ¥1,000. */
const WENJIANA = 'prod_wenjiana';
/** 货币基金 — NOT held in the fixtures, minAmount ¥100. */
const HUOBI = 'prod_huobi';

/** One `InvestmentHolding.purchaseHistory` record (owned by `banking-sdk/investment.ts`). */
interface PurchaseRecord {
  at: number;
  amount: string;
  totalPrincipal: string;
  marketValue: string;
  newBalance: string;
  sourceAccountId: string;
  executionKey?: string;
}

function db() {
  return getTestPrisma();
}

async function checkingBalanceMinor(): Promise<bigint> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (!account) throw new Error(`${CHECKING} missing from fixtures`);
  return account.balanceMinor;
}

/** ALL holdings for (user, product), whatever the status — proves whether a second row was opened. */
function holdingCount(productId: string): Promise<number> {
  return db().investmentHolding.count({ where: { userId: DEMO_USER_ID, productId } });
}

async function holdingById(id: string) {
  const holding = await db().investmentHolding.findUnique({ where: { id } });
  if (!holding) throw new Error(`holding ${id} missing`);
  return holding;
}

/** Parse the (nullable) JSON-text purchase history; a NULL column is `[]`. */
function historyOf(raw: string | null): PurchaseRecord[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('purchaseHistory is not a JSON array');
  return parsed as PurchaseRecord[];
}

function subscribe(productId: string, amount: string, idempotencyKey?: string): Promise<InvestResult> {
  return banking.investment.subscribeInvestment({
    userId: DEMO_USER_ID,
    productId,
    amount,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

function investmentFlowRows() {
  return banking.transaction.listTransactions(DEMO_USER_ID, { category: INVESTMENT_FLOW_CATEGORY });
}

describe('banking-sdk/investment · aggregation — creating a holding', () => {
  it('a first purchase of an un-held product creates ONE holding and records the creating purchase', async () => {
    expect(await holdingCount(HUOBI)).toBe(0);
    expect(await checkingBalanceMinor()).toBe(2_358_000n);

    const result = await subscribe(HUOBI, '1000.00');

    expect(result.success).toBe(true);
    expect(result.addedToExisting).toBe(false);
    // `lastPurchaseAt` is the purchase instant — the SAME epoch ms the result reports as `occurredAt`.
    expect(typeof result.lastPurchaseAt).toBe('number');
    expect(result.lastPurchaseAt).toBe(result.occurredAt);
    expect(result.lastPurchaseAt).toBe(demoNow());
    expect(result.newBalance).toBe('22580.00');

    expect(await holdingCount(HUOBI)).toBe(1);
    const holding = await holdingById(result.holdingId);
    expect(holding).toMatchObject({ productId: HUOBI, status: 'HOLDING', principalAmountMinor: 100_000n });

    // The creating purchase is the SOLE history record (no executionKey on an unkeyed purchase).
    const history = historyOf(holding.purchaseHistory);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      amount: '1000.00',
      totalPrincipal: '1000.00',
      newBalance: '22580.00',
      sourceAccountId: 'acct_checking',
      at: demoNow(),
    });
    expect(history[0].executionKey).toBeUndefined();

    expect(await checkingBalanceMinor()).toBe(2_258_000n);
  });
});

describe('banking-sdk/investment · aggregation — keeping ONE holding', () => {
  it('a second purchase aggregates: principal grows, both purchases recorded, ONE holding, TWO flow rows', async () => {
    const first = await subscribe(HUOBI, '1000.00');
    expect(first.newBalance).toBe('22580.00');

    const second = await subscribe(HUOBI, '2000.00');

    expect(second.success).toBe(true);
    expect(second.addedToExisting).toBe(true);
    expect(second.holdingId).toBe(first.holdingId);
    expect(second.amount).toBe('2000.00');
    expect(second.newBalance).toBe('20580.00');

    // EXACTLY ONE holding for (user, product) — the second purchase did not open a second row.
    expect(await holdingCount(HUOBI)).toBe(1);
    const holding = await holdingById(second.holdingId);
    expect(holding.principalAmountMinor).toBe(300_000n);
    expect(holding.status).toBe('HOLDING');

    // BOTH purchases, oldest → newest: the creating one then the aggregation.
    const history = historyOf(holding.purchaseHistory);
    expect(history).toHaveLength(2);
    expect(history.map((record) => record.amount)).toEqual(['1000.00', '2000.00']);
    expect(history.map((record) => record.totalPrincipal)).toEqual(['1000.00', '3000.00']);
    expect(history[1].newBalance).toBe('20580.00');

    expect(await checkingBalanceMinor()).toBe(2_058_000n);

    // Two account-flow DEBIT rows — one per purchase, in the shared investment-flow category.
    const flows = await investmentFlowRows();
    expect(flows).toHaveLength(2);
    expect(flows.every((row) => row.direction === 'DEBIT')).toBe(true);
    expect(flows.every((row) => row.category === INVESTMENT_FLOW_CATEGORY)).toBe(true);
  });
});

describe('banking-sdk/investment · aggregation — recomputing the market value', () => {
  it('buying more 稳健理财A aggregates into the seeded HOLDING and values the new principal at cost', async () => {
    const before = await holdingById(SEEDED_HOLDING);
    expect(before.principalAmountMinor).toBe(500_000n);
    expect(before.estimatedMarketValue).toBe('5050');

    const result = await subscribe(WENJIANA, '1000.00');

    // SAME row — the seeded holding, aggregated, not a new one.
    expect(result.holdingId).toBe(SEEDED_HOLDING);
    expect(result.addedToExisting).toBe(true);
    expect(result.newBalance).toBe('22580.00');

    const holding = await holdingById(SEEDED_HOLDING);
    expect(holding.principalAmountMinor).toBe(600_000n);
    // newMV = (oldMV '5050') + (amount '1000.00') = '6050' (added at cost, no accrual).
    expect(holding.estimatedMarketValue).toBe('6050');
    expect(holding.status).toBe('HOLDING');

    expect(await holdingCount(WENJIANA)).toBe(1);
    expect(await checkingBalanceMinor()).toBe(2_258_000n);
  });
});

describe('banking-sdk/investment · aggregation — recording the creating purchase too', () => {
  it('after two purchases the history is [creating, aggregation], both pointing at the funding account', async () => {
    const first = await subscribe(HUOBI, '1000.00');
    await subscribe(HUOBI, '2000.00');

    const holding = await holdingById(first.holdingId);
    const history = historyOf(holding.purchaseHistory);

    expect(history).toHaveLength(2);
    // [0] = the CREATING purchase; [1] = the aggregation into the same holding.
    expect(history[0]).toMatchObject({ amount: '1000.00', totalPrincipal: '1000.00', sourceAccountId: 'acct_checking' });
    expect(history[1]).toMatchObject({ amount: '2000.00', totalPrincipal: '3000.00', sourceAccountId: 'acct_checking' });
  });
});

describe('banking-sdk/investment · aggregation — after a full redemption', () => {
  it('a purchase after a full redemption opens a NEW holding instead of aggregating', async () => {
    const redeemed = await banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: SEEDED_HOLDING,
      mode: 'ALL',
    });
    expect(redeemed.amount).toBe('5050.00');
    expect((await holdingById(SEEDED_HOLDING)).status).toBe('REDEEMED');

    const result = await subscribe(WENJIANA, '1000.00');

    expect(result.addedToExisting).toBe(false);
    expect(result.holdingId).not.toBe(SEEDED_HOLDING);

    const fresh = await holdingById(result.holdingId);
    expect(fresh).toMatchObject({ productId: WENJIANA, status: 'HOLDING', principalAmountMinor: 100_000n });

    // The closed holding stays REDEEMED; exactly ONE HOLDING row exists for the product now — the new one.
    const open = await db().investmentHolding.findMany({
      where: { userId: DEMO_USER_ID, productId: WENJIANA, status: 'HOLDING' },
    });
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(result.holdingId);
  });
});

describe('banking-sdk/investment · aggregation — at-most-once with a key', () => {
  it('repeating an AGGREGATING purchase with the SAME key neither re-debits nor re-appends', async () => {
    await subscribe(HUOBI, '1000.00');
    const KEY = 'plan:task_aggregate:node_1';

    const first = await subscribe(HUOBI, '2000.00', KEY);
    expect(first.addedToExisting).toBe(true);
    expect(first.newBalance).toBe('20580.00');

    const replay = await subscribe(HUOBI, '2000.00', KEY);
    expect(replay).toEqual(first);

    // No second debit, no second history record: principal, balance and history are unmoved.
    expect(await checkingBalanceMinor()).toBe(2_058_000n);
    expect(await holdingCount(HUOBI)).toBe(1);
    const holding = await holdingById(first.holdingId);
    expect(holding.principalAmountMinor).toBe(300_000n);
    expect(historyOf(holding.purchaseHistory)).toHaveLength(2);
  });
});
