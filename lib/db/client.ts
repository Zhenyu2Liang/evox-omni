import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { currentTransaction } from './unit-of-work.ts';

/**
 * A Prisma handle a repository can read/write through: the process-wide {@link prisma} singleton OR
 * an OPEN interactive-transaction client (`Prisma.TransactionClient`).
 *
 * WHY: a read that logically belongs to an already-open transaction MUST run on that transaction's
 * client. Issuing it through the global `prisma` instead can DEADLOCK — with a single-connection
 * datasource (`?connection_limit=1`) the open interactive transaction holds the only connection, so
 * a global read waits for a free connection until Prisma's interactive-transaction timeout expires
 * ("Transaction already closed"). Repositories therefore accept this as an OPTIONAL second argument,
 * defaulting to the global client so every existing caller is unchanged.
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Resolves the SQLite database URL.
 * Prefers DATABASE_URL; falls back to an absolute path to prisma/dev.db so this
 * works even when no .env file is present.
 */
export function resolveDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  return 'file:' + path.join(process.cwd(), 'prisma', 'dev.db');
}

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * Process-wide PrismaClient singleton, cached on globalThis so Next.js HMR does
 * not open a new connection pool on every reload. Constructed with an explicit
 * datasources url fallback so it works without .env.
 */
export const prisma: PrismaClient =
  globalForPrisma.prisma ??
  new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });

/** Explicit repository port for the current command's unit of work. */
export function dbClient(): DbClient {
  return currentTransaction() ?? prisma;
}

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

/**
 * Best-effort SQLite connection hardening for the app (production) client.
 *
 * WHY: `security/security-gateway.ts` depends on concurrent `prisma.$transaction` write-lock
 * serialization to keep the atomic transfer-limit claim exactly-once. SQLite rejects a write with
 * `SQLITE_BUSY` the moment another connection holds the write lock unless a non-zero
 * `busy_timeout` is set — which would turn those concurrent claims into immediate failures instead
 * of letting them wait their turn. `journal_mode = WAL` additionally lets readers proceed while a
 * write transaction is open. (`tests/helpers/db.ts` sets the same pragmas for the test DB.)
 *
 * NOTE: `$queryRawUnsafe` is required rather than `$executeRawUnsafe` — both PRAGMAs return a
 * result row and Prisma's SQLite driver rejects an `execute` that returns rows. `journal_mode` is
 * a persistent property of the DB file (applies to every connection); `busy_timeout` is
 * per-connection, so on a pooled SQLite datasource this raises it on the connection that runs the
 * statement (Prisma's own default is 5s; run with `?connection_limit=1` to make it pool-wide).
 *
 * NON-FATAL by design: this is a concurrency optimisation, never a correctness gate, so it must
 * never throw at import time (missing/read-only DB, or a client that sets its own pragmas).
 */
function applySqlitePragmas(client: PrismaClient): void {
  for (const statement of ['PRAGMA journal_mode = WAL;', 'PRAGMA busy_timeout = 10000;']) {
    try {
      void client.$queryRawUnsafe(statement).catch((error: unknown) => {
        console.warn(`[lib/db/client] SQLite pragma failed (non-fatal): ${statement}`, error);
      });
    } catch (error) {
      console.warn(`[lib/db/client] SQLite pragma threw synchronously (non-fatal): ${statement}`, error);
    }
  }
}

applySqlitePragmas(prisma);

export default prisma;
