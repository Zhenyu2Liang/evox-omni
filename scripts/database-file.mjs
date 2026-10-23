import path from 'node:path';
import nextEnv from '@next/env';

/** Match prisma.config.ts and the maintenance CLIs without logging environment contents. */
export function resolveDatabaseFile(repoRoot = path.resolve(import.meta.dirname, '..')) {
  nextEnv.loadEnvConfig(repoRoot, false, {
    info() {}, error() { throw new Error('Environment configuration could not be loaded.'); },
  });
  const url = process.env.DATABASE_URL ?? 'file:./dev.db';
  if (!url.startsWith('file:')) throw new Error('A SQLite file URL is required.');
  const filename = url.slice(5).split('?')[0];
  if (!filename || filename === ':memory:') throw new Error('A persistent SQLite database file is required.');
  return path.isAbsolute(filename) ? filename : path.resolve(repoRoot, 'prisma', filename);
}
