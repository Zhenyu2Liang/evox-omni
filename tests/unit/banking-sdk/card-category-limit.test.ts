import { beforeEach, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { demoNow, demoPreviousMonthRange } from '@/lib/clock';
import { getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

beforeEach(resetDatabase);
const db = () => getTestPrisma();
const limit = (amount: string) => banking.card.setCardLimit({ userId: DEMO_USER_ID, cardId: 'card_debit', category: '餐饮', amount });
const spend = (amount: string, category = '餐饮', now = demoNow()) => banking.card.consumeCard(
  { userId: DEMO_USER_ID, cardId: 'card_debit', amount, category }, { now });

it('rejects the original 1-yuan limit / 2-yuan spend without changing any ledger', async () => {
  await limit('1.00');
  const before = await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
  await expect(spend('2.00')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect((await db().account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
  expect(await db().cardConsumption.count()).toBe(0);
});

it('checks cumulative spend and allows the exact boundary', async () => {
  await limit('1.00');
  await spend('0.60');
  await spend('0.40');
  await expect(spend('0.01')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});

it('does not count another category or a previous business month', async () => {
  await limit('1.00');
  await spend('1.00', '餐饮', demoPreviousMonthRange().start.getTime());
  await spend('2.00', '其他');
  await spend('1.00');
  await expect(spend('0.01')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});

it('enforces a zero category limit', async () => {
  await limit('0.00');
  await expect(spend('0.01')).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
});

it('inherits a zero category limit through repeated replacements', async () => {
  await limit('0.00');
  let cardId = 'card_debit';
  for (let generation = 0; generation < 2; generation++) {
    await banking.card.reportLostCard(cardId, DEMO_USER_ID);
    const replacement = await banking.card.replaceCard(cardId, DEMO_USER_ID);
    expect(replacement.limits).toContainEqual({ category: '餐饮', amount: '0.00' });
    await expect(banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: replacement.id, amount: '0.01', category: '餐饮' }))
      .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    cardId = replacement.id;
  }
  expect(await db().cardConsumption.count()).toBe(0);
});

it('carries category spend forward, permits the exact boundary, and does not reset a changed replacement limit on replay', async () => {
  await limit('1.00');
  await spend('0.60');
  await banking.card.reportLostCard('card_debit', DEMO_USER_ID);
  const replacement = await banking.card.replaceCard('card_debit', DEMO_USER_ID);
  await expect(banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: replacement.id, amount: '0.41', category: '餐饮' }))
    .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: replacement.id, amount: '0.40', category: '餐饮' });
  await banking.card.setCardLimit({ userId: DEMO_USER_ID, cardId: replacement.id, category: '餐饮', amount: '0.50' });
  expect((await banking.card.replaceCard('card_debit', DEMO_USER_ID)).limits).toContainEqual({ category: '餐饮', amount: '0.50' });
  await expect(banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: replacement.id, amount: '0.01', category: '餐饮' }))
    .rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
  expect(await db().cardConsumption.count()).toBe(2);
});

it('serializes concurrent category spending without exceeding the limit', async () => {
  await limit('1.00');
  const results = await Promise.allSettled([spend('0.60'), spend('0.60')]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await db().cardConsumption.count()).toBe(1);
});
