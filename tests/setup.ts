/**
 * tests/setup.ts — Vitest global setup (registered via `setupFiles`).
 *
 * INFRASTRUCTURE, not business logic. It makes every suite deterministic and offline by:
 *
 *   1. Pointing `DATABASE_URL` at an isolated **test SQLite** file (`prisma/test.db`,
 *      git-ignored) using an ABSOLUTE path, so the Prisma CLI and the runtime client
 *      (`lib/db/client.ts` → `resolveDatabaseUrl()`) resolve the SAME file.
 *   2. Forcing `LLM_MODE=mock` (the faux provider) so no suite ever touches the network.
 *   3. Provisioning the schema once per run (`prisma db push --force-reset`), guarded by a
 *      marker file so parallel workers do not race.
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = process.cwd();
const prismaDir = path.join(repoRoot, 'prisma');
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
// 2. Provision the schema once (idempotent across workers via the marker file).
// ---------------------------------------------------------------------------

function provisionTestDatabase(): void {
  if (process.env.VITEST_SKIP_DB_SETUP === '1') return;
  if (existsSync(provisionMarker)) return; // another worker already provisioned this run

  mkdirSync(prismaDir, { recursive: true });
  try {
    // `--force-reset` drops any stale data; `--skip-generate` keeps this a pure schema push.
    execSync('npx prisma db push --force-reset --skip-generate', {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    writeFileSync(provisionMarker, new Date().toISOString());
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

export { testDbUrl, testDbPath };
