import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import { reportDisplayTrend, reportTrendSvg, reportCategorySvg } from '@/lib/bill-report-presentation';
import { billReportHtml } from '@/lib/bill-report-export';
import { addMoney } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';

useFreshDatabase();
describe('report display grouping and portable charts', () => {
  it('groups daily points into at most five exact buckets and keeps the SDK daily contract', async () => {
    const report = await banking.report.getBillReport(DEMO_USER_ID);
    const points = reportDisplayTrend(report);
    expect(report.trend).toHaveLength(30);
    expect(points.map(point => point.label)).toEqual(['01-07', '08-14', '15-21', '22-28', '29-30']);
    for (const key of ['inflow', 'outflow', 'net', 'spending'] as const) {
      expect(points.reduce((sum, point) => addMoney(sum, point[key]), '0.00')).toBe(report.totals[key]);
    }
    expect(points.reduce((sum, point) => sum + point.count, 0)).toBe(report.totals.count);
    expect(reportTrendSvg(report, 'zh-CN').match(/data-report-bucket=/g)).toHaveLength(5);
  });
  it('keeps leap days and preserves twelve monthly points for annual reports', async () => {
    const leap = await banking.report.getBillReport(DEMO_USER_ID, { month: '2024-02' });
    expect(reportDisplayTrend(leap).at(-1)?.label).toBe('29-29');
    expect(reportDisplayTrend(await banking.report.getBillReport(DEMO_USER_ID, { month: '2023-02' }))).toHaveLength(4);
    const annual = await banking.report.getBillReport(DEMO_USER_ID, { period: 'year', year: '2026' });
    expect(reportDisplayTrend(annual)).toEqual(annual.trend);
    expect(reportTrendSvg(annual, 'en').match(/data-report-bucket=/g)).toHaveLength(12);
  });
  it('does not round aggregate bucket amounts through floating point or the per-row int64 bound', async () => {
    const report = await banking.report.getBillReport(DEMO_USER_ID, { month: '2040-01' });
    report.trend[0].outflow = '92233720368547758.07';
    report.trend[1].outflow = '92233720368547758.07';
    expect(reportDisplayTrend(report)[0].outflow).toBe('184467440737095516.14');
  });
  it('embeds escaped SVG charts and data summaries in offline HTML', async () => {
    await getTestPrisma().transaction.create({ data: { userId: DEMO_USER_ID, accountId: 'acct_checking', amountMinor: -1n,
      direction: 'DEBIT', merchant: 'Fixture', category: '<svg onload="alert(1)">', occurredAt: new Date('2030-01-01T00:00:00Z') } });
    const report = await banking.report.getBillReport(DEMO_USER_ID, { month: '2030-01' });
    const html = billReportHtml(report, 'zh-CN');
    expect(html.match(/<svg xmlns=/g)).toHaveLength(2);
    expect(html).toContain('每 7 天汇总');
    expect(html).toContain('数据摘要');
    expect(html).toContain('&lt;svg onload=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain('<svg onload=');
    expect(reportCategorySvg(report, 'zh-CN')).not.toContain('<svg onload=');
  });
});
