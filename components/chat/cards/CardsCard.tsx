'use client';

import type { CardView } from '@/banking-sdk';
import { CardTile } from '../../banking';
import { Card, EmptyState } from '../../ui';

export interface CardsCardProps {
  data: CardView[];
  className?: string;
}

/**
 * Chat card: the user's bank cards. Each card is rendered by the `banking` read-model `CardTile`
 * (never re-implemented here) inside a titled surface; an `EmptyState` is shown when there are none.
 */
export function CardsCard(p: CardsCardProps) {
  return (
    <Card title="我的卡片" className={p.className}>
      {p.data.length === 0 ? (
        <EmptyState title="暂无卡片" description="当前没有可展示的银行卡。" />
      ) : (
        <div className="flex flex-col gap-3">
          {p.data.map((card) => (
            <CardTile key={card.id} card={card} />
          ))}
        </div>
      )}
    </Card>
  );
}
