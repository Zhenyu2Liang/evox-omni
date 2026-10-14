import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '@/lib/db/prisma';

const transactions = new AsyncLocalStorage<Prisma.TransactionClient>();

/** Repository defaults resolve to the same transaction throughout one command. */
export function currentTransaction(): Prisma.TransactionClient | undefined {
  return transactions.getStore();
}

export function withinTransaction<T>(client: Prisma.TransactionClient, run: () => Promise<T>): Promise<T> {
  return transactions.run(client, run);
}
