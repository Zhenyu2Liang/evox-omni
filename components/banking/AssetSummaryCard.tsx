'use client';

/**
 * AssetSummaryCard — total assets, checking balance, available credit and monthly spending.
 *
 * Localized presentational component with no fetching or database access.
 * Renders booked amounts through Money and total assets through DecimalMoney, which rounds
 * HALF_UP to two fraction digits for display while storage keeps full precision.
 */
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { DecimalMoney } from '../ui/DecimalMoney';
import type { DashboardSummary } from '@/banking-sdk';
import type { MoneyAmount } from '@/lib/money';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface AssetSummaryCardProps {
  summary: DashboardSummary;
  className?: string;
}

interface AssetStatProps {
  label: string;
  amount: MoneyAmount;
  className?: string;
  estimated?: boolean;
}

/** One labelled money stat (local, non-exported). */
function AssetStat({ label, amount, className, estimated }: AssetStatProps) {
  const cls = [
    'flex flex-col gap-1 rounded-xl bg-banking-light p-4 shadow-xs',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <span className="text-sm text-banking-navy/70">{label}</span>
      <span className="text-xl font-semibold text-banking-navy">
        {estimated ? <DecimalMoney amount={amount} /> : <Money amount={amount} />}
      </span>
    </div>
  );
}

export function AssetSummaryCard({ summary, className }: AssetSummaryCardProps) {
  const { t } = useI18n();
  return (
    <Card title={t('business.assets.title')} className={className}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <AssetStat label={t('business.assets.total')} amount={summary.totalAssets} estimated />
        <AssetStat label={t('business.assets.checking')} amount={summary.checkingBalance} />
        <AssetStat label={t('business.assets.credit')} amount={summary.creditAvailable} />
        <AssetStat label={t('business.assets.spend', { month: summary.month })} amount={summary.monthSpend} />
      </div>
    </Card>
  );
}
