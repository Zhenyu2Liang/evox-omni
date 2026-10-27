'use client';

/**
 * CardTile — read-model tile: one bank card (masked number, status, limits, credit line) and, when
 * its settlement account resolves, that account and its balances.
 *
 * Localized presentational component with no data access — the
 * `CardView` DTO arrives via props. Money renders only through `ui/Money`; the (non-risk) card
 * status uses `ui/Badge`, never `ui/StatusBadge` (which is reserved for permission tiers).
 *
 * The settlement-account block follows `CardView.linkedAccountStatus` exactly as
 * `./card-account-display` reduces it: `LINKED` shows 关联账户 / 账户余额 / 可用余额, `MISSING` and
 * `UNTRUSTED` show ONLY their notice (no amount, never `0.00`), `NOT_APPLICABLE` (a CREDIT card)
 * keeps its 信用额度 / 可用额度 rows. An unusable card (`!usable`) adds a notice but keeps its
 * balances visible — unusable is not empty.
 */
import type { CardView } from '@/banking-sdk';
import type { ReactNode } from 'react';
import { Badge } from '../ui/Badge';
import type { BadgeProps } from '../ui/Badge';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import type { MessageKey } from '@/lib/i18n/shared';
import { CardPrimaryAmount } from './CardPrimaryAmount';
import { BankCardFace } from './BankCardFace';
import {
  cardAccountDisplay,
  cardShowsAccountAmounts,
  cardUnavailableNoticeKey,
  linkedAccountNoticeKey,
} from './card-account-display';

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

/** Card status → tone of the 「卡片不可用」 notice (loss is an error, a freeze a warning). */
const UNAVAILABLE_TONE: Record<CardView['status'], NonNullable<BadgeProps['tone']>> = {
  ACTIVE: 'neutral',
  FROZEN: 'warn',
  LOST: 'danger',
  PENDING: 'neutral',
};

export function CardTile({ card, className, footer }: CardTileProps) {
  const { t } = useI18n();
  const cls = ['space-y-3', className].filter(Boolean).join(' ');
  const showsAccountAmounts = cardShowsAccountAmounts(card);
  const account = cardAccountDisplay(card);
  const unavailableNotice = cardUnavailableNoticeKey(card);
  const linkedAccountNotice = linkedAccountNoticeKey(card.linkedAccountStatus);
  const accountLabel = [account.accountName, account.accountNumber].filter(Boolean).join(' · ');

  return (
    <Card className={cls} footer={footer}>
      <div className="space-y-4">
      <BankCardFace type={card.type} inactive={card.status !== 'ACTIVE'}>
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="text-sm font-medium text-banking-navy">
            {t(CARD_TYPE_LABEL[card.type])} · {card.network}
          </div>
          <div className="pt-2 font-mono text-xl tracking-[0.12em] text-banking-deep">
            {card.numberMasked}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {card.replacedByCardId !== undefined ? (
            <Badge tone="info">{t('business.cards.replaced')}</Badge>
          ) : null}
          <Badge tone={STATUS_TONE[card.status]}>{t(STATUS_LABEL[card.status])}</Badge>
        </div>
      </div>
      </BankCardFace>

      {unavailableNotice !== undefined ? (
        <Badge tone={UNAVAILABLE_TONE[card.status]}>{t(unavailableNotice)}</Badge>
      ) : null}

      <CardPrimaryAmount card={card} />
      <details data-card-details className="border-t border-banking-light pt-3">
        <summary className="cursor-pointer text-sm font-medium text-banking-interactive hover:text-banking-accent">{t('business.presentation.cardDetails')}</summary>
        <div className="mt-3 space-y-3">
      {card.type === 'CREDIT' &&
      (card.creditLimit !== undefined || card.availableLimit !== undefined) ? (
        <dl className="grid grid-cols-2 gap-3">
          {card.creditLimit !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy">{t('business.cards.limit')}</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={card.creditLimit} />
              </dd>
            </div>
          ) : null}
          {card.availableLimit !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy">{t('business.cards.available')}</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={card.availableLimit} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {showsAccountAmounts && accountLabel ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-banking-navy">{t('business.cards.linkedAccount')}</span>
          <span className="font-semibold text-banking-deep">{accountLabel}</span>
        </div>
      ) : null}

      {showsAccountAmounts &&
      (account.accountBalance !== undefined || account.usableBalance !== undefined) ? (
        <dl className="grid grid-cols-2 gap-3">
          {account.accountBalance !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy">{t('business.cards.accountBalance')}</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={account.accountBalance} />
              </dd>
            </div>
          ) : null}
          {account.usableBalance !== undefined ? (
            <div>
              <dt className="text-xs text-banking-navy">{t('business.cards.usableBalance')}</dt>
              <dd className="text-sm font-semibold text-banking-deep">
                <Money amount={account.usableBalance} />
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {linkedAccountNotice !== undefined ? (
        <p className="text-sm text-banking-navy">{t(linkedAccountNotice)}</p>
      ) : null}

      {card.monthlyLimit !== undefined ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-banking-navy">{t('business.cards.monthlyLimit')}</span>
          <span className="font-semibold text-banking-deep">
            <Money amount={card.monthlyLimit} />
          </span>
        </div>
      ) : null}

      {card.limits.length > 0 ? (
        <div className="space-y-1 border-t border-banking-light pt-2">
          <div className="text-xs text-banking-navy">{t('business.cards.categoryLimits')}</div>
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
      </div></details>
      </div>
    </Card>
  );
}
