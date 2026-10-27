'use client';

/**
 * SubscriptionTile — read-model tile: one subscription (amount, cycle, next charge, remind).
 *
 * Localized presentational component with no data access — the
 * `SubscriptionView` DTO arrives via props. Money renders only through `ui/Money`; the
 * subscription/reminder status uses `ui/Badge` (non-risk statuses).
 */
import { formatDateTime } from '@/lib/date';
import type { SubscriptionView } from '@/banking-sdk';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Money } from '../ui/Money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

export interface SubscriptionTileProps {
  subscription: SubscriptionView;
  className?: string;
}

/** Translation key per billing cycle. */
const CYCLE_LABEL: Record<SubscriptionView['cycle'], MessageKey> = {
  MONTHLY: 'business.subscriptions.monthly',
  QUARTERLY: 'business.subscriptions.quarterly',
  YEARLY: 'business.subscriptions.yearly',
};

/** Translation key per subscription status. */
const STATUS_LABEL: Record<SubscriptionView['status'], MessageKey> = {
  ACTIVE: 'business.subscriptions.active',
  CANCELLED: 'business.subscriptions.cancelled',
};

/** Subscription status → badge tone. */
const STATUS_TONE: Record<SubscriptionView['status'], NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  CANCELLED: 'neutral',
};

export function SubscriptionTile({ subscription, className }: SubscriptionTileProps) {
  const { t } = useI18n();
  const cls = ['min-w-0 px-1 py-3 sm:px-2 sm:py-3.5', className].filter(Boolean).join(' ');

  return (
    <article data-subscription-row className={cls}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5"><span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-banking-lilac-soft text-banking-lilac">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-12 5h4" /></svg>
        </span><div className="min-w-0"><h3 className="break-words text-sm font-semibold text-banking-deep">{subscription.name}</h3>
          <p className="mt-0.5 text-xs text-banking-navy">{t(CYCLE_LABEL[subscription.cycle])}</p></div></div>
        <div className="max-w-full text-right"><p className="overflow-x-auto whitespace-nowrap text-base font-semibold text-banking-deep"><Money amount={subscription.amount} /></p>
          <Badge tone={STATUS_TONE[subscription.status]}>{t(STATUS_LABEL[subscription.status])}</Badge></div>
      </div>
      <dl className="mt-2 grid gap-x-5 gap-y-1 text-xs text-banking-navy sm:flex sm:flex-wrap">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1"><dt>{t('business.subscriptions.nextCharge')}</dt>
          <dd>{formatDateTime(subscription.nextChargeAt)}</dd></div>
        <div className="flex items-center gap-2"><dt>{t('business.subscriptions.reminder')}</dt><dd><Badge tone={subscription.remind ? 'success' : 'neutral'}>
          {t(subscription.remind ? 'business.subscriptions.reminderOn' : 'business.subscriptions.reminderOff')}
        </Badge></dd></div>
      </dl>
    </article>
  );
}
