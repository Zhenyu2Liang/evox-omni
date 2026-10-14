/**
 * Shared test infrastructure for current-schema Prisma clients and isolated SQLite databases.
 * Both Vitest setup and browser acceptance check the actually resolved client before importing it.
 * CLI failures retain diagnostics, and child processes inherit the schema-engine logging policy.
 */
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  cliCommand,
  pinSchemaEngineLogging,
  prismaCliEnv,
  resolvePrismaBin,
  resolveRepoRoot,
  resolveTsxBin,
  SCHEMA_ENGINE_RUST_LOG,
  type CliInvocation,
} from '../../lib/prisma-cli-env';

// Database scripts and test harnesses share the same CLI and environment policy.
export {
  cliCommand,
  pinSchemaEngineLogging,
  resolvePrismaBin,
  resolveRepoRoot,
  resolveTsxBin,
  SCHEMA_ENGINE_RUST_LOG,
};
export type { CliInvocation };

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
    // EVERY spawned CLI (db push / generate / seed) inherits the pinned schema-engine log level, so
    // an ambient `RUST_LOG≥warn` can never suppress the engine's INFO banner again (see the
    // `SCHEMA_ENGINE_RUST_LOG` note above).
    env: prismaCliEnv(opts.env),
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

/** The application imports this explicit generated output, never a node_modules client stub. */
function prismaClientArtifactPaths(repoRoot: string): string[] {
  const dir = path.join(repoRoot, 'lib', 'db', 'generated');
  return [path.join(dir, 'internal', 'class.ts'), path.join(dir, 'client.ts')];
}

/**
 * Preserve schema tokens and quoted strings while ignoring formatting and comments.
 * Prisma also reorders model block attributes; their order does not change the generated client.
 */
function schemaTokens(schema: string): string[] {
  const tokens = schema.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g) ?? [];
  const significant = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const normalized: string[] = [];
  let blockDepth = 0;
  let blockAttributes: string[][] = [];

  for (let index = 0; index < significant.length; index++) {
    const token = significant[index];
    if (blockDepth === 1 && token === '@' && significant[index + 1] === '@') {
      const attribute = significant.slice(index, index + 3);
      let next = index + 3;
      if (significant[next] === '(') {
        let argumentDepth = 0;
        do {
          const argumentToken = significant[next++];
          attribute.push(argumentToken);
          if (argumentToken === '(') argumentDepth++;
          else if (argumentToken === ')') argumentDepth--;
        } while (next < significant.length && argumentDepth > 0);
      }
      blockAttributes.push(attribute);
      index = next - 1;
      continue;
    }
    if (token === '{') blockDepth++;
    else if (token === '}') {
      if (blockDepth === 1) {
        blockAttributes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        normalized.push(...blockAttributes.flat());
        blockAttributes = [];
      }
      blockDepth--;
    }
    normalized.push(token);
  }
  return normalized;
}

/** The resolved generated artifacts must describe the current repository schema. */
export function prismaClientGenerated(repoRoot: string): boolean {
  try {
    const artifacts = prismaClientArtifactPaths(repoRoot);
    if (!artifacts.every(artifact => existsSync(artifact))) return false;
    const inlineSchema = /"inlineSchema"\s*:\s*("(?:\\.|[^"\\])*")/.exec(readFileSync(artifacts[0], 'utf8'))?.[1];
    if (!inlineSchema) return false;
    const generatedSchema: string = JSON.parse(inlineSchema);
    const currentSchema = readFileSync(path.join(repoRoot, 'prisma', 'schema.prisma'), 'utf8');
    return JSON.stringify(schemaTokens(generatedSchema)) === JSON.stringify(schemaTokens(currentSchema));
  } catch {
    return false;
  }
}

/** Verify schema freshness and construction in an isolated process without connecting to a database. */
export function prismaClientUsable(repoRoot: string): boolean {
  if (!prismaClientGenerated(repoRoot)) return false;
  const script = "const {createDatabaseClient}=require('./lib/db/database.ts');const client=createDatabaseClient('file::memory:');void client.$disconnect();";
  const probe = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: repoRoot,
    windowsHide: true,
    encoding: 'utf8',
  });
  return probe.status === 0;
}

/** Generate the TypeScript client without opening or modifying a database. */
export function runPrismaGenerate(repoRoot: string, env?: NodeJS.ProcessEnv): void {
  const generate = cliCommand(resolvePrismaBin(repoRoot), ['prisma', 'generate']);
  runCliStep(generate.command, generate.args, { cwd: repoRoot, env });
}

/** Generate only when the actual installed client is missing, stale or unusable; verify again afterward. */
export function ensurePrismaClientGenerated(repoRoot: string, env?: NodeJS.ProcessEnv): void {
  if (prismaClientUsable(repoRoot)) return;
  console.log('The Prisma Client is missing, stale or unusable. Running prisma generate.');
  runPrismaGenerate(repoRoot, env);
  if (prismaClientUsable(repoRoot)) return;
  throw new Error('Prisma Client generation completed, but the resolved client is unusable or does not match the current schema.');
}

// ---------------------------------------------------------------------------
// Ordered provisioning ladder (ADDITIVE fallback — the primary rung is unchanged).
// ---------------------------------------------------------------------------

/** One rung of a provisioning ladder: a labelled `prisma db push` invocation shape. */
export interface PushRung {
  /** Human-readable label, e.g. `db push --force-reset` (used in diagnostics). */
  label: string;
  /** FULL CLI args INCLUDING the `prisma` program name, e.g. `['prisma','db','push']`. */
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
 * ROOT CAUSE (fixed here): the opaque `Error: Schema engine error:` a clean checkout used to hit was
 * NOT an invocation-shape problem — an ambient `RUST_LOG` at/above `warn` suppresses the schema
 * engine's INFO banner, which makes Prisma's own error mapper discard the engine's ERROR line and
 * report an EMPTY reason (full explanation on {@link SCHEMA_ENGINE_RUST_LOG}). Every spawned rung
 * therefore runs with the log level pinned to `info`, so the banner is always present.
 *
 * WHY THE LADDER IS STILL HERE: the ORDERED fallback remains as clean-checkout hardening for GENUINE
 * invocation-shape differences — the historical PRIMARY shape first (byte-for-byte unchanged) and
 * then, ADDITIVELY and only AFTER a failure, progressively simpler shapes ending in the flag-less
 * `db push`. Rungs are never skipped and no rung may be removed.
 *
 * Mechanics: each rung runs ONLY after the previous one FAILED, and `dbFiles` (+ sidecars) are deleted
 * with `removeSqliteFiles` BEFORE EVERY rung — so `--force-reset` is not required on later rungs (the
 * file is gone; a fresh push is equivalent). A rung whose push SUCCEEDS but whose `afterPush` throws
 * is ALSO treated as failed and the ladder advances.
 *
 * FAIL-LOUD: if EVERY rung fails, a single error is thrown that embeds the FULL captured stdout+stderr
 * of EVERY rung (`diagnosticCliOutput`, tail preserved) PLUS enriched environment diagnostics (the
 * resolved `DATABASE_URL`, the ambient vs pinned `RUST_LOG`, the cwd, the project-local Prisma CLI
 * path and whether it exists, a `prisma -v`-style version/engine summary, and the presence of the
 * schema-engine artifacts) — so a future `Schema engine error:` is never opaque again. A rung that
 * failed with the MASKED-EMPTY engine error additionally gets an explicit explanation
 * (`MASKED_ENGINE_ERROR_HINT`). It NEVER silently continues.
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
        diagnosticCliOutput(result.stdout, result.stderr) +
        (isMaskedSchemaEngineError(result.stdout, result.stderr) ? `\n${MASKED_ENGINE_ERROR_HINT}` : ''),
    });
  }
  throw new Error(buildProvisionFailure(opts, attempts));
}

/**
 * Does the captured CLI output carry the MASKED-EMPTY schema-engine failure — `Schema engine error:`
 * with NOTHING after the colon (no `error_code`, no message)?
 *
 * That empty shape is the signature of the RUST_LOG/banner interaction described on
 * {@link SCHEMA_ENGINE_RUST_LOG}: the engine's real reason was thrown away by Prisma's own error
 * mapper, so nothing downstream can recover it. `provisionSchemaLadder` forces `RUST_LOG=info`, so
 * this should be unreachable — the detector exists purely so a future occurrence is EXPLAINED rather
 * than left as a bare, reason-less `Schema engine error:`.
 */
export function isMaskedSchemaEngineError(stdout: string | null, stderr: string | null): boolean {
  return /Schema engine error:[ \t]*(?:\r?\n|$)/.test(`${stdout ?? ''}\n${stderr ?? ''}`);
}

/** Added to a failing rung's diagnostics when {@link isMaskedSchemaEngineError} fires. */
const MASKED_ENGINE_ERROR_HINT =
  '（提示：Prisma 报出的 schema engine 错误信息为「空」。Prisma 解析引擎 stderr 时会丢弃第 0 行' +
  '（期望它是 INFO 横幅）；当环境变量 `RUST_LOG` ≥ `warn` 时横幅被抑制、ERROR 行落到第 0 行并被丢弃，' +
  '于是只剩空消息。本工具链已在每个 CLI 步骤强制 `RUST_LOG=info`——若此处仍为空，请检查外层进程是否注入了别的 `RUST_LOG`。）';

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
  // The schema-engine log level is the one env knob whose value silently changes Prisma's error
  // reporting, so surface BOTH the ambient value and the pinned value used for spawned CLIs.
  lines.push(
    `RUST_LOG: 环境=${env.RUST_LOG ?? '(未设置)'} → CLI 子进程=${SCHEMA_ENGINE_RUST_LOG}（强制，见 SCHEMA_ENGINE_RUST_LOG）`,
  );

  const cliPath = resolvePrismaBin(opts.repoRoot);
  lines.push(
    `项目本地 Prisma CLI: ${cliPath ?? '(缺失：node_modules/prisma/build/index.js)'}${cliPath ? '（存在）' : ''}`,
  );
  if (cliPath !== undefined) {
    const version = spawnSync(process.execPath, [cliPath, '-v'], {
      cwd: opts.repoRoot,
      windowsHide: true,
      encoding: 'utf8',
      env: prismaCliEnv(env),
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
