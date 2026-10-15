import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { investments } from '@/lib/db/repositories';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const HOLDING_ID = 'holding_wenjiana';
const ACCOUNT_ID = 'acct_checking';

async function setEstimate(value: string): Promise<void> {
  await getTestPrisma().investmentHolding.update({
    where: { id: HOLDING_ID },
    data: { estimatedMarketValue: value },
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
    expect(created.principalAmountMinor).toBe(100001n);
    expect(created.estimatedMarketValue).toBe('1000.019876543210123456');
    const view = (await banking.investment.listHoldings(DEMO_USER_ID))
      .find((holding) => holding.id === created.id);
    expect(view).toMatchObject({
      amount: '1000.01',
      marketValue: '1000.019876543210123456',
      profit: '0.009876543210123456',
    });
  });

  it.each([
    ['5050.004999999999999999', '5050.00', 505000n],
    ['5050.005', '5050.01', 505001n],
    ['5050.005000000000000001', '5050.01', 505001n],
  ])('rounds %s once at redemption settlement', async (estimate, settled, creditMinor) => {
    await setEstimate(estimate);
    const result = await banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      expectedRedemptionAmount: settled,
      idempotencyKey: 'precision-settlement',
    });
    expect(result.amount).toBe(settled);
    expect(result.redemptionValuation).toBe(estimate);
    expect(result.settlementRounding).toBe('HALF_UP');
    const stored = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(stored.estimatedMarketValue).toBe(estimate);
    const ledger = await getTestPrisma().transaction.findFirstOrThrow({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    });
    expect(ledger.amountMinor).toBe(creditMinor);
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2358000n + creditMinor);
  });

  it('preserves a quote above the JavaScript safe integer range through settlement', async () => {
    await setEstimate('900719925474099.005');
    const holding = (await banking.investment.listHoldings(DEMO_USER_ID))[0];
    expect(holding.marketValue).toBe('900719925474099.005');
    expect(holding.profit).toBe('900719925469099.005');
    const result = await banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      expectedRedemptionAmount: '900719925474099.01',
    });
    expect(result.amount).toBe('900719925474099.01');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(90071992549767901n);
  });

  it('replays the original settlement after the stored estimate changes', async () => {
    await setEstimate('5050.005');
    const input = {
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      expectedRedemptionAmount: '5050.01',
      idempotencyKey: 'precision-original-receipt',
    };
    const original = await banking.investment.redeemInvestment(input);
    await setEstimate('9999.999999');
    expect(await banking.investment.redeemInvestment(input)).toEqual(original);
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2863001n);
    expect(await getTestPrisma().transaction.count({
      where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY },
    })).toBe(1);
  });

  it('requires new authorization when a changed estimate changes the settled amount', async () => {
    await setEstimate('5050.005');
    await expect(banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
      expectedRedemptionAmount: '5050.00',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    const holding = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(holding.status).toBe('HOLDING');
    const account = await getTestPrisma().account.findUniqueOrThrow({ where: { id: ACCOUNT_ID } });
    expect(account.balanceMinor).toBe(2358000n);
  });

  it.each(['0', '0.0049'])('settles a total-loss quote %s without inventing cash', async (estimate) => {
    await setEstimate(estimate);
    const input = { userId: DEMO_USER_ID, holdingId: HOLDING_ID, idempotencyKey: 'precision-total-loss' };
    const original = await banking.investment.redeemInvestment(input);
    expect(original.amount).toBe('0.00');
    expect(original.redemptionValuation).toBe(estimate);
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

  it.each(['-1.001', 'invalid'])('rejects an invalid settlement quote %s without any financial write', async (estimate) => {
    await setEstimate(estimate);
    await expect(banking.investment.redeemInvestment({
      userId: DEMO_USER_ID,
      holdingId: HOLDING_ID,
    })).rejects.toBeDefined();
    const holding = await getTestPrisma().investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_ID } });
    expect(holding.status).toBe('HOLDING');
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
