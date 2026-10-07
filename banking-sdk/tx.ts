/**
 * Banking SDK — transaction boundary (the ONLY direct Prisma usage in the SDK).
 *
 * WHY this module exists: a money-moving or multi-row write must be ALL-OR-NOTHING.
 * Doing the steps as two independent awaits leaves a partial write when the second step
 * fails (e.g. a debited balance with no ledger row / no holding), and lets concurrent calls
 * overspend into a negative balance. Wrapping the whole unit in a single interactive
 * `prisma.$transaction` makes the database roll everything back on any failure, so a partial
 * debit can never survive.
 *
 * Design note: `banking-sdk` otherwise persists ONLY through `lib/db/repositories/*`, and that
 * remains the rule for every single-statement write. This file is the single, deliberate,
 * documented exception — it touches the Prisma client directly so several statements can share
 * one transaction. Keep it that way: no other SDK file may import `prisma` (or `@prisma/client`)
 * for writes.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/db/client';
import { bankingExecutionContext } from './execution-context';

/** The Prisma client bound to an open interactive transaction. */
export type Tx = Prisma.TransactionClient;

/**
 * Run `fn` inside a single interactive transaction. All writes performed with the provided `tx`
 * client commit together, or (on any thrown error) roll back together. `fn` may throw `AppError`
 * to abort the unit — nothing it wrote is persisted.
 */
export function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const context = bankingExecutionContext();
  return prisma.$transaction(async (tx) => {
    // Every SDK mutation enters here, including runners that only forward their first argument.
    // The trusted fence takes the SQLite writer slot before any banking write in this transaction.
    await context?.fence?.(tx);
    return fn(tx);
  }).then((result) => {
    context?.onTransactionCommitted?.();
    return result;
  });
}
