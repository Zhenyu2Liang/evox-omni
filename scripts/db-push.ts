/**
 * `scripts/db-push.ts` — the SUPPORTED deployment entrypoint for `prisma db push`.
 *
 * WHY THIS WRAPPER EXISTS: running `npx prisma db push` (the bare command the deploy docs used to
 * show) against a MISSING SQLite file prints an opaque EMPTY `Error: Schema engine error:` and fails.
 * ROOT CAUSE: Prisma's schema-engine error mapper does `err.split(/\r?\n/).slice(1)` — it DROPS line 0
 * because it expects the engine's `INFO` banner there. An ambient `RUST_LOG` at/above `warn`
 * suppresses that banner, so the mapper also discards the LEGITIMATE line-0 `P1003 database does not
 * exist` that `db push` relies on to create a brand-new SQLite file. Pinning `RUST_LOG=info` restores
 * the banner. Full mechanism: `lib/prisma-cli-env.ts#SCHEMA_ENGINE_RUST_LOG`.
 *
 * This wrapper therefore:
 *   1. pins the schema-engine log level (`pinSchemaEngineLogging()`) BEFORE spawning the CLI,
 *   2. resolves the PROJECT-LOCAL Prisma CLI (`resolvePrismaBin(resolveRepoRoot())`) and runs it with
 *      the SAME Node that runs this script (`cliCommand`), falling back to `npx` only if the local
 *      binary is absent, and
 *   3. passes every extra argument through (`process.argv.slice(2)`, e.g. `--force-reset` for
 *      `npm run db:reset`) and exits with the child's exit code.
 *
 * It self-provisions a MISSING SQLite file (no manual DB creation, no readiness marker, no skip
 * flag): the pinned env makes `db push`'s `P1003` probe survive parsing, so the engine creates the
 * database and applies the schema. Invoked via `npm run db:push` / `npm run db:reset`.
 */
import { spawnSync } from 'node:child_process';
import {
  cliCommand,
  pinSchemaEngineLogging,
  prismaCliEnv,
  resolvePrismaBin,
  resolveRepoRoot,
} from '../lib/prisma-cli-env';

// Pin the schema-engine log level on THIS process, so `process.env` (and therefore the child CLI)
// carries `RUST_LOG=info` even before the explicit per-spawn env below.
pinSchemaEngineLogging();

const repoRoot = resolveRepoRoot();
const invocation = cliCommand(resolvePrismaBin(repoRoot), [
  'prisma',
  'db',
  'push',
  ...process.argv.slice(2),
]);

const result = spawnSync(invocation.command, invocation.args, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: prismaCliEnv(process.env),
});

if (result.error !== undefined && result.error !== null) {
  const code = (result.error as NodeJS.ErrnoException).code;
  console.error(
    `[db:push] 无法启动 Prisma CLI（${invocation.command}）：${result.error.message}` +
      (code === undefined ? '' : `（code=${code}）`),
  );
  process.exit(1);
}

process.exit(result.status ?? 1);
