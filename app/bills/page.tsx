/**
 * Bills / 账单 — `/bills` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `banking.transaction.analyzeSpending(userId, { month })`      → `SpendingAnalysis`
 *   `banking.transaction.listTransactions(userId, { from, to })`  → `TransactionView[]`
 *   `banking.transaction.listAnomalies(userId)`                   → `AnomalyItem[]`
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * The month comes from `?month=YYYY-MM` (Next 15: `searchParams` is a Promise). Absent/invalid →
 * the SDK default (the demo clock's current month). `listTransactions` filters by an epoch-ms
 * `[from, to)` range (it has no `month` option), so the range is derived from the analysed month.
 *
 * Composes (`@/components` — read-only sibling, owns the APIs): charts `SpendingPie` / `SpendingBar`
 * / `SpendingTrend` / `MiniSparkline`, `ui/Table` for the ledger, `banking/AnomalyBanner` for flagged
 * spends, with `ui/Card` / `ui/Money` / `ui/EmptyState` chrome. Money is rendered by `ui/Money`.
 */
import { getConfig } from '@/lib/config';
import { formatDateTime, monthRange } from '@/lib/date';
import { banking } from '@/banking-sdk';
import type { AnomalyItem, SpendingAnalysis, TransactionView } from '@/banking-sdk';
import {
  AnomalyBanner,
  Card,
  EmptyState,
  MiniSparkline,
  Money,
  SpendingBar,
  SpendingPie,
  SpendingTrend,
  Table,
} from '@/components';
import type { TableColumn } from '@/components';

/** Only a well-formed `YYYY-MM` (months 01–12) is honoured; anything else falls back to the demo month. */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

interface BillsPageProps {
  /** Next 15 passes `searchParams` as a Promise: `?month=YYYY-MM`. */
  searchParams: Promise<{ month?: string }>;
}

/** Half-open `[from, to)` epoch-ms bounds for a `YYYY-MM` label (the shape the ledger query needs). */
function monthBounds(month: string): { from: number; to: number } {
  const [year, monthNumber] = month.split('-').map(Number);
  const { start, end } = monthRange(new Date(year, monthNumber - 1, 1));
  return { from: start.getTime(), to: end.getTime() };
}

export default async function BillsPage({ searchParams }: BillsPageProps) {
  const userId = getConfig().demoUserId;
  const { month: monthParam } = await searchParams;
  const month = monthParam !== undefined && MONTH_PATTERN.test(monthParam) ? monthParam : undefined;

  const analysis: SpendingAnalysis = await banking.transaction.analyzeSpending(
    userId,
    month !== undefined ? { month } : {},
  );
  const { from, to } = monthBounds(analysis.month);
  const transactions: TransactionView[] = await banking.transaction.listTransactions(userId, { from, to });
  const anomalies: AnomalyItem[] = await banking.transaction.listAnomalies(userId);

  const columns: TableColumn<TransactionView>[] = [
    { key: 'occurredAt', header: '时间', render: (row) => formatDateTime(row.occurredAt) },
    { key: 'merchant', header: '商户' },
    { key: 'category', header: '分类' },
    { key: 'amount', header: '金额', align: 'right', render: (row) => <Money amount={row.amount} signed /> },
    {
      key: 'status',
      header: '状态',
      align: 'center',
      render: (row) => (row.isAnomaly ? '异常' : row.direction === 'DEBIT' ? '支出' : '收入'),
    },
  ];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-banking-deep">账单</h1>
          <p className="mt-1 text-sm text-banking-navy">
            {analysis.month} · 共 {transactions.length} 笔交易 · {anomalies.length} 项异常 · 本月支出{' '}
            <Money amount={analysis.total} />
          </p>
        </div>
        <form className="flex items-center gap-2" method="get">
          <label htmlFor="month" className="text-sm text-banking-navy">
            选择月份
          </label>
          <input
            id="month"
            type="month"
            name="month"
            defaultValue={analysis.month}
            className="rounded-lg border border-banking-light px-2 py-1 text-sm text-banking-navy"
          />
          <button type="submit" className="rounded-lg bg-banking-accent px-3 py-1 text-sm text-white">
            查看
          </button>
        </form>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card title="本月支出">
          <Money amount={analysis.total} className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-xs text-banking-navy">
            环比 {analysis.momChangePct >= 0 ? '+' : '-'}
            {Math.abs(analysis.momChangePct)}% · 上月 <Money amount={analysis.prevTotal} />
          </p>
        </Card>
        <Card title="最大单笔">
          {analysis.largest !== null ? (
            <>
              <Money
                amount={analysis.largest.amount}
                signed
                className="text-2xl font-semibold text-banking-deep"
              />
              <p className="mt-1 text-xs text-banking-navy">{analysis.largest.merchant}</p>
            </>
          ) : (
            <p className="text-xs text-banking-navy">本月暂无支出</p>
          )}
        </Card>
        <Card title="常去商户">
          {analysis.topMerchant !== null ? (
            <>
              <Money amount={analysis.topMerchant.amount} className="text-2xl font-semibold text-banking-deep" />
              <p className="mt-1 text-xs text-banking-navy">
                {analysis.topMerchant.merchant} · {analysis.topMerchant.count} 笔
              </p>
            </>
          ) : (
            <p className="text-xs text-banking-navy">本月暂无支出</p>
          )}
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card title="分类占比">
          <SpendingPie data={analysis.byCategory} height={240} />
        </Card>
        <Card title="分类金额">
          <SpendingBar data={analysis.byCategory} height={240} />
        </Card>
        <Card title="近半年趋势" className="lg:col-span-2">
          <SpendingTrend data={analysis.monthlyTrend} height={220} />
          <MiniSparkline data={analysis.monthlyTrend.map((point) => point.amount)} height={40} className="mt-2" />
        </Card>
      </section>

      {anomalies.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium text-banking-deep">异常提醒</h2>
          {anomalies.map((anomaly) => (
            <AnomalyBanner key={anomaly.transaction.id} anomaly={anomaly} />
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-medium text-banking-deep">交易明细</h2>
        <Table
          columns={columns}
          rows={transactions}
          rowKey={(row) => row.id}
          empty={<EmptyState title="本月暂无交易" description="所选月份没有交易记录。" />}
        />
      </section>
    </main>
  );
}
