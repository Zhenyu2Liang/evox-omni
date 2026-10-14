/**
 * tests/setup.ts — Vitest global setup (registered via `setupFiles`).
 *
 * INFRASTRUCTURE, not business logic. It makes every suite deterministic and offline by:
 *
 *   1. Pointing `DATABASE_URL` at an isolated **test SQLite** file (`prisma/test.db`,
 *      git-ignored) using an ABSOLUTE path, so the Prisma CLI and the runtime client
 *      (`lib/db/client.ts` → `resolveDatabaseUrl()`) resolve the SAME file.
 *   2. Forcing `LLM_MODE=mock` (the faux provider) so no suite ever touches the network.
 *   3. Guaranteeing a **generated, usable Prisma Client** on a clean checkout, pinning the
 *      **schema-engine log level** (`RUST_LOG=info`, see below), then provisioning the schema
 *      through an ordered ladder of supported Prisma 7 `db push` commands.
 *      Fallbacks run only after a failure. The guard marker stores the
 *      **sha1 of `prisma/schema.prisma`** so parallel workers do not race AND a stale `test.db`
 *      (provisioned before a schema change) is automatically re-pushed instead of silently reused.
 *      Because the fast-path keeps `test.db` in WAL mode (which `--force-reset` cannot re-reset), the
 *      stale DB files are removed before EVERY push rung so it always starts from a clean slate.
 *
 * WHY `RUST_LOG` IS PINNED: Prisma parses the schema engine's stderr as
 * `split(/\r?\n/).slice(1)` — it DROPS line 0, expecting the engine's INFO banner there. An ambient
 * `RUST_LOG` at/above `warn` suppresses that banner, so the engine's ERROR line lands at index 0 and
 * is dropped too: Prisma then reports an EMPTY `Error: Schema engine error:` (destroying even the
 * legitimate `P1003 Database … does not exist` probe that `db push` needs before creating a fresh
 * SQLite file) and a cold-checkout push fails for no real reason. Forcing `RUST_LOG=info` on this
 * process and on every spawned CLI restores the banner. Mechanism:
 * `helpers/prisma-cli.ts#SCHEMA_ENGINE_RUST_LOG`.
 *
 * Fixture SEEDING is intentionally NOT done here — a single global seed would be wiped by the
 * per-suite resets that tests need for isolation. Each suite seeds through
 * `tests/helpers/fixtures.ts` / `tests/helpers/db.ts` in `beforeAll`/`beforeEach`
 * (`resetDatabase()`). This file guarantees an EMPTY, MIGRATED test DB plus the right env.
 *
 * Generation is explicit: a clean checkout has no `lib/db/generated` output.
 * `ensurePrismaClientGenerated()` creates and checks it before application imports run.
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
  ensurePrismaClientGenerated,
  pinSchemaEngineLogging,
  provisionSchemaLadder,
} from './helpers/prisma-cli';

// Pin the Prisma schema engine's log level to `info` BEFORE anything spawns a CLI: an ambient
// `RUST_LOG≥warn` suppresses the engine's INFO banner, which makes Prisma DROP the engine's ERROR
// line and report an EMPTY `Error: Schema engine error:` — breaking cold-start provisioning outright.
// See `prisma-cli.ts#SCHEMA_ENGINE_RUST_LOG` for the full mechanism.
pinSchemaEngineLogging();

const repoRoot = process.cwd();
const prismaDir = path.join(repoRoot, 'prisma');
const schemaPath = path.join(prismaDir, 'schema.prisma');
const testDbPath = path.join(prismaDir, 'test.db');
const provisionMarker = path.join(prismaDir, '.test-db-provisioned');

// ---------------------------------------------------------------------------
// 1. Environment — isolate the database and pin the deterministic offline model.
// ---------------------------------------------------------------------------

// Absolute `file:` URL keeps the Prisma CLI (`prisma db push`) and the runtime client
// (`createDatabaseClient()`) on the exact same file.
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
  // (b) Start from a CLEAN SLATE and provision through the shared ORDERED LADDER
  //     (`prisma-cli.ts#provisionSchemaLadder`). `--force-reset` cannot reliably re-reset an existing
  //     WAL-mode SQLite file (Prisma's reset step fails with "Error code 11: The database disk image
  //     is malformed"), and the fast-path pragmas in `tests/helpers/db.ts` keep `test.db` permanently
  //     in WAL mode — so the ladder deletes `test.db` + its -wal/-shm/-journal sidecars BEFORE EVERY
  //     rung, guaranteeing each push recreates the schema from scratch.
  // Prisma 7 never generates implicitly during db push; generation was checked above.
  // A plain push creates the new isolated file after the harness removed all old files.
  //     Each rung runs ONLY after the previous one FAILED. If EVERY rung fails the ladder THROWS a
  //     single error with the FULL captured output of each rung + environment diagnostics — never a warn.
  provisionSchemaLadder({
    repoRoot,
    dbDir: prismaDir,
    dbFiles: ['test.db', 'test.db-wal', 'test.db-shm', 'test.db-journal'],
    env: process.env,
    rungs: [
      { label: 'db push', args: ['prisma', 'db', 'push'] },
    ],
  });
  markProvisioned();
}

provisionTestDatabase();

// The better-sqlite3 adapter uses one native connection; no connection_limit URL parameter exists.
export { testDbUrl, testDbPath };
