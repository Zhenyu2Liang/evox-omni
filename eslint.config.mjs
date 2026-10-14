import { defineConfig, globalIgnores } from 'eslint/config';
import nextPlugin from '@next/eslint-plugin-next';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default defineConfig([
  tseslint.configs.base,
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}', 'lib/**/*.{ts,tsx}'],
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
      // This application does not opt into React Compiler. Enforce hook correctness without
      // requiring compiler-specific ref/effect patterns during this dependency upgrade.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  globalIgnores([
    '.next*/**', 'next-env.d.ts', 'node_modules/**', 'dist/**', 'coverage/**',
    '.pnpm-store/**', '.npm-cache/**', '.vitest/**', '.agents/**', '.codex/**',
    'test-results/**', 'logs/**', 'output/**', 'lib/db/generated/**',
  ]),
]);
