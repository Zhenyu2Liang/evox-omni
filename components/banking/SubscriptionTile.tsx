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
import { Card } from '../ui/Card';
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
  const cls = ['space-y-3', className].filter(Boolean).join(' ');

  return (
    <Card
      className={cls}
      title={<span className="flex items-center gap-2.5"><span aria-hidden="true" className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-banking-lilac-soft text-banking-lilac">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 3v4m8-4v4M4 11h16m-12 5h4" /></svg>
      </span>{subscription.name}</span>}
      description={t(CYCLE_LABEL[subscription.cycle])}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-lg font-semibold text-banking-deep">
          <Money amount={subscription.amount} />
        </span>
        <Badge tone={STATUS_TONE[subscription.status]}>{t(STATUS_LABEL[subscription.status])}</Badge>
      </div>

      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-banking-navy/60">{t('business.subscriptions.nextCharge')}</span>
        <span className="text-banking-navy">{formatDateTime(subscription.nextChargeAt)}</span>
      </div>

      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-banking-navy/60">{t('business.subscriptions.reminder')}</span>
        <Badge tone={subscription.remind ? 'success' : 'neutral'}>
          {t(subscription.remind ? 'business.subscriptions.reminderOn' : 'business.subscriptions.reminderOff')}
        </Badge>
      </div>
    </Card>
  );
}
