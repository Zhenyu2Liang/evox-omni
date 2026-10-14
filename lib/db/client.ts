import type { Prisma, PrismaClient } from './prisma.ts';
import { currentTransaction } from './unit-of-work.ts';
import { createDatabaseClient } from './database.ts';
export { createDatabaseClient, resolveDatabaseUrl } from './database.ts';

/**
 * A Prisma handle a repository can read/write through: the process-wide {@link prisma} singleton OR
 * an OPEN interactive-transaction client (`Prisma.TransactionClient`).
 *
 * WHY: a read that logically belongs to an already-open transaction MUST run on that transaction's
 * client. Issuing it through the global `prisma` instead can DEADLOCK — with a single-connection
 * SQLite adapter, the open interactive transaction holds the single connection, so
 * a global read waits for a free connection until Prisma's interactive-transaction timeout expires
 * ("Transaction already closed"). Repositories therefore accept this as an OPTIONAL second argument,
 * defaulting to the global client so every existing caller is unchanged.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Process-wide PrismaClient singleton, cached on globalThis so Next.js HMR does
 * not open a new native SQLite connection on every reload.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  createDatabaseClient();

/** Explicit repository port for the current command's unit of work. */
export function dbClient(): DbClient {
  return currentTransaction() ?? prisma;
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
