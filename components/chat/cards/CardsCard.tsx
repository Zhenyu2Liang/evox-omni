'use client';

import type { CardView } from '@/banking-sdk';
import { Badge, EmptyState, Money } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import type { BadgeProps } from '../../ui/Badge';
import { ResultCard, ResultMetric } from './ResultCard';

export interface CardsCardProps {
  data: CardView[];
  className?: string;
}

const TYPE_LABEL: Record<CardView['type'], MessageKey> = {
  DEBIT: 'business.cards.debit', CREDIT: 'business.cards.credit', VIRTUAL: 'business.cards.virtual',
};
const STATUS_LABEL: Record<CardView['status'], MessageKey> = {
  ACTIVE: 'business.cards.active', FROZEN: 'business.cards.frozen', LOST: 'business.cards.lost', PENDING: 'business.cards.pending',
};
const STATUS_TONE: Record<CardView['status'], NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'success', FROZEN: 'info', LOST: 'danger', PENDING: 'warn',
};

/** Bank-card results show masked card details and the server's exact spending limits. */
export function CardsCard(p: CardsCardProps) {
  const { t } = useI18n();
  return (
    <ResultCard title={t('cards.bankCards.title')} className={p.className} marker="▣">
      {p.data.length === 0 ? (
        <EmptyState title={t('cards.bankCards.empty.title')} description={t('cards.bankCards.empty.description')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {p.data.map((card) => (
            <li key={card.id} className="min-w-0 overflow-hidden rounded-xl border border-banking-light">
              <div className="bg-gradient-to-br from-banking-deep to-banking-navy p-3.5 text-white">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="text-xs text-white/75">{t(TYPE_LABEL[card.type])} · {card.network}</span>
                  <Badge tone={STATUS_TONE[card.status]}>{t(STATUS_LABEL[card.status])}</Badge>
                </div>
                <div className="mt-3 break-words font-mono text-lg tracking-widest">{card.numberMasked}</div>
              </div>
              <div className="space-y-3 p-3.5">
                <dl className="grid gap-2 sm:grid-cols-2">
                  {card.type === 'CREDIT' && card.creditLimit !== undefined ? <ResultMetric label={t('business.cards.limit')}><Money amount={card.creditLimit} /></ResultMetric> : null}
                  {card.type === 'CREDIT' && card.availableLimit !== undefined ? <ResultMetric label={t('business.cards.available')}><Money amount={card.availableLimit} /></ResultMetric> : null}
                  {card.monthlyLimit !== undefined ? <ResultMetric label={t('business.cards.monthlyLimit')}><Money amount={card.monthlyLimit} /></ResultMetric> : null}
                  {card.type === 'VIRTUAL' && (card.linkedAccountNumber ?? card.linkedAccountId) !== undefined ? <ResultMetric label={t('business.cards.linkedAccount')}>{card.linkedAccountNumber ?? card.linkedAccountId}</ResultMetric> : null}
                  {card.type === 'VIRTUAL' && card.accountAvailableBalance !== undefined ? <ResultMetric label={t('business.cards.accountAvailable')}><Money amount={card.accountAvailableBalance} /></ResultMetric> : null}
                  {card.type === 'VIRTUAL' && card.payableAmount !== undefined ? <ResultMetric label={t('business.cards.payableAmount')}><Money amount={card.payableAmount} /></ResultMetric> : null}
                </dl>
                {card.limits.length ? (
                  <div>
                    <div className="mb-2 text-xs text-banking-navy/60">{t('business.cards.categoryLimits')}</div>
                    <dl className="space-y-1.5">
                      {card.limits.map((limit, index) => (
                        <div key={`${limit.category}-${index}`} className="flex flex-wrap justify-between gap-2 text-xs">
                          <dt className="text-banking-navy">{limit.category}</dt>
                          <dd className="font-semibold text-banking-deep"><Money amount={limit.amount} /></dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </ResultCard>
  );
}
