import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { banking } from '@/banking-sdk';
import { TransactionRemark } from '@/components/banking/TransactionRemark';
import { RecentTransactions } from '@/components/banking/RecentTransactions';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));
useFreshDatabase();

describe('recorded transaction notes stay visible', () => {
  it('carries a stored transfer note through dashboard, bills and report read models', async () => {
    const row = await getTestPrisma().transaction.create({ data: { userId: DEMO_USER_ID, accountId: 'acct_checking',
      amountMinor: -20000n, direction: 'DEBIT', category: '转账', merchant: '转账给张伟', channel: 'TRANSFER',
      remark: '打车', occurredAt: new Date('2026-09-25T04:00:00Z') } });
    const overview = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(overview.recentTransactions.find(item => item.id === row.id)?.remark).toBe('打车');
    const html = renderToStaticMarkup(createElement(RecentTransactions, { transactions: overview.recentTransactions }));
    expect(html).toMatch(/<th[^>]*>备注<\/th><\/tr>/);
    expect(html).toMatch(/<td[^>]*><span data-transaction-remark[^>]*>打车<\/span><\/td><\/tr>/);
    expect(html).not.toContain('备注：打车');
    expect((await banking.transaction.listTransactions(DEMO_USER_ID)).find(item => item.id === row.id)?.remark).toBe('打车');
    expect((await banking.report.getBillReport(DEMO_USER_ID)).transactions.find(item => item.id === row.id)?.description).toBe('打车');
  });
  it('keeps multiline user text escaped and never interprets note markup as HTML', () => {
    const html = renderToStaticMarkup(createElement(TransactionRemark, { remark: '<img src=x onerror=alert(1)>\n打车返程' }));
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;\n打车返程');
    expect(html).not.toContain('<img');
    expect(html).toContain('whitespace-pre-wrap');
    for (const remark of [undefined, '', '  \n']) expect(renderToStaticMarkup(createElement(TransactionRemark, { remark }))).toMatch(/>—<\/span>/);
  });
  it('localizes the label while preserving the recorded note verbatim', () => {
    const transaction = { id: 'note', accountId: 'acct_checking', currency: 'CNY', isAnomaly: false, merchant: 'Merchant', category: 'Transfer', occurredAt: Date.now(), amount: '-2.00', direction: 'DEBIT', remark: '打车' } as const;
    const html = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: 'en', children: createElement(RecentTransactions, { transactions: [transaction] }) }));
    expect(html).toMatch(/<th[^>]*>Note<\/th><\/tr>/);
    expect(html).toMatch(/<span data-transaction-remark[^>]*>打车<\/span>/);
  });
});
