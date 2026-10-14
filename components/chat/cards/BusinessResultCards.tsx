'use client';

import type { ReactNode } from 'react';
import type { BusinessReceipt, ContactCardView, DashboardCardView, ScheduledCardView } from '@/lib/contracts/agent';
import { useI18n } from '@/lib/i18n/LocaleProvider';
import { formatDateTime } from '@/lib/date';
import { Badge, Card, Money } from '../../ui';
import { DecimalMoney } from '../../ui/DecimalMoney';
import { maskPhone } from './maskPhone';

type ResultIconKind = 'contact' | 'assets' | 'schedule' | 'budget' | 'investment';

const ICON_PATHS: Record<ResultIconKind, string> = {
  contact: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  assets: 'M3 10h18 M5 10v9 M10 10v9 M14 10v9 M19 10v9 M3 21h18 M3 7l9-5 9 5v3H3Z',
  schedule: 'M8 2v4 M16 2v4 M3 10h18 M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2 M12 13v4l3 2',
  budget: 'M21 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-2 M3 8h18v8h-5a4 4 0 0 1 0-8 M17 12h1',
  investment: 'M22 11v1a10 10 0 1 1-6-9 M22 4 12 14l-3-3',
};

/** Decorative repository-native SVGs keep business cards independent of an icon package. */
function ResultIcon({ kind }: { kind: ResultIconKind }) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON_PATHS[kind]} /></svg>;
}

function Header({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: string }) {
  return <div className="flex items-start gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-banking-accent">{icon}</span>
    <div><h3 className="font-semibold text-banking-deep">{title}</h3>{subtitle ? <p className="mt-1 text-xs font-normal text-banking-navy/65">{subtitle}</p> : null}</div></div>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-2"><dt className="text-sm text-banking-navy/65">{label}</dt>
    <dd className="break-words text-right text-sm font-medium text-banking-deep">{children}</dd></div>;
}

export function ContactsCard({ data, className }: { data: ContactCardView[]; className?: string }) {
  const { t } = useI18n();
  return <Card className={className} title={<Header icon={<ResultIcon kind="contact" />} title={t('business.contacts.title')} subtitle={t('business.contacts.count', { count: data.length })} />}>
    {data.length === 0 ? <p className="text-sm text-banking-navy/65">{t('business.contacts.empty')}</p> :
      <div className="grid gap-3 sm:grid-cols-2">{data.map((contact, index) => <div key={index} className="rounded-xl border border-banking-light bg-banking-light/30 p-4">
        <p className="font-semibold text-banking-deep">{contact.name}</p><p className="mt-1 text-sm text-banking-navy/65">{maskPhone(contact.phone)}</p>
        {contact.bank ? <p className="mt-2 text-xs text-banking-navy/65">{contact.bank}</p> : null}
        {contact.remark ? <p className="mt-2 break-words text-sm text-banking-navy/75">{contact.remark}</p> : null}
      </div>)}</div>}
  </Card>;
}

export function DashboardCard({ data, className }: { data: DashboardCardView; className?: string }) {
  const { t } = useI18n();
  const stats = [
    { key: 'business.assets.total' as const, value: <DecimalMoney amount={data.totalAssets} /> },
    { key: 'business.assets.checking' as const, value: <Money amount={data.checkingBalance} /> },
    { key: 'business.assets.credit' as const, value: <Money amount={data.creditAvailable} /> },
    { key: 'business.assets.spend' as const, value: <Money amount={data.monthSpend} /> },
  ];
  return <Card className={className} title={<Header icon={<ResultIcon kind="assets" />} title={t('business.assets.title')} subtitle={t('business.results.asOf', { time: formatDateTime(data.asOf) })} />}>
    <div className="grid gap-3 sm:grid-cols-2">{stats.map(stat => <div key={stat.key} className="rounded-xl bg-banking-light/50 p-4">
      <p className="text-xs text-banking-navy/65">{t(stat.key, { month: data.month })}</p><p className="mt-2 break-all text-xl font-semibold text-banking-deep">{stat.value}</p>
    </div>)}</div>
  </Card>;
}

export function ScheduledCard({ data, created, className }: { data: ScheduledCardView[]; created: boolean; className?: string }) {
  const { t } = useI18n();
  return <Card className={className} title={<Header icon={<ResultIcon kind="schedule" />} title={t(created ? 'business.scheduled.created' : 'business.scheduled.title')} subtitle={t('business.scheduled.scope')} />}>
    {data.length === 0 ? <p className="text-sm text-banking-navy/65">{t('business.scheduled.empty')}</p> : <div className="space-y-3">{data.map((task, index) =>
      <div key={index} className="rounded-xl border border-banking-light bg-banking-light/20 p-4"><div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-semibold text-banking-deep">{task.name}</h4><Badge tone={task.status === 'DONE' ? 'success' : task.status === 'FAILED' ? 'danger' : 'info'}>{t(`business.scheduled.status.${task.status}`)}</Badge>
      </div><dl className="mt-2"><Field label={t('business.scheduled.kind')}>{t(`business.scheduled.kind.${task.kind}`)}</Field>
        <Field label={t('business.scheduled.runAt')}>{formatDateTime(task.runAt)}</Field>
        <Field label={t('business.scheduled.confirmation')}>{t(task.requiresConfirmation ? 'business.scheduled.confirmationRequired' : 'business.scheduled.confirmationNotRequired')}</Field>
      </dl></div>)}</div>}
  </Card>;
}

export function BusinessReceiptCard({ data, className }: { data: BusinessReceipt; className?: string }) {
  const { t } = useI18n();
  if (data.kind === 'budget') {
    return <Card className={className} title={<Header icon={<ResultIcon kind="budget" />} title={t('business.receipt.budget')} subtitle={t('business.receipt.budgetScope')} />}>
      <div className="rounded-xl bg-cyan-50/60 p-4"><p className="text-sm text-banking-navy/70">{data.name}</p>
        <p className="mt-2 break-all text-2xl font-semibold text-banking-deep"><Money amount={data.amount} /></p></div>
      <dl className="mt-3"><Field label={t('business.receipt.status')}>{t(`business.receipt.budgetStatus.${data.status}`)}</Field>
        {data.purpose ? <Field label={t('business.receipt.purpose')}>{data.purpose}</Field> : null}
        {data.dueDate === undefined ? null : <Field label={t('business.receipt.dueDate')}>{formatDateTime(data.dueDate)}</Field>}
      </dl></Card>;
  }
  return <Card className={className} title={<Header icon={<ResultIcon kind="investment" />} title={t(`business.receipt.${data.kind}`)} />}>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-banking-light/40 p-4">
      <p className="break-all text-2xl font-semibold text-banking-deep"><Money amount={data.amount} /></p>
      <Badge tone={data.success ? 'success' : 'danger'}>{t(data.success ? 'cards.success' : 'cards.failed')}</Badge></div>
    <dl className="mt-3"><Field label={t('cards.balanceAfter')}><Money amount={data.newBalance} /></Field>
      <Field label={t('business.receipt.time')}>{formatDateTime(data.occurredAt)}</Field>
      {data.redemptionValuation === undefined ? null : <Field label={t('business.receipt.valuation')}><DecimalMoney amount={data.redemptionValuation} /></Field>}
      {data.settlementRounding === undefined ? null : <Field label={t('business.receipt.rounding')}>{t('business.receipt.halfUp')}</Field>}
    </dl></Card>;
}
