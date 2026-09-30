'use client';

import type { ReactNode } from 'react';
import type { TransferResult } from '@/banking-sdk';
import { Badge, Card, Money } from '../../ui';

export interface TransferCardProps {
  data: TransferResult;
  className?: string;
}

export function TransferCard({ data, className }: TransferCardProps) {
  const { success, recipient, amount, newBalance, remark } = data;

  return (
    <Card
      className={className}
      title={
        <span className="flex items-center gap-2">
          {success ? '转账成功' : '转账失败'}
          <Badge tone={success ? 'success' : 'danger'}>{success ? '成功' : '失败'}</Badge>
        </span>
      }
    >
      <dl className="flex flex-col gap-2">
        <Field label="收款人" value={recipient.name} />
        <Field label="手机号" value={recipient.phone} />
        {recipient.bank ? <Field label="银行" value={recipient.bank} /> : null}
        <Field label="金额" value={<Money amount={amount} />} />
        {newBalance !== undefined ? (
          <Field label="转后余额" value={<Money amount={newBalance} />} />
        ) : null}
        {remark ? <Field label="备注" value={remark} /> : null}
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
