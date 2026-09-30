/**
 * Bills / 账单 — `/bills` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read models — no HTTP hop):
 *   `banking.transaction.analyzeSpending(userId, { month })`  → `SpendingAnalysis`
 *   `banking.transaction.listTransactions(userId, { month })` → `TransactionView[]`
 *   `banking.transaction.listAnomalies(userId)`               → `AnomalyItem[]`
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * Composes (`../components` — referenced by name only; the component library owns the API):
 *   MonthPicker, CategoryPie, MonthlyTrendChart (Recharts), TransactionsTable, AnomalyList.
 *   TODO: the selected `month` (`YYYY-MM`) should be read from the URL search param.
 */
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import type { AnomalyItem, SpendingAnalysis, TransactionView } from '@/banking-sdk';

export default async function BillsPage() {
  const userId = getConfig().demoUserId;

  // TODO: wire read model — analytics, ledger rows and flagged anomalies for the month.
  const analysis: SpendingAnalysis = await banking.transaction.analyzeSpending(userId);
  const transactions: TransactionView[] = await banking.transaction.listTransactions(userId);
  const anomalies: AnomalyItem[] = await banking.transaction.listAnomalies(userId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold text-banking-deep">账单</h1>
        <p className="mt-1 text-sm text-banking-navy">
          {analysis.month} · 共 {transactions.length} 笔交易 · {anomalies.length} 项异常
        </p>
      </header>

      {/*
        TODO: wire read model into the component library (`@/components`, read-only sibling):
          <MonthPicker selected={analysis.month} />
          <CategoryPie data={analysis.byCategory} />
          <MonthlyTrendChart data={analysis.monthlyTrend} />
          <TransactionsTable rows={transactions} />
          <AnomalyList anomalies={anomalies} />
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        消费分析图表、交易明细与异常列表将由 `@/components` 渲染。
      </section>
    </main>
  );
}
