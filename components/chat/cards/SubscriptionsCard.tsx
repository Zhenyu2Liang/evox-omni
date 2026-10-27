'use client';

import type { SubscriptionView } from '@/banking-sdk';
import { Badge, EmptyState, Money } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { formatDateTime } from '@/lib/date';
import type { MessageKey } from '@/lib/i18n/shared';
import { ResultCard } from './ResultCard';

export interface SubscriptionsCardProps {
  data: SubscriptionView[];
  className?: string;
}

const CYCLE_LABEL: Record<SubscriptionView['cycle'], MessageKey> = {
  MONTHLY: 'business.subscriptions.monthly',
  QUARTERLY: 'business.subscriptions.quarterly',
  YEARLY: 'business.subscriptions.yearly',
};

/** Compact subscription results retain the server's billing and reminder facts. */
export function SubscriptionsCard(p: SubscriptionsCardProps) {
  const { t } = useI18n();
  return (
    <ResultCard title={t('cards.subscription.title')} className={p.className} marker="↻">
      {p.data.length === 0 ? (
        <EmptyState title={t('cards.subscription.empty.title')} description={t('cards.subscription.empty.description')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {p.data.map((subscription) => (
            <li key={subscription.id} className="min-w-0 rounded-xl border border-banking-light bg-banking-light/60 p-3.5">
              <div className="flex items-start justify-between gap-2">
                <span className="min-w-0 break-words text-sm font-semibold text-banking-deep">{subscription.name}</span>
                <Badge className="shrink-0" tone={subscription.status === 'ACTIVE' ? 'success' : 'neutral'}>
                  {t(subscription.status === 'ACTIVE' ? 'business.subscriptions.active' : 'business.subscriptions.cancelled')}
                </Badge>
              </div>
              <div className="mt-3 flex flex-wrap items-baseline gap-x-1.5 gap-y-1">
                <Money amount={subscription.amount} className="break-words text-xl font-semibold tracking-tight text-banking-deep" />
                <span className="text-xs text-banking-navy">/ {t(CYCLE_LABEL[subscription.cycle])}</span>
              </div>
              <dl className="mt-3 space-y-2 border-t border-banking-light pt-3 text-xs">
                {subscription.status === 'ACTIVE' ? (
                  <div className="flex flex-wrap justify-between gap-x-2 gap-y-1">
                    <dt className="text-banking-navy">{t('business.subscriptions.nextCharge')}</dt>
                    <dd className="tabular-nums text-banking-navy">{formatDateTime(subscription.nextChargeAt)}</dd>
                  </div>
                ) : null}
                <div className="flex flex-wrap justify-between gap-x-2 gap-y-1">
                  <dt className="text-banking-navy">{t('business.subscriptions.reminder')}</dt>
                  <dd className={subscription.remind ? 'font-medium text-banking-success' : 'text-banking-navy'}>
                    {t(subscription.remind ? 'business.subscriptions.reminderOn' : 'business.subscriptions.reminderOff')}
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </ResultCard>
  );
}
