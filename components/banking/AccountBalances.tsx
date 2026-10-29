'use client';

import type { AccountView, CardView } from '@/banking-sdk';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { EmptyState } from '../ui/EmptyState';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export function AccountBalances({ accounts, cards }: { accounts: AccountView[]; cards?: CardView[] }) {
  const { t } = useI18n();
  return <Card title={<h2>{t('pages.overview.accounts')}</h2>}>
    {accounts.length ? <ul className="grid gap-4 sm:grid-cols-2">{accounts.map(account => {
      const linked = cards?.filter(card => card.linkedAccountId === account.id && card.linkedAccountStatus === 'LINKED' && card.status !== 'LOST');
      return <li key={account.id} data-overview-account className="rounded-xl border border-banking-border bg-banking-light p-5">
        <h3 className="text-base font-semibold text-banking-deep">{account.name}</h3>
        <p className="mt-1 text-sm text-banking-navy">{t('cards.balance.accountNumber', { number: account.numberMasked })}</p>
        <p className="mt-5 text-xs text-banking-navy">{t('pages.overview.depositBalance')}</p>
        <p className="mt-1 text-2xl font-semibold text-banking-deep"><Money amount={account.balance} /></p>
        {linked !== undefined ? <p className="mt-3 text-xs text-banking-navy">{linked.length ? t('pages.overview.linkedCards', { numbers: linked.map(card => card.numberMasked).join('、') }) : t('pages.overview.noLinkedCard')}</p> : null}
      </li>;
    })}</ul> : <EmptyState title={t('cards.balance.empty.title')} description={t('cards.balance.empty.description')} />}
  </Card>;
}
