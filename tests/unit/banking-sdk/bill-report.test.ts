import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { resolveBillReportQuery } from '@/banking-sdk/bill-report';
import { businessDate } from '@/lib/date';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();
const db = () => getTestPrisma();
async function book(at: Date, minor: bigint, options: { userId?: string; category?: string; currency?: string; isAnomaly?: boolean } = {}) {
  return db().transaction.create({ data: { userId: options.userId ?? DEMO_USER_ID, accountId: 'acct_checking',
    occurredAt: at, amountMinor: minor, direction: minor < 0n ? 'DEBIT' : 'CREDIT', merchant: 'Report fixture',
    category: options.category ?? '餐饮', currency: options.currency ?? 'CNY', isAnomaly: options.isAnomaly ?? false } });
}

describe('bill report exact ledger read model', () => {
  it('defaults to the demo month and rejects invalid, mixed and unknown filters', () => {
    expect(resolveBillReportQuery()).toEqual({ period: 'month', label: '2026-09' });
    expect(resolveBillReportQuery({ period: 'year' })).toEqual({ period: 'year', label: '2026' });
    for (const query of [{ month: '2026-13' }, { month: '0000-01' }, { period: 'week' }, { period: 'year', month: '2026-09' },
      { period: 'month', year: '2026' }, { period: 'year', year: '10000' }, { period: 'year', year: '999' }, { userId: 'other' }, { month: ['2026-01', '2026-02'] }, null]) {
      expect(() => resolveBillReportQuery(query)).toThrowError(expect.objectContaining({ code: 'VALIDATION' }));
    }
  });

  it('matches existing spending, includes anomalies and excludes investment principal only from spending', async () => {
    await book(businessDate(2026, 8, 25), -12345n, { category: '投资' });
    await book(businessDate(2026, 8, 25), 13000n, { category: '投资' });
    const report = await banking.report.getBillReport(DEMO_USER_ID);
    const analysis = await banking.transaction.analyzeSpending(DEMO_USER_ID);
    expect(report.totals.spending).toBe(analysis.total);
    expect(report.totals.outflow).toBe(centsToMoney(moneyToCents(analysis.total) + 12345n));
    expect(report.totals.anomalyCount).toBeGreaterThan(0);
    expect(report.categories.some(row => row.category === '投资')).toBe(false);
    expect(report.transactions.some(row => row.category === '投资' && row.direction === 'CREDIT')).toBe(true);
    expect(report.trend).toHaveLength(30);
  });

  it('uses half-open UTC+08 month boundaries and leap day, with an exact prior-period comparison', async () => {
    await book(businessDate(2024, 0, 31, 23, 59), -100n);
    const first = await book(businessDate(2024, 1), -125n);
    const leap = await book(businessDate(2024, 1, 29, 23, 59), -75n, { isAnomaly: true });
    await book(businessDate(2024, 2), -500n);
    const report = await banking.report.getBillReport(DEMO_USER_ID, { month: '2024-02' });
    expect(report.transactions.map(row => row.id)).toEqual([leap.id, first.id]);
    expect(report.from).toBe(Date.parse('2024-01-31T16:00:00Z'));
    expect(report.to).toBe(Date.parse('2024-02-29T16:00:00Z'));
    expect(report.trend).toHaveLength(29);
    expect(report.trend.at(-1)?.spending).toBe('0.75');
    expect(report.previous).toMatchObject({ label: '2024-01', totals: { spending: '1.00' }, spendingChangePct: '100.00' });
    expect(report.totals).toMatchObject({ outflow: '2.00', net: '-2.00', count: 2, anomalyCount: 1 });
  });

  it('covers all twelve months, calendar year boundaries and previous year, including December', async () => {
    await book(businessDate(2029, 11, 31, 23, 59), -600n);
    for (let month = 0; month < 12; month++) await book(businessDate(2030, month), -100n);
    await book(businessDate(2031, 0), -900n);
    const report = await banking.report.getBillReport(DEMO_USER_ID, { period: 'year', year: '2030' });
    expect(report.totals.spending).toBe('12.00');
    expect(report.previous).toMatchObject({ label: '2029', totals: { spending: '6.00' }, spendingChangePct: '100.00' });
    expect(report.trend.map(point => point.spending)).toEqual(Array(12).fill('1.00'));
    expect(report.trend.at(-1)?.label).toBe('2030-12');
    expect(report.categories).toEqual([{ category: '餐饮', amount: '12.00', count: 12, sharePct: '100.00' }]);
  });

  it('keeps money exact above Number precision and the per-row signed-64-bit limit', async () => {
    await book(businessDate(2030, 0), -9223372036854775807n);
    await book(businessDate(2030, 0), -9223372036854775807n);
    const report = await banking.report.getBillReport(DEMO_USER_ID, { month: '2030-01' });
    expect(report.totals.spending).toBe('184467440737095516.14');
    expect(report.totals.net).toBe('-184467440737095516.14');
    expect(report.categories[0].amount).toBe(report.totals.spending);
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it('returns an honest empty report with null comparison when prior spending is zero', async () => {
    const report = await banking.report.getBillReport(DEMO_USER_ID, { period: 'year', year: '2040' });
    expect(report.totals).toEqual({ inflow: '0.00', outflow: '0.00', net: '0.00', spending: '0.00', count: 0, anomalyCount: 0 });
    expect(report.previous.spendingChangePct).toBeNull();
    expect(report.trend).toHaveLength(12);
    expect(report.categories).toEqual([]);
    expect(report.transactions).toEqual([]);
  });

  it('isolates the owner and currency and does not truncate a report at 50 or 200 rows', async () => {
    await db().user.create({ data: { id: 'report-other', name: 'Other', phone: '13800001111' } });
    await book(businessDate(2030, 0), -900n, { userId: 'report-other' });
    await book(businessDate(2030, 0), -900n, { currency: 'USD' });
    await db().transaction.createMany({ data: Array.from({ length: 251 }, (_, i) => ({ userId: DEMO_USER_ID, accountId: 'acct_checking',
      occurredAt: businessDate(2030, 0, 1, 0, i), amountMinor: -1n, direction: 'DEBIT', merchant: `Row ${i}`, category: '餐饮' })) });
    const report = await banking.report.getBillReport(DEMO_USER_ID, { month: '2030-01' });
    expect(report.totals).toMatchObject({ count: 251, spending: '2.51' });
    expect(report.transactions).toHaveLength(251);
    expect((await banking.report.getBillReport('report-other', { month: '2030-01' })).totals.spending).toBe('9.00');
  });
});
