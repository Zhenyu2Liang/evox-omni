import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Runner for the NODE-LOCAL `provider-live.test.ts` spec.
 *
 * The repo-root `vitest.config.ts` only globs `tests/**` (a read-only sibling of this node, off
 * limits for this node's writers), so a node-local spec is not auto-discovered by `npm run test`
 * and the vitest CLI filter alone cannot widen `include`. This config aliases `@` to the repo
 * root and includes exactly this spec:
 *
 *   npx vitest run --config agent/providers/vitest.provider-live.config.ts
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../..'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['agent/providers/provider-live.test.ts'],
    env: { LLM_MODE: 'mock' },
  },
});
