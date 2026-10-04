/**
 * Scoped Vitest config for the `banking-sdk` atomicity regression spec.
 *
 * WHY a dedicated config: the repo-wide `vitest.config.ts` collects only `tests/**`, but this
 * agent may write ONLY inside its own node (`./banking-sdk`) — the shared test tree (`./tests`)
 * is a read-only sibling. This config lets the in-node `atomicity.test.ts` run against the same
 * test database + setup as the standard suite, without touching that shared tree.
 *
 * Run:  npx vitest run --config banking-sdk/vitest.atomicity.config.ts
 * (Deliberately NOT auto-discovered: `include` is scoped to this node, so `npm run test` — which
 *  uses the root `vitest.config.ts` — is unaffected.)
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const repoRoot = path.resolve(__dirname, '..');

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      '@': repoRoot,
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // Scoped to this node only (the shared suite keeps using the root config).
    include: ['banking-sdk/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    // The test DB is one shared SQLite file reset per test → run files sequentially.
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
