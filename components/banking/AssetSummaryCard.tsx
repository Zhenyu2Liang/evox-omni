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
    'flex min-w-0 items-center justify-between gap-3 rounded-xl p-3 shadow-xs @[18rem]:flex-col @[18rem]:items-stretch @[18rem]:gap-1 sm:p-4',
    className ?? 'bg-banking-light',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div data-asset-stat className={cls}>
      <span className="min-w-0 text-sm text-banking-navy">{label}</span>
      <span data-asset-value className="max-w-[65%] shrink-0 overflow-x-auto whitespace-nowrap text-lg font-semibold text-banking-deep @[18rem]:max-w-full @[44rem]:text-xl">
        {estimated ? <DecimalMoney amount={amount} /> : <Money amount={amount} />}
      </span>
    </div>
  );
}

export function AssetSummaryCard({ summary, className }: AssetSummaryCardProps) {
  const { t } = useI18n();
  return (
    <Card title={t('business.assets.title')} className={className}>
      <div className="@container"><div className="grid grid-cols-1 gap-3 @[18rem]:grid-cols-2 @[44rem]:grid-cols-4">
        <AssetStat label={t('business.assets.total')} amount={summary.totalAssets} className="bg-banking-teal-soft" estimated />
        <AssetStat label={t('business.assets.checking')} amount={summary.checkingBalance} className="bg-banking-blue-soft" />
        <AssetStat label={t('business.assets.credit')} amount={summary.creditAvailable} className="bg-banking-lilac-soft" />
        <AssetStat label={t('business.assets.spend', { month: summary.month })} amount={summary.monthSpend} className="bg-banking-apricot-soft" />
      </div></div>
    </Card>
  );
}
