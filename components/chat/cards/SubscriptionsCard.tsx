'use client';

import type { SubscriptionView } from '@/banking-sdk';
import { SubscriptionTile } from '../../banking';
import { Card, EmptyState } from '../../ui';

export interface SubscriptionsCardProps {
  data: SubscriptionView[];
  className?: string;
}

/**
 * Chat card: the user's recurring subscriptions. Each subscription is rendered by the `banking`
 * read-model `SubscriptionTile` (never re-implemented here) inside a titled surface; an
 * `EmptyState` is shown when there are none.
 */
export function SubscriptionsCard(p: SubscriptionsCardProps) {
  return (
    <Card title="我的订阅" className={p.className}>
      {p.data.length === 0 ? (
        <EmptyState title="暂无订阅" description="当前没有可展示的订阅服务。" />
      ) : (
        <div className="flex flex-col gap-3">
          {p.data.map((subscription) => (
            <SubscriptionTile key={subscription.id} subscription={subscription} />
          ))}
        </div>
      )}
    </Card>
  );
}
