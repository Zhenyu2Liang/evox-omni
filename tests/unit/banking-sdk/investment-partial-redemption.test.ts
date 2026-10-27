/**
 * Unit: banking-sdk/investment — PARTIAL redemption of a portion of a holding.
 *
 * WHAT it pins down (all through the SDK barrel `@/banking-sdk` + the test SQLite):
 *   1. A redemption口径 STRICTLY SMALLER than the position redeems that PORTION — by AMOUNT (converted
 *      to shares at the published net value) or by SHARES: the holding STAYS `HOLDING` with FEWER
 *      shares and less REMAINING COST, its unrounded market value is recomputed as
 *      `remainingShares × net value`, and ONE credit settles `HALF_UP(redeemedShares × net value)`.
 *      The realized profit is `settled − consumed cost`, the remaining cost is `cost − consumed`
 *      (cost conservation), and the position's CUMULATIVE profit is unchanged by redeeming — a
 *      redemption moves profit from unrealized to realized, it never creates any.
 *   2. The partial outcome is persisted on `InvestmentHolding.redemptionHistory` (one JSON record per
 *      portion, carrying the mode, shares, net value, quote, settled amount, remaining values and
 *      execution identity) while the account-flow `Transaction` row (`INVESTMENT_FLOW_CATEGORY`,
 *      CREDIT) mirrors the credit.
 *   3. REPLAY — a repeat with the SAME execution identity returns the persisted original outcome and
 *      credits NOTHING (even after a later FULL close).
 *   4. VALIDATION — an over-redeem (more shares than held, or an amount above the position's market
 *      value) or a non-positive/malformed portion is rejected with `AppError('VALIDATION')` BEFORE any
 *      write (no balance/holding/flow change).
 *
 * Fixtures: 活期 ¥23,580 (2358000 minor), the single holding `holding_wenjiana` (remaining cost
 * ¥5,000 = 500000 minor, 5050 shares, status HOLDING) and 稳健理财A, whose published net value is 1 so
 * 5050 shares are worth `5050`.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { InvestResult, TransactionView } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { AppError } from '@/lib/errors';
import { decimalText, formatDecimalCNY } from '@/lib/decimal';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

/** The seeded HOLDING (remaining cost ¥5,000, 5050 shares worth `5050`) — the redemption target. */
const SEEDED_HOLDING = 'holding_wenjiana';
/** The product whose published net value prices the position (1 before any case changes it). */
const SEEDED_PRODUCT = 'prod_wenjiana';
/** The funding account every redemption credits (fixture balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START_MINOR = 2_358_000n; // ¥23,580.00
/** The seeded position's cumulative profit before any redemption: `5050 − 5000`. */
const SEEDED_TOTAL_PROFIT = '50';

function db() {
  return getTestPrisma();
}

/** The seeded holding's current row (cost / shares / market value / status / redemption history). */
function holdingRow() {
  return db().investmentHolding.findUnique({ where: { id: SEEDED_HOLDING } });
}

async function checkingBalanceMinor(): Promise<bigint> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (!account) throw new Error(`${CHECKING} missing from fixtures`);
  return account.balanceMinor;
}

/** The investment-flow ledger rows (the account-flow CREDITs this spec settles), newest first. */
function flowRows(): Promise<TransactionView[]> {
  return banking.transaction.listTransactions(DEMO_USER_ID, { category: INVESTMENT_FLOW_CATEGORY });
}

/** The live view of the seeded position — where `cumulativeProfit` (realized + unrealized) is reported. */
async function holdingView() {
  return (await banking.investment.listHoldings(DEMO_USER_ID)).find((holding) => holding.id === SEEDED_HOLDING);
}

/** One persisted partial-redemption record (`InvestmentHolding.redemptionHistory`, owned by the SDK). */
interface RedemptionRecord {
  at: number;
  mode: 'SHARES' | 'AMOUNT' | 'ALL';
  shares: string;
  netValuePerUnit: string;
  netValueDate?: number;
  settledAmount: string;
  feeAmount: string;
  feeRule: string;
  cost: string;
  realizedProfit: string;
  remainingShares: string;
  remainingCost: string;
  remainingMarketValue: string;
  newBalance: string;
  sourceAccountId: string;
  executionKey?: string;
}

function redemptionHistory(raw: string | null | undefined): RedemptionRecord[] {
  return raw === null || raw === undefined ? [] : (JSON.parse(raw) as RedemptionRecord[]);
}

/** Redeem the seeded holding under an EXPLICIT口径 (`AMOUNT` / `SHARES` / `ALL`) — never a default. */
function redeem(input: {
  mode: 'AMOUNT' | 'SHARES' | 'ALL';
  amount?: string;
  shares?: string;
  idempotencyKey?: string;
  expectedSettlementAmount?: string;
}): Promise<InvestResult> {
  return banking.investment.redeemInvestment({
    userId: DEMO_USER_ID,
    holdingId: SEEDED_HOLDING,
    mode: input.mode,
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.shares !== undefined ? { shares: input.shares } : {}),
    ...(input.expectedSettlementAmount !== undefined ? { expectedSettlementAmount: input.expectedSettlementAmount } : {}),
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
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

describe('banking-sdk/investment · partial redemption (portion of the position)', () => {
  it('Case A · redeems a portion, keeps HOLDING and credits the settled share ONCE', async () => {
    // AMOUNT 2000.00 ÷ net value 1 = 2000 shares out of 5050, worth 2000 × 1 = ¥2,000.00.
    const result = await redeem({ mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'partial-1' });

    expect(result.partial).toBe(true);
    expect(result.mode).toBe('AMOUNT');
    expect(result.amount).toBe('2000.00');
    expect(result.redemptionValuation).toBe('2000');
    expect(result.settlementRounding).toBe('HALF_UP');
    expect(result.redeemedShares).toBe('2000');
    expect(result.remainingShares).toBe('3050');
    expect(result.netValuePerUnit).toBe('1');
    // Cost is consumed in proportion to the redeemed SHARES: HALF_UP(5000.00 × 2000/5050) = 1980.20.
    expect(result.redeemedPrincipal).toBe('1980.20');
    expect(result.remainingPrincipal).toBe('3019.80');
    expect(result.remainingCost).toBe('3019.80');
    expect(result.remainingMarketValue).toBe('3050');
    // Unrounded decimal text: 3050 − 3019.80 = 30.2 (canonical, no trailing zero).
    expect(result.remainingProfit).toBe('30.2');
    // Realized profit is the settled cash minus the consumed cost — never a fresh gain.
    expect(result.realizedProfit).toBe('19.80');
    expect(result.feeAmount).toBe('0.00');
    expect(result.feeRule).toBe('SIMULATED_NONE');
    expect(result.newBalance).toBe('25580.00');

    // The holding SURVIVES with fewer shares, less cost and a recomputed unrounded value.
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(301_980n);
    expect(row?.shares).toBe('3050');
    expect(row?.estimatedMarketValue).toBe('3050');
    expect(row?.realizedProfitMinor).toBe(1_980n);

    // Redeeming only MOVES profit: realized 19.80 + still-unrealized 30.20 = the seeded 50.00.
    // Unrounded decimal text: 3050 − 3019.80 = 30.2 (canonical, no trailing zero).
    const view = await holdingView();
    expect(view).toMatchObject({
      shares: '3050',
      amount: '3019.80',
      marketValue: '3050',
      profit: '30.2',
      realizedProfit: '19.80',
      cumulativeProfit: SEEDED_TOTAL_PROFIT,
    });

    // Exactly ONE credit: 2358000 + 200000 = 2558000 minor.
    expect(await checkingBalanceMinor()).toBe(2_558_000n);

    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: '2000.00',
      direction: 'CREDIT',
      category: INVESTMENT_FLOW_CATEGORY,
      merchant: '赎回',
      channel: 'APP',
    });

    // ONE persisted history record carrying the口径, quote, settlement and this portion's identity.
    const history = redemptionHistory(row?.redemptionHistory);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      mode: 'AMOUNT',
      shares: '2000',
      netValuePerUnit: '1',
      settledAmount: '2000.00',
      feeAmount: '0.00',
      feeRule: 'SIMULATED_NONE',
      cost: '1980.20',
      realizedProfit: '19.80',
      remainingShares: '3050',
      remainingCost: '3019.80',
      remainingMarketValue: '3050',
      newBalance: '25580.00',
      sourceAccountId: CHECKING,
      executionKey: 'partial-1',
    });
  });

  // Pins the DOCUMENTED at-most-once contract for a PARTIAL redemption: `investment.ts`'s module
  // header ("a repeat with the SAME identity returns that original outcome and credits nothing") and
  // `types.ts` `RedeemInvestmentInput.idempotencyKey` ("a repeat of a PARTIAL redemption replays the
  // stored partial outcome from redemptionHistory without crediting again"). The identity replay holds
  // while the holding is STILL `HOLDING`: the repeat returns the original outcome instead of
  // re-executing the portion and crediting a second time.
  it('Case B · replaying the SAME identity returns the original outcome and credits NOTHING', async () => {
    const first = await redeem({ mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'partial-1' });
    expect(first.newBalance).toBe('25580.00');
    expect(await checkingBalanceMinor()).toBe(2_558_000n);

    const replay = await redeem({ mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'partial-1' });

    // The SAME original outcome — no second credit, no second history record, no second flow row.
    expect(replay).toEqual(first);
    expect(await checkingBalanceMinor()).toBe(2_558_000n);
    const row = await holdingRow();
    expect(row?.principalAmountMinor).toBe(301_980n);
    expect(row?.shares).toBe('3050');
    expect(row?.estimatedMarketValue).toBe('3050');
    expect(redemptionHistory(row?.redemptionHistory)).toHaveLength(1);
    expect(await flowRows()).toHaveLength(1);
  });

  it('Case C · a distinct portion settles normally as a SECOND credit', async () => {
    const first = await redeem({ mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'k1' });
    expect(first.amount).toBe('2000.00');

    // 1000.00 ÷ net value 1 = 1000 shares out of the remaining 3050, worth 1000 × 1 = ¥1,000.00.
    const second = await redeem({ mode: 'AMOUNT', amount: '1000.00', idempotencyKey: 'k2' });
    expect(second.partial).toBe(true);
    expect(second.amount).toBe('1000.00');
    expect(second.redemptionValuation).toBe('1000');
    expect(second.redeemedShares).toBe('1000');
    expect(second.remainingShares).toBe('2050');
    // HALF_UP(3019.80 × 1000/3050) = 990.10 consumed, 2029.70 left.
    expect(second.redeemedPrincipal).toBe('990.10');
    expect(second.remainingPrincipal).toBe('2029.70');
    expect(second.remainingCost).toBe('2029.70');
    expect(second.remainingMarketValue).toBe('2050');
    // Unrounded decimal text: 2050 − 2029.70 = 20.3 (canonical, no trailing zero).
    expect(second.remainingProfit).toBe('20.3');
    // THIS portion's realized profit only: 1000.00 settled − 990.10 consumed cost = 9.90.
    // The cumulative 19.80 + 9.90 = 29.70 lives on the holding (see the view assertions below).
    expect(second.realizedProfit).toBe('9.90');
    expect(second.newBalance).toBe('26580.00');

    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(202_970n);
    expect(row?.shares).toBe('2050');
    expect(row?.estimatedMarketValue).toBe('2050');
    expect(row?.realizedProfitMinor).toBe(2_970n);

    // Cost conservation + no invented profit after TWO portions: 29.70 realized + 20.3 unrealized.
    const view = await holdingView();
    expect(view).toMatchObject({
      shares: '2050',
      amount: '2029.70',
      marketValue: '2050',
      profit: '20.3',
      realizedProfit: '29.70',
      cumulativeProfit: SEEDED_TOTAL_PROFIT,
    });

    // 2358000 + 200000 + 100000 = 2658000 minor.
    expect(await checkingBalanceMinor()).toBe(2_658_000n);

    const history = redemptionHistory(row?.redemptionHistory);
    expect(history).toHaveLength(2);
    expect(history.map((record) => record.executionKey)).toEqual(['k1', 'k2']);
    expect(history[1]).toMatchObject({
      mode: 'AMOUNT',
      shares: '1000',
      settledAmount: '1000.00',
      cost: '990.10',
      realizedProfit: '9.90',
      remainingShares: '2050',
      remainingCost: '2029.70',
      executionKey: 'k2',
    });
    // Consumed + remaining cost always add back up to the cost before the portion.
    expect(history[1].cost).toBe('990.10');
    expect(history[1].remainingCost).toBe('2029.70');

    // TWO credits, each settled from the SHARES it redeemed.
    const flow = await flowRows();
    expect(flow).toHaveLength(2);
    expect(flow.map((row) => row.amount).sort()).toEqual(['1000.00', '2000.00']);
  });

  it('Case D · over-redeem is rejected before any write', async () => {
    // More shares than held …
    const overShares = await rejectionOf(() => redeem({ mode: 'SHARES', shares: '6000' }));
    expect(overShares).toBeInstanceOf(AppError);
    expect((overShares as AppError).code).toBe('VALIDATION');

    // … and an amount above the position's market value (5050 shares × 1) are both rejected.
    const overAmount = await rejectionOf(() => redeem({ mode: 'AMOUNT', amount: '6000.00' }));
    expect(overAmount).toBeInstanceOf(AppError);
    expect((overAmount as AppError).code).toBe('VALIDATION');

    // NOTHING moved: balance, holding cost/shares and the flow ledger are all untouched.
    expect(await checkingBalanceMinor()).toBe(CHECKING_START_MINOR);
    expect(await flowRows()).toHaveLength(0);
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(500_000n);
    expect(row?.shares).toBe('5050');
    expect(redemptionHistory(row?.redemptionHistory)).toHaveLength(0);
  });

  it('Case E · non-positive portions are rejected with no write', async () => {
    for (const bad of ['0.00', '-1.00']) {
      const error = await rejectionOf(() => redeem({ mode: 'AMOUNT', amount: bad, idempotencyKey: `bad-${bad}` }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION');
    }
    for (const bad of ['0', '-1']) {
      const error = await rejectionOf(() => redeem({ mode: 'SHARES', shares: bad, idempotencyKey: `bad-shares-${bad}` }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION');
    }

    expect(await checkingBalanceMinor()).toBe(CHECKING_START_MINOR);
    expect(await flowRows()).toHaveLength(0);
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(500_000n);
    expect(row?.shares).toBe('5050');
    expect(redemptionHistory(row?.redemptionHistory)).toHaveLength(0);
  });

  it('Case F · a full close after a partial settles the remainder; the earlier partial still replays', async () => {
    const partial = await redeem({ mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'k1' });
    expect(partial.amount).toBe('2000.00');
    expect(await checkingBalanceMinor()).toBe(2_558_000n);

    // `ALL` closes the remaining 3050 shares; the whole remaining valuation settles.
    const close = await redeem({ mode: 'ALL' });
    expect(close.partial).toBeUndefined();
    expect(close.mode).toBe('ALL');
    expect(close.redeemedShares).toBe('3050');
    expect(close.amount).toBe('3050.00');
    expect(close.realizedProfit).toBe('30.20');
    expect(close.newBalance).toBe('28630.00');

    const closed = await holdingRow();
    expect(closed?.status).toBe('REDEEMED');
    expect(closed?.shares).toBe('0');
    expect(closed?.principalAmountMinor).toBe(0n);
    // Realized across both portions: 19.80 + 30.20 = the seeded 50.00 (5050 − 5000), no more.
    expect(closed?.realizedProfitMinor).toBe(5_000n);
    // 2000 + 3050 = 5050 total credited: 2358000 + 505000 = 2863000 minor.
    expect(await checkingBalanceMinor()).toBe(2_863_000n);
    expect(await flowRows()).toHaveLength(2);

    // Replaying the EARLIER partial identity AFTER the full close still returns its original outcome…
    const replay = await redeem({ mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'k1' });
    expect(replay).toEqual(partial);

    // …and credits nothing more: the balance and the flow ledger are unchanged.
    expect(await checkingBalanceMinor()).toBe(2_863_000n);
    expect(await flowRows()).toHaveLength(2);
  });

  // REGRESSION for the display change (commit 55369a5: `formatDecimalCNY` now rounds CNY to exactly
  // TWO decimals HALF_UP). Presentation rounding must NOT leak into the UNDERLYING valuation or
  // settlement: a partial redemption still stores the remainder at the FULL unrounded precision of
  // `shares × net value` (up to ten fractional digits) and settles the redeemed share with ONE HALF_UP
  // step at the cent boundary — exactly as before the display change.
  it('Case G · a long-fraction quote settles ONCE at cents and keeps the remainder UNROUNDED', async () => {
    // 4096.123456 shares × published net value 1.2345 = an UNROUNDED ¥5,056.664406432 position.
    await db().investmentHolding.update({
      where: { id: SEEDED_HOLDING },
      data: { shares: decimalText('4096.123456') },
    });
    await db().investmentProduct.update({
      where: { id: SEEDED_PRODUCT },
      data: { latestNetValuePerUnit: decimalText('1.2345') },
    });

    const result = await redeem({ mode: 'SHARES', shares: '1234.56789', idempotencyKey: 'partial-precision' });

    // Settlement: 1234.56789 × 1.2345 = 1524.074060205 → HALF_UP ONCE → ¥1,524.07.
    expect(result.partial).toBe(true);
    expect(result.mode).toBe('SHARES');
    expect(result.redeemedShares).toBe('1234.56789');
    expect(result.redemptionValuation).toBe('1524.074060205');
    expect(result.amount).toBe('1524.07');
    expect(result.settlementRounding).toBe('HALF_UP');
    // HALF_UP(5000.00 × 1234.56789/4096.123456) = 1507.00 consumed, 3493.00 left.
    expect(result.redeemedPrincipal).toBe('1507.00');
    expect(result.remainingPrincipal).toBe('3493.00');
    expect(result.remainingShares).toBe('2861.555566');
    // Remainder = 2861.555566 × 1.2345 = 3532.590346227 (and redeemed + remainder = 5056.664406432).
    expect(result.remainingMarketValue).toBe('3532.590346227');
    expect(result.remainingProfit).toBe('39.590346227');
    expect(result.realizedProfit).toBe('17.07');
    expect(result.newBalance).toBe('25104.07');

    // The remainder is PERSISTED at FULL unrounded precision (nine fraction digits) — NOT the
    // two-decimal display form and NOT the rounded cents; the row matches the result's own valuation.
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(349_300n);
    expect(row?.shares).toBe('2861.555566');
    expect(row?.estimatedMarketValue).toBe('3532.590346227');
    expect(row?.estimatedMarketValue).toBe(result.remainingMarketValue);
    expect((row?.estimatedMarketValue ?? '').split('.')[1]).toHaveLength(9);

    // The DISPLAY boundary rounds that SAME stored value to ¥3,532.59 — yet storage keeps precision.
    expect(formatDecimalCNY(result.remainingMarketValue ?? '')).toBe('¥3,532.59');
    expect(row?.estimatedMarketValue).not.toBe('3532.59');

    // Exactly ONE credit of the SINGLE HALF_UP settlement: 2358000 + 152407 = 2510407 minor.
    expect(await checkingBalanceMinor()).toBe(2_510_407n);
    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: '1524.07',
      direction: 'CREDIT',
      category: INVESTMENT_FLOW_CATEGORY,
    });
  });
});
