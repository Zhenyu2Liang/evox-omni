/**
 * lib/db/vitest.staging.config.ts — STAGING test runner (TEMPORARY).
 *
 * The root `vitest.config.ts` restricts `test.include` to `tests/**`, so a repository-scoped
 * spec under `lib/db/repositories/__tests__/` is NOT auto-discovered by the default run. This
 * config lets that spec run in isolation while it still lives inside `lib/db`:
 *
 *     npx vitest run --config lib/db/vitest.staging.config.ts
 *
 * The `root` is pinned to this file's directory (`lib/db`), so `include` / `setupFiles` below
 * are resolved relative to `lib/db`. `@` resolves to the repo root (`lib/db/../..`).
 *
 * REMOVAL: once the root agent RELOCATES `pendingAction.claim.test.ts` to `tests/unit/lib/`
 * (its final home inside the sibling `tests` node, which the default config already covers),
 * DELETE this file — it exists only to bridge that move.
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../..'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['repositories/__tests__/**/*.test.ts'],
    setupFiles: ['../../tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    hookTimeout: 60000,
    // The shared test SQLite file is reset+seeded per test; parallel files would race that
    // reset (same reason the root config sets this false).
    fileParallelism: false,
  },
});
