import { z } from 'zod';
import { AppError } from '../lib/errors';
import type { TransactionQuery } from './types';

export const MAX_TRANSACTION_READ_LIMIT = 200;
export const MAX_DATE_TIMESTAMP = 8_640_000_000_000_000;

const epochTimestamp = z.number().int().min(-MAX_DATE_TIMESTAMP).max(MAX_DATE_TIMESTAMP);
const transactionQuerySchema = z.object({
  from: epochTimestamp.optional(),
  to: epochTimestamp.optional(),
  category: z.string().trim().min(1).max(80).optional(),
  limit: z.number().int().min(1).max(MAX_TRANSACTION_READ_LIMIT).optional(),
}).strict().refine(query => query.from === undefined || query.to === undefined || query.from < query.to);

/** Invalid filters fail closed rather than silently widening the account-data query. */
export function validateTransactionQuery(input: unknown): TransactionQuery {
  const parsed = transactionQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Invalid transaction filters: use integer epoch timestamps, a nonempty category, an ordered half-open range, and a limit from 1 to 200.');
  }
  return parsed.data;
}

/** Accept the explicit banking month format without dropping malformed optional input. */
export function validateSpendingMonth(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(input)) {
    throw new AppError('VALIDATION', 'Invalid spending month: expected YYYY-MM with a month from 01 to 12.');
  }
  return input;
}
