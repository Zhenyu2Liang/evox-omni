import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Local, DB-free runner for the `./security` node.
 *
 * The ROOT `vitest.config.ts` only discovers `tests/**` (and needs the seeded test SQLite). This
 * node's local spec (`security/_tests/risk-engine-dedup.test.ts`) exercises
 * `computeInFlightTransferTotal` against a hand-written Prisma stub — no SQLite, no seeding, no
 * network, no external setup.
 *
 * Run: `npx vitest run --config security/_vitest.local.config.ts`
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['security/_tests/**/*.test.ts'],
  },
});
