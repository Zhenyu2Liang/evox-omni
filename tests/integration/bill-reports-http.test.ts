import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/bills/reports/route';
import { banking } from '@/banking-sdk';
import { billReportCsv, billReportHtml, csvText } from '@/lib/bill-report-export';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';
import { DEMO_USER_ID } from '../helpers/fixtures';

useFreshDatabase();
const request = (query = '') => GET(new NextRequest(`http://localhost/api/bills/reports${query}`));

describe('bill report HTTP and safe exports', () => {
  it('returns the same exact report as the SDK with private no-store caching', async () => {
    const response = await request('?period=year&year=2026');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect((await response.json()).data).toEqual(await banking.report.getBillReport(DEMO_USER_ID, { period: 'year', year: '2026' }));
  });

  it.each(['?period=year&month=2026-09', '?month=2026-13', '?year=2026', '?period=year&year=2026&year=2025',
    '?format=xlsx', '?locale=xx', '?userId=report-other', '?period=quarter', '?month=2026-09&month=2026-08'])('rejects invalid or ambiguous filters: %s', async query => {
    const response = await request(query);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION');
  });

  it('rejects an untrusted host before reading report data', async () => {
    const response = await GET(new NextRequest('http://attacker.example/api/bills/reports'));
    expect(response.status).toBe(403);
  });

  it('downloads every record, signed exact amounts and a UTF-8 BOM with a safe filename', async () => {
    const response = await request('?period=month&month=2026-09&format=csv&locale=en');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="bill-report-2026-09.csv"');
    const report = await banking.report.getBillReport(DEMO_USER_ID);
    const text = new TextDecoder().decode(bytes);
    expect(text.trim().split('\r\n')).toHaveLength(report.totals.count + 1);
    for (const row of report.transactions) expect(text).toContain(`"${row.amount}"`);
    expect(text).toContain('Transaction time');
  });

  it('escapes HTML and spreadsheet formulas without changing the stored facts', async () => {
    const merchant = '<img src=x onerror=alert(1)> & "店铺"';
    const note = '=HYPERLINK("https://attacker.example","open")';
    const row = await getTestPrisma().transaction.create({ data: { userId: DEMO_USER_ID, accountId: 'acct_checking', amountMinor: -123n,
      direction: 'DEBIT', category: '+SUM(1,2)', merchant, remark: note, occurredAt: new Date('2026-09-20T00:00:00Z') } });
    const csv = await (await request('?month=2026-09&format=csv')).text();
    expect(csv).toContain('"\'+SUM(1,2)"');
    expect(csv).toContain('"\'=HYPERLINK(""https://attacker.example"",""open"")"');
    const response = await request('?month=2026-09&format=html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await response.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;店铺&quot;');
    expect(html).toContain('@media print');
    expect(html).toContain('消费分类');
    expect(html).toContain('资金趋势');
    expect((await getTestPrisma().transaction.findUniqueOrThrow({ where: { id: row.id } })).remark).toBe(note);
  });

  it.each(['=1+1', '+1+1', '-1+1', '@SUM(A1)', ' \t=1', '\rhello', '\nhello', '\ttext', '\u0001=cmd'])('neutralizes formula-like text: %j', value => {
    expect(csvText(value).startsWith('"\'')).toBe(true);
  });

  it('exports empty reports and aggregate amounts above a single database value range', async () => {
    const report = await banking.report.getBillReport(DEMO_USER_ID, { month: '2040-02' });
    report.totals.inflow = '184467440737095516.14';
    expect(billReportHtml(report, 'en')).toContain('¥184,467,440,737,095,516.14');
    expect(billReportCsv(report, 'zh-CN').split('\r\n')).toHaveLength(2);
  });
});
