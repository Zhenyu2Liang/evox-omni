/**
 * RecentTransactions — read-model tile: transaction list (money via ui/Money).
 *
 * Server-safe presentational component: no `'use client'`, no hooks, no fetching, no DB.
 * Renders a `TransactionView[]` through the generic `ui/Table`; empty input falls back to
 * an `ui/EmptyState`.
 */
import type { ReactNode } from 'react';
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import { Table } from '../ui/Table';
import type { TableColumn } from '../ui/Table';
import { EmptyState } from '../ui/EmptyState';
import { formatDateTime } from '@/lib/date';
import type { TransactionView } from '@/banking-sdk';

export interface RecentTransactionsProps {
  transactions: TransactionView[];
  limit?: number;
  title?: ReactNode;
  className?: string;
}

const COLUMNS: TableColumn<TransactionView>[] = [
  { key: 'merchant', header: '商户', render: (row) => row.merchant },
  { key: 'category', header: '分类', render: (row) => row.category },
  { key: 'occurredAt', header: '时间', render: (row) => formatDateTime(row.occurredAt) },
  {
    key: 'amount',
    header: '金额',
    align: 'right',
    render: (row) => <Money amount={row.amount} signed />,
  },
];

export function RecentTransactions({ transactions, limit, title, className }: RecentTransactionsProps) {
  const rows = limit === undefined ? transactions : transactions.slice(0, Math.max(0, limit));

  return (
    <Card title={title ?? '最近交易'} className={className}>
      {rows.length === 0 ? (
        <EmptyState title="暂无交易" description="该时间段内没有可展示的交易记录。" />
      ) : (
        <Table columns={COLUMNS} rows={rows} rowKey={(row) => row.id} />
      )}
    </Card>
  );
}
