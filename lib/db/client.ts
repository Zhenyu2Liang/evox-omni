import path from 'node:path';
import { PrismaClient } from '@prisma/client';

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

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
