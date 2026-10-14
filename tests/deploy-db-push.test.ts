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
import { createRequire } from 'node:module';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliCommand, removeSqliteFiles, resolveRepoRoot, resolveTsxBin } from './helpers/prisma-cli';
import { resetDemoDatabase } from '@/scripts/db-push';

const repoRoot = resolveRepoRoot();
const prismaDir = path.join(repoRoot, 'prisma');
const { DatabaseSync } = createRequire(path.join(repoRoot, 'package.json'))('node:sqlite') as typeof import('node:sqlite');

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
  it('recreates a WAL-mode demo database and seeds a fresh baseline without runtime history', () => {
    const dbName = `verify-reset-${process.pid}.db`;
    const dbPath = path.join(prismaDir, dbName);
    const sidecars = [dbName, `${dbName}-wal`, `${dbName}-shm`, `${dbName}-journal`];
    const shared = ['dev.db', 'test.db', 'e2e.db'].map(name => path.join(prismaDir, name));
    const before = shared.map(fileStamp);
    removeSqliteFiles(prismaDir, sidecars);
    try {
      const initial = new DatabaseSync(dbPath);
      initial.exec('PRAGMA journal_mode = WAL; CREATE TABLE "ResetFixture" ("id" TEXT PRIMARY KEY); INSERT INTO "ResetFixture" VALUES (\'simulated\');');
      expect(initial.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
      initial.close();
      const invocation = cliCommand(resolveTsxBin(repoRoot), ['tsx', path.join('scripts', 'db-push.ts'), '--force-reset']);
      const result = spawnSync(invocation.command, invocation.args, {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `file:${dbPath}`, RUST_LOG: 'warn' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `${result.stdout ?? ''}${result.stderr ?? ''}`).toBe(0);
      const current = new DatabaseSync(dbPath);
      try {
        expect(current.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        expect(current.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get('ResetFixture')).toBeUndefined();
        expect(current.prepare('PRAGMA table_info("InvestmentProduct")').all())
          .toContainEqual(expect.objectContaining({ name: 'annual_yield_rate', type: 'TEXT' }));
      } finally { current.close(); }

      const seedInvocation = cliCommand(resolveTsxBin(repoRoot), ['tsx', path.join('prisma', 'seed.ts')]);
      const seeded = spawnSync(seedInvocation.command, seedInvocation.args, {
        cwd: repoRoot, encoding: 'utf8', env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      });
      expect(seeded.error).toBeUndefined();
      expect(seeded.status, `${seeded.stdout ?? ''}${seeded.stderr ?? ''}`).toBe(0);
      const baseline = new DatabaseSync(dbPath);
      try {
        expect(baseline.prepare('SELECT COUNT(*) AS count FROM "Account"').get()?.count).toBeGreaterThan(0);
        expect(baseline.prepare('SELECT COUNT(*) AS count FROM "Transaction"').get()?.count).toBeGreaterThan(0);
        for (const tableName of [
          'AgentSession', 'AgentRun', 'ModelRequest', 'AgentRunEvent', 'ToolInvocation',
          'AgentTask', 'AgentTaskNode', 'ManualReview', 'PendingAction', 'MfaChallenge',
          'ExecutionReceipt', 'AuthorizationDecision', 'AuditLog', 'SecurityEvent', 'CircuitBreakerState',
        ]) {
          expect(baseline.prepare(`SELECT COUNT(*) AS count FROM "${tableName}"`).get()?.count, tableName).toBe(0);
        }
      } finally { baseline.close(); }
    } finally {
      expect(shared.map(fileStamp)).toEqual(before);
      removeSqliteFiles(prismaDir, [...sidecars, `${dbName}.backup.db`]);
    }
  }, 120_000);

  it('refuses to reset an out-of-workspace or non-file database', () => {
    expect(() => resetDemoDatabase('file:../../outside.db', repoRoot)).toThrow('inside the current workspace');
    expect(() => resetDemoDatabase('file::memory:', repoRoot)).toThrow('persistent SQLite file');
  });

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
