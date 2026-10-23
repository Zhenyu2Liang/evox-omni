/**
 * Snapshot the demo SQLite database before a schema push or a data backfill.
 *
 * WHY the SQLite online backup API instead of a plain file copy: the runtime opens the database with
 * `PRAGMA journal_mode = WAL`, so freshly committed rows can still live in `dev.db-wal`. Copying only
 * `dev.db` can therefore produce a snapshot that is missing committed rows. `sqlite3_backup` reads
 * through the WAL and writes ONE self-contained file, which is exactly what a rollback needs to
 * restore.
 *
 * Destination: `logs/db-backups/<timestamp>-<uuid>-<source file name>`.
 * The directory is created when missing and the command is repeatable.
 * Run with `node scripts/db-backup.mjs`.
 */
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { resolveDatabaseFile } from './database-file.mjs';

/** Repository root, resolved from this script so the command works from any working directory. */
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
/** Snapshots are operational artifacts, so they live under the repository's log directory. */
const BACKUP_DIRECTORY = path.join(REPO_ROOT, 'logs', 'db-backups');

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
  const destination = path.join(BACKUP_DIRECTORY, `${timestamp(new Date())}-${randomUUID()}-${path.basename(source)}`);
  // Exclusive reservation plus a random suffix prevents simultaneous backups from replacing one another.
  closeSync(openSync(destination, 'wx'));

  const database = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(database, destination);
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  } finally {
    database.close();
  }
  writeFileSync(destination + '.json', JSON.stringify({
    source, snapshot: destination, createdAt: new Date().toISOString(),
    restore: 'Stop all database users. Restore this snapshot to source after preserving/removing its WAL and SHM sidecars. Restore the matching code/schema version too.',
  }, null, 2), { flag: 'wx' });

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
