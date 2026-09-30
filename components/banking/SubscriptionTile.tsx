/**
 * SubscriptionTile — read-model tile: one subscription (amount, cycle, next charge, remind).
 *
 * Server-safe presentational component: no `'use client'`, no hooks, no data access — the
 * `SubscriptionView` DTO arrives via props. Money renders only through `ui/Money`; the
 * subscription/reminder status uses `ui/Badge` (non-risk statuses).
 */
import { formatDateTime } from '@/lib/date';
import type { SubscriptionView } from '@/banking-sdk';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';

export interface SubscriptionTileProps {
  subscription: SubscriptionView;
  className?: string;
}

/** Chinese label per billing cycle. */
const CYCLE_LABEL: Record<SubscriptionView['cycle'], string> = {
  MONTHLY: '每月',
  QUARTERLY: '每季',
  YEARLY: '每年',
};

/** Subscription status → Chinese label. */
const STATUS_LABEL: Record<SubscriptionView['status'], string> = {
  ACTIVE: '订阅中',
  CANCELLED: '已取消',
};

/** Subscription status → badge tone. */
const STATUS_TONE: Record<SubscriptionView['status'], NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  CANCELLED: 'neutral',
};

export function SubscriptionTile({ subscription, className }: SubscriptionTileProps) {
  const cls = ['space-y-3', className].filter(Boolean).join(' ');

  return (
    <Card
      className={cls}
      title={subscription.name}
      description={CYCLE_LABEL[subscription.cycle]}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-lg font-semibold text-banking-deep">
          <Money amount={subscription.amount} />
        </span>
        <Badge tone={STATUS_TONE[subscription.status]}>{STATUS_LABEL[subscription.status]}</Badge>
      </div>

      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-banking-navy/60">下次扣费</span>
        <span className="text-banking-navy">{formatDateTime(subscription.nextChargeAt)}</span>
      </div>

      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-banking-navy/60">到期提醒</span>
        <Badge tone={subscription.remind ? 'success' : 'neutral'}>
          {subscription.remind ? '已开启提醒' : '未开启提醒'}
        </Badge>
      </div>
    </Card>
  );
}
