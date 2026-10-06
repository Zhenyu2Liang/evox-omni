/**
 * tests/setup.ts — Vitest global setup (registered via `setupFiles`).
 *
 * INFRASTRUCTURE, not business logic. It makes every suite deterministic and offline by:
 *
 *   1. Pointing `DATABASE_URL` at an isolated **test SQLite** file (`prisma/test.db`,
 *      git-ignored) using an ABSOLUTE path, so the Prisma CLI and the runtime client
 *      (`lib/db/client.ts` → `resolveDatabaseUrl()`) resolve the SAME file.
 *   2. Forcing `LLM_MODE=mock` (the faux provider) so no suite ever touches the network.
 *   3. Provisioning the schema (`prisma db push --force-reset`) whenever the provisioned
 *      schema version changes. The guard marker stores the **sha1 of `prisma/schema.prisma`**
 *      so parallel workers do not race AND a stale `test.db` (provisioned before a schema
 *      change) is automatically re-pushed instead of silently reused. Because the fast-path
 *      keeps `test.db` in WAL mode (which `--force-reset` cannot re-reset), the stale DB files
 *      are removed first so the push always starts from a clean slate.
 *
 * Fixture SEEDING is intentionally NOT done here — a single global seed would be wiped by the
 * per-suite resets that tests need for isolation. Each suite seeds through
 * `tests/helpers/fixtures.ts` / `tests/helpers/db.ts` in `beforeAll`/`beforeEach`
 * (`resetDatabase()`). This file guarantees an EMPTY, MIGRATED test DB plus the right env.
 *
 * HOW THIS FILE IS WIRED (root-owned config — escalate to root, do NOT edit from here):
 *   `vitest.config.ts` MUST add   `test.setupFiles: ['tests/setup.ts']`.
 *   Optionally also   `test.env: { LLM_MODE: 'mock' }`   (belt-and-braces; this file sets it too).
 *
 * PREREQUISITES:
 *   - `npm install` (prisma CLI available).
 *   - `npx prisma generate` before any test imports `@prisma/client` (e.g. `lib/db/client`).
 *     The schema push below runs with `--skip-generate` on purpose — generation is a build step.
 *
 * ENV ESCAPES:
 *   - `VITEST_SKIP_DB_SETUP=1` → skip schema provisioning (pure unit runs with no DB).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = process.cwd();
const prismaDir = path.join(repoRoot, 'prisma');
const schemaPath = path.join(prismaDir, 'schema.prisma');
const testDbPath = path.join(prismaDir, 'test.db');
const provisionMarker = path.join(prismaDir, '.test-db-provisioned');

// ---------------------------------------------------------------------------
// 1. Environment — isolate the database and pin the deterministic offline model.
// ---------------------------------------------------------------------------

// Absolute `file:` URL keeps the Prisma CLI (`prisma db push`) and the runtime client
// (`new PrismaClient({ datasources: { db: { url } } })`) on the exact same file.
const testDbUrl = 'file:' + testDbPath.split(path.sep).join('/');
process.env.DATABASE_URL = testDbUrl;
process.env.LLM_MODE = 'mock';
(process.env as Record<string, string>).NODE_ENV = process.env.NODE_ENV ?? 'test';

// ---------------------------------------------------------------------------
// 2. Provision the schema when the schema version changes (marker = sha1 of schema.prisma).
// ---------------------------------------------------------------------------

/** sha1 (hex) of the raw bytes of `prisma/schema.prisma` — the provisioned "schema version". */
function schemaHash(): string {
  return createHash('sha1').update(readFileSync(schemaPath)).digest('hex');
}

/**
 * True only when the marker records the CURRENT schema hash AND the test DB still exists.
 * Everything else (absent marker/DB/schema, truncated marker, an old-format ISO-date marker)
 * falls through to a re-provision, so a stale `test.db` can never be silently reused.
 */
function isProvisioned(): boolean {
  if (!existsSync(schemaPath)) return false;
  if (!existsSync(testDbPath)) return false; // deleted DB ⇒ marker is meaningless
  if (!existsSync(provisionMarker)) return false;
  // FULL-string equality (never a prefix/substring check): a partially-written / truncated
  // marker can never compare equal, so it is always treated as invalid.
  return readFileSync(provisionMarker, 'utf8').trim() === schemaHash();
}

/**
 * Record the current schema hash in the marker. Written ATOMICALLY (sibling temp file then
 * rename) because the marker is a mutual-exclusion signal between parallel workers — a
 * half-written marker must never be observable.
 */
function markProvisioned(): void {
  const tmpMarker = `${provisionMarker}.${process.pid}.tmp`;
  writeFileSync(tmpMarker, schemaHash());
  renameSync(tmpMarker, provisionMarker);
}

function provisionTestDatabase(): void {
  if (process.env.VITEST_SKIP_DB_SETUP === '1') return;
  if (isProvisioned()) return; // schema unchanged & DB present — another worker already provisioned

  mkdirSync(prismaDir, { recursive: true });
  try {
    // Start from a CLEAN SLATE. `--force-reset` cannot reliably re-reset an existing WAL-mode
    // SQLite file (Prisma's reset step fails with "Error code 11: The database disk image is
    // malformed"), and the fast-path pragmas in `tests/helpers/db.ts` keep `test.db` permanently
    // in WAL mode. Removing the DB file and its -wal/-shm/-journal sidecars guarantees the push
    // below recreates the schema from scratch (verified: a re-push on a WAL db fails; on a
    // freshly removed one it succeeds).
    for (const stale of [testDbPath, `${testDbPath}-wal`, `${testDbPath}-shm`, `${testDbPath}-journal`]) {
      rmSync(stale, { force: true });
    }
    // `--force-reset` drops any stale data; `--skip-generate` keeps this a pure schema push.
    execSync('npx prisma db push --force-reset --skip-generate', {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    markProvisioned();
  } catch (error) {
    // Do not hard-crash the whole run: pure unit suites need no DB. Loudly warn so the
    // failure is impossible to miss when integration suites actually need the DB.
    console.warn(
      '[tests/setup] Could not provision the test database (prisma db push failed).\n' +
        '             Run `npm install` then `npx prisma generate` and retry.\n' +
        `             DATABASE_URL=${testDbUrl}`,
      error,
    );
  }
}

provisionTestDatabase();

// Runtime-only pool constraint (applied AFTER the CLI push above, which used the clean URL).
// A single SQLite connection keeps the per-connection `PRAGMA synchronous=NORMAL` from
// `tests/helpers/db.ts` authoritative for EVERY query, so no pooled connection falls back to
// synchronous=FULL and stalls a write. The Prisma CLI ignores unknown query params; the runtime
// client honours `connection_limit`.
process.env.DATABASE_URL = testDbUrl + '?connection_limit=1';
export { testDbUrl, testDbPath };
