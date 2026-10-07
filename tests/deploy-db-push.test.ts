/**
 * deploy-db-push.test.ts — REGRESSION spec for the SUPPORTED deployment entrypoint `scripts/db-push.ts`
 * (backing `npm run db:push` / `npm run db:reset`).
 *
 * BUG BEING LOCKED IN: on a MISSING SQLite file, a bare `prisma db push` under an ambient
 * `RUST_LOG≥warn` prints an opaque EMPTY `Error: Schema engine error:` and FAILS instead of creating
 * the database. ROOT CAUSE: Prisma's schema-engine error mapper does
 * `err.split(/\r?\n/).slice(1)` — it DROPS line 0 (expecting the engine's INFO banner there), so with
 * `RUST_LOG≥warn` it also discards the legitimate line-0 `P1003 database does not exist` probe that
 * `db push` relies on. `scripts/db-push.ts` pins `RUST_LOG=info`, which restores the banner.
 *
 * This spec drives the REAL deploy script through `tsx` (the same way `npm run db:push` does) with an
 * ambient `RUST_LOG=warn` and a DELIBERATELY isolated absolute `DATABASE_URL` under `prisma/`, and
 * asserts the cold DB self-provisions (exit 0 + the file appears). The isolated DB and its sidecars
 * are deleted before AND after; the shared `prisma/dev.db` / `test.db` / `e2e.db` are asserted
 * UNTOUCHED so an accidental `.env` override can never slip a shared DB into this run.
 *
 * The `tsx` launcher is resolved EXACTLY as the E2E harness does
 * (`cliCommand(resolveTsxBin(repoRoot), ['tsx', …])`): with the project-local binary that is
 * `process.execPath` + `node_modules/tsx/dist/cli.mjs`, and it degrades to `npx tsx` only when the
 * dependency is merely hoisted ABOVE the repo root (e.g. a linked worktree).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliCommand, removeSqliteFiles, resolveRepoRoot, resolveTsxBin } from './helpers/prisma-cli';

const repoRoot = resolveRepoRoot();
const prismaDir = path.join(repoRoot, 'prisma');

/** A cheap change-detection stamp (`mtimeMs:size`), or `(absent)` when the file does not exist. */
function fileStamp(filePath: string): string {
  try {
    const stat = statSync(filePath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return '(absent)';
  }
}

describe('scripts/db-push.ts — cold deploy under RUST_LOG=warn', () => {
  it(
    'self-provisions a MISSING isolated SQLite file and exits 0',
    () => {
      const tsx = cliCommand(resolveTsxBin(repoRoot), ['tsx', path.join('scripts', 'db-push.ts')]);

      const dbName = `verify-deploy-${process.pid}.db`;
      const dbPath = path.join(prismaDir, dbName);
      const dbUrl = 'file:' + dbPath.split(path.sep).join('/');
      // NEVER one of the shared DB files (dev/test/e2e) — guard against a path mistake.
      const shared = ['dev.db', 'test.db', 'e2e.db'].map((n) => path.join(prismaDir, n));
      expect(shared).not.toContain(dbPath);

      const sidecars = [dbName, `${dbName}-wal`, `${dbName}-shm`, `${dbName}-journal`];
      const sharedStampsBefore = shared.map(fileStamp);

      removeSqliteFiles(prismaDir, sidecars);
      expect(existsSync(dbPath), '隔离库应已删除（起点必须是一个缺失的库）').toBe(false);

      try {
        const result = spawnSync(tsx.command, tsx.args, {
          cwd: repoRoot,
          encoding: 'utf8',
          // Ambient suppression: RUST_LOG=warn is exactly what used to break the cold push.
          env: { ...process.env, RUST_LOG: 'warn', DATABASE_URL: dbUrl },
        });
        const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
        expect(result.error, `无法启动 tsx：${result.error?.message ?? ''}`).toBeUndefined();
        expect(result.status, `db:push 未以 0 退出（RUST_LOG=warn，缺失库）：\n${output}`).toBe(0);
        expect(existsSync(dbPath), `隔离库未被创建：${dbPath}\n${output}`).toBe(true);
      } finally {
        // Shared DBs must be byte-identical: proves the isolated DATABASE_URL was honoured (no .env override).
        expect(shared.map(fileStamp)).toEqual(sharedStampsBefore);
        removeSqliteFiles(prismaDir, sidecars);
      }
      expect(existsSync(dbPath), '隔离库应在用例结束时被清理').toBe(false);
    },
    120_000,
  );
});
