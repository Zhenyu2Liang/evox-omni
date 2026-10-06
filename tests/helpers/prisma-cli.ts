/**
 * `tests/helpers/prisma-cli.ts` — SHARED Prisma-CLI plumbing for test infrastructure.
 *
 * WHY THIS EXISTS: two independent entry points must provision an ISOLATED SQLite schema before
 * anything touches it —
 *
 *   - the Vitest global setup (`tests/setup.ts` → `prisma/test.db`, run by every `npm run test`), and
 *   - the real-browser acceptance harness (`tests/e2e/helpers.ts` → `prisma/e2e.db`, run by
 *     `npx tsx tests/e2e/acceptance.e2e.ts`).
 *
 * Both must therefore:
 *
 *   (a) guarantee a GENERATED, usable Prisma Client BEFORE any suite/seed imports `@prisma/client`.
 *       A bare `npm install` leaves ONLY the `@prisma/client` POSTINSTALL STUB on disk (`package.json`
 *       has no `postinstall` hook and `prisma generate` is a separate script), so `node_modules/.prisma/
 *       client` has no `schema.prisma` copy and `new PrismaClient()` throws
 *       `@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.`
 *       Every DB-backed suite then dies at IMPORT time with that misleading message — the real cause
 *       ("the clean checkout never generated the client") is nowhere in the failure.
 *
 *   (b) run their CLI steps (db push / seed) so a failure carries the FULL captured stdout+stderr. A
 *       bare `Error: Schema engine error:` must never hide the engine's real reason, and provisioning
 *       must NEVER silently warn-and-continue (a swallowed failure shows up later as the far more
 *       confusing `The table main.X does not exist in the current database.`).
 *
 * Extracting it here keeps the two call sites from drifting apart. It uses Node built-ins ONLY (no
 * `vitest`, no `@/` alias) so both the Vitest setup file and the tsx-run E2E harness can import it.
 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

/** Delete SQLite files (a missing file is not an error) — `names` are relative to `dir`. */
export function removeSqliteFiles(dir: string, names: readonly string[]): void {
  for (const name of names) {
    try {
      rmSync(path.join(dir, name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

/**
 * Upper bound (characters) on the combined CLI output embedded in a failure message.
 *
 * Generous on purpose: the REAL Prisma diagnostics (schema-engine reason, DB lock, malformed image)
 * are usually printed LAST, so the failure message must NEVER be a head-only slice that hides the
 * tail. When the output exceeds this cap BOTH ends are kept (`<head>…<tail>`), so the root cause is
 * always visible.
 */
const CLI_OUTPUT_CAP = 16_000;

/** Render a spawn failure (`result.error`) with its message AND error code, or `''` when there is none. */
export function spawnErrorText(error: Error | null | undefined): string {
  if (!error) return '';
  const code = (error as NodeJS.ErrnoException).code;
  const codePart = code === undefined ? '' : ` code=${code}`;
  return `（无法启动进程：${error.message}${codePart}）`;
}

/**
 * Render a failed CLI step's FULL captured stdout+stderr for diagnosis.
 *
 * The two streams are labelled (`stdout` / `stderr`) and the WHOLE output is included — Prisma writes
 * the real engine reason to stderr, frequently at the TAIL, so slicing to the last N characters hid
 * exactly the line needed to diagnose the failure. Only when the combined output exceeds
 * `CLI_OUTPUT_CAP` is a middle section elided — and even then BOTH the head and the tail are
 * preserved, so no diagnostic is ever lost from the tail.
 */
export function diagnosticCliOutput(stdout: string | null, stderr: string | null): string {
  const sections: string[] = [];
  const out = (stdout ?? '').trim();
  const err = (stderr ?? '').trim();
  if (out.length > 0) sections.push(`--- stdout ---\n${out}`);
  if (err.length > 0) sections.push(`--- stderr ---\n${err}`);
  const combined = sections.join('\n');
  if (combined.length <= CLI_OUTPUT_CAP) return combined;
  const half = Math.floor(CLI_OUTPUT_CAP / 2);
  const head = combined.slice(0, half);
  const tail = combined.slice(combined.length - half);
  return `${head}\n…[中间省略 ${combined.length - 2 * half} 字符]…\n${tail}`;
}

export interface RunCliStepOptions {
  cwd: string;
  /** Environment for the child process (defaults to the current `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Run one CLI step synchronously in `opts.cwd`; throws with the FULL captured output on failure
 * (success is decided by the EXIT CODE, never by stderr text — the deprecated `package.json#prisma`
 * warning lines are harmless). A failure message carries the complete combined stdout+stderr
 * (`diagnosticCliOutput`, tail preserved) plus any spawn `error` (message + code), so the real reason
 * is never hidden by truncation.
 */
export function runCliStep(command: string, args: readonly string[], opts: RunCliStepOptions): string {
  const result = spawnSync(command, [...args], {
    cwd: opts.cwd,
    windowsHide: true,
    encoding: 'utf8',
    env: opts.env ?? process.env,
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    const spawnError = spawnErrorText(result.error);
    throw new Error(
      `执行失败（退出码 ${result.status ?? 'null'}）${spawnError}：${command} ${args.join(' ')}\n` +
        diagnosticCliOutput(result.stdout, result.stderr),
    );
  }
  return out;
}

/**
 * Absolute paths a SUCCESSFUL `prisma generate` writes into the generated Prisma Client
 * (`node_modules/.prisma/client`). The `@prisma/client` POSTINSTALL STUB that a bare `npm install`
 * leaves behind ships the runtime files but NOT the `schema.prisma` copy, so requiring ALL of them is
 * a reliable on-disk "the client is generated" signal.
 */
function prismaClientArtifactPaths(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'node_modules', '.prisma', 'client');
  return [path.join(dir, 'schema.prisma'), path.join(dir, 'index.js'), path.join(dir, 'default.js')];
}

/** Are the generated Prisma Client ARTIFACTS all present on disk? */
export function prismaClientGenerated(repoRoot: string): boolean {
  return prismaClientArtifactPaths(repoRoot).every((p) => existsSync(p));
}

/**
 * Does the generated Prisma Client actually CONSTRUCT? A throwaway Node process requires
 * `@prisma/client` and instantiates `PrismaClient` (which never CONNECTS — construction only).
 * The postinstall stub throws `@prisma/client did not initialize yet…`, so this is the real
 * "usable, not a stub" probe — artifact presence alone cannot detect a partially-provisioned client.
 */
export function prismaClientUsable(repoRoot: string): boolean {
  const script = "const {PrismaClient}=require('@prisma/client');new PrismaClient();";
  const probe = spawnSync(process.execPath, ['-e', script], {
    cwd: repoRoot,
    windowsHide: true,
    encoding: 'utf8',
  });
  return probe.status === 0;
}

/** Run `prisma generate` — materialises the Client + its engine artifacts — via the shared CLI path. */
export function runPrismaGenerate(repoRoot: string, env?: NodeJS.ProcessEnv): void {
  const generate = cliCommand(resolvePrismaBin(repoRoot), ['prisma', 'generate']);
  runCliStep(generate.command, generate.args, { cwd: repoRoot, env });
}

/**
 * Ensure a GENERATED, usable Prisma Client exists before any DB step needs it.
 *
 * WHY: the repo-root `package.json` has NO `postinstall` hook and `prisma generate` is a SEPARATE
 * script (`db:generate`), so a clean `npm install`-only checkout leaves `node_modules/.prisma/client`
 * holding ONLY the `@prisma/client` stub, whose `PrismaClient` throws
 * `@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.`
 * The provisioning pushes below run with `--skip-generate` (they deliberately skip generation), so the
 * client (and the seed, which imports `@prisma/client`) would then be broken and every DB-backed suite
 * would fail as an infrastructure error — exactly the bug this guards against.
 *
 * Robustness: skips ONLY when the generated artifacts are present AND the client actually constructs
 * (`prismaClientUsable`), so a partially-provisioned or stale `node_modules` self-heals by (re)running
 * `prisma generate`. After generating, artifact presence is the HARD gate (a flaky probe can at most
 * trigger a harmless extra generate, never a false failure). `generate` needs no live DB.
 */
export function ensurePrismaClientGenerated(repoRoot: string, env?: NodeJS.ProcessEnv): void {
  if (prismaClientGenerated(repoRoot) && prismaClientUsable(repoRoot)) return;
  console.log('· 未检测到可用的 Prisma Client → 运行 prisma generate（清理环境自举步骤）');
  runPrismaGenerate(repoRoot, env);
  if (!prismaClientGenerated(repoRoot)) {
    throw new Error('prisma generate 完成后 Prisma Client 产物仍缺失（见上方完整 CLI 输出）');
  }
}
