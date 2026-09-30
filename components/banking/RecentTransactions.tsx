/**
 * RecentTransactions — read-model tile: transaction list (money via ui/Money).
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`).
 */
import type { ReactNode } from 'react';
import type { TransactionView } from '@/banking-sdk';

export interface RecentTransactionsProps {
  transactions: TransactionView[];
  limit?: number;
  title?: ReactNode;
  className?: string;
}

export function RecentTransactions(_props: RecentTransactionsProps) {
  return null;
}
