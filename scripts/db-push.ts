/**
 * Synchronize the current demo schema through the project-local Prisma CLI.
 * Load application configuration without displaying values, preserve schema-engine diagnostics
 * for cold database creation, and forward explicit CLI flags. There is no old-schema conversion.
 * Invoked through pnpm db:push or the explicit simulated-data reset command.
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import nextEnv from '@next/env';
const { loadEnvConfig } = nextEnv;
import {
  cliCommand,
  pinSchemaEngineLogging,
  prismaCliEnv,
  resolvePrismaBin,
  resolveRepoRoot,
} from '../lib/prisma-cli-env';

/** An explicit demo reset replaces the SQLite file and its WAL sidecars as one dataset. */
export function resetDemoDatabase(url: string, repoRoot: string): void {
  if (!url.startsWith('file:')) throw new Error('Demo reset requires a SQLite file database.');
  const filename = url.slice('file:'.length).split('?')[0];
  if (!filename || filename === ':memory:') throw new Error('Demo reset requires a persistent SQLite file.');
  const databasePath = path.isAbsolute(filename) ? filename : path.resolve(repoRoot, 'prisma', filename);
  const relative = path.relative(repoRoot, databasePath);
  if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
    throw new Error('Demo reset databases must be inside the current workspace.');
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(databasePath + suffix, { force: true });
}

/** Synchronize the current schema; previous database schemas are unsupported. */
export async function runDatabasePush(): Promise<number> {
  pinSchemaEngineLogging();
  const repoRoot = resolveRepoRoot();
  // Use the application's environment loader without displaying configuration values.
  loadEnvConfig(repoRoot, false, { info: () => undefined, error: () => { throw new Error('Environment configuration could not be loaded.'); } });
  const args = process.argv.slice(2);
  if (args.includes('--force-reset')) {
    resetDemoDatabase(process.env.DATABASE_URL ?? 'file:./dev.db', repoRoot);
  }
  const invocation = cliCommand(resolvePrismaBin(repoRoot), ['prisma', 'db', 'push', ...args]);
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: prismaCliEnv(process.env),
  });
  if (result.error) {
    console.error(`[db:push] Could not start the Prisma CLI: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(resolveRepoRoot(), 'scripts', 'db-push.ts')) {
  void runDatabasePush().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : 'Database deployment failed.');
    process.exitCode = 1;
  });
}
