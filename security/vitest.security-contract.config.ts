/**
 * `security/vitest.security-contract.config.ts` — LOCAL Vitest config for the regression contracts
 * that live next to the code they pin (`security/*.test.ts`).
 *
 * WHY A SECOND CONFIG: the root `vitest.config.ts` `include` list is owned by the repository root and
 * only collects `tests/**` and `agent/**`. The security contracts below are deliberately co-located
 * with the security layer, so they need their own collector. This file mirrors the root config
 * EXACTLY (same root, alias, setup file, env, timeouts and sequential file execution) and only widens
 * `include` — it must never become a place to relax determinism.
 *
 * RUN: `pnpm exec vitest run --config security/vitest.security-contract.config.ts`
 *
 * `root` is pinned to the REPOSITORY ROOT (not this directory) because `tests/setup.ts` derives the
 * repo root, the Prisma test DB path and the schema-provisioning marker from `process.cwd()`.
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(import.meta.dirname, '..');

export default defineConfig({
  root: repoRoot,
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      '@': repoRoot,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['security/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    // Every DB-backed suite shares ONE SQLite file (prisma/test.db) and resets+seeds it per test;
    // running files in parallel races that shared reset. Run files sequentially.
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
