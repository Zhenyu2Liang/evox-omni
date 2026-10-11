import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/**/*.{test,spec}.ts', 'agent/**/*.{test,spec}.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    // Every DB-backed suite shares ONE SQLite file (prisma/test.db) and resets+seeds it per
    // test; running files in parallel races that shared reset and produces false "Socket
    // timeout" failures. Run files sequentially (queries within a file still parallelize).
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
