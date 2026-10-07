/**
 * `lib/prisma-cli-env.ts` — SHARED Prisma-CLI environment policy + binary-resolution plumbing.
 *
 * WHY THIS EXISTS: every entry point that spawns the Prisma CLI must pin the schema engine's log
 * level to `info` BEFORE it runs, so a CLEAN dev/test DB auto-initializes instead of dying with an
 * opaque EMPTY `Error: Schema engine error:`. Three independent entry points need exactly this:
 *
 *   - the Vitest global setup (`tests/setup.ts` → `prisma/test.db`, run by every `npm run test`),
 *   - the real-browser acceptance harness (`tests/e2e/helpers.ts` → `prisma/e2e.db`, run by
 *     `npx tsx tests/e2e/acceptance.e2e.ts`), and
 *   - the SUPPORTED deployment entrypoint (`scripts/db-push.ts`, wired to `npm run db:push` /
 *     `npm run db:reset`), which is what the README's deploy path drives.
 *
 * All three therefore need:
 *
 *   (a) the schema-engine LOG-LEVEL policy — pinning `RUST_LOG=info` so the engine's INFO banner is
 *       never suppressed and Prisma's own error mapper does not discard the engine's real reason.
 *       See {@link SCHEMA_ENGINE_RUST_LOG} for the full mechanism. This is the ROOT-CAUSE fix for the
 *       opaque `Error: Schema engine error:` on a cold checkout.
 *
 *   (b) generic CLI/binary RESOLUTION helpers — {@link resolveRepoRoot}, {@link resolvePrismaBin},
 *       {@link resolveTsxBin}, {@link cliCommand} — so each call site builds a directly-launchable
 *       invocation for the project-local binary with the SAME Node that runs the caller.
 *
 * Extracting it here keeps the call sites from drifting apart. It uses Node built-ins ONLY (no
 * `vitest`, no `@/` alias, no side effects at import) so the Vitest setup file, the tsx-run E2E
 * harness AND the tsx-run deploy script can all import it unchanged.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** A directly-launchable CLI invocation (`command` + `args`). */
export interface CliInvocation {
  command: string;
  args: string[];
}

/**
 * Project root containing `package.json` + `next.config.mjs`, found by walking up from `startDir`.
 * Falls back to `startDir` when no match is found.
 */
export function resolveRepoRoot(startDir: string = process.cwd()): string {
  let dir = startDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'next.config.mjs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/** Project-local Prisma CLI entry (`node_modules/prisma/build/index.js`), or `undefined` if absent. */
export function resolvePrismaBin(repoRoot: string): string | undefined {
  const bin = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');
  return existsSync(bin) ? bin : undefined;
}

/** Project-local tsx CLI entry (`node_modules/tsx/dist/cli.mjs`), or `undefined` if absent. */
export function resolveTsxBin(repoRoot: string): string | undefined {
  const bin = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return existsSync(bin) ? bin : undefined;
}

/**
 * Build a directly-launchable CLI invocation for `npxArgs` (e.g. `['prisma','db','push']`).
 *
 * PREFERRED — the project-local binary launched with the SAME Node that runs the harness
 * (`<process.execPath> node_modules/…`): no `npx`/`.cmd` shim resolution. FALLBACK (only when the
 * local binary is missing, e.g. a hoisted `node_modules`) — `cmd.exe /d /s /c "npx …"` on Windows
 * (there is no `npx` binary, only `npx.cmd`) / the plain command on POSIX.
 */
export function cliCommand(localBin: string | undefined, npxArgs: readonly string[]): CliInvocation {
  if (localBin !== undefined) return { command: process.execPath, args: [localBin, ...npxArgs.slice(1)] };
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `npx ${npxArgs.join(' ')}`] };
  }
  return { command: npxArgs[0]!, args: [...npxArgs.slice(1)] };
}

// ---------------------------------------------------------------------------
// Schema-engine LOG LEVEL pinning — the ROOT-CAUSE fix for the opaque
// `Error: Schema engine error:` on a cold checkout.
// ---------------------------------------------------------------------------

/**
 * The ONLY schema-engine log level that keeps Prisma's error reporting intact: `info`.
 *
 * WHY THIS MATTERS (this is the root cause of the empty `Error: Schema engine error:`):
 * the Prisma schema engine is a Rust binary that writes a JSON-lines log to stderr whose FIRST line
 * is an INFO banner (`{"level":"INFO",…,"target":"schema_engine"}`) followed by any diagnostic lines
 * (`{"level":"ERROR",…,"error_code":"P1003",…,"target":"schema_engine::logger"}`). Prisma's CLI
 * error mapper (`ape(e)` in `prisma/build/index.js`) parses that stream as
 * `e.split(/\r?\n/).slice(1)` — it DROPS line 0 because it expects the banner there. But the CLI's
 * engine spawn builds the child env as `{ RUST_LOG:"info", RUST_BACKTRACE:"1", ...process.env }`, so
 * an ambient `RUST_LOG` at/above `warn` OVERRIDES the intended `info` default, the engine suppresses
 * its INFO banner, and the ERROR line lands at index 0 — where `slice(1)` throws it away. The parsed
 * message is then empty and the CLI reports a bare `Error: Schema engine error:` with no reason,
 * while the *legitimate* `P1003 Database … does not exist` probe (which `db push` RELIES on before
 * creating a fresh SQLite file) is destroyed — so a cold-checkout push FAILS instead of provisioning.
 *
 * Pinning `RUST_LOG=info` restores the banner, so the ERROR line survives parsing and Prisma behaves
 * exactly as on a clean environment.
 */
export const SCHEMA_ENGINE_RUST_LOG = 'info';

/**
 * Pin {@link SCHEMA_ENGINE_RUST_LOG} (plus a sane `RUST_BACKTRACE`) on `env` — defaulting to
 * `process.env` — MUTATING and returning it.
 *
 * Called once at module load by every entry point that spawns a Prisma CLI (`tests/setup.ts`,
 * `tests/e2e/helpers.ts` and the deployment script `scripts/db-push.ts`) so this process AND every
 * child it spawns (the Prisma CLI, the engine it starts, the Next dev server) inherit the pinned
 * level. A caller that spawns per step additionally re-pins it via {@link prismaCliEnv}, so passing
 * an explicit env object cannot re-introduce the suppression.
 */
export function pinSchemaEngineLogging(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  env.RUST_LOG = SCHEMA_ENGINE_RUST_LOG;
  if (env.RUST_BACKTRACE === undefined) env.RUST_BACKTRACE = '1';
  return env;
}

/**
 * The env for ONE spawned Prisma CLI step: a NEW object containing the ambient env with the
 * schema-engine log level pinned (`RUST_LOG=info`) and `RUST_BACKTRACE` defaulted to `'1'`.
 *
 * Unlike {@link pinSchemaEngineLogging} this does NOT mutate its input — the caller's env object is
 * left untouched.
 */
export function prismaCliEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const base = env ?? process.env;
  return { ...base, RUST_LOG: SCHEMA_ENGINE_RUST_LOG, RUST_BACKTRACE: base.RUST_BACKTRACE ?? '1' };
}
