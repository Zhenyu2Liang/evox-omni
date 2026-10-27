'use client';

import type { ReactNode } from 'react';
import type { TransferResult } from '@/banking-sdk';
import { Badge, Card, Money } from '../../ui';
import { maskPhone } from './maskPhone';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface TransferCardProps {
  data: TransferResult;
  className?: string;
}

export function TransferCard({ data, className }: TransferCardProps) {
  const { t } = useI18n();
  const { success, recipient, amount, newBalance, remark } = data;

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          {t(success ? 'cards.transfer.success' : 'cards.transfer.failed')}
          <Badge tone={success ? 'success' : 'danger'}>{t(success ? 'cards.success' : 'cards.failed')}</Badge>
        </span>
      }
    >
      <div className="mb-3 rounded-xl bg-banking-light/50 p-4">
        <p className="text-banking-caption text-banking-navy">{t('cards.amount')}</p>
        <p className="my-2 text-2xl font-semibold text-banking-deep"><Money amount={amount} /></p>
        <dl><Field label={t('cards.recipient')} value={recipient.name} /></dl>
      </div>
      <details data-receipt-details>
        <summary className="cursor-pointer text-sm font-medium text-banking-interactive hover:text-banking-accent-text">{t('business.presentation.details')}</summary>
      <dl className="mt-3 flex flex-col gap-2">
        <Field label={t('cards.phone')} value={maskPhone(recipient.phone)} />
        {recipient.bank ? <Field label={t('cards.bank')} value={recipient.bank} /> : null}
        {newBalance !== undefined ? (
          <Field label={t('cards.balanceAfter')} value={<Money amount={newBalance} />} />
        ) : null}
        {remark ? <Field label={t('cards.remark')} value={remark} /> : null}
      </dl></details>
    </Card>
  );
}

interface FieldProps {
  label: string;
  value: ReactNode;
}

function Field({ label, value }: FieldProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="text-sm text-banking-navy">{label}</dt>
      <dd className="font-medium text-banking-deep">{value}</dd>
    </div>
  );
}
