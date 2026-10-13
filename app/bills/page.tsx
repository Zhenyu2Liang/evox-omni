/**
 * Bills / 账单 — `/bills` (Server Component, RSC by default).
 *
 * Server-fetched read models (no HTTP hop): `banking.transaction.analyzeSpending(userId, { month })`,
 * `listTransactions(userId, { from, to })`, `listAnomalies(userId)`. The month comes from
 * `?month=YYYY-MM` (Next 15 `searchParams` is a Promise); absent/invalid → the SDK default (the demo
 * clock's current month). `listTransactions` has no `month` option, so its epoch-ms `[from, to)` range
 * is derived from the analysed month.
 *
 * Composes `@/components` (read-only sibling): charts `SpendingPie`/`SpendingBar`/`SpendingTrend`/
 * `MiniSparkline`, `ui/Table` (ledger), `banking/AnomalyBanner` (flagged spends), `ui/Card`/`ui/Money`/
 * `ui/EmptyState`. Money is rendered by `ui/Money`; props stay JSON-serializable (epoch ms).
 */
import { getConfig } from '@/lib/config';
import { formatDateTime, monthRange } from '@/lib/date';
import { banking } from '@/banking-sdk';
import type { AnomalyItem, SpendingAnalysis, TransactionView } from '@/banking-sdk';
import { AnomalyBanner, Card, EmptyState, MiniSparkline, Money, SpendingBar, SpendingPie, SpendingTrend, Table } from '@/components';
import type { TableColumn } from '@/components';
import { compareDecimal } from '@/lib/decimal';

/** Only a `YYYY-MM` month (01–12) is honoured; anything else falls back to the demo month. */
const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Next 15 passes `searchParams` as a Promise (`?month=YYYY-MM`). */
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
  const userId = getConfig().demoUserId;
  const { month: monthParam } = await searchParams;
  const month = monthParam !== undefined && MONTH_PATTERN.test(monthParam) ? monthParam : undefined;

  const analysis: SpendingAnalysis = await banking.transaction.analyzeSpending(userId, month !== undefined ? { month } : {});
  const { from, to } = monthBounds(analysis.month);
  const transactions: TransactionView[] = await banking.transaction.listTransactions(userId, { from, to });
  const anomalies: AnomalyItem[] = (await banking.transaction.listAnomalies(userId)).filter(item => item.transaction.occurredAt >= from && item.transaction.occurredAt < to);

  const columns: TableColumn<TransactionView>[] = [
    { key: 'occurredAt', header: '时间', render: (row) => formatDateTime(row.occurredAt) },
    { key: 'merchant', header: '商户' },
    { key: 'category', header: '分类' },
    { key: 'amount', header: '金额', align: 'right', render: (row) => <Money amount={row.amount} signed /> },
    { key: 'status', header: '状态', align: 'center', render: (row) => (row.isAnomaly ? '异常' : row.direction === 'DEBIT' ? '支出' : '收入') },
  ];

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-banking-deep">账单</h1>
          <p className="mt-1 text-sm text-banking-navy">
            {analysis.month} · 共 {transactions.length} 笔交易 · {anomalies.length} 项异常 · {'\u5df2\u5165\u8d26\u6d88\u8d39'} <Money amount={analysis.total} />{'\uff08\u4e0d\u542b\u6295\u8d44\u8d44\u91d1\u6d41\uff09'}
          </p>
        </div>
        <form className="flex items-center gap-2" method="get">
          <label htmlFor="month" className="text-sm text-banking-navy">选择月份</label>
          <input id="month" type="month" name="month" defaultValue={analysis.month} className="rounded-lg border border-banking-light px-2 py-1 text-sm text-banking-navy" />
          <button type="submit" className="rounded-lg bg-banking-accent px-3 py-1 text-sm text-white">查看</button>
        </form>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        <Card title={'\u5df2\u5165\u8d26\u6d88\u8d39\uff08\u4e0d\u542b\u6295\u8d44\uff09'}>
          <Money amount={analysis.total} className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-xs text-banking-navy">
            环比 {compareDecimal(analysis.momChangePct, '0') > 0 ? '+' : ''}{analysis.momChangePct}% · 上月 <Money amount={analysis.prevTotal} />
          </p>
        </Card>
        <Card title="最大单笔">
          <Money amount={analysis.largest?.amount ?? '0.00'} signed className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-xs text-banking-navy">{analysis.largest?.merchant ?? '本月暂无支出'}</p>
        </Card>
        <Card title="常去商户">
          <Money amount={analysis.topMerchant?.amount ?? '0.00'} className="text-2xl font-semibold text-banking-deep" />
          <p className="mt-1 text-xs text-banking-navy">{analysis.topMerchant?.merchant ?? '本月暂无支出'}</p>
        </Card>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <Card title="分类占比"><SpendingPie data={analysis.byCategory} height={240} /></Card>
        <Card title="分类金额"><SpendingBar data={analysis.byCategory} height={240} /></Card>
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
