'use client';

import type { CardView } from '@/banking-sdk';
import { Badge, EmptyState, Money } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import type { BadgeProps } from '../../ui/Badge';
import {
  cardAccountDisplay,
  cardShowsAccountAmounts,
  cardUnavailableNoticeKey,
  linkedAccountNoticeKey,
} from '@/components/banking/card-account-display';
import { ResultCard, ResultMetric } from './ResultCard';
import { IssuedCardNumber } from './IssuedCardNumber';
import { CardPrimaryAmount } from '../../banking/CardPrimaryAmount';

export interface CardsCardProps {
  data: CardView[];
  issuanceActionId?: string;
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

/**
 * Bank-card results show masked card details, the server's exact spending limits and — when the
 * card's settlement account resolves — that account together with its balances.
 *
 * The account block follows `CardView.linkedAccountStatus` exactly as `card-account-display`
 * reduces it: `LINKED` shows 关联账户 / 账户余额 / 可用余额, `MISSING` and `UNTRUSTED` show ONLY their
 * notice (no amount, never `0.00`), `NOT_APPLICABLE` (a CREDIT card) keeps its 信用额度 / 可用额度 rows.
 * An unusable card (`!usable`) adds a notice but keeps its balances visible — unusable is not empty.
 */
export function CardsCard(p: CardsCardProps) {
  const { t } = useI18n();
  return (
    <ResultCard title={t('cards.bankCards.title')} className={p.className} marker="▣">
      {p.data.length === 0 ? (
        <EmptyState title={t('cards.bankCards.empty.title')} description={t('cards.bankCards.empty.description')} />
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {p.data.map((card) => {
            const account = cardAccountDisplay(card);
            const showsAccountAmounts = cardShowsAccountAmounts(card);
            const linkedAccountNotice = linkedAccountNoticeKey(card.linkedAccountStatus);
            const unavailableNotice = cardUnavailableNoticeKey(card);
            const accountLabel = [account.accountName, account.accountNumber].filter(Boolean).join(' · ');
            return (
              <li key={card.id} className="min-w-0 overflow-hidden rounded-xl border border-banking-light">
                <div className="bg-gradient-to-br from-banking-deep to-banking-navy p-3.5 text-white">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="text-xs text-white/75">{t(TYPE_LABEL[card.type])} · {card.network}</span>
                    <Badge tone={STATUS_TONE[card.status]}>{t(STATUS_LABEL[card.status])}</Badge>
                  </div>
                  <div className="mt-3 break-words font-mono text-lg tracking-widest">{card.numberMasked}</div>
                </div>
                <div className="space-y-3 p-3.5">
                  {unavailableNotice !== undefined ? (
                    <p className="rounded-xl bg-banking-light/70 px-3 py-2 text-xs text-banking-navy/70">{t(unavailableNotice)}</p>
                  ) : null}
                  <CardPrimaryAmount card={card} />
                  {p.issuanceActionId ? <IssuedCardNumber actionId={p.issuanceActionId} cardId={card.id} /> : null}
                  <details data-card-details>
                    <summary className="cursor-pointer text-sm font-medium text-banking-accent">{t('business.presentation.cardDetails')}</summary>
                  <div className="mt-3 space-y-3"><dl className="grid gap-2 sm:grid-cols-2">
                    {card.type === 'CREDIT' && card.creditLimit !== undefined ? <ResultMetric label={t('business.cards.limit')}><Money amount={card.creditLimit} /></ResultMetric> : null}
                    {card.type === 'CREDIT' && card.availableLimit !== undefined ? <ResultMetric label={t('business.cards.available')}><Money amount={card.availableLimit} /></ResultMetric> : null}
                    {showsAccountAmounts && accountLabel ? <ResultMetric label={t('business.cards.linkedAccount')}>{accountLabel}</ResultMetric> : null}
                    {showsAccountAmounts && account.accountBalance !== undefined ? <ResultMetric label={t('business.cards.accountBalance')}><Money amount={account.accountBalance} /></ResultMetric> : null}
                    {showsAccountAmounts && account.usableBalance !== undefined ? <ResultMetric label={t('business.cards.usableBalance')}><Money amount={account.usableBalance} /></ResultMetric> : null}
                    {card.monthlyLimit !== undefined ? <ResultMetric label={t('business.cards.monthlyLimit')}><Money amount={card.monthlyLimit} /></ResultMetric> : null}
                  </dl>
                  {linkedAccountNotice !== undefined ? (
                    <p className="text-xs text-banking-navy/60">{t(linkedAccountNotice)}</p>
                  ) : null}
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
                  </div></details>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </ResultCard>
  );
}
