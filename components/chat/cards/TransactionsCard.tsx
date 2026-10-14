'use client';
import type { TransactionView } from '@/banking-sdk';
import { Money } from '../../ui';
import { formatDateTime } from '@/lib/date';
import { absoluteMinor, centsToMoney, moneyToCents } from '@/lib/money';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { ResultCard } from './ResultCard';

export function TransactionsCard({ data }: { data: TransactionView[] }) {
  const { t } = useI18n();
  return (
    <ResultCard title={t('cards.transaction.title', { count: data.length })} marker="⇄">
      {data.length ? (
        <ul className="divide-y divide-banking-light">
          {data.map(row => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 py-3 first:pt-1 last:pb-1">
              <div className="min-w-0">
                <div className="break-words text-sm font-medium text-banking-deep">{row.merchant}</div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-banking-navy/60">
                  <span className="rounded-md bg-banking-light px-1.5 py-0.5">{row.category}</span>
                  <span className="tabular-nums">{formatDateTime(row.occurredAt)}</span>
                </div>
              </div>
              <Money
                amount={centsToMoney((row.direction === 'DEBIT' ? -1n : 1n) * absoluteMinor(moneyToCents(row.amount)))}
                signed
                className={`break-words text-right text-sm font-semibold ${row.direction === 'DEBIT' ? 'text-banking-deep' : 'text-banking-success'}`}
              />
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-banking-navy/60">{t('cards.transaction.empty')}</p>}
    </ResultCard>
  );
}
