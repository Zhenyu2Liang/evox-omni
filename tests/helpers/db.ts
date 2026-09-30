/**
 * tests/helpers/db.ts — test-database lifecycle helpers.
 *
 * The integration/scenario and banking-sdk suites need a REAL SQLite DB (Prisma) that is
 * reset to a known state before each test. `tests/setup.ts` provisions the schema + points
 * `DATABASE_URL` at `prisma/test.db`; this module owns *resetting* and *seeding* it.
 *
 * STATUS: documented STUB — signatures frozen; implementations land in Phase 2 once
 * `lib/db/repositories` and the generated Prisma client exist. Do NOT import `@prisma/client`
 * at module load in a way that breaks pure unit runs — import it lazily inside functions.
 */
import type { PrismaClient } from '@prisma/client';

/** The Prisma singleton bound to the test DB (`lib/db/client`). Lazily resolves the client. */
export function getTestPrisma(): PrismaClient {
  throw new Error('not implemented');
}

/**
 * Delete every row from every table in **FK-safe order** (children → parents) so the DB is
 * empty. Table order MUST respect relations (PendingAction→MfaChallenge, AgentTask→AgentTaskNode,
 * Transaction→Account, etc.). Does NOT re-seed.
 */
export async function truncateAll(): Promise<void> {
  throw new Error('not implemented');
}

/**
 * `truncateAll()` then `fixtures.seedDemoData()` — the canonical "fresh world" for a test.
 * Also resets in-process security state (circuit breaker) keyed by the session(s) a suite uses.
 */
export async function resetDatabase(): Promise<void> {
  throw new Error('not implemented');
}

/**
 * Register the Vitest hooks a DB-backed suite needs:
 *   beforeEach → `resetDatabase()`
 *   afterAll   → disconnect the Prisma client (avoid open handles / worker hangs).
 * Call once at the top of a `describe`/file: `useFreshDatabase();`.
 */
export function useFreshDatabase(): void {
  throw new Error('not implemented');
}

/** Disconnect the Prisma client (idempotent). Used by suite teardown. */
export async function disconnectTestPrisma(): Promise<void> {
  throw new Error('not implemented');
}
