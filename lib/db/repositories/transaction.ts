import type { Prisma, Transaction } from '@/lib/db/prisma';
import { dbClient } from '../client';
import { absoluteMinor, moneyToCents, type MoneyInput } from '../../money';

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
export interface CategoryTotal { category: string; total: bigint; count: number; }

/**
 * Transactions for `query.userId`, most recent first (`occurredAt` descending).
 * The range is half-open `[from, to)`; `category`/`channel`/`direction` are exact matches;
 * `limit` caps the number of rows returned (newest first).
 */
export function listTransactions(query: TransactionQuery): Promise<Transaction[]> {
  const where: Prisma.TransactionWhereInput = { userId: query.userId };
  if (query.from !== undefined || query.to !== undefined) {
    where.occurredAt = {
      ...(query.from !== undefined ? { gte: query.from } : {}),
      ...(query.to !== undefined ? { lt: query.to } : {}),
    };
  }
  if (query.category !== undefined) where.category = query.category;
  if (query.channel !== undefined) where.channel = query.channel;
  if (query.direction !== undefined) where.direction = query.direction;

  return dbClient().transaction.findMany({
    where,
    orderBy: { occurredAt: 'desc' },
    ...(query.limit !== undefined ? { take: query.limit } : {}),
  });
}

export function getTransaction(id: string): Promise<Transaction | null> {
  return dbClient().transaction.findUnique({ where: { id } });
}

export function createTransaction(input: { accountId: string; userId: string; amount: MoneyInput; direction: 'DEBIT' | 'CREDIT'; category: string; merchant: string; channel?: string | null; remark?: string | null; counterpartyId?: string | null; occurredAt: Date; isAnomaly?: boolean; anomalyReason?: string | null; currency?: string }): Promise<Transaction> {
  return dbClient().transaction.create({
    data: {
      accountId: input.accountId,
      userId: input.userId,
      amountMinor: moneyToCents(input.amount),
      direction: input.direction,
      category: input.category,
      merchant: input.merchant,
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.remark !== undefined ? { remark: input.remark } : {}),
      ...(input.counterpartyId !== undefined ? { counterpartyId: input.counterpartyId } : {}),
      occurredAt: input.occurredAt,
      ...(input.isAnomaly !== undefined ? { isAnomaly: input.isAnomaly } : {}),
      ...(input.anomalyReason !== undefined ? { anomalyReason: input.anomalyReason } : {}),
      ...(input.currency !== undefined ? { currency: input.currency } : {}),
    },
  });
}

/**
 * Absolute total of DEBIT amounts in [from, to).
 * DEBIT amounts are stored negative, so the absolute value of the aggregate is returned.
 */
export async function sumDebitsInRange(userId: string, from: Date, to: Date): Promise<bigint> {
  const rows = await listTransactions({ userId, direction: 'DEBIT', from, to });
  return rows.reduce((total, row) => total + absoluteMinor(row.amountMinor), 0n);
}

/** Debit totals grouped by category in [from, to), sorted by total descending. */
export async function listByCategory(userId: string, from: Date, to: Date): Promise<CategoryTotal[]> {
  const rows = await listTransactions({ userId, direction: 'DEBIT', from, to });
  const totals = new Map<string, CategoryTotal>();
  for (const row of rows) {
    const current = totals.get(row.category) ?? { category: row.category, total: 0n, count: 0 };
    current.total += absoluteMinor(row.amountMinor);
    current.count += 1;
    totals.set(row.category, current);
  }
  return [...totals.values()].sort((a, b) => a.total < b.total ? 1 : a.total > b.total ? -1 : a.category.localeCompare(b.category));
}

/** Previously flagged anomalies (`isAnomaly = true`), most recent first. */
export function listAnomalies(userId: string, limit?: number): Promise<Transaction[]> {
  return dbClient().transaction.findMany({
    where: { userId, isAnomaly: true },
    orderBy: { occurredAt: 'desc' },
    ...(limit !== undefined ? { take: limit } : {}),
  });
}

/** Transactions whose merchant, remark or category contains `keyword`, most recent first. */
export function searchTransactions(userId: string, keyword: string, limit?: number): Promise<Transaction[]> {
  return dbClient().transaction.findMany({
    where: {
      userId,
      OR: [
        { merchant: { contains: keyword } },
        { remark: { contains: keyword } },
        { category: { contains: keyword } },
      ],
    },
    orderBy: { occurredAt: 'desc' },
    ...(limit !== undefined ? { take: limit } : {}),
  });
}

export function countTransactionsSince(userId: string, since: Date): Promise<number> {
  return dbClient().transaction.count({
    where: { userId, occurredAt: { gte: since } },
  });
}

/**
 * Absolute (positive) total of OUTGOING transfer debits at or after `sinceMs`
 * (i.e. rows with `occurredAt >= new Date(sinceMs)` where `direction === 'DEBIT'`
 * AND `channel === 'TRANSFER'`). DEBIT amounts are stored negative, so the absolute
 * value of the aggregate is returned. Used by the risk engine to compute the day's
 * running transfer total.
 */
export async function sumOutgoingTransfersSince(userId: string, sinceMs: number): Promise<bigint> {
  const rows = await listTransactions({ userId, direction: 'DEBIT', channel: 'TRANSFER', from: new Date(sinceMs) });
  return rows.reduce((total, row) => total + absoluteMinor(row.amountMinor), 0n);
}
