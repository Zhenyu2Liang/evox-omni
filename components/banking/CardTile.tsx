'use client';

/**
 * CardTile — read-model tile: one bank card (masked number, status, limits, credit line).
 *
 * Localized presentational component with no data access — the
 * `CardView` DTO arrives via props. Money renders only through `ui/Money`; the (non-risk) card
 * status uses `ui/Badge`, never `ui/StatusBadge` (which is reserved for permission tiers).
 */
import type { CardView } from '@/banking-sdk';
import type { ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';

export interface CardTileProps {
  card: CardView;
  className?: string;
  footer?: ReactNode;
}

/** Translation key per card type. */
const CARD_TYPE_LABEL: Record<CardView['type'], MessageKey> = {
  DEBIT: 'business.cards.debit',
  CREDIT: 'business.cards.credit',
  VIRTUAL: 'business.cards.virtual',
};

/** Translation key per card status. */
const STATUS_LABEL: Record<CardView['status'], MessageKey> = {
  ACTIVE: 'business.cards.active',
  FROZEN: 'business.cards.frozen',
  LOST: 'business.cards.lost',
  PENDING: 'business.cards.pending',
};

/** Card status → badge tone. */
const STATUS_TONE: Record<CardView['status'], NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success',
  FROZEN: 'info',
  LOST: 'danger',
  PENDING: 'warn',
};

export function CardTile({ card, className, footer }: CardTileProps) {
  const { t } = useI18n();
  const cls = ['space-y-3', className].filter(Boolean).join(' ');

  return (
    <Card className={cls} footer={footer}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-banking-navy">
            {t(CARD_TYPE_LABEL[card.type])} · {card.network}
          </div>
          <div className="font-mono text-lg tracking-widest text-banking-deep">
            {card.numberMasked}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {card.replacedByCardId !== undefined ? (
            <Badge tone="info">{t('business.cards.replaced')}</Badge>
          ) : null}
          <Badge tone={STATUS_TONE[card.status]}>{t(STATUS_LABEL[card.status])}</Badge>
        </div>
      </div>

      {card.type === 'CREDIT' &&
      (card.creditLimit !== undefined || card.availableLimit !== undefined) ? (
        <dl className="grid grid-cols-2 gap-3">
          {card.creditLimit !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy/60">{t('business.cards.limit')}</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={card.creditLimit} />
              </dd>
            </div>
          ) : null}
          {card.availableLimit !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy/60">{t('business.cards.available')}</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={card.availableLimit} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {card.monthlyLimit !== undefined ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-banking-navy/60">{t('business.cards.monthlyLimit')}</span>
          <span className="font-semibold text-banking-deep">
            <Money amount={card.monthlyLimit} />
          </span>
        </div>
      ) : null}

      {card.limits.length > 0 ? (
        <div className="space-y-1 border-t border-banking-light pt-2">
          <div className="text-xs text-banking-navy/60">{t('business.cards.categoryLimits')}</div>
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
