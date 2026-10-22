import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { investments } from '@/lib/db/repositories';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { decimalText } from '@/lib/decimal';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const HOLDING_ID = 'holding_wenjiana';
const ACCOUNT_ID = 'acct_checking';
const PRODUCT_ID = 'prod_wenjiana';

/**
 * A position is SHARES × NET VALUE, so a sub-cent quote can only be seeded through one of those two
 * columns: `estimatedMarketValue` no longer prices a holding. Both setters write the RAW column the
 * SDK reads, canonicalized (`decimalText`) because the SDK rejects trailing-zero text as 净值/份额缺失.
 */
async function setShares(shares: string): Promise<void> {
  await getTestPrisma().investmentHolding.update({
    where: { id: HOLDING_ID },
    data: { shares: decimalText(shares) },
  });
}

async function setNetValue(netValue: string): Promise<void> {
  await getTestPrisma().investmentProduct.update({
    where: { id: PRODUCT_ID },
    data: { latestNetValuePerUnit: decimalText(netValue) },
  });
}

describe('investment decimal precision', () => {
  it('replays the full original purchase result after the account balance changes', async () => {
    // prod_huobi is not held yet, so this exercises the creation path that persists `subscribeResult`.
    const input = { userId: DEMO_USER_ID, productId: 'prod_huobi', amount: '1000.01', idempotencyKey: 'original-purchase' };
    const original = await banking.investment.subscribeInvestment(input);
    expect(original.newBalance).toBe('22579.99');
    await getTestPrisma().account.update({ where: { id: ACCOUNT_ID }, data: { balanceMinor: 123456n } });
    expect(await banking.investment.subscribeInvestment(input)).toEqual(original);
    const holding = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: original.holdingId } });
    expect(JSON.parse(holding.subscribeResult!)).toEqual(original);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } })).balanceMinor).toBe(123456n);
    expect(await getTestPrisma().transaction.count({ where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY } })).toBe(1);
  });

  it.each([null, '{', '{}'])('rejects an incomplete original purchase result %s without another debit', async (subscribeResult) => {
    // prod_huobi is not held yet, so the creation path persists a replayable `subscribeResult` to corrupt.
    const input = { userId: DEMO_USER_ID, productId: 'prod_huobi', amount: '1000.00', idempotencyKey: 'corrupt-purchase' };
    const original = await banking.investment.subscribeInvestment(input);
    await getTestPrisma().investmentHolding.update({ where: { id: original.holdingId }, data: { subscribeResult } });
    await expect(banking.investment.subscribeInvestment(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } })).balanceMinor).toBe(2258000n);
    expect(await getTestPrisma().transaction.count({ where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY } })).toBe(1);
  });

  it('preserves rates finer than a basis point and compares them without rounding', async () => {
    const lower = await investments.createProduct({
      code: 'PRECISION_LOWER',
      name: 'Precision lower',
      riskLevel: 'R2',
      annualYieldRate: '0.032575000000000001',
      termDays: 90,
      minAmount: '1.00',
    });
    const higher = await investments.createProduct({
      code: 'PRECISION_HIGHER',
      name: 'Precision higher',
      riskLevel: 'R2',
      annualYieldRate: '0.032575000000000002',
      termDays: 90,
      minAmount: '1.00',
    });

    expect(lower.annualYieldRate).toBe('0.032575000000000001');
    expect(higher.annualYieldRate).toBe('0.032575000000000002');
    const comparison = await banking.investment.compareInvestments([lower.id, higher.id]);
    expect(comparison.highestRateId).toBe(higher.id);
    expect(comparison.products.map((product) => product.annualYieldRate)).toEqual([
      '0.032575000000000001',
      '0.032575000000000002',
    ]);
  });

  it('keeps estimates and profit exact while retaining booked principal in cents', async () => {
    const created = await investments.createHolding({
      userId: DEMO_USER_ID,
      productId: 'prod_wenjiana',
      amount: '1000.01',
      marketValue: '1000.019876543210123456',
    });
    // Cost stays booked in exact cents and the historical estimate snapshot is stored untouched …
    expect(created.principalAmountMinor).toBe(100001n);
    expect(created.estimatedMarketValue).toBe('1000.019876543210123456');

    // … but it no longer PRICES the position: a row without recorded shares is 历史数据不足 and
    // reports its cost, never the stale estimate.
    const unrecorded = (await banking.investment.listHoldings(DEMO_USER_ID))
      .find((holding) => holding.id === created.id);
    expect(unrecorded).toMatchObject({
      amount: '1000.01',
      marketValue: '1000.01',
      valueBasis: 'HISTORICAL_DATA_INSUFFICIENT',
    });
    expect(unrecorded?.profit).toBeUndefined();

    // Once shares are recorded the unrounded valuation is `shares × net value` at full precision (six
    // fractional digits here), never a cent-rounded figure, and profit is the exact difference.
    await getTestPrisma().investmentHolding.update({ where: { id: created.id }, data: { shares: '1000.019876' } });
    const view = (await banking.investment.listHoldings(DEMO_USER_ID))
      .find((holding) => holding.id === created.id);
    expect(view).toMatchObject({
      amount: '1000.01',
      shares: '1000.019876',
      latestNetValue: '1',
      marketValue: '1000.019876',
      profit: '0.009876',
      valueBasis: 'NET_VALUE',
    });
  });

  it.each([
    ['5050.004999', '5050.00', 505000n],
    ['5050.005', '5050.01', 505001n],
    ['5050.005001', '5050.01', 505001n],
  ])('rounds a %s share valuation once at redemption settlement', async (shares, settled, creditMinor) => {
    // prod_wenjiana prices at 1, so the UNROUNDED valuation equals the share count: the three cases
    // straddle the half-cent boundary and must be rounded HALF_UP exactly ONCE, at settlement.
    await setShares(shares);
    const result = await banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      mode: 'ALL',
      expectedSettlementAmount: settled,
      idempotencyKey: 'precision-settlement',
    });
    expect(result.amount).toBe(settled);
    expect(result.redemptionValuation).toBe(shares);
    expect(result.settlementRounding).toBe('HALF_UP');
    expect(result.redeemedShares).toBe(shares);
    expect(result.netValuePerUnit).toBe('1');
    const stored = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(stored.status).toBe('REDEEMED');
    expect(stored.shares).toBe('0');
    expect(stored.estimatedMarketValue).toBe('0');
    const ledger = await getTestPrisma().transaction.findFirstOrThrow({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    });
    expect(ledger.amountMinor).toBe(creditMinor);
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2358000n + creditMinor);
  });

  it('preserves a quote above the JavaScript safe integer range through settlement', async () => {
    // 900719925474099.005 CNY is 90,071,992,547,409,901 cents — far beyond Number.MAX_SAFE_INTEGER.
    await setShares('900719925474099.005');
    const holding = (await banking.investment.listHoldings(DEMO_USER_ID))[0];
    expect(holding.marketValue).toBe('900719925474099.005');
    expect(holding.profit).toBe('900719925469099.005');
    const result = await banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      mode: 'ALL',
      expectedSettlementAmount: '900719925474099.01',
    });
    expect(result.amount).toBe('900719925474099.01');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(90071992549767901n);
  });

  it('replays the original settlement after the stored estimate changes', async () => {
    await setShares('5050.005');
    const input = {
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      mode: 'ALL' as const,
      expectedSettlementAmount: '5050.01',
      idempotencyKey: 'precision-original-receipt',
    };
    const original = await banking.investment.redeemInvestment(input);
    // A net value published AFTER the redemption must not re-price the committed settlement.
    await setNetValue('2.0000');
    expect(await banking.investment.redeemInvestment(input)).toEqual(original);
    expect(original.netValuePerUnit).toBe('1');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2863001n);
    expect(await getTestPrisma().transaction.count({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    })).toBe(1);
  });

  it('requires new authorization when a changed estimate changes the settled amount', async () => {
    // Unrounded valuation 5050.005 settles at 5050.01, so an approval of 5050.00 is stale.
    await setShares('5050.005');
    await expect(banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      mode: 'ALL',
      expectedSettlementAmount: '5050.00',
    })).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: { holdingId: HOLDING_ID, field: 'expectedSettlementAmount' },
    });
    const holding = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(holding.status).toBe('HOLDING');
    expect(holding.shares).toBe('5050.005');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2358000n);
    expect(await getTestPrisma().transaction.count({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    })).toBe(0);
  });

  it.each(['0.0001', '0.0049'])('settles a total-loss quote %s without inventing cash', async (netValue) => {
    // One share priced below half a cent: the valuation rounds to 0.00, so no cash is minted — and a
    // replay returns the same zero settlement instead of crediting a second time.
    await setShares('1');
    await setNetValue(netValue);
    const input = { userId: DEMO_USER_ID, holdingId: HOLDING_ID, mode: 'ALL' as const, idempotencyKey: 'precision-total-loss' };
    const original = await banking.investment.redeemInvestment(input);
    expect(original.amount).toBe('0.00');
    expect(original.redemptionValuation).toBe(netValue);
    expect(await banking.investment.redeemInvestment(input)).toEqual(original);
    const holding = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(holding.status).toBe('REDEEMED');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2358000n);
    const ledger = await getTestPrisma().transaction.findMany({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amountMinor).toBe(0n);
  });

  it.each(['-1.001', 'invalid'])('rejects an invalid settlement quote %s without any financial write', async (netValue) => {
    // The quote is the product's published net value; a corrupt one prices nothing at all.
    await getTestPrisma().investmentProduct.update({
      where: { id: PRODUCT_ID },
      data: { latestNetValuePerUnit: netValue },
    });
    await expect(banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      mode: 'ALL',
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    const holding = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(holding.status).toBe('HOLDING');
    expect(holding.shares).toBe('5050');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2358000n);
    expect(await getTestPrisma().transaction.count({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    })).toBe(0);
  });

  it('rejects negative rates and valuations at the repository boundary', async () => {
    await expect(async () => investments.createProduct({
      code: 'NEGATIVE_RATE',
      name: 'Invalid rate',
      riskLevel: 'R1',
      annualYieldRate: '-0.00001',
      termDays: 90,
      minAmount: '1.00',
    })).rejects.toBeDefined();
    await expect(async () => investments.createHolding({
      userId: DEMO_USER_ID,
      productId: 'prod_wenjiana',
      amount: '1000.00',
      marketValue: '-0.00001',
    })).rejects.toBeDefined();
    expect(await getTestPrisma().investmentProduct.count({ where: { code: 'NEGATIVE_RATE' } })).toBe(0);
    expect(await getTestPrisma().investmentHolding.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
  });

  it('rejects over-scale decimal values instead of silently truncating them', async () => {
    await expect(async () => investments.createHolding({
      userId: DEMO_USER_ID,
      productId: 'prod_wenjiana',
      amount: '1000.00',
      marketValue: '1000.0000000000000000001',
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(async () => investments.createProduct({
      code: 'OVER_SCALE_RATE',
      name: 'Over scale rate',
      riskLevel: 'R1',
      annualYieldRate: '0.0325750000000000001',
      termDays: 90,
      minAmount: '1.00',
    })).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await getTestPrisma().investmentHolding.count({ where: { userId: DEMO_USER_ID } })).toBe(1);
    expect(await getTestPrisma().investmentProduct.count({ where: { code: 'OVER_SCALE_RATE' } })).toBe(0);
  });
});
