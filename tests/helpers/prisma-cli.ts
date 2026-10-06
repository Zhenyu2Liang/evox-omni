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
import { existsSync, readdirSync, rmSync } from 'node:fs';
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

/** Raw outcome of one spawned CLI step (never throws — callers decide how to react). */
export interface CliStepResult {
  /** `true` iff the process exited with code 0. */
  ok: boolean;
  /** Process exit code (`null` when the process could not be spawned or was signalled). */
  status: number | null;
  stdout: string | null;
  stderr: string | null;
  /** Spawn failure (`ENOENT` etc.), or `null` — rendered by `spawnErrorText`. */
  error: Error | null;
}

/**
 * Spawn one CLI step synchronously and return its RAW outcome (stdout/stderr/exit code) WITHOUT
 * throwing. `runCliStep` layers the fail-loud contract on top of this; the provisioning LADDER uses
 * it directly so it can fold EACH rung's complete output (`diagnosticCliOutput`, tail preserved) into
 * one combined failure.
 */
export function runCliStepCaptured(
  command: string,
  args: readonly string[],
  opts: RunCliStepOptions,
): CliStepResult {
  const result = spawnSync(command, [...args], {
    cwd: opts.cwd,
    windowsHide: true,
    encoding: 'utf8',
    env: opts.env ?? process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error ?? null,
  };
}

/**
 * Run one CLI step synchronously in `opts.cwd`; throws with the FULL captured output on failure
 * (success is decided by the EXIT CODE, never by stderr text — the deprecated `package.json#prisma`
 * warning lines are harmless). A failure message carries the complete combined stdout+stderr
 * (`diagnosticCliOutput`, tail preserved) plus any spawn `error` (message + code), so the real reason
 * is never hidden by truncation.
 */
export function runCliStep(command: string, args: readonly string[], opts: RunCliStepOptions): string {
  const result = runCliStepCaptured(command, args, opts);
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (!result.ok) {
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
 * AUTHORITATIVE GATE - the USABILITY probe (`prismaClientUsable`): it requires `@prisma/client` and
 * constructs a `PrismaClient` exactly the way the suites do, so it is true iff the client that will
 * ACTUALLY be required is usable. It is the ONLY reliable signal because Node resolves `@prisma/client`
 * by walking UP the directory tree: in a hoisted layout (a sparse/local `node_modules` whose real deps -
 * `@prisma/client`, `prisma` - live in a PARENT `node_modules`) `prisma generate` writes the client to
 * that PARENT path, so the fixed worktree-local artifact path checked by `prismaClientGenerated` stays
 * absent even though the client resolves and constructs fine. Gating on artifact presence alone would
 * therefore falsely force a generate and then THROW on a healthy worktree.
 *
 * `prismaClientGenerated` (worktree-local artifact presence) is kept only as a NON-authoritative proxy.
 * Post-generate we accept EITHER signal: a clean checkout (stub-only `node_modules`) has a false probe
 * until `generate` runs, and artifact presence then confirms success even if the probe is momentarily
 * flaky - a false-negative probe at most costs a harmless extra generate, never a false failure.
 * `generate` needs no live DB.
 */
export function ensurePrismaClientGenerated(repoRoot: string, env?: NodeJS.ProcessEnv): void {
  if (prismaClientUsable(repoRoot)) return;
  console.log('· 未检测到可用的 Prisma Client → 运行 prisma generate（清理环境自举步骤）');
  runPrismaGenerate(repoRoot, env);
  if (prismaClientUsable(repoRoot) || prismaClientGenerated(repoRoot)) return;
  throw new Error('prisma generate 完成后 Prisma Client 产物仍缺失（见上方完整 CLI 输出）');
}

// ---------------------------------------------------------------------------
// Ordered provisioning ladder (ADDITIVE fallback — the primary rung is unchanged).
// ---------------------------------------------------------------------------

/** One rung of a provisioning ladder: a labelled `prisma db push` invocation shape. */
export interface PushRung {
  /** Human-readable label, e.g. `db push --force-reset --skip-generate` (used in diagnostics). */
  label: string;
  /** FULL CLI args INCLUDING the `prisma` program name, e.g. `['prisma','db','push','--skip-generate']`. */
  args: readonly string[];
  /** Optional pre-step run BEFORE this rung's push (e.g. `prisma generate`). A throw fails the rung. */
  before?: () => void;
}

export interface ProvisionSchemaOptions {
  /** Project root — the cwd for every CLI step and where `node_modules/prisma` is resolved. */
  repoRoot: string;
  /** Directory holding the SQLite file + its `-wal`/`-shm`/`-journal` sidecars. */
  dbDir: string;
  /** SQLite file names (relative to `dbDir`) DELETED, via `removeSqliteFiles`, before EACH rung. */
  dbFiles: readonly string[];
  /** The ORDERED ladder: each rung runs ONLY after the previous rung FAILED. */
  rungs: readonly PushRung[];
  /** Environment for the child processes (defaults to the current `process.env`). */
  env?: NodeJS.ProcessEnv;
  /**
   * Runs AFTER a rung's push SUCCEEDS (e.g. a usability probe + a seed). A throw here is treated
   * EXACTLY like a push failure — the ladder advances to the NEXT rung, never a warn-and-continue.
   */
  afterPush?: (rung: PushRung) => void;
}

/** Safe single-line text for ANY throwable (never a raw stack). */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/**
 * Provision a SQLite schema through an ORDERED LADDER of `prisma db push` invocation shapes.
 *
 * WHY A LADDER: on a clean checkout the AUTOMATIC push can die with an opaque
 * `Error: Schema engine error:` (empty detail) even though a MANUAL plain `prisma db push` (NO flags)
 * succeeds in the very same worktree — the one concrete, evidence-based differentiator is the
 * INVOCATION SHAPE (the automatic paths always pass `--skip-generate` and sometimes `--force-reset`).
 * Rather than guess, the ladder tries the historical PRIMARY shape first (byte-for-byte unchanged) and
 * then, ADDITIVELY and only AFTER a failure, falls back to progressively simpler shapes ending in the
 * flag-less `db push` that is known to succeed where the flagged shapes fail.
 *
 * Mechanics: each rung runs ONLY after the previous one FAILED, and `dbFiles` (+ sidecars) are deleted
 * with `removeSqliteFiles` BEFORE EVERY rung — so `--force-reset` is not required on later rungs (the
 * file is gone; a fresh push is equivalent). A rung whose push SUCCEEDS but whose `afterPush` throws
 * is ALSO treated as failed and the ladder advances.
 *
 * FAIL-LOUD: if EVERY rung fails, a single error is thrown that embeds the FULL captured stdout+stderr
 * of EVERY rung (`diagnosticCliOutput`, tail preserved) PLUS enriched environment diagnostics (the
 * resolved `DATABASE_URL`, the cwd, the project-local Prisma CLI path and whether it exists, a
 * `prisma -v`-style version/engine summary, and the presence of the schema-engine artifacts) — so a
 * future `Schema engine error:` is never opaque again. It NEVER silently continues.
 */
export function provisionSchemaLadder(opts: ProvisionSchemaOptions): void {
  if (opts.rungs.length === 0) throw new Error('provisionSchemaLadder：至少需要一个 rung');
  const attempts: { rung: PushRung; output: string }[] = [];
  for (const rung of opts.rungs) {
    // Optional pre-step (e.g. `prisma generate`) — a throw fails THIS rung and advances the ladder.
    if (rung.before !== undefined) {
      try {
        rung.before();
      } catch (e) {
        attempts.push({ rung, output: `（前置步骤失败）${errorText(e)}` });
        continue;
      }
    }
    removeSqliteFiles(opts.dbDir, opts.dbFiles);
    const push = cliCommand(resolvePrismaBin(opts.repoRoot), rung.args);
    const result = runCliStepCaptured(push.command, push.args, { cwd: opts.repoRoot, env: opts.env });
    if (result.ok) {
      try {
        opts.afterPush?.(rung);
        return;
      } catch (e) {
        attempts.push({
          rung,
          output:
            `（push 成功，但后置步骤失败）${errorText(e)}\n` +
            diagnosticCliOutput(result.stdout, result.stderr),
        });
        continue;
      }
    }
    attempts.push({
      rung,
      output:
        `执行失败（退出码 ${result.status ?? 'null'}）${spawnErrorText(result.error)}：${push.command} ${push.args.join(' ')}\n` +
        diagnosticCliOutput(result.stdout, result.stderr),
    });
  }
  throw new Error(buildProvisionFailure(opts, attempts));
}

/** Assemble the single fail-loud error: every rung's rendered output + the environment diagnostics. */
function buildProvisionFailure(
  opts: ProvisionSchemaOptions,
  attempts: readonly { rung: PushRung; output: string }[],
): string {
  const lines: string[] = [];
  lines.push(
    `数据库 schema 配置失败：已按顺序尝试全部 ${opts.rungs.length} 种 prisma db push 形态，均未成功（fail-loud，绝不静默继续）。`,
  );
  attempts.forEach((attempt, index) => {
    lines.push('');
    lines.push(`=== 尝试 ${index + 1}/${opts.rungs.length}：${attempt.rung.label} ===`);
    lines.push(attempt.output.length > 0 ? attempt.output : '(无输出)');
  });
  lines.push('');
  lines.push('=== 环境诊断上下文 ===');
  lines.push(provisionDiagnostics(opts));
  return lines.join('\n');
}

/** Best-effort environment snapshot so a future `Schema engine error:` is never opaque again. */
function provisionDiagnostics(opts: ProvisionSchemaOptions): string {
  const env = opts.env ?? process.env;
  const lines: string[] = [];
  lines.push(`DATABASE_URL: ${env.DATABASE_URL ?? '(未设置)'}`);
  lines.push(`cwd (repoRoot): ${opts.repoRoot}`);

  const cliPath = resolvePrismaBin(opts.repoRoot);
  lines.push(
    `项目本地 Prisma CLI: ${cliPath ?? '(缺失：node_modules/prisma/build/index.js)'}${cliPath ? '（存在）' : ''}`,
  );
  if (cliPath !== undefined) {
    const version = spawnSync(process.execPath, [cliPath, '-v'], {
      cwd: opts.repoRoot,
      windowsHide: true,
      encoding: 'utf8',
      env,
    });
    const rendered = diagnosticCliOutput(version.stdout, version.stderr);
    lines.push(
      `prisma -v（退出码 ${version.status ?? 'null'}）${spawnErrorText(version.error)}：\n` +
        (rendered.length > 0 ? rendered : '(无输出)'),
    );
  }

  const enginesDir = path.join(opts.repoRoot, 'node_modules', '@prisma', 'engines');
  let enginesText: string;
  if (!existsSync(enginesDir)) {
    enginesText = `(目录不存在：${enginesDir})`;
  } else {
    try {
      const engines = readdirSync(enginesDir).filter((name) => name.startsWith('schema-engine'));
      enginesText = engines.length > 0 ? engines.join(', ') : `(目录存在但无 schema-engine*：${enginesDir})`;
    } catch (e) {
      enginesText = `(读取失败：${errorText(e)})`;
    }
  }
  lines.push(`schema-engine 产物: ${enginesText}`);

  lines.push(
    `目标 DB 文件（相对 ${opts.dbDir}）: ${opts.dbFiles
      .map((name) => `${name}=${existsSync(path.join(opts.dbDir, name)) ? '存在' : '缺失'}`)
      .join(' ')}`,
  );
  return lines.join('\n');
}
