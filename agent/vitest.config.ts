/**
 * agent/vitest.config.ts — LOCAL Vitest config for the `agent/` node's own specs.
 *
 * WHY THIS EXISTS: the node's own tests live under `./agent/__tests__/` (the node is the only
 * writable area for this workstream), which the ROOT `vitest.config.ts` does not include
 * (`include: ['tests/**']`). Run them with:
 *
 *     npx vitest run --config agent/vitest.config.ts
 *
 * It mirrors the root config EXACTLY (alias `@` → repo root, the shared `tests/setup.ts`, the
 * forced offline `LLM_MODE=mock`, sequential files for the shared SQLite) so the specs run the
 * production agent/security/SDK/DB code with only the model scripted.
 */
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// `tests/setup.ts` resolves the repo root from `process.cwd()`; use the SAME anchor here so the
// `@` alias, the test-DB path and the schema push all agree. (A config-relative `__dirname` would
// wrongly resolve to `agent/` for this nested config.)
const repoRoot = process.cwd();

export default defineConfig({
  resolve: {
    alias: {
      '@': repoRoot,
      // Keep the node-local specifier usable from the `agent/__tests__/` specs.
      '@agent': path.join(repoRoot, 'agent'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['agent/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    // Every DB-backed spec shares ONE SQLite file and resets+seeds it per test; parallel files
    // race that reset (same rationale as the root config).
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
