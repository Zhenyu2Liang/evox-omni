'use client';

import type { SpendingAnalysis } from '@/banking-sdk';
import { formatDateTime } from '@/lib/date';
import { compareDecimal } from '@/lib/decimal';
import { Money } from '../../ui/Money';
import { EmptyState } from '../../ui/EmptyState';
import { SpendingPie, SpendingTrend } from '../../charts';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { ResultCard, ResultMetric } from './ResultCard';

export interface SpendingCardProps {
  data: SpendingAnalysis;
  className?: string;
}

/**
 * Spending analysis card: total + month-over-month change, category-share and trend charts
 * (composed from `../../charts`), the top merchant and the largest single transaction.
 * Renders an `EmptyState` when the analysis carries nothing to display.
 */
export function SpendingCard({ data, className }: SpendingCardProps) {
  const { t } = useI18n();
  const hasCategories = data.byCategory.length > 0;
  const hasTrend = data.monthlyTrend.length > 0;
  const hasContent = hasCategories || hasTrend || data.topMerchant !== null || data.largest !== null;

  if (!hasContent) {
    return (
      <ResultCard className={className} title={t('cards.spending.title', { month: data.month })} marker="◔">
        <EmptyState
          title={t('cards.spending.empty.title')}
          description={t('cards.spending.empty.description', { month: data.month })}
        />
      </ResultCard>
    );
  }

  const momUp = compareDecimal(data.momChangePct, '0') > 0;
  const momFlat = compareDecimal(data.momChangePct, '0') === 0;
  const momClass = momFlat ? 'text-banking-navy' : momUp ? 'text-banking-danger' : 'text-banking-success';
  const momText = `${momUp ? '+' : ''}${data.momChangePct}%`;

  return (
    <ResultCard
      className={className}
      title={t('cards.spending.title', { month: data.month })}
      description={t('cards.spending.description')}
      marker="◔"
    >
      <div className="space-y-4">
        <dl className="grid gap-2 sm:grid-cols-3">
          <ResultMetric label={t('cards.spending.posted')}>
            <Money amount={data.total} className="text-2xl font-semibold text-banking-deep" />
          </ResultMetric>
          <ResultMetric label={t('cards.spending.previous')}>
            <Money amount={data.prevTotal} className="text-base text-banking-navy" />
          </ResultMetric>
          <ResultMetric label={t('cards.spending.change')}>
            <span className={`text-base font-medium ${momClass}`}>{momText}</span>
          </ResultMetric>
        </dl>

        {(hasCategories || hasTrend) && (
          <div className="grid gap-4 md:grid-cols-2">
            {hasCategories && <SpendingPie data={data.byCategory} height={200} />}
            {hasTrend && <SpendingTrend data={data.monthlyTrend} height={200} />}
          </div>
        )}

        {data.topMerchant && (
          <div className="rounded-xl bg-banking-light p-3">
            <div className="text-banking-caption text-banking-navy">{t('cards.spending.topMerchant')}</div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-banking-navy">{data.topMerchant.merchant}</span>
              <span className="flex flex-wrap items-center gap-2">
                <Money amount={data.topMerchant.amount} className="font-semibold text-banking-deep" />
                <span className="text-banking-caption text-banking-navy">{t('cards.transaction.count', { count: data.topMerchant.count })}</span>
              </span>
            </div>
          </div>
        )}

        {data.largest && (
          <div className="rounded-xl bg-banking-light p-3">
            <div className="text-banking-caption text-banking-navy">{t('cards.spending.largest')}</div>
            <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
              <span className="font-medium text-banking-navy">{data.largest.merchant}</span>
              <Money amount={data.largest.amount} signed className="font-semibold text-banking-deep" />
            </div>
            <div className="mt-1 text-banking-caption text-banking-navy">
              {data.largest.category} · {formatDateTime(data.largest.occurredAt)}
            </div>
          </div>
        )}
      </div>
    </ResultCard>
  );
}
