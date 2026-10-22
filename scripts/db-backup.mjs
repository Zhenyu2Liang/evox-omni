/**
 * Snapshot the demo SQLite database before a schema push or a data backfill.
 *
 * WHY the SQLite online backup API instead of a plain file copy: the runtime opens the database with
 * `PRAGMA journal_mode = WAL`, so freshly committed rows can still live in `dev.db-wal`. Copying only
 * `dev.db` can therefore produce a snapshot that is missing committed rows. `sqlite3_backup` reads
 * through the WAL and writes ONE self-contained file, which is exactly what a rollback needs to
 * restore.
 *
 * Destination: `logs/db-backups/<yyyyMMdd-HHmmss>-<source file name>`.
 * The directory is created when missing and the command is repeatable.
 * Run with `node scripts/db-backup.mjs`.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';

/** Repository root, resolved from this script so the command works from any working directory. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
/** Snapshots are operational artifacts, so they live under the repository's log directory. */
const BACKUP_DIRECTORY = path.join(REPO_ROOT, 'logs', 'db-backups');

/**
 * Resolve the SQLite file the application uses, matching `lib/db/url.ts`: a relative `file:` path is
 * anchored at `prisma/`, and `DATABASE_URL` defaults to `file:./dev.db` → `prisma/dev.db`.
 * The environment file is never read here; only an explicitly exported variable is honored.
 */
function resolveDatabaseFile() {
  const url = process.env.DATABASE_URL ?? 'file:./dev.db';
  if (!url.startsWith('file:')) throw new Error('The banking demo requires a SQLite file URL in DATABASE_URL.');
  const filename = url.slice('file:'.length).split('?')[0];
  if (!filename) throw new Error('The SQLite database file name must not be empty.');
  if (filename === ':memory:') throw new Error('An in-memory database cannot be backed up.');
  return path.isAbsolute(filename) ? filename : path.resolve(REPO_ROOT, 'prisma', filename);
}

/** `yyyyMMdd-HHmmss` in local time, so consecutive snapshots sort chronologically. */
function timestamp(date) {
  const pad = value => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Print a repository-relative path so the output stays stable across machines. */
function display(file) {
  const relative = path.relative(REPO_ROOT, file);
  return relative === '' ? file : relative;
}

async function runBackup() {
  const source = resolveDatabaseFile();
  if (!existsSync(source)) {
    console.error(`[db:backup] Source database not found: ${display(source)}`);
    console.error('[db:backup] Create it with `pnpm db:push` (optionally `pnpm db:seed`) before backing up.');
    return 1;
  }

  mkdirSync(BACKUP_DIRECTORY, { recursive: true });
  const destination = path.join(BACKUP_DIRECTORY, `${timestamp(new Date())}-${path.basename(source)}`);
  // The destination is fully owned by this command: drop a same-second snapshot and its sidecars so
  // the backup starts from an empty file instead of inheriting stale pages.
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(destination + suffix, { force: true });

  const database = new DatabaseSync(source);
  try {
    await backup(database, destination);
  } finally {
    database.close();
  }

  console.log(`[db:backup] Snapshot written: ${display(destination)}`);
  console.log(`[db:backup] Source: ${display(source)}`);
  return 0;
}

try {
  process.exitCode = await runBackup();
} catch (error) {
  console.error(`[db:backup] ${error instanceof Error ? error.message : 'Database backup failed.'}`);
  process.exitCode = 1;
}
