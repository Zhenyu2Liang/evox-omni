import Link from 'next/link';
import { getConfig } from '@/lib/config';
import { banking } from '@/banking-sdk';
import { AnomalyBanner, AssetSummaryCard, RecentTransactions } from '@/components';
import { getServerI18n } from '@/lib/i18n/server';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const { t } = await getServerI18n();
  const summary = await banking.dashboard.getDashboardSummary(getConfig().demoUserId);

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-6 p-4 sm:p-6 lg:p-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-banking-deep">{t('pages.overview.title')}</h1>
          <p className="mt-1 text-sm text-banking-navy">
            {t('pages.overview.summary', { month: summary.month, count: summary.recentTransactions.length })}
          </p>
        </div>
        <Link href="/agent" className="rounded-xl bg-banking-deep px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-banking-interactive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-banking-accent">
          {t('pages.overview.askAssistant')}
        </Link>
      </header>
      <AssetSummaryCard summary={summary} />
      {summary.latestAnomaly ? <AnomalyBanner anomaly={summary.latestAnomaly} /> : null}
      <RecentTransactions transactions={summary.recentTransactions} title={t('pages.overview.recentTransactions')} />
    </main>
  );
}
