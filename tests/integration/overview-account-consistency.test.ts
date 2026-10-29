import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { banking } from '@/banking-sdk';
import { GET } from '@/app/api/cards/route';
import { AccountBalances } from '@/components/banking/AccountBalances';
import { BalanceCard } from '@/components/chat/cards/BalanceCard';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';

useFreshDatabase();
describe('deposit account visibility across overview, cards and balance queries', () => {
  it('shows the savings deposit on both pages without inventing an issued savings card', async () => {
    const overview = await banking.dashboard.getOverview(DEMO_USER_ID);
    const cards = await banking.card.getCardPage(DEMO_USER_ID);
    const balance = await banking.account.getBalance(DEMO_USER_ID);
    expect(overview.accounts).toEqual(balance.accounts);
    expect(cards.accounts).toEqual(balance.accounts);
    expect(cards.accounts).toContainEqual(expect.objectContaining({ type: 'SAVINGS', numberMasked: '****3309', balance: '50000.00' }));
    expect(cards.cards.some(card => card.numberMasked === '****3309')).toBe(false);
    const html = renderToStaticMarkup(createElement(AccountBalances, cards));
    expect(html).toContain('储蓄账户');
    expect(html).toContain('账户尾号 ****3309');
    expect(html).toContain('¥50,000.00');
    expect(html).toContain('未关联银行卡');
    expect(renderToStaticMarkup(createElement(BalanceCard, { data: balance }))).toContain('账户尾号 ****3309');
  });
  it('keeps the new account projection masked and scoped to the server-owned user', async () => {
    await getTestPrisma().account.update({ where: { id: 'acct_savings' }, data: { number: '6222000000003309' } });
    const response = await GET(new NextRequest('http://localhost/api/cards?userId=foreign'));
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain('****3309');
    expect(text).not.toContain('6222000000003309');
    expect(JSON.parse(text).data.accounts).toHaveLength(2);
  });
  it('refreshes account balances and linked-card balances from the same database state', async () => {
    await getTestPrisma().account.update({ where: { id: 'acct_checking' }, data: { balanceMinor: 2348000n } });
    const { accounts, cards } = await banking.card.getCardPage(DEMO_USER_ID);
    expect(accounts.find(account => account.id === 'acct_checking')?.balance).toBe('23480.00');
    expect(cards.find(card => card.id === 'card_debit')?.accountAvailableBalance).toBe('23480.00');
    expect((await banking.dashboard.getOverview(DEMO_USER_ID)).summary.checkingBalance).toBe('23480.00');
  });
});
