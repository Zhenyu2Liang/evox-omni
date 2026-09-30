import type { Transaction } from '@prisma/client';

/** Filter for transaction listing. Range is [from, to). */
export interface TransactionQuery {
  userId: string;
  from?: Date;
  to?: Date;
  category?: string;
  channel?: string;
  direction?: 'DEBIT' | 'CREDIT';
  limit?: number;
}

/** Aggregate of debits grouped by category. */
export interface CategoryTotal { category: string; total: number; count: number; }

export function listTransactions(query: TransactionQuery): Promise<Transaction[]> {
  throw new Error('not implemented');
}

export function getTransaction(id: string): Promise<Transaction | null> {
  throw new Error('not implemented');
}

export function createTransaction(input: { accountId: string; userId: string; amount: number; direction: 'DEBIT' | 'CREDIT'; category: string; merchant: string; channel?: string | null; remark?: string | null; counterpartyId?: string | null; occurredAt: Date; isAnomaly?: boolean; anomalyReason?: string | null; currency?: string }): Promise<Transaction> {
  throw new Error('not implemented');
}

/** Absolute total of DEBIT amounts in [from, to). */
export function sumDebitsInRange(userId: string, from: Date, to: Date): Promise<number> {
  throw new Error('not implemented');
}

/** Debit totals grouped by category in [from, to). */
export function listByCategory(userId: string, from: Date, to: Date): Promise<CategoryTotal[]> {
  throw new Error('not implemented');
}

export function listAnomalies(userId: string, limit?: number): Promise<Transaction[]> {
  throw new Error('not implemented');
}

export function searchTransactions(userId: string, keyword: string, limit?: number): Promise<Transaction[]> {
  throw new Error('not implemented');
}

export function countTransactionsSince(userId: string, since: Date): Promise<number> {
  throw new Error('not implemented');
}
