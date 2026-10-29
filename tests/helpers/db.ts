/**
 * tests/helpers/db.ts — test-database lifecycle helpers.
 *
 * The integration/scenario and banking-sdk suites need a REAL SQLite DB (Prisma) that is
 * reset to a known state before each test. `tests/setup.ts` provisions the schema + points
 * `DATABASE_URL` at `prisma/test.db`; this module owns *resetting* and *seeding* it.
 *
 * LOAD-SAFE: `@/lib/db/client` (which constructs the Prisma singleton) is resolved LAZILY inside
 * `getTestPrisma()` — importing this module never constructs Prisma, so pure unit suites can import
 * it (directly or via the `./helpers` barrel) without a database.
 */
import { createRequire } from 'node:module';
import { afterAll, beforeEach } from 'vitest';
import type { PrismaClient } from '@/lib/db/prisma';

/** Shape of the resolved `@/lib/db/client` module (named + default export the same singleton). */
interface PrismaClientModule {
  prisma: PrismaClient;
  default?: PrismaClient;
}

let cachedModule: PrismaClientModule | undefined;
let cachedClient: PrismaClient | undefined;
let disconnected = false;

/**
 * Resolve `@/lib/db/client` without a module-load side effect. Uses Node's `require` (via
 * `createRequire`) so the Prisma construction happens only when a test actually needs the DB;
 * `lib/db/client` caches the singleton on `globalThis`, so every accessor (Vite graph or Node)
 * shares ONE client bound to the test SQLite.
 */
function loadPrismaModule(): PrismaClientModule {
  if (!cachedModule) {
    const require = createRequire(import.meta.url);
    cachedModule = require('../../lib/db/client.ts') as PrismaClientModule;
  }
  return cachedModule;
}

/** The Prisma singleton bound to the test DB (`lib/db/client`). Lazily resolves the client. */
export function getTestPrisma(): PrismaClient {
  if (!cachedClient) {
    cachedClient = loadPrismaModule().prisma ?? loadPrismaModule().default;
    disconnected = false;
  }
  return cachedClient;
}

let pragmasReady: Promise<void> | undefined;

/**
 * Apply the SQLite connection pragmas that make the test DB fast — ONCE per process.
 *
 * The test DB defaults to SQLite's rollback journal with `synchronous=FULL`, so EVERY write commit
 * fsyncs (~150–300 ms on this local Windows disk). Because every DB-backed test runs
 * `resetDatabase()` (≈28 write statements) in `beforeEach`, that was the dominant cost (~6 s per
 * test) and the reason the full suite exceeded the tool timeout. WAL + `synchronous=NORMAL`
 * collapses a reset to a few ms while preserving full isolation (each test still truncates +
 * re-seeds from scratch).
 *
 * `journal_mode=WAL` is a PERSISTENT property of the DB file, so this is effectively once-per-DB;
 * the module flag just avoids re-issuing it on every call. Idempotent and safe to call repeatedly.
 * On failure the flag is reset so a later call can retry. Pure test infra — not business logic.
 */
export function ensureTestPragmas(): Promise<void> {
  if (!pragmasReady) {
    const prisma = getTestPrisma();
    pragmasReady = (async () => {
      await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL;');
      await prisma.$queryRawUnsafe('PRAGMA synchronous = NORMAL;');
      await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 10000;');
    })().catch((error: unknown) => {
      pragmasReady = undefined;
      throw error;
    });
  }
  return pragmasReady;
}

/**
 * Delete every row from every table in **FK-safe order** (children → parents) so the DB is
 * empty. Table order MUST respect relations (MfaChallenge→PendingAction, AgentTaskNode→AgentTask,
 * CardLimit→Card, ScheduledNotification→ScheduledTask, ModelRequest/AgentRunEvent/ToolInvocation
 * →AgentRun, Transaction→Account, InvestmentHolding→User+InvestmentProduct,
 * Card/Account/Subscription/Budget/ScheduledTask/Contact/AgentSession→User, AuditLog/SecurityEvent→User).
 * `ExecutionReceipt`, `CircuitBreakerState`, `AuthorizationDecision`, `RiskSignal` and
 * `CardConsumption` declare no relations, so their position in the order is free.
 *
 * COMPLETENESS IS MANDATORY: this list must name EVERY model of `prisma/schema.prisma`. A declared
 * `onDelete: Cascade` is NOT a substitute — a table omitted here leaks into the NEXT test (and into
 * the next RUN of the same file). `CardConsumption` is the cautionary case: relation-free, it kept
 * per-user spend rows and its UNIQUE `executionKey` across resets, so a repeat run replayed against a
 * previous run's card id and threw `CONFLICT`. `tests/helpers/db-truncate.test.ts` asserts
 * model-by-model coverage of this function, so a newly added model cannot be forgotten again.
 * Does NOT re-seed.
 */
export async function truncateAll(): Promise<void> {
  await ensureTestPragmas();
  const prisma = getTestPrisma();
  await prisma.billReportAnalysis.deleteMany();
  await prisma.agentRunEvent.deleteMany();
  await prisma.toolInvocation.deleteMany();
  await prisma.modelRequest.deleteMany();
  await prisma.agentRun.deleteMany();
  await prisma.authorizationDecision.deleteMany();
  await prisma.riskSignal.deleteMany();
  await prisma.manualReview.deleteMany();
  await prisma.mfaChallenge.deleteMany();
  await prisma.pendingAction.deleteMany();
  await prisma.executionReceipt.deleteMany();
  await prisma.agentTaskNode.deleteMany();
  await prisma.agentTask.deleteMany();
  await prisma.cardLimit.deleteMany();
  // Relation-free spend ledger (indexes + a UNIQUE `executionKey` only): no FK forces its deletion,
  // so it MUST be listed explicitly or rows and replay keys survive the reset.
  await prisma.cardConsumption.deleteMany();
  await prisma.transaction.deleteMany();
  await prisma.investmentHolding.deleteMany();
  await prisma.card.deleteMany();
  await prisma.account.deleteMany();
  await prisma.subscription.deleteMany();
  await prisma.budget.deleteMany();
  await prisma.scheduledNotification.deleteMany();
  await prisma.scheduledTask.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.securityEvent.deleteMany();
  await prisma.circuitBreakerState.deleteMany();
  await prisma.agentSession.deleteMany();
  await prisma.investmentProduct.deleteMany();
  await prisma.user.deleteMany();
}

/**
 * `truncateAll()` then `fixtures.seedDemoData()` — the canonical "fresh world" for a test.
 *
 * NOTE on the security circuit breaker: it is DURABLE (`CircuitBreakerState`), keyed by OWNER — not
 * by session id — so a lock is shared by ALL of a user's sessions and survives a new process
 * (`security/circuit-breaker.ts`). `truncateAll()` therefore also clears `circuitBreakerState`, so a
 * lock can never leak from one test into the next. Suites that need an UNRELATED breaker owner can
 * still use a fresh actor id with no `AgentSession`/`User` row (it resolves to `session:<id>`).
 */
export async function resetDatabase(): Promise<void> {
  await truncateAll();
  const fixtures = await import('./fixtures');
  await fixtures.seedDemoData();
}

/**
 * Register the Vitest hooks a DB-backed suite needs:
 *   beforeEach → `resetDatabase()`
 *   afterAll   → disconnect the Prisma client (avoid open handles / worker hangs).
 * Call once at the top of a `describe`/file: `useFreshDatabase();`.
 */
export function useFreshDatabase(): void {
  beforeEach(async () => {
    await resetDatabase();
  });
  afterAll(async () => {
    await disconnectTestPrisma();
  });
}

/** Disconnect the Prisma client (idempotent). Used by suite teardown. */
export async function disconnectTestPrisma(): Promise<void> {
  if (!cachedClient || disconnected) return;
  await cachedClient.$disconnect();
  disconnected = true;
}
