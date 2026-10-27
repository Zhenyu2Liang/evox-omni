'use client';

import type { CardView } from '@/banking-sdk';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { Money } from '../ui/Money';
import { cardAccountDisplay } from './card-account-display';

/** Account cash, available credit and payable cash remain separate server-provided facts. */
export function CardPrimaryAmount({ card }: { card: CardView }) {
  const { t } = useI18n();
  const account = cardAccountDisplay(card);
  const amount = card.type === 'CREDIT' ? card.availableLimit : card.type === 'VIRTUAL' ? account.usableBalance : account.accountBalance;
  const label = card.type === 'CREDIT' ? card.usable ? 'business.cards.available' : 'business.presentation.recordedCredit' : card.type === 'VIRTUAL' ? 'business.presentation.payable' : 'business.cards.accountBalance';
  if (amount === undefined) return null;
  return <dl data-card-primary-amount data-card-type={card.type} className="rounded-xl border border-banking-navy/10 bg-white/80 p-4">
    <dt className="text-xs text-banking-navy/65">{t(label)}</dt>
    <dd className="mt-1 break-all text-2xl font-semibold tabular-nums text-banking-deep"><Money amount={amount} /></dd>
  </dl>;
}
