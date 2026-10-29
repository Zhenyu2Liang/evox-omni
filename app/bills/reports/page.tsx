import Link from 'next/link';
import { banking } from '@/banking-sdk';
import { resolveBillReportQuery, type BillReportQuery } from '@/banking-sdk/bill-report';
import { Card } from '@/components/ui/Card';
import { getConfig } from '@/lib/config';
import { demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { formatBusinessDate, formatDateTime } from '@/lib/date';
import { formatCNY } from '@/lib/money';
import { reportDisplayTrend, reportTrendSvg, reportFacts } from '@/lib/bill-report-presentation';
import { billReportSnapshot, readBillReportAnalysis } from '@/agent/bill-report-analysis';
import { getServerI18n } from '@/lib/i18n/server';
import { ReportFilters } from './ReportFilters';
import { ReportAnalysis } from './ReportAnalysis';
import { TransactionRemark } from '@/components/banking/TransactionRemark';

export const dynamic = 'force-dynamic';
const PAGE_SIZE = 50;
const linkStyle = 'inline-flex min-h-11 items-center justify-center rounded-xl border border-banking-border bg-banking-surface px-4 py-2 text-sm font-medium text-banking-deep transition-colors hover:bg-banking-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent';

export default async function BillReportsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { t, locale } = await getServerI18n();
  const raw = await searchParams;
  const { page: pageParam, ...query } = raw;
  let selection: ReturnType<typeof resolveBillReportQuery>;
  try { selection = resolveBillReportQuery(query); }
  catch (error) {
    if (!(error instanceof AppError) || error.code !== 'VALIDATION') throw error;
    const fallback = formatBusinessDate(demoNow());
    return <main className="mx-auto w-full max-w-6xl space-y-6 p-4 sm:p-8"><h1 className="bank-page-heading text-3xl font-semibold text-banking-deep">{t('pages.reports.title')}</h1><p role="alert" className="rounded-xl bg-banking-neutral p-4 text-banking-danger">{t('pages.reports.invalid')}</p><Card><ReportFilters period="month" month={fallback.slice(0, 7)} year={fallback.slice(0, 4)} /></Card></main>;
  }
  const report = await banking.report.getBillReport(getConfig().demoUserId, query as BillReportQuery);
  const analysis = await readBillReportAnalysis(getConfig().demoUserId, report, locale);
  const trend = reportDisplayTrend(report);
  const pages = Math.max(1, Math.ceil(report.transactions.length / PAGE_SIZE));
  const page = typeof pageParam === 'string' && /^[1-9]\d{0,8}$/.test(pageParam) ? Math.min(Number(pageParam), pages) : 1;
  const entries = report.transactions.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const params = new URLSearchParams(selection.period === 'month' ? { period: 'month', month: report.label } : { period: 'year', year: report.label });
  const exportUrl = (format: string) => `/api/bills/reports?${params}&format=${format}&locale=${locale}`;
  const pageUrl = (number: number) => `/bills/reports?${params}&page=${number}`;
  const defaultMonth = selection.period === 'month' ? report.label : `${report.label}-01`;
  const reportTitle = t(report.period === 'month' ? 'pages.reports.monthly' : 'pages.reports.yearly');

  return <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
    <header>
      <Link href="/bills" className="text-sm text-banking-interactive underline-offset-4 hover:underline">← {t('pages.reports.back')}</Link>
      <h1 className="bank-page-heading mt-3 text-3xl font-semibold tracking-tight text-banking-deep">{t('pages.reports.title')}</h1>
      <p className="mt-2 text-sm text-banking-navy">{t('pages.reports.subtitle')}</p>
    </header>
    <Card padding="lg"><ReportFilters key={`${report.period}-${report.label}`} period={report.period} month={defaultMonth} year={report.label.slice(0, 4)} /></Card>
    <section aria-label={reportTitle} className="rounded-2xl border border-banking-border bg-banking-surface p-5 sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div><p className="text-sm font-medium text-banking-navy">{reportTitle} · CNY · UTC+08:00</p><h2 className="mt-1 text-3xl font-semibold tracking-tight text-banking-deep">{report.label}</h2><p className="mt-2 text-sm text-banking-navy">{t('pages.reports.counts', { count: report.totals.count, anomalies: report.totals.anomalyCount })}</p></div>
        <div className="flex flex-wrap gap-2"><a href={exportUrl('pdf')} className={`${linkStyle} border-banking-accent/30 text-banking-accent-text`}>{t('pages.reports.pdf')} ↓</a><a href={exportUrl('csv')} className={linkStyle}>{t('pages.reports.csv')} ↓</a><a href={exportUrl('html')} className={linkStyle}>{t('pages.reports.html')} ↓</a></div>
      </div>
      <div className="mt-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {(['inflow', 'outflow', 'net', 'spending'] as const).map((key, index) => <div key={key} className={`min-w-0 rounded-xl p-4 ${index === 0 ? 'bg-banking-teal-soft' : index === 2 ? 'bg-banking-blue-soft' : 'bg-banking-light'}`}><h3 className="text-sm text-banking-navy">{t(`pages.reports.${key}`)}</h3><p className={`mt-3 break-all text-2xl font-semibold tabular-nums tracking-tight ${index === 0 ? 'text-banking-teal' : 'text-banking-deep'}`}>{formatCNY(report.totals[key])}</p></div>)}
      </div>
      <p className="mt-5 text-sm text-banking-navy">{t('pages.reports.comparison', { period: report.previous.label, amount: formatCNY(report.previous.totals.spending), change: report.previous.spendingChangePct === null ? t('pages.reports.noComparison') : `${report.previous.spendingChangePct}%` })}</p>
      <p className="mt-2 text-xs leading-relaxed text-banking-navy">{t('pages.reports.scope')}</p>
    </section>
    {report.totals.count === 0 ? <p role="status" className="rounded-2xl border border-dashed border-banking-input-border p-8 text-center text-sm text-banking-navy">{t('pages.reports.empty')}</p> : null}
    <ReportAnalysis key={`${billReportSnapshot(report)}-${locale}`} query={selection.period === 'month' ? { period: 'month', month: report.label } : { period: 'year', year: report.label }} facts={reportFacts(report, locale)} initialAnalysis={analysis} empty={report.totals.count === 0} />
    <div className="grid min-w-0 items-start gap-6 lg:grid-cols-[1.6fr_1fr]">
      <Card title={t('pages.reports.trend')} description={t(report.period === 'year' ? 'pages.reports.byMonth' : 'pages.reports.weekly')}>
        <div className="mt-2" dangerouslySetInnerHTML={{ __html: reportTrendSvg(report, locale) }} />
        <details className="mt-4 text-sm text-banking-navy"><summary className="cursor-pointer">{t('pages.reports.trendDetails')}</summary><div className="mt-3 overflow-x-auto"><table className="w-full text-xs"><thead><tr><th scope="col" className="p-2 text-left">{t('pages.reports.period')}</th><th scope="col">{t('pages.reports.inflow')}</th><th scope="col">{t('pages.reports.outflow')}</th></tr></thead><tbody>{trend.map(point => <tr key={point.label}><th scope="row" className="whitespace-nowrap p-2 text-left font-normal">{point.label}</th><td className="text-center tabular-nums">{formatCNY(point.inflow)}</td><td className="text-center tabular-nums">{formatCNY(point.outflow)}</td></tr>)}</tbody></table></div></details>
      </Card>
      <Card title={t('pages.reports.categories')}>
        {report.categories.length === 0 ? <p className="py-8 text-sm text-banking-navy">{t('pages.reports.noSpending')}</p> : <ul className="space-y-5">{report.categories.map(category => <li key={category.category}><div className="flex flex-wrap justify-between gap-2 text-sm"><span className="break-all text-banking-deep">{category.category}</span><span className="tabular-nums text-banking-navy">{formatCNY(category.amount)} · {category.sharePct}%</span></div><div className="mt-2 h-1.5 overflow-hidden rounded-full bg-banking-subtle"><div className="h-full rounded-full bg-banking-teal" style={{ width: `${category.sharePct}%` }} /></div></li>)}</ul>}
      </Card>
    </div>
    <Card title={t('pages.reports.ledger')} description={t('pages.reports.ledgerHint')}>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-banking-light text-banking-navy"><tr>{(['time', 'merchant', 'category', 'amount', 'status', 'remark'] as const).map(key => <th scope="col" key={key} className={`whitespace-nowrap py-3 font-medium ${key === 'remark' ? 'w-24 px-4' : 'px-5'}`}>{t(key === 'remark' ? 'business.transactions.remark' : `pages.reports.${key}`)}</th>)}</tr></thead><tbody className="text-banking-deep">{entries.map(row => <tr key={row.id} className="border-t border-banking-border/60 hover:bg-banking-light"><td className="whitespace-nowrap px-5 py-4 text-xs tabular-nums text-banking-navy">{formatDateTime(row.occurredAt)}</td><td className="min-w-36 max-w-64 break-words px-5 py-4">{row.merchant}</td><td className="max-w-40 break-words px-5 py-4 text-banking-navy">{row.category}</td><td className="whitespace-nowrap px-5 py-4 font-medium tabular-nums">{row.direction === 'CREDIT' ? '+' : ''}{formatCNY(row.amount)}</td><td className="whitespace-nowrap px-5 py-4"><span className={`rounded-full px-2 py-1 text-xs ${row.isAnomaly ? 'bg-banking-neutral text-banking-danger' : 'bg-banking-teal-soft text-banking-teal'}`}>{t(row.isAnomaly ? 'pages.reports.flagged' : 'pages.reports.booked')}</span></td><td className="w-24 px-4 py-4"><TransactionRemark remark={row.description} /></td></tr>)}</tbody></table></div>
      <nav aria-label={t('pages.reports.ledger')} className="flex flex-wrap items-center justify-between gap-3 border-t border-banking-border p-5"><span className="text-xs text-banking-navy">{t('pages.reports.page', { page, pages, count: report.totals.count })}</span><div className="flex gap-2">{page > 1 ? <Link className={linkStyle} href={pageUrl(page - 1)}>{t('pages.reports.previousPage')}</Link> : null}{page < pages ? <Link className={linkStyle} href={pageUrl(page + 1)}>{t('pages.reports.nextPage')}</Link> : null}</div></nav>
    </Card>
  </main>;
}
