import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { banking } from '@/banking-sdk';
import CardManager from '@/app/cards/CardManager';
import CardConsumeDialog from '@/app/cards/CardConsumeDialog';
import { POST } from '@/app/api/cards/[id]/consume/route';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';
import { idCtx } from '../app/harness';

useFreshDatabase();

it('does not offer a credit card spend entry and explains the limitation', async () => {
  const card = (await banking.card.getCards(DEMO_USER_ID)).find(c => c.id === 'card_credit')!;
  const html = renderToStaticMarkup(createElement(CardManager, { initialCards: [card] }));
  expect(html).not.toContain('data-card-consume="');
  expect(html).toContain('信用卡暂不支持模拟消费');
});

it('blocks a credit card dialog even when directly mounted', async () => {
  const card = (await banking.card.getCards(DEMO_USER_ID)).find(c => c.id === 'card_credit')!;
  const html = renderToStaticMarkup(createElement(CardConsumeDialog, { card, onClose() {}, onConsumed() {} }));
  expect(html).toMatch(/<fieldset disabled=""/);
  expect(html).toContain('信用卡暂不支持模拟消费');
});

it('refuses a forged credit-card consume request even if it has a settlement binding', async () => {
  const db = getTestPrisma();
  await db.card.update({ where: { id: 'card_credit' }, data: { linkedAccountId: 'acct_checking' } });
  const before = await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
  const count = await db.transaction.count();
  const response = await POST(new NextRequest('http://localhost/api/cards/card_credit/consume', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: '1.00', executionKey: 'credit-must-not-spend' }),
  }), idCtx('card_credit'));
  expect(response.status).toBe(409);
  expect((await response.json()).error.code).toBe('CONFLICT');
  expect((await db.account.findUniqueOrThrow({ where: { id: before.id } })).balanceMinor).toBe(before.balanceMinor);
  expect(await db.transaction.count()).toBe(count);
  expect(await db.cardConsumption.count({ where: { executionKey: 'credit-must-not-spend' } })).toBe(0);
});

it('preserves account-backed debit-card consumption', async () => {
  const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: 'card_debit', amount: '12.34', executionKey: 'debit-still-works' });
  expect(result.consumption.amount).toBe('12.34');
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2356766n);
});
