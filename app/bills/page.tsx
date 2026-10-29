/**
 * Bills / 账单 — `/bills` (Server Component, RSC by default).
 *
 * Server-fetched read models (no HTTP hop): `banking.transaction.analyzeSpending(userId, { month })`,
 * `listTransactions(userId, { from, to })`, `listAnomalies(userId)`. The month comes from
 * `?month=YYYY-MM` (`searchParams` is a Promise); absent/invalid → the SDK default (the demo
 * clock's current month). `listTransactions` has no `month` option, so its epoch-ms `[from, to)` range
 * is derived from the analysed month.
 *
 * Composes `@/components` (read-only sibling): charts `SpendingPie`/`SpendingBar`/`SpendingTrend`/
 * `ui/Table` (ledger), `banking/AnomalyBanner` (flagged spends), `ui/Card`/`ui/Money`/
 * `ui/EmptyState`. Money is rendered by `ui/Money`; props stay JSON-serializable (epoch ms).
 */
import { getConfig } from '@/lib/config';
import Link from 'next/link';
import { formatDateTime, monthRange } from '@/lib/date';
import { banking } from '@/banking-sdk';
import type { AnomalyItem, SpendingAnalysis, TransactionView } from '@/banking-sdk';
import { AnomalyBanner, Card, EmptyState, Money, SpendingBar, SpendingPie, SpendingTrend, Table } from '@/components';
import type { TableColumn } from '@/components';
import { compareDecimal } from '@/lib/decimal';
import { formatCNY } from '@/lib/money';
import { getServerI18n } from '@/lib/i18n/server';
import { TransactionRemark } from '@/components/banking/TransactionRemark';

/** Only a `YYYY-MM` month (01–12) is honoured; anything else falls back to the demo month. */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Next.js passes `searchParams` as a Promise (`?month=YYYY-MM`). */
interface BillsPageProps {
  searchParams: Promise<{ month?: string }>;
}

/** Half-open `[from, to)` epoch-ms bounds for a `YYYY-MM` label (the ledger query's shape). */
function monthBounds(month: string): { from: number; to: number } {
  const [year, monthNumber] = month.split('-').map(Number);
  const { start, end } = monthRange(new Date(year, monthNumber - 1, 1));
  return { from: start.getTime(), to: end.getTime() };
}

// Reads live Prisma data, so it must render per request — never statically prerendered at build.
export const dynamic = 'force-dynamic';

export default async function BillsPage({ searchParams }: BillsPageProps) {
  const { t } = await getServerI18n();
  const userId = getConfig().demoUserId;
  const { month: monthParam } = await searchParams;
  const month = monthParam !== undefined && MONTH_PATTERN.test(monthParam) ? monthParam : undefined;

  const analysis: SpendingAnalysis = await banking.transaction.analyzeSpending(userId, month !== undefined ? { month } : {});
  const { from, to } = monthBounds(analysis.month);
  const transactions: TransactionView[] = await banking.transaction.listTransactions(userId, { from, to });
  const anomalies: AnomalyItem[] = (await banking.transaction.listAnomalies(userId)).filter(item => item.transaction.occurredAt >= from && item.transaction.occurredAt < to);

  const columns: TableColumn<TransactionView>[] = [
    { key: 'occurredAt', header: t('pages.bills.column.time'), render: (row) => formatDateTime(row.occurredAt) },
    { key: 'merchant', header: t('pages.bills.column.merchant') },
    { key: 'category', header: t('pages.bills.column.category') },
    { key: 'amount', header: t('pages.bills.column.amount'), align: 'right', render: (row) => <Money amount={row.amount} signed /> },
    { key: 'status', header: t('pages.bills.column.status'), align: 'center', render: (row) => t(row.isAnomaly ? 'pages.bills.status.anomaly' : row.direction === 'DEBIT' ? 'pages.bills.status.expense' : 'pages.bills.status.income') },
    { key: 'remark', header: t('business.transactions.remark'), className: 'w-24', render: row => <TransactionRemark remark={row.remark} /> },
  ];

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="bank-page-heading text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.bills.title')}</h1>
          <Link href={`/bills/reports?period=month&month=${analysis.month}`} className="mt-2 inline-flex min-h-11 items-center text-sm font-medium text-banking-interactive underline-offset-4 hover:underline">{t('pages.reports.open')} →</Link>
          <p className="mt-1 text-sm text-banking-navy">
            {t('pages.bills.summary', { month: analysis.month, transactions: transactions.length, anomalies: anomalies.length, total: formatCNY(analysis.total) })}
          </p>
        </div>
        <form className="flex items-center gap-2" method="get">
          <label htmlFor="month" className="text-sm text-banking-navy">{t('pages.bills.selectMonth')}</label>
          <input id="month" type="month" name="month" defaultValue={analysis.month} className="bank-input rounded-lg border border-banking-accent/15 bg-banking-surface px-2 py-1 text-sm text-banking-navy" />
          <button type="submit" className="rounded-lg bg-banking-accent px-3 py-1 text-sm text-white hover:bg-banking-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent">{t('pages.bills.view')}</button>
        </form>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card title={t('pages.bills.bookedSpending')}>
          <Money amount={analysis.total} className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-banking-caption text-banking-navy">
            {t('pages.bills.monthComparison', { change: `${compareDecimal(analysis.momChangePct, '0') > 0 ? '+' : ''}${analysis.momChangePct}`, total: formatCNY(analysis.prevTotal) })}
          </p>
        </Card>
        <Card title={t('pages.bills.largestTransaction')}>
          <Money amount={analysis.largest?.amount ?? '0.00'} signed className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-banking-caption text-banking-navy">{analysis.largest?.merchant ?? t('pages.bills.noSpending')}</p>
        </Card>
        <Card title={t('pages.bills.topMerchant')}>
          <Money amount={analysis.topMerchant?.amount ?? '0.00'} className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-banking-caption text-banking-navy">{analysis.topMerchant?.merchant ?? t('pages.bills.noSpending')}</p>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card title={t('pages.bills.categoryShare')}><SpendingPie data={analysis.byCategory} height={240} /></Card>
        <Card title={t('pages.bills.categoryAmounts')}><SpendingBar data={analysis.byCategory} height={240} /></Card>
        <Card title={t('pages.bills.sixMonthTrend')} className="lg:col-span-2">
          <SpendingTrend data={analysis.monthlyTrend} height={220} />
        </Card>
      </section>

      {anomalies.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-banking-deep">{t('pages.bills.anomalyAlerts')}</h2>
          {anomalies.map((anomaly) => (
            <AnomalyBanner key={anomaly.transaction.id} anomaly={anomaly} />
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-medium text-banking-deep">{t('pages.bills.transactionDetails')}</h2>
        <div className="overflow-x-auto"><Table
          className="min-w-[720px]"
          columns={columns}
          rows={transactions}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t('pages.bills.emptyTitle')} description={t('pages.bills.emptyDescription')} />}
        /></div>
      </section>
    </main>
  );
}
