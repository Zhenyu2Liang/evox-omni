/**
 * Dashboard — `/` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read model — no HTTP hop):
 *   `banking.dashboard.getDashboardSummary(userId)` → `DashboardSummary`
 *     (totalAssets · checkingBalance · creditAvailable · monthSpend · month
 *      · recentTransactions · latestAnomaly · asOf).
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * Composes (`../components` — referenced by name only; the component library owns the API):
 *   BalanceCard, stat tiles (总资产 / 活期余额 / 信用卡额度 / 本月消费),
 *   RecentTransactionsTable, AnomalyBanner, and the AI Agent entry linking to `/agent`.
 */
import Link from 'next/link';
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import type { DashboardSummary } from '@/banking-sdk';

export default async function DashboardPage() {
  const userId = getConfig().demoUserId;

  // TODO: wire read model — `summary` is handed to the component library below.
  const summary: DashboardSummary = await banking.dashboard.getDashboardSummary(userId);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-banking-deep">总览</h1>
          <p className="mt-1 text-sm text-banking-navy">
            本月（{summary.month}）· 近期 {summary.recentTransactions.length} 笔交易与异常提醒
          </p>
        </div>
        <Link
          href="/agent"
          className="rounded-xl bg-banking-accent px-4 py-2 text-sm font-medium text-white"
        >
          打开 AI Agent
        </Link>
      </header>

      {/*
        TODO: wire read model into the component library (`@/components`, read-only sibling):
          <BalanceCard summary={summary} />
          <StatTiles summary={summary} />          // 总资产 / 活期余额 / 信用卡额度 / 本月消费
          <RecentTransactionsTable rows={summary.recentTransactions} />
          <AnomalyBanner anomaly={summary.latestAnomaly} />
      */}
      <section className="rounded-2xl bg-white p-6 text-sm text-banking-navy shadow-sm">
        余额卡片、统计指标、近期交易与异常提醒将由 `@/components` 渲染。
      </section>
    </main>
  );
}
