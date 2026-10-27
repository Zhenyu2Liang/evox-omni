/**
 * Unit: banking-sdk/investment — the 「净值 + 份额」 redemption model (see `docs/cn/investments.md`).
 *
 * WHAT it pins down, every case with CONCRETE numbers through the SDK barrel `@/banking-sdk` and the
 * test SQLite:
 *   1. AGGREGATION — a second purchase of the same product merges shares AND cost, and the paid amount
 *      never shows up as profit; two purchases write two account-flow rows.
 *   2. PARTIAL `SHARES` / `AMOUNT` — the remaining shares, remaining cost, remaining market value and
 *      remaining profit stay consistent with each other and with the persisted row.
 *   3. FULL CLOSE (`ALL`) — shares/cost/market value collapse to zero, the whole gain becomes realized
 *      profit, and the position leaves the ACTIVE holdings list.
 *   4. PROFIT vs LOSS — a net value above and below the cost basis gives a realized sign and amount of
 *      the right direction (`+230.29` / `-192.31`).
 *   5. PRECISION — net value 4 dp, shares FLOOR-ed to 6 dp with the residual cent left in cost, the
 *      SINGLE HALF_UP settlement step at the exact `.xx5` / `.xx4` boundary, and two consecutive
 *      partial redemptions whose shares and cash add up.
 *   6. IDEMPOTENCY — the same execution identity replays the original outcome and credits nothing.
 *   7. CONCURRENCY — two simultaneous redemptions of the same position never oversell or overpay.
 *   8. FIVE-WAY CONSERVATION — account cash, shares, remaining cost, profit and the ledger row move
 *      together.
 *
 * Fixtures (`tests/helpers/fixtures.ts`): 活期 ¥23,580 (2,358,000 minor) and ONE holding
 * `holding_wenjiana` — 稳健理财A, `shares '5050'`, remaining cost ¥5,000 (500,000 minor), realized
 * profit 0, i.e. a position worth 5050 × 1 = ¥5,050 (+50) at the published net value `1.0000`.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { HoldingView, InvestResult, TransactionView } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { AppError } from '@/lib/errors';
import { addDecimal, compareDecimal, decimalText, multiplyDecimal, subtractDecimal } from '@/lib/decimal';
import { moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

/** The seeded HOLDING (5050 shares, ¥5,000 remaining cost) — the redemption target. */
const SEEDED_HOLDING = 'holding_wenjiana';
/** 稳健理财A — net value `1.0000`, ¥1,000 minimum; it holds the seeded position. */
const WENJIANA = 'prod_wenjiana';
/** 稳健理财B — net value `0.9880`, ¥5,000 minimum, no seeded position. */
const WENJIANB = 'prod_wenjib';
/** 货币基金 — net value `1.0000`, ¥100 minimum, no seeded position. */
const HUOBI = 'prod_huobi';
/** The funding account every purchase debits and every redemption credits. */
const CHECKING = 'acct_checking';
const CHECKING_START_MINOR = 2_358_000n; // ¥23,580.00
/** The position's booked cost basis before any redemption (¥5,000.00). */
const SEEDED_COST = '5000.00';

function db() {
  return getTestPrisma();
}

/** The seeded holding's row (shares / remaining cost / status / realized profit / history). */
async function holdingRow() {
  const row = await db().investmentHolding.findUnique({ where: { id: SEEDED_HOLDING } });
  if (row === null) throw new Error(`${SEEDED_HOLDING} missing from the fixtures`);
  return row;
}

async function checkingBalanceMinor(): Promise<bigint> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (account === null) throw new Error(`${CHECKING} missing from the fixtures`);
  return account.balanceMinor;
}

/** The investment-flow ledger rows (`INVESTMENT_FLOW_CATEGORY`), newest first. */
function flowRows(): Promise<TransactionView[]> {
  return banking.transaction.listTransactions(DEMO_USER_ID, { category: INVESTMENT_FLOW_CATEGORY });
}

/** The ACTIVE holdings (`listHoldings` only reports `HOLDING`; a closed position disappears). */
function holdings(): Promise<HoldingView[]> {
  return banking.investment.listHoldings(DEMO_USER_ID);
}

/** The active view of one product's position. */
async function viewOf(productId: string): Promise<HoldingView> {
  const view = (await holdings()).find((holding) => holding.productId === productId);
  if (view === undefined) throw new Error(`no active holding for ${productId}`);
  return view;
}

/**
 * Publish a net value the way a daily 净值 update would: canonical decimal TEXT, at most 4 fraction
 * digits (the SDK treats a non-canonical column as "no net value published").
 */
async function publishNetValue(productId: string, netValue: string): Promise<void> {
  await db().investmentProduct.update({
    where: { id: productId },
    data: { latestNetValuePerUnit: decimalText(netValue) },
  });
}

function subscribe(productId: string, amount: string, idempotencyKey?: string): Promise<InvestResult> {
  return banking.investment.subscribeInvestment({
    userId: DEMO_USER_ID,
    productId,
    amount,
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  });
}

/** Redeem under an explicit口径 — `SHARES` (shares), `AMOUNT` (amount) or `ALL`. */
function redeem(input: {
  mode: 'SHARES' | 'AMOUNT' | 'ALL';
  shares?: string;
  amount?: string;
  holdingId?: string;
  idempotencyKey?: string;
}): Promise<InvestResult> {
  return banking.investment.redeemInvestment({
    userId: DEMO_USER_ID,
    holdingId: input.holdingId ?? SEEDED_HOLDING,
    mode: input.mode,
    ...(input.shares !== undefined ? { shares: input.shares } : {}),
    ...(input.amount !== undefined ? { amount: input.amount } : {}),
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

/** Σ CNY amounts of the given results, in minor units. */
function sumSettledMinor(results: readonly InvestResult[]): bigint {
  return results.reduce((total, result) => total + moneyToCents(result.amount), 0n);
}

/** Σ of the redemption amounts in the ledger rows, in minor units. */
function sumFlowMinor(rows: readonly TransactionView[]): bigint {
  return rows.reduce((total, row) => total + moneyToCents(row.amount), 0n);
}

describe('banking-sdk/investment · 净值 + 份额 赎回模型', () => {
  it('Case 1 · 追加申购只累加份额与成本，申购金额不计入收益（两笔流水）', async () => {
    // Seeded position: 5050 shares, ¥5,000 cost, net value 1.0000 ⇒ 5050 × 1 = ¥5,050 (+50).
    const first = await subscribe(WENJIANA, '1000.00');
    expect(first.addedToExisting).toBe(true);
    expect(first.subscribedShares).toBe('1000'); // FLOOR(¥1,000 ÷ 1.0000) = 1,000 shares
    expect(first.totalShares).toBe('6050'); // 5050 + 1000
    expect(first.amount).toBe('1000.00');
    expect(first.newBalance).toBe('22580.00');

    const second = await subscribe(WENJIANA, '2000.00');
    expect(second.addedToExisting).toBe(true);
    expect(second.subscribedShares).toBe('2000');
    expect(second.totalShares).toBe('8050');
    expect(second.newBalance).toBe('20580.00');

    // Shares and cost grew TOGETHER: 5050 + 1000 + 2000 shares, ¥5,000 + ¥3,000 cost.
    const row = await holdingRow();
    expect(row.status).toBe('HOLDING');
    expect(row.principalAmountMinor).toBe(800_000n);
    expect(row.shares).toBe('8050');
    expect(row.estimatedMarketValue).toBe('8050'); // 8050 × 1
    expect(row.realizedProfitMinor).toBe(0n); // a purchase realizes nothing

    const view = await viewOf(WENJIANA);
    expect(view.amount).toBe('8000.00'); // remaining COST, never a market value
    expect(view.shares).toBe('8050');
    expect(view.latestNetValue).toBe('1');
    expect(view.marketValue).toBe('8050');
    // The ¥3,000 paid is NOT profit: unrealized profit is still market value − cost = 8050 − 8000.
    expect(view.profit).toBe('50');
    expect(view.realizedProfit).toBe('0.00');
    expect(view.cumulativeProfit).toBe('50');
    expect(view.purchases).toHaveLength(2);
    expect(view.purchases?.[1]).toMatchObject({
      amount: '2000.00',
      shares: '2000',
      totalShares: '8050',
      totalPrincipal: '8000.00',
      netValuePerUnit: '1',
      newBalance: '20580.00',
    });

    // TWO purchases ⇒ TWO account-flow DEBIT rows and nothing else.
    const flow = await flowRows();
    expect(flow).toHaveLength(2);
    expect(flow.every((entry) => entry.direction === 'DEBIT')).toBe(true);
    expect(flow.every((entry) => entry.category === INVESTMENT_FLOW_CATEGORY)).toBe(true);
    expect(flow.map((entry) => entry.amount).sort()).toEqual(['-1000.00', '-2000.00']);
    // 23,580.00 − 1,000.00 − 2,000.00
    expect(await checkingBalanceMinor()).toBe(2_058_000n);
  });

  it('Case 2 · SHARES 口径部分赎回：剩余份额/成本/市值/收益四者自洽', async () => {
    const result = await redeem({ mode: 'SHARES', shares: '2000', idempotencyKey: 'shares-1' });

    // 2000 shares × 1.0000 = ¥2,000.00 settled; HALF_UP(¥5,000 × 2000/5050 = 1980.198019…) = ¥1,980.20.
    expect(result.partial).toBe(true);
    expect(result.mode).toBe('SHARES');
    expect(result.redeemedShares).toBe('2000');
    expect(result.remainingShares).toBe('3050');
    expect(result.netValuePerUnit).toBe('1');
    expect(result.redemptionValuation).toBe('2000'); // exact, before the single rounding step
    expect(result.settlementRounding).toBe('HALF_UP');
    expect(result.feeAmount).toBe('0.00');
    expect(result.feeRule).toBe('SIMULATED_NONE');
    expect(result.amount).toBe('2000.00');
    expect(result.redeemedPrincipal).toBe('1980.20');
    expect(result.remainingCost).toBe('3019.80'); // 5,000.00 − 1,980.20
    expect(result.remainingPrincipal).toBe('3019.80');
    expect(result.remainingMarketValue).toBe('3050'); // 3050 × 1
    // 3050 − 3019.80 = ¥30.20, published as canonical decimal text ('30.2').
    expect(result.remainingProfit).toBe('30.2');
    expect(result.realizedProfit).toBe('19.80'); // 2000.00 − 1980.20
    expect(result.newBalance).toBe('25580.00');

    // The position SURVIVES as HOLDING with fewer shares and less cost.
    const row = await holdingRow();
    expect(row.status).toBe('HOLDING');
    expect(row.shares).toBe('3050');
    expect(row.principalAmountMinor).toBe(301_980n);
    expect(row.estimatedMarketValue).toBe('3050');
    expect(row.realizedProfitMinor).toBe(1_980n);

    // Four-way self-consistency, derived from the SDK's OWN view rather than the constants above.
    const view = await viewOf(WENJIANA);
    expect(view.shares).toBe('3050');
    expect(view.amount).toBe('3019.80');
    expect(view.marketValue).toBe(multiplyDecimal(view.shares!, view.latestNetValue!)); // 市值 = 份额 × 净值
    // `amount` is settled CNY text (2 dp) while the decimals are canonical, so compare numerically.
    expect(decimalText(view.amount)).toBe(subtractDecimal(SEEDED_COST, result.redeemedPrincipal!)); // 剩余 = 原 − 已扣
    expect(view.profit).toBe(subtractDecimal(view.marketValue!, view.amount)); // 收益 = 市值 − 剩余成本
    expect(view.realizedProfit).toBe('19.80');
    expect(view.profit).toBe('30.2'); // ¥30.20 in canonical text
    // 已实现 + 未实现 = the position's whole gain (5050 − 5000 = 50).
    expect(view.cumulativeProfit).toBe(addDecimal(view.realizedProfit!, view.profit!));
    expect(view.cumulativeProfit).toBe('50');

    const history = view.redemptions;
    expect(history).toHaveLength(1);
    expect(history?.[0]).toMatchObject({
      mode: 'SHARES',
      shares: '2000',
      netValuePerUnit: '1',
      settledAmount: '2000.00',
      feeAmount: '0.00',
      feeRule: 'SIMULATED_NONE',
      cost: '1980.20',
      realizedProfit: '19.80',
    });

    // ONE credit of the single settlement; 2,358,000 + 200,000 minor.
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
  });

  it('Case 2 · AMOUNT 口径部分赎回：先按净值折算份额，再按份额扣成本', async () => {
    const result = await redeem({ mode: 'AMOUNT', amount: '1000.00', idempotencyKey: 'amount-1' });

    // FLOOR(¥1,000 ÷ 1.0000, 6 dp) = 1,000 shares; cost HALF_UP(¥5,000 × 1000/5050) = ¥990.10.
    expect(result.mode).toBe('AMOUNT');
    expect(result.partial).toBe(true);
    expect(result.redeemedShares).toBe('1000');
    expect(result.remainingShares).toBe('4050');
    expect(result.redemptionValuation).toBe('1000');
    expect(result.amount).toBe('1000.00');
    expect(result.redeemedPrincipal).toBe('990.10');
    expect(result.remainingCost).toBe('4009.90');
    expect(result.remainingMarketValue).toBe('4050');
    expect(result.remainingProfit).toBe('40.1'); // 4050 − 4009.90 = ¥40.10, canonical text
    expect(result.realizedProfit).toBe('9.90');
    expect(result.newBalance).toBe('24580.00');

    const row = await holdingRow();
    expect(row.status).toBe('HOLDING');
    expect(row.shares).toBe('4050');
    expect(row.principalAmountMinor).toBe(400_990n);
    expect(row.estimatedMarketValue).toBe('4050');
    expect(row.realizedProfitMinor).toBe(990n);

    const view = await viewOf(WENJIANA);
    expect(view.shares).toBe('4050');
    expect(view.amount).toBe('4009.90');
    expect(view.marketValue).toBe(multiplyDecimal(view.shares!, view.latestNetValue!));
    expect(decimalText(view.amount)).toBe(subtractDecimal(SEEDED_COST, result.redeemedPrincipal!));
    expect(view.profit).toBe(subtractDecimal(view.marketValue!, view.amount));
    expect(view.profit).toBe('40.1'); // ¥40.10 in canonical text
    expect(view.cumulativeProfit).toBe('50');
    expect(view.redemptions?.[0]).toMatchObject({ mode: 'AMOUNT', shares: '1000', settledAmount: '1000.00' });

    // 2,358,000 + 100,000 minor.
    expect(await checkingBalanceMinor()).toBe(2_458_000n);
    expect(await flowRows()).toHaveLength(1);
  });

  it('Case 3 · ALL 口径全额赎回：份额/成本/市值清零，全部收益转为已实现', async () => {
    const result = await redeem({ mode: 'ALL', idempotencyKey: 'all-1' });

    expect(result.partial).toBeUndefined(); // a full close is NOT a partial redemption
    expect(result.mode).toBe('ALL');
    expect(result.redeemedShares).toBe('5050');
    expect(result.remainingShares).toBe('0');
    expect(result.amount).toBe('5050.00');
    expect(result.redemptionValuation).toBe('5050');
    expect(result.redeemedPrincipal).toBe('5000.00');
    expect(result.remainingCost).toBe('0.00');
    expect(result.remainingPrincipal).toBe('0.00');
    expect(result.realizedProfit).toBe('50.00'); // 5050.00 − 5000.00
    expect(result.feeAmount).toBe('0.00');
    expect(result.feeRule).toBe('SIMULATED_NONE');
    expect(result.newBalance).toBe('28630.00');

    const row = await holdingRow();
    expect(row.status).toBe('REDEEMED');
    expect(row.shares).toBe('0');
    expect(row.principalAmountMinor).toBe(0n);
    expect(row.estimatedMarketValue).toBe('0');
    expect(row.realizedProfitMinor).toBe(5_000n);
    expect(row.redeemExecutionKey).toBe('all-1');

    // Nothing is left to value: no shares, no cost, so unrealized = 0 and the closed position is not
    // an ACTIVE holding any more (`listHoldings` reads status HOLDING only).
    expect((await holdings()).map((holding) => holding.id)).not.toContain(SEEDED_HOLDING);
    // 50.00 realized + 0.00 unrealized = the position's whole gain.
    expect(addDecimal(result.realizedProfit!, '0')).toBe('50');

    // 2,358,000 + 505,000 minor, and exactly ONE ledger row.
    expect(await checkingBalanceMinor()).toBe(2_863_000n);
    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: '5050.00',
      direction: 'CREDIT',
      category: INVESTMENT_FLOW_CATEGORY,
      merchant: '赎回',
      channel: 'APP',
    });
  });

  it('Case 4 · 净值上涨（prod_wenjiana 1.0357）：赎回的已实现收益为正 +230.29', async () => {
    await publishNetValue(WENJIANA, '1.0357');
    const view = await viewOf(WENJIANA);
    expect(view.latestNetValue).toBe('1.0357');
    expect(view.marketValue).toBe('5230.285'); // 5050 × 1.0357, exact
    expect(view.profit).toBe('230.285'); // 5230.285 − 5000

    const result = await redeem({ mode: 'ALL', idempotencyKey: 'profit-1' });

    // 5230.285 → HALF_UP ONCE → ¥5,230.29; consumed cost ¥5,000.00 ⇒ realized +¥230.29.
    expect(result.redemptionValuation).toBe('5230.285');
    expect(result.amount).toBe('5230.29');
    expect(result.redeemedPrincipal).toBe('5000.00');
    expect(result.realizedProfit).toBe('230.29');
    expect(compareDecimal(result.realizedProfit!, '0')).toBe(1);

    const row = await holdingRow();
    expect(row.status).toBe('REDEEMED');
    expect(row.realizedProfitMinor).toBe(23_029n);
    expect(row.shares).toBe('0');
    // 2,358,000 + 523,029 minor (¥5,230.29 settled).
    expect(await checkingBalanceMinor()).toBe(2_881_029n);
  });

  it('Case 4 · 净值下跌（prod_wenjib 0.9880 → 0.9500）：赎回的已实现收益为负 −192.31', async () => {
    // FLOOR(¥5,000 ÷ 0.9880, 6 dp) = 5060.728744 shares — the floored residual stays in cost.
    const purchase = await subscribe(WENJIANB, '5000.00', 'buy-wenjib');
    expect(purchase.addedToExisting).toBe(false);
    expect(purchase.subscribedShares).toBe('5060.728744');
    expect(purchase.totalShares).toBe('5060.728744');
    expect(purchase.newBalance).toBe('18580.00'); // 23,580.00 − 5,000.00

    // Right after the purchase the position is worth 5060.728744 × 0.9880 = ¥4,999.999999072, i.e.
    // −¥0.000000928 — less than one cent, never a phantom gain from the FLOOR.
    const fresh = await viewOf(WENJIANB);
    expect(fresh.amount).toBe('5000.00');
    expect(fresh.marketValue).toBe('4999.999999072');
    expect(fresh.profit).toBe('-0.000000928');
    expect(compareDecimal(fresh.profit!, '0')).toBe(-1);
    expect(compareDecimal(fresh.profit!, '-0.01')).toBe(1); // |profit| < ¥0.01

    await publishNetValue(WENJIANB, '0.95'); // the 净值 falls below the purchase price
    const dropped = await viewOf(WENJIANB);
    expect(dropped.marketValue).toBe('4807.6923068'); // 5060.728744 × 0.95
    expect(dropped.profit).toBe('-192.3076932');

    const result = await redeem({ mode: 'ALL', holdingId: purchase.holdingId, idempotencyKey: 'loss-1' });

    // HALF_UP(4807.6923068) → ¥4,807.69 credited against the full ¥5,000.00 cost ⇒ −¥192.31.
    expect(result.redemptionValuation).toBe('4807.6923068');
    expect(result.amount).toBe('4807.69');
    expect(result.redeemedPrincipal).toBe('5000.00');
    expect(result.realizedProfit).toBe('-192.31');
    expect(compareDecimal(result.realizedProfit!, '0')).toBe(-1);
    expect(result.remainingShares).toBe('0');

    const row = await db().investmentHolding.findUnique({ where: { id: purchase.holdingId } });
    expect(row?.status).toBe('REDEEMED');
    expect(row?.realizedProfitMinor).toBe(-19_231n);
    // 23,580.00 − 5,000.00 + 4,807.69
    expect(await checkingBalanceMinor()).toBe(2_338_769n);
  });

  it('Case 5 · 净值 4 位 / 份额 FLOOR 到 6 位：¥100.01 买到 96.562711 份，残差留下成本', async () => {
    await publishNetValue(HUOBI, '1.0357');

    // ¥100.01 ÷ 1.0357 = 96.5627114… ⇒ FLOOR to 6 dp = 96.562711 shares (never rounded up).
    const purchase = await subscribe(HUOBI, '100.01', 'floor-buy');
    expect(purchase.subscribedShares).toBe('96.562711');
    expect(purchase.totalShares).toBe('96.562711');

    const view = await viewOf(HUOBI);
    expect(view.shares).toBe('96.562711');
    expect(view.amount).toBe('100.01'); // the FULL paid amount remains the cost basis
    expect(view.marketValue).toBe('100.0099997827'); // 96.562711 × 1.0357, exact
    // The un-invested residual stays in cost, so a fresh purchase realizes ¥0.00 to the cent.
    expect(view.profit).toBe('-0.0000002173');
    expect(compareDecimal(view.profit!, '-0.01')).toBe(1); // > −¥0.01
    expect(compareDecimal(view.profit!, '0.01')).toBe(-1); // < +¥0.01

    // An AMOUNT redemption is FLOOR-ed the same way: ¥10.00 ÷ 1.0357 = 9.6553059… → 9.655305 shares.
    const result = await redeem({ mode: 'AMOUNT', amount: '10.00', holdingId: purchase.holdingId });
    expect(result.redeemedShares).toBe('9.655305');
    expect(result.netValuePerUnit).toBe('1.0357');
    expect(result.redemptionValuation).toBe('9.9999993885'); // 9.655305 × 1.0357
    expect(result.amount).toBe('10.00'); // HALF_UP(9.9999993885) = 10.00
    expect(result.redeemedPrincipal).toBe('10.00'); // HALF_UP(100.01 × 9.655305/96.562711) = 10.00
    expect(result.realizedProfit).toBe('0.00'); // ¥10.00 in, ¥10.00 of cost out — no phantom gain
    expect(result.remainingShares).toBe('86.907406'); // 96.562711 − 9.655305
    expect(result.remainingCost).toBe('90.01'); // 100.01 − 10.00
    expect(result.remainingMarketValue).toBe('90.0100003942'); // 86.907406 × 1.0357
    expect(result.remainingProfit).toBe('0.0000003942');

    const row = await db().investmentHolding.findUnique({ where: { id: purchase.holdingId } });
    expect(row?.status).toBe('HOLDING');
    expect(row?.shares).toBe('86.907406');
    expect(row?.principalAmountMinor).toBe(9_001n);
  });

  it('Case 5 · 结算 HALF_UP 到分：恰好 .005 上舍、.004 下舍，两笔赎回的份额与现金求和一致', async () => {
    // 10 shares × 1.2345 = ¥12.345 ⇒ HALF_UP at the cent boundary ⇒ ¥12.35 (goes UP).
    await publishNetValue(WENJIANA, '1.2345');
    const up = await redeem({ mode: 'SHARES', shares: '10', idempotencyKey: 'round-up' });
    expect(up.redemptionValuation).toBe('12.345');
    expect(up.settlementRounding).toBe('HALF_UP');
    expect(up.amount).toBe('12.35');
    expect(up.redeemedPrincipal).toBe('9.90'); // HALF_UP(5000.00 × 10/5050) = 990 minor
    expect(up.realizedProfit).toBe('2.45'); // 12.35 − 9.90
    expect(up.remainingShares).toBe('5040');
    expect(up.remainingCost).toBe('4990.10'); // 5000.00 − 9.90
    expect(up.remainingMarketValue).toBe('6221.88'); // 5040 × 1.2345
    expect(up.remainingProfit).toBe('1231.78');
    expect(up.newBalance).toBe('23592.35'); // 23,580.00 + 12.35

    // 10 shares × 1.2344 = ¥12.344 ⇒ ¥12.34 (goes DOWN).
    await publishNetValue(WENJIANA, '1.2344');
    const down = await redeem({ mode: 'SHARES', shares: '10', idempotencyKey: 'round-down' });
    expect(down.redemptionValuation).toBe('12.344');
    expect(down.amount).toBe('12.34');
    expect(down.redeemedPrincipal).toBe('9.90'); // HALF_UP(4990.10 × 10/5040) = 990 minor
    expect(down.realizedProfit).toBe('2.44');
    expect(down.remainingShares).toBe('5030');
    expect(down.remainingCost).toBe('4980.20');
    expect(down.remainingMarketValue).toBe('6209.032'); // 5030 × 1.2344
    expect(down.remainingProfit).toBe('1228.832');

    // Consecutive partial redemptions: 5050 − (10 + 10) = 5030 shares left, and the shares / cash of
    // the persisted history add up to the row and to the account.
    const row = await holdingRow();
    expect(row.shares).toBe('5030');
    expect(row.principalAmountMinor).toBe(498_020n);
    const view = await viewOf(WENJIANA);
    const redeemedTotal = (view.redemptions ?? []).reduce((total, record) => addDecimal(total, record.shares), '0');
    expect(redeemedTotal).toBe('20');
    expect(addDecimal(redeemedTotal, view.shares!)).toBe('5050');
    const settledTotal = (view.redemptions ?? []).reduce((total, record) => addDecimal(total, record.settledAmount), '0');
    expect(settledTotal).toBe('24.69'); // 12.35 + 12.34
    // 2,358,000 + 1,235 + 1,234 minor.
    expect(await checkingBalanceMinor()).toBe(2_360_469n);
    const flow = await flowRows();
    expect(flow).toHaveLength(2);
    expect(sumFlowMinor(flow)).toBe(2_469n);
    expect(flow.map((entry) => entry.amount).sort()).toEqual(['12.34', '12.35']);
  });

  it('Case 6 · 同一 executionKey 重放：部分与全额赎回都返回原结果且不再入账', async () => {
    const partial = await redeem({ mode: 'SHARES', shares: '2000', idempotencyKey: 'idem-partial' });
    expect(partial.amount).toBe('2000.00');
    expect(await checkingBalanceMinor()).toBe(2_558_000n);
    expect(await flowRows()).toHaveLength(1);

    const partialReplay = await redeem({ mode: 'SHARES', shares: '2000', idempotencyKey: 'idem-partial' });
    expect(partialReplay).toEqual(partial); // the ORIGINAL outcome, byte for byte
    expect((await holdingRow()).shares).toBe('3050'); // no second share deduction
    expect(await checkingBalanceMinor()).toBe(2_558_000n); // no second credit
    expect(await flowRows()).toHaveLength(1); // no second ledger row

    // The remaining 3050 shares close at ¥3,050.00 against ¥3,019.80 of cost ⇒ +¥30.20 realized.
    const close = await redeem({ mode: 'ALL', idempotencyKey: 'idem-full' });
    expect(close.partial).toBeUndefined();
    expect(close.amount).toBe('3050.00');
    expect(close.redeemedPrincipal).toBe('3019.80');
    expect(close.realizedProfit).toBe('30.20');
    expect(await checkingBalanceMinor()).toBe(2_863_000n); // 2,558,000 + 305,000 minor
    expect(await flowRows()).toHaveLength(2);

    const closeReplay = await redeem({ mode: 'ALL', idempotencyKey: 'idem-full' });
    expect(closeReplay).toEqual(close);
    expect(await checkingBalanceMinor()).toBe(2_863_000n);
    expect(await flowRows()).toHaveLength(2);
    const row = await holdingRow();
    expect(row.status).toBe('REDEEMED');
    expect(row.shares).toBe('0');
    // Realized profit is booked ONCE per redemption identity: 19.80 + 30.20 = the position's gain 50.00.
    expect(row.realizedProfitMinor).toBe(5_000n);
  });

  it('Case 7 · 并发赎回同一持仓：不超卖、不超付，份额与现金守恒', async () => {
    // 3000 + 3000 > 5050 held: at most ONE of the two can succeed.
    const settled = await Promise.allSettled([
      redeem({ mode: 'SHARES', shares: '3000', idempotencyKey: 'race-a' }),
      redeem({ mode: 'SHARES', shares: '3000', idempotencyKey: 'race-b' }),
    ]);
    const fulfilled = settled
      .filter((entry): entry is PromiseFulfilledResult<InvestResult> => entry.status === 'fulfilled')
      .map((entry) => entry.value);
    const rejected = settled.filter((entry) => entry.status === 'rejected');

    // Exactly one winner. The loser MUST be rejected as a DOMAIN error — observed `VALIDATION`
    // (「赎回份额不能超过持有份额」, because it re-reads the reduced share count inside the transaction);
    // a lost guarded write would be `CONFLICT`. Never a second, oversized payout.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = (rejected[0] as PromiseRejectedResult).reason;
    expect(loser).toBeInstanceOf(AppError);
    expect(['VALIDATION', 'CONFLICT']).toContain((loser as AppError).code);
    expect(fulfilled[0].redeemedShares).toBe('3000');
    expect(fulfilled[0].amount).toBe('3000.00');

    const balance = await checkingBalanceMinor();
    const cashDelta = balance - CHECKING_START_MINOR;
    const credited = sumSettledMinor(fulfilled);
    expect(cashDelta).toBe(credited); // every credited cent is exactly the settled amount
    expect(credited).toBe(300_000n);
    expect(credited).toBeLessThanOrEqual(505_000n); // never more than the position could pay

    // Shares: redeemed + remaining === 5050, and the remainder cannot go negative.
    const view = await viewOf(WENJIANA);
    const remaining = view.shares!;
    expect(compareDecimal(remaining, '0')).toBe(1);
    expect(addDecimal(fulfilled[0].redeemedShares!, remaining)).toBe('5050');
    expect(remaining).toBe('2050');
    // ¥5,000.00 − HALF_UP(5000.00 × 3000/5050 = 2970.297029…) = ¥2,029.70 of cost stays.
    expect(view.amount).toBe('2029.70');

    // The ledger mirrors the winners one-for-one.
    const flow = await flowRows();
    expect(flow).toHaveLength(fulfilled.length);
    expect(flow.every((entry) => entry.direction === 'CREDIT')).toBe(true);
    expect(sumFlowMinor(flow)).toBe(credited);
  });

  it('Case 8 · 五者守恒：账户现金、份额、剩余成本、收益与流水共同移动', async () => {
    await publishNetValue(WENJIANA, '1.0357');
    const balanceBefore = await checkingBalanceMinor();

    // 1000 shares × 1.0357 = ¥1,035.70 settled; HALF_UP(5000.00 × 1000/5050) = ¥990.10 consumed.
    const result = await redeem({ mode: 'SHARES', shares: '1000', idempotencyKey: 'conserve-1' });
    expect(result.redemptionValuation).toBe('1035.7');
    expect(result.amount).toBe('1035.70');
    expect(result.redeemedPrincipal).toBe('990.10');
    expect(result.realizedProfit).toBe('45.60'); // 1035.70 − 990.10
    expect(result.remainingShares).toBe('4050');
    expect(result.remainingCost).toBe('4009.90');
    expect(result.remainingMarketValue).toBe('4194.585'); // 4050 × 1.0357
    expect(result.remainingProfit).toBe('184.685'); // 4194.585 − 4009.90

    // 1. Cash: the funding account rose by EXACTLY the settled amount — one payment, no double credit.
    const balanceAfter = await checkingBalanceMinor();
    const cashDelta = balanceAfter - balanceBefore;
    expect(cashDelta).toBe(moneyToCents(result.amount));
    expect(cashDelta).toBe(103_570n);
    expect(balanceAfter).toBe(2_461_570n);

    // 2. Shares: 5050 − 1000 = 4050, and the redeemed shares are gone for good.
    const row = await holdingRow();
    expect(row.shares).toBe('4050');
    // 3. Cost: consumed + remaining === the original cost basis.
    expect(decimalText(result.redeemedPrincipal!)).toBe(
      subtractDecimal(SEEDED_COST, result.remainingCost!),
    );
    expect(row.principalAmountMinor).toBe(400_990n);
    // 4. Profit: unrealized + realized add up to the position's whole gain (5230.285 − 5000).
    const view = await viewOf(WENJIANA);
    expect(view.marketValue).toBe(multiplyDecimal(view.shares!, view.latestNetValue!));
    expect(view.profit).toBe(subtractDecimal(view.marketValue!, view.amount));
    expect(view.cumulativeProfit).toBe(addDecimal(view.realizedProfit!, view.profit!));
    expect(view.cumulativeProfit).toBe('230.285');
    // 5. Ledger: exactly ONE row, equal to the settled amount.
    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: '1035.70',
      direction: 'CREDIT',
      category: INVESTMENT_FLOW_CATEGORY,
      merchant: '赎回',
      accountId: CHECKING,
    });
    expect(sumFlowMinor(flow)).toBe(cashDelta);
  });
});

describe('banking-sdk/investment · 赎回口径与执行身份的拒绝路径', () => {
  it('Case 9 · 口径缺失或使用已退役的 redeemAmount 时在任何写入前被拒绝', async () => {
    // `redeemAmount` is the retired PRINCIPAL口径: rejected with the clarification error, even though
    // a value was supplied.
    await expect(
      banking.investment.redeemInvestment({ userId: DEMO_USER_ID, holdingId: SEEDED_HOLDING, redeemAmount: '2000.00' }),
    ).rejects.toBeInstanceOf(AppError);
    const withoutMode = await banking.investment
      .redeemInvestment({ userId: DEMO_USER_ID, holdingId: SEEDED_HOLDING })
      .then(() => null)
      .catch((error: unknown) => error);
    expect(withoutMode).toBeInstanceOf(AppError);
    expect((withoutMode as AppError).code).toBe('VALIDATION');

    // Nothing moved: no credit, no ledger row, no share change.
    expect(await checkingBalanceMinor()).toBe(CHECKING_START_MINOR);
    expect(await flowRows()).toHaveLength(0);
    const row = await holdingRow();
    expect(row.shares).toBe('5050');
    expect(row.principalAmountMinor).toBe(500_000n);
    expect(row.status).toBe('HOLDING');
  });
});
