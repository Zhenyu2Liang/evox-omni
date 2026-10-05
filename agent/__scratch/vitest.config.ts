import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../..'),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['agent/__scratch/**/*.{test,spec}.ts'],
    setupFiles: ['tests/setup.ts'],
    env: { LLM_MODE: 'mock' },
    testTimeout: 20000,
    fileParallelism: false,
    hookTimeout: 60000,
  },
});
