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
      <dl className="flex flex-col gap-2">
        <Field label={t('cards.recipient')} value={recipient.name} />
        <Field label={t('cards.phone')} value={maskPhone(recipient.phone)} />
        {recipient.bank ? <Field label={t('cards.bank')} value={recipient.bank} /> : null}
        <Field label={t('cards.amount')} value={<Money amount={amount} />} />
        {newBalance !== undefined ? (
          <Field label={t('cards.balanceAfter')} value={<Money amount={newBalance} />} />
        ) : null}
        {remark ? <Field label={t('cards.remark')} value={remark} /> : null}
      </dl>
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
      <dt className="text-sm text-banking-navy/70">{label}</dt>
      <dd className="font-medium text-banking-deep">{value}</dd>
    </div>
  );
}
