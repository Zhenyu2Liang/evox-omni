/**
 * CardTile — read-model tile: one bank card (masked number, status, limits, credit line).
 *
 * Server-safe presentational component: no `'use client'`, no hooks, no data access — the
 * `CardView` DTO arrives via props. Money renders only through `ui/Money`; the (non-risk) card
 * status uses `ui/Badge`, never `ui/StatusBadge` (which is reserved for permission tiers).
 */
import type { CardView } from '@/banking-sdk';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';

export interface CardTileProps {
  card: CardView;
  className?: string;
}

/** Chinese label per card type. */
const CARD_TYPE_LABEL: Record<CardView['type'], string> = {
  DEBIT: '借记卡',
  CREDIT: '信用卡',
  VIRTUAL: '虚拟卡',
};

/** Card status → Chinese label. */
const STATUS_LABEL: Record<CardView['status'], string> = {
  ACTIVE: '正常',
  FROZEN: '已冻结',
  LOST: '已挂失',
  PENDING: '待激活',
};

/** Card status → badge tone. */
const STATUS_TONE: Record<CardView['status'], NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  FROZEN: 'info',
  LOST: 'danger',
  PENDING: 'warn',
};

export function CardTile({ card, className }: CardTileProps) {
  const cls = ['space-y-3', className].filter(Boolean).join(' ');

  return (
    <Card className={cls}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-banking-navy">
            {CARD_TYPE_LABEL[card.type]} · {card.network}
          </div>
          <div className="font-mono text-lg tracking-widest text-banking-deep">
            {card.numberMasked}
          </div>
        </div>
        <Badge tone={STATUS_TONE[card.status]}>{STATUS_LABEL[card.status]}</Badge>
      </div>

      {card.type === 'CREDIT' &&
      (card.creditLimit !== undefined || card.availableLimit !== undefined) ? (
        <dl className="grid grid-cols-2 gap-3">
          {card.creditLimit !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy/60">额度</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={card.creditLimit} />
              </dd>
            </div>
          ) : null}
          {card.availableLimit !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy/60">可用</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={card.availableLimit} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {card.monthlyLimit !== undefined ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-banking-navy/60">月限额</span>
          <span className="font-semibold text-banking-deep">
            <Money amount={card.monthlyLimit} />
          </span>
        </div>
      ) : null}

      {card.limits.length > 0 ? (
        <div className="space-y-1 border-t border-banking-light pt-2">
          <div className="text-xs text-banking-navy/60">分类限额</div>
          <ul className="space-y-1">
            {card.limits.map((limit, index) => (
              <li
                key={`${limit.category}-${index}`}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-banking-navy">{limit.category}</span>
                <span className="font-medium text-banking-deep">
                  <Money amount={limit.amount} />
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
