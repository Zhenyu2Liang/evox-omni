import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Dedicated Vitest config for the `agent/**\/*.test.ts` unit specs (e.g. `agent/grounding.test.ts`).
 *
 * The ROOT `vitest.config.ts` only includes `tests/**`, so agent-local pure-unit specs need this
 * config. It mirrors the root config exactly, only widening `include` to the `agent/` subtree.
 *
 * Run it from the REPO ROOT with an explicit `--config`:
 *   npx vitest run --config ./agent/vitest.agent.config.ts
 * (Running from a linked `node_modules` junction can load a duplicate Vitest and report
 * "No test suite found in file"; repo-root + explicit config avoids that.)
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '..'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['agent/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    // Shares ONE SQLite file (prisma/test.db) with the root suites; run files sequentially.
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
