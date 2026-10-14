'use client';

/**
 * RecentTransactions — read-model tile: transaction list (money via ui/Money).
 *
 * Localized presentational component with no fetching or database access.
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
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface RecentTransactionsProps {
  transactions: TransactionView[];
  limit?: number;
  title?: ReactNode;
  className?: string;
}

export function RecentTransactions({ transactions, limit, title, className }: RecentTransactionsProps) {
  const { t } = useI18n();
  const columns: TableColumn<TransactionView>[] = [
    { key: 'merchant', header: t('business.transactions.merchant'), render: (row) => row.merchant },
    { key: 'category', header: t('business.transactions.category'), render: (row) => row.category },
    { key: 'occurredAt', header: t('business.transactions.time'), render: (row) => formatDateTime(row.occurredAt) },
    {
      key: 'amount',
      header: t('business.transactions.amount'),
      align: 'right',
      render: (row) => <Money amount={row.amount} signed />,
    },
  ];
  const rows = limit === undefined ? transactions : transactions.slice(0, Math.max(0, limit));

  return (
    <Card title={title ?? t('business.transactions.title')} className={className}>
      {rows.length === 0 ? (
        <EmptyState title={t('business.transactions.empty')} description={t('business.transactions.emptyDescription')} />
      ) : (
        <Table columns={columns} rows={rows} rowKey={(row) => row.id} />
      )}
    </Card>
  );
}
