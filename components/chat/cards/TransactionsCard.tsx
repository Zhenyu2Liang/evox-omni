'use client';
import type { TransactionView } from '@/banking-sdk';
import { Card, Money } from '../../ui';
import { formatDateTime } from '@/lib/date';
import { absoluteMinor, centsToMoney, moneyToCents } from '@/lib/money';

export function TransactionsCard({ data }: { data: TransactionView[] }) {
  return <Card title={`交易明细（${data.length} 笔）`}>
    {data.length ? <div className="space-y-3">{data.map(row => <div key={row.id} className="border-b border-banking-light pb-2 text-sm">
      <div className="flex justify-between"><span>{row.merchant} · {row.category}</span><Money amount={centsToMoney((row.direction === 'DEBIT' ? -1n : 1n) * absoluteMinor(moneyToCents(row.amount)))} signed /></div>
      <p className="text-xs text-banking-navy/60">{formatDateTime(row.occurredAt)} · {row.accountId} · {row.id}</p>
    </div>)}</div> : <p>该范围没有交易记录。</p>}
  </Card>;
}
