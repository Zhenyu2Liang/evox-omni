import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the planner node's PURE unit tests (`planner/*.test.ts`).
 *
 * These suites are inject-only (they build `PlanDeps` stubs, see `planner/plan-test-harness.ts`):
 * no SQLite, no Prisma client, no network. That is why this config deliberately sets NO
 * `setupFiles` — the root config's `tests/setup.ts` pushes the schema and seeds the shared test
 * database, which these tests never touch.
 *
 * NOTE ON LOCATION: the canonical home for these files is `tests/unit/planner/`. The root
 * `vitest.config.ts` `include` lists only `tests/**` and `agent/**`, and the `planner` node has no
 * write access to `tests/`. The node that owns the root config should add this config's `include`
 * glob (planner test files) to the root `include`, move these files to `tests/unit/planner/` and
 * then delete this config.
 *
 * Run from the repository root:
 *   pnpm exec vitest run --config planner/vitest.config.ts
 */
export default defineConfig({
  root: path.resolve(import.meta.dirname, '..'),
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, '..'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['planner/**/*.test.ts'],
  },
});
