import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Next 15's legacy resolution patch recognizes the bundled CommonJS entry point.
const require = createRequire(import.meta.url);
const { FlatCompat } = require('@eslint/eslintrc');

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  {
    ignores: ['.next/**', 'node_modules/**', 'dist/**', 'coverage/**', '.pnpm-store/**', '.npm-cache/**', 'test-results/**'],
  },
  ...compat.extends('next/core-web-vitals'),
];

export default eslintConfig;
