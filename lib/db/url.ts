import path from 'node:path';

/** Resolve file URLs against the schema directory, identically for the CLI and runtime. */
export function resolveDatabaseUrl(url = process.env.DATABASE_URL, repoRoot = process.cwd()): string {
  const value = url ?? 'file:./dev.db';
  if (!value.startsWith('file:')) throw new Error('The banking demo requires a SQLite file URL.');
  const filename = value.slice('file:'.length).split('?')[0];
  if (!filename) throw new Error('The SQLite database filename must not be empty.');
  if (filename === ':memory:') return 'file::memory:';
  return 'file:' + (path.isAbsolute(filename) ? filename : path.resolve(repoRoot, 'prisma', filename));
}
