import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { InvestResult } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

// Subscribes a product the user does not already hold, so the purchase creates its own holding
// instead of aggregating into holding_wenjiana and leaving its execution key in purchaseHistory.
const purchase = { userId: DEMO_USER_ID, productId: 'prod_huobi', amount: '1000.00', idempotencyKey: 'review-purchase' };
const redemption = { userId: DEMO_USER_ID, holdingId: 'holding_wenjiana', expectedRedemptionAmount: '5050.00', idempotencyKey: 'review-redemption' };

async function postedState() {
  const client = getTestPrisma();
  return {
    balance: (await client.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor,
    flows: await client.transaction.count({ where: { userId: DEMO_USER_ID, category: INVESTMENT_FLOW_CATEGORY } }),
  };
}

describe('reviewed SDK replay boundaries', () => {
  it('replays a committed purchase before checking the current product minimum', async () => {
    const original = await banking.investment.subscribeInvestment(purchase);
    await getTestPrisma().investmentProduct.update({ where: { id: purchase.productId }, data: { minAmountMinor: 200000n } });
    expect(await banking.investment.subscribeInvestment(purchase)).toEqual(original);
    expect(await postedState()).toEqual({ balance: 2258000n, flows: 1 });
  });

  it('replays original investment results without resolving a current checking account', async () => {
    const subscribed = await banking.investment.subscribeInvestment(purchase);
    const redeemed = await banking.investment.redeemInvestment(redemption);
    await getTestPrisma().account.update({ where: { id: 'acct_checking' }, data: { type: 'SAVINGS' } });
    expect(await banking.investment.subscribeInvestment(purchase)).toEqual(subscribed);
    expect(await banking.investment.redeemInvestment(redemption)).toEqual(redeemed);
    expect(await postedState()).toEqual({ balance: 2763000n, flows: 2 });
  });

  it('rejects a changed purchase under the same key before current product validation', async () => {
    await banking.investment.subscribeInvestment(purchase);
    await getTestPrisma().investmentProduct.update({ where: { id: purchase.productId }, data: { minAmountMinor: 200000n } });
    await expect(banking.investment.subscribeInvestment({ ...purchase, amount: '999.00' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await postedState()).toEqual({ balance: 2258000n, flows: 1 });
  });

  it.each([
    ['null', () => null],
    ['primitive', () => 42],
    ['empty object', () => ({})],
    ['wrong holding', (original: InvestResult) => ({ ...original, holdingId: 'other-holding' })],
    ['wrong product', (original: InvestResult) => ({ ...original, productId: 'other-product' })],
    ['numeric amount', (original: InvestResult) => ({ ...original, amount: 5050 })],
    ['negative balance', (original: InvestResult) => ({ ...original, newBalance: '-1.00' })],
    ['missing account', (original: InvestResult) => ({ ...original, sourceAccountId: '' })],
    ['invalid time', (original: InvestResult) => ({ ...original, occurredAt: 'invalid' })],
    ['missing valuation', (original: InvestResult) => ({ ...original, redemptionValuation: undefined })],
    ['different valuation', (original: InvestResult) => ({ ...original, redemptionValuation: '5050.01' })],
    ['different rounding', (original: InvestResult) => ({ ...original, settlementRounding: 'DOWN' })],
  ] as const)('rejects %s in a saved redemption result without another credit', async (_label, corrupt) => {
    const original = await banking.investment.redeemInvestment(redemption);
    await getTestPrisma().investmentHolding.update({ where: { id: redemption.holdingId }, data: { redeemResult: JSON.stringify(corrupt(original)) } });
    await expect(banking.investment.redeemInvestment(redemption)).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await postedState()).toEqual({ balance: 2863000n, flows: 1 });
  });

  it('rejects a changed approved redemption amount under a committed key', async () => {
    await banking.investment.redeemInvestment(redemption);
    await expect(banking.investment.redeemInvestment({ ...redemption, expectedRedemptionAmount: '5051.00' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await postedState()).toEqual({ balance: 2863000n, flows: 1 });
  });

  it('resolves a raw phone through the same masked matching rule as contact search', async () => {
    const result = await banking.transfer.createTransfer({ userId: DEMO_USER_ID, phone: '13900000002', amount: '100.00' });
    expect(result.recipient.contactId).toBe('contact_zhangwei');
    expect(result.newBalance).toBe('23480.00');
  });

  it('rejects ambiguous masked phone matches without moving cash', async () => {
    await getTestPrisma().contact.create({ data: { userId: DEMO_USER_ID, name: 'Duplicate contact', phone: '139****0002' } });
    await expect(banking.transfer.createTransfer({ userId: DEMO_USER_ID, phone: '13900000002', amount: '100.00' }))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
});
