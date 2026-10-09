/**
 * Dashboard — `/` (Server Component, RSC by default).
 *
 * Data (fetched on the server, direct read model — no HTTP hop):
 *   `banking.dashboard.getDashboardSummary(userId)` → `DashboardSummary`
 *     (totalAssets · checkingBalance · creditAvailable · monthSpend · month
 *      · recentTransactions · latestAnomaly · asOf).
 *   User id: `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`).
 *
 * Composes (`@/components` — read-only sibling; the component library owns the API):
 *   `AssetSummaryCard`     — 总资产 / 活期余额 / 信用卡额度 / 本月消费.
 *   `AnomalyBanner`        — suspicious-spend banner for the latest anomaly (when present).
 *   `RecentTransactions`   — the recent transaction list.
 *   The AI Agent entry links to `/agent`.
 */
import Link from 'next/link';
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import type { DashboardSummary } from '@/banking-sdk';
import { AnomalyBanner, AssetSummaryCard, RecentTransactions } from '@/components';

// Reads live Prisma data, so it must render per request — never statically prerendered at build.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const userId = getConfig().demoUserId;

  // Read model — aggregated assets, month spend, recent transactions and the latest anomaly.
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

      {/* 总资产 / 活期余额 / 信用卡额度 / 本月消费 */}
      <AssetSummaryCard summary={summary} />

      {summary.latestAnomaly ? <AnomalyBanner anomaly={summary.latestAnomaly} /> : null}

      <RecentTransactions transactions={summary.recentTransactions} title="近期交易" />
    </main>
  );
}
