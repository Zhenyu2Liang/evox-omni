/**
 * tests/setup.ts — Vitest global setup (registered via `setupFiles`).
 *
 * INFRASTRUCTURE, not business logic. It makes every suite deterministic and offline by:
 *
 *   1. Pointing `DATABASE_URL` at an isolated **test SQLite** file (`prisma/test.db`,
 *      git-ignored) using an ABSOLUTE path, so the Prisma CLI and the runtime client
 *      (`lib/db/client.ts` → `resolveDatabaseUrl()`) resolve the SAME file.
 *   2. Forcing `LLM_MODE=mock` (the faux provider) so no suite ever touches the network.
 *   3. Guaranteeing a **generated, usable Prisma Client** on a clean checkout, then provisioning
 *      the schema (`prisma db push --force-reset`) whenever the provisioned schema version changes.
 *      The guard marker stores the **sha1 of `prisma/schema.prisma`** so parallel workers do not
 *      race AND a stale `test.db` (provisioned before a schema change) is automatically re-pushed
 *      instead of silently reused. Because the fast-path keeps `test.db` in WAL mode (which
 *      `--force-reset` cannot re-reset), the stale DB files are removed first so the push always
 *      starts from a clean slate.
 *
 * Fixture SEEDING is intentionally NOT done here — a single global seed would be wiped by the
 * per-suite resets that tests need for isolation. Each suite seeds through
 * `tests/helpers/fixtures.ts` / `tests/helpers/db.ts` in `beforeAll`/`beforeEach`
 * (`resetDatabase()`). This file guarantees an EMPTY, MIGRATED test DB plus the right env.
 *
 * WHY A BARE `npm install` ALONE IS NOT ENOUGH: `package.json` has no `postinstall` hook and
 * `prisma generate` is a separate script, so a clean checkout has ONLY the `@prisma/client`
 * POSTINSTALL STUB. Every DB-backed suite would then die at IMPORT time with the misleading
 * `@prisma/client did not initialize yet…`. `ensurePrismaClientGenerated()` (shared with the E2E
 * harness) self-bootstraps the client here before anything imports it.
 *
 * FAIL-LOUD BY DESIGN: a provisioning/generate failure THROWS with the FULL captured CLI output
 * (never a `console.warn` that lets the run continue). Letting the run continue would surface the
 * failure later as the far more confusing
 * `The table main.X does not exist in the current database.` and hide the real reason.
 *
 * HOW THIS FILE IS WIRED (root-owned config — escalate to root, do NOT edit from here):
 *   `vitest.config.ts` MUST add   `test.setupFiles: ['tests/setup.ts']`.
 *   Optionally also   `test.env: { LLM_MODE: 'mock' }`   (belt-and-braces; this file sets it too).
 *
 * PREREQUISITES:
 *   - `npm install` (prisma CLI + engines available; this file generates the client for you).
 *
 * ENV ESCAPES:
 *   - `VITEST_SKIP_DB_SETUP=1` → skip client generation AND schema provisioning entirely, so a
 *     pure-unit run needs no database at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  cliCommand,
  ensurePrismaClientGenerated,
  removeSqliteFiles,
  resolvePrismaBin,
  runCliStep,
} from './helpers/prisma-cli';

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

  // (a) Self-bootstrap the Prisma Client on a clean checkout (cheap no-op once generated): a bare
  //     `npm install` leaves only the stub, which makes every DB-backed suite throw at import time.
  ensurePrismaClientGenerated(repoRoot, process.env);

  if (isProvisioned()) return; // schema unchanged & DB present — another worker already provisioned

  mkdirSync(prismaDir, { recursive: true });
  // (b) Start from a CLEAN SLATE. `--force-reset` cannot reliably re-reset an existing WAL-mode
  //     SQLite file (Prisma's reset step fails with "Error code 11: The database disk image is
  //     malformed"), and the fast-path pragmas in `tests/helpers/db.ts` keep `test.db` permanently
  //     in WAL mode. Removing the DB file and its -wal/-shm/-journal sidecars guarantees the push
  //     below recreates the schema from scratch.
  removeSqliteFiles(prismaDir, ['test.db', 'test.db-wal', 'test.db-shm', 'test.db-journal']);
  // `--force-reset` drops any stale data; `--skip-generate` keeps this a pure schema push (the client
  // was already generated above). A failure THROWS with the FULL captured CLI output — never a warn.
  const push = cliCommand(resolvePrismaBin(repoRoot), [
    'prisma',
    'db',
    'push',
    '--force-reset',
    '--skip-generate',
  ]);
  runCliStep(push.command, push.args, { cwd: repoRoot, env: process.env });
  markProvisioned();
}

provisionTestDatabase();

// Runtime-only pool constraint (applied AFTER the CLI push above, which used the clean URL).
// A single SQLite connection keeps the per-connection `PRAGMA synchronous=NORMAL` from
// `tests/helpers/db.ts` authoritative for EVERY query, so no pooled connection falls back to
// synchronous=FULL and stalls a write. The Prisma CLI ignores unknown query params; the runtime
// client honours `connection_limit`.
process.env.DATABASE_URL = testDbUrl + '?connection_limit=1';
export { testDbUrl, testDbPath };
