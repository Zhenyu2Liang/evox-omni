'use client';

import type { BalanceView } from '@/banking-sdk';
import { EmptyState, Money } from '../../ui';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { ResultCard } from './ResultCard';

export interface BalanceCardProps {
  data: BalanceView;
  className?: string;
}

export function BalanceCard({ data, className }: BalanceCardProps) {
  const { t } = useI18n();
  const { totalAvailable, currency, accounts } = data;

  return (
    <ResultCard title={t('cards.balance.title')} className={className} marker="¥">
      <div className="rounded-xl bg-banking-ink px-4 py-4 text-white">
        <div className="text-xs text-white/70">{t('cards.balance.available')}</div>
        <div className="mt-1 break-words text-2xl font-semibold tracking-tight sm:text-3xl"><Money amount={totalAvailable} /></div>
        <div className="mt-1 text-xs text-white/60">{currency}</div>
      </div>

      {accounts.length === 0 ? (
        <EmptyState
          className="mt-4"
          title={t('cards.balance.empty.title')}
          description={t('cards.balance.empty.description')}
        />
      ) : (
        <ul className="mt-3 divide-y divide-banking-light">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-1 py-3"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-medium text-banking-deep">{account.name}</span>
                <span className="text-xs text-banking-navy">{account.numberMasked}</span>
              </div>
              <span className="break-words text-right font-semibold text-banking-deep">
                <Money amount={account.balance} />
              </span>
            </li>
          ))}
        </ul>
      )}
    </ResultCard>
  );
}
