/**
 * `tests/e2e/helpers.ts` — shared harness for the REAL-BROWSER acceptance suite.
 *
 * This node (`tests/e2e`) is a self-contained, real-browser end-to-end harness: it boots the actual
 * Next.js dev server on a free port, launches the machine's real headless Chrome via
 * `playwright-core`, drives the real `/agent` UI, and asserts on RENDERED DOM. Only the model is
 * scripted (`LLM_MODE=mock`); the app, route handlers, security gateway, banking SDK and SQLite DB
 * are the real ones.
 *
 * Design notes:
 *  - No `@/` alias (relative imports / node built-ins only) to avoid tsx path-resolution surprises.
 *  - Every file under `tests/e2e/` is type-checked by `tsc --noEmit` (tsconfig `include: **\/*.ts`),
 *    so Playwright objects are typed from `playwright-core`.
 *  - These files MUST NOT carry `.test.`/`.spec.` in their name (vitest's include glob is
 *    `tests/**\/*.{test,spec}.ts`), so this harness never runs under `npm run test`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Browser, Locator, Page } from 'playwright-core';

/** Generous default for DOM waits (Next dev client hydration can lag on a cold compile). */
export const DEFAULT_TIMEOUT_MS = 45_000;
/** Navigation timeout — the first `/agent` request can trigger a 60s+ dev-server compile. */
export const NAV_TIMEOUT_MS = 180_000;

/** The repository root (contains `package.json` + `next.config.mjs`), found by walking up from cwd. */
export const REPO_ROOT = resolveRepoRoot();
/** Scratch dir for failure screenshots (git-ignored — never committed). */
export const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'tests', 'e2e', 'screenshots');

/** Absolute path to the project root, resolved from `process.cwd()` by locating `next.config.mjs`. */
function resolveRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'next.config.mjs'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Resolve after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Safe single-line text for ANY throwable (never a raw stack). */
export function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// --- structured reporter ------------------------------------------------------------------------

/** Prints exactly one `PASS|FAIL|SKIP <journey> — <evidence>` line per journey; counts failures. */
export interface Reporter {
  pass(name: string, evidence: string): void;
  fail(name: string, reason: string): void;
  skip(name: string, reason: string): void;
  readonly passes: number;
  readonly failures: number;
  readonly skips: number;
}

export function createReporter(): Reporter {
  let passes = 0;
  let failures = 0;
  let skips = 0;
  const line = (status: string, name: string, detail: string) => {
    console.log(`${status} ${name} — ${detail}`);
  };
  return {
    pass(name, evidence) {
      passes += 1;
      line('PASS', name, evidence);
    },
    fail(name, reason) {
      failures += 1;
      line('FAIL', name, reason);
    },
    skip(name, reason) {
      skips += 1;
      line('SKIP', name, reason);
    },
    get passes() {
      return passes;
    },
    get failures() {
      return failures;
    },
    get skips() {
      return skips;
    },
  };
}

/** Run one journey, translating any throw into a `FAIL` line. Returns the evidence string. */
export async function runJourney(
  reporter: Reporter,
  name: string,
  fn: (browser: Browser) => Promise<string>,
): Promise<void> {
  try {
    reporter.pass(name, await fn(browserRefOrThrow()));
  } catch (e) {
    reporter.fail(name, errText(e));
  }
}

// The journey runner needs the shared browser handle; the entry script sets it via `setActiveBrowser`.
let activeBrowser: Browser | undefined;
/** Register the shared browser handle used by `runJourney`. */
export function setActiveBrowser(browser: Browser | undefined): void {
  activeBrowser = browser;
}
function browserRefOrThrow(): Browser {
  if (!activeBrowser) throw new Error('浏览器尚未启动');
  return activeBrowser;
}

// --- generic polling ----------------------------------------------------------------------------

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  /** Human description used in the timeout error (e.g. "MFA 卡片"). */
  description: string;
}

/**
 * Poll `predicate` until it returns a truthy value, then return it. Throws a descriptive error on
 * timeout. Wait on real DOM/state conditions — never a fixed sleep.
 */
export async function waitFor<T>(
  predicate: () => Promise<T | false | null | undefined>,
  opts: WaitOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (e) {
      lastError = e;
    }
    if (Date.now() > deadline) {
      const suffix = lastError === undefined ? '' : `（最后错误：${errText(lastError)}）`;
      throw new Error(`等待超时（${timeoutMs}ms）：${opts.description}${suffix}`);
    }
    await sleep(intervalMs);
  }
}

// --- free port + dev server ---------------------------------------------------------------------

/** Pick a free TCP port at runtime (bind :0, read the assigned port, close). */
export async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('无法获取空闲端口')));
      }
    });
  });
}

/** A booted `next dev` server on a free port. */
export interface DevServer {
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number;
  /** Bounded tail of the dev-server stdout/stderr (for diagnostics). */
  output(): string;
  /** Kill the whole process tree (idempotent, synchronous — safe from `process.on('exit')`). */
  stop(): void;
}

/** Kill a process and its descendants. Windows needs `taskkill /T`; POSIX uses the process group. */
export function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Project-local Next CLI entry (`node_modules/next/dist/bin/next`), or `undefined` if absent. */
function resolveNextBin(): string | undefined {
  const bin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  return existsSync(bin) ? bin : undefined;
}

/**
 * The command that boots Next dev.
 *
 * PREFERRED — the project-local Next CLI launched with the SAME Node that runs this harness
 * (`<process.execPath> node_modules/next/dist/bin/next dev -p <port>`): no `npx`/shell shim
 * resolution, no `.cmd` re-serialization, and identical behaviour on Windows and POSIX. This is the
 * reliable direct-binary invocation (both `node_modules/.bin/next*` shims and `npx` were flaky here:
 * an EMPTY stdout pipe / never-ready server).
 *
 * FALLBACK (only when the local binary is missing) — `cmd.exe /d /s /c "npx next dev -p <port>"` on
 * Windows (there is no `npx` binary, only `npx.cmd`) / `npx next dev -p <port>` on POSIX. We
 * deliberately do NOT use Node's `shell: true`: `shell:true` + args re-serialization produced the
 * empty stdout pipe in this environment.
 */
function devServerCommand(port: number): { command: string; args: string[] } {
  const nextBin = resolveNextBin();
  if (nextBin !== undefined) {
    return { command: process.execPath, args: [nextBin, 'dev', '-p', String(port)] };
  }
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `npx next dev -p ${port}`] };
  }
  return { command: 'npx', args: ['next', 'dev', '-p', String(port)] };
}

/**
 * Boot Next dev detached (its own process group/tree, so it can be killed whole). Both stdout and
 * stderr are captured into a bounded tail (exposed via `output()`) for diagnostics. Starts the
 * process only — callers must `waitForAppReady` before driving the UI.
 */
export function startDevServer(port: number): DevServer {
  const { command, args } = devServerCommand(port);
  const child: ChildProcess = spawn(command, args, {
    cwd: REPO_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      // Isolate the app from the shared `prisma/dev.db` — see `useIsolatedDatabase`/`E2E_DB_URL`.
      DATABASE_URL: process.env['DATABASE_URL'] ?? E2E_DB_URL,
    },
  });

  const pid = child.pid;
  if (pid === undefined) throw new Error('无法启动 next dev（未获得 pid）');

  let log = '';
  const append = (chunk: Buffer | string) => {
    log = (log + chunk.toString()).slice(-16_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (e) => append(`[spawn error] ${e.message}\n`));

  let stopped = false;
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    pid,
    output: () => log,
    stop() {
      if (stopped) return;
      stopped = true;
      killProcessTree(pid);
      try {
        child.unref();
      } catch {
        /* non-fatal */
      }
    },
  };
}

/** True when `/api/health` returned the frozen `{ ok:true, data:{ status:'ok' } }` envelope. */
function isHealthOk(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  if (record.ok !== true) return false;
  const data = record.data;
  return Boolean(data && typeof data === 'object' && (data as Record<string, unknown>).status === 'ok');
}

/** One readiness probe of `GET /api/health`; returns a failure detail, or `undefined` when ready. */
async function probeHealth(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return `HTTP ${res.status}`;
    const body: unknown = await res.json();
    return isHealthOk(body) ? undefined : `非预期响应体：${JSON.stringify(body).slice(0, 160)}`;
  } catch (e) {
    return errText(e);
  }
}

/** One readiness probe of `GET /agent` (SSR chat page must return 200 with the composer markup). */
async function probeAgentPage(baseUrl: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseUrl}/agent`, { headers: { Accept: 'text/html' } });
    if (!res.ok) return `HTTP ${res.status}`;
    const html = await res.text();
    return html.includes('描述你的需求') ? undefined : '/agent 未返回聊天输入框标记';
  } catch (e) {
    return errText(e);
  }
}

/**
 * Poll `GET <baseUrl>/api/health` until it reports `{ ok:true, data:{ status:'ok' } }`.
 * Generous default timeout — the first request triggers Next dev's cold compile.
 */
export async function waitForHealth(baseUrl: string, opts: { timeoutMs?: number; output?: () => string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? NAV_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let last = '尚无响应';
  for (;;) {
    const detail = await probeHealth(baseUrl);
    if (detail === undefined) return;
    last = detail;
    if (Date.now() > deadline) {
      const tail = opts.output ? ` ｜ dev-server 输出尾部：${opts.output().slice(-800)}` : '';
      throw new Error(`/api/health 未就绪（${timeoutMs}ms）：${last}${tail}`);
    }
    await sleep(500);
  }
}

/**
 * Wait until BOTH `/api/health` reports ready AND `GET /agent` serves the chat UI. Health alone can
 * be ready while the first `/agent` compile is still in flight, so the harness drives the UI only
 * once the page itself is being served. Waits on real HTTP responses — never a fixed sleep.
 */
export async function waitForAppReady(
  baseUrl: string,
  opts: { timeoutMs?: number; output?: () => string } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? NAV_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let healthOk = false;
  let pageOk = false;
  let healthDetail = '尚无响应';
  let pageDetail = '尚未请求';
  for (;;) {
    if (!healthOk) {
      const detail = await probeHealth(baseUrl);
      if (detail === undefined) healthOk = true;
      else healthDetail = detail;
    }
    if (healthOk && !pageOk) {
      const detail = await probeAgentPage(baseUrl);
      if (detail === undefined) pageOk = true;
      else pageDetail = detail;
    }
    if (healthOk && pageOk) return;
    if (Date.now() > deadline) {
      const missing = !healthOk ? `/api/health（${healthDetail}）` : `/agent（${pageDetail}）`;
      const tail = opts.output ? ` ｜ dev-server 输出尾部：${opts.output().slice(-800)}` : '';
      throw new Error(`应用未就绪（${timeoutMs}ms）：${missing}${tail}`);
    }
    await sleep(500);
  }
}

/**
 * Boot Next dev and wait for FULL readiness (`/api/health` + `/agent`). On failure the process tree is
 * killed and the boot is retried ONCE on a fresh port; when every attempt fails the captured
 * dev-server log tail is printed and a descriptive error is thrown (the entry script then FAILs every
 * journey and exits non-zero — never a silent pass).
 */
export async function bootDevServer(opts: { timeoutMs?: number; attempts?: number } = {}): Promise<DevServer> {
  const attempts = opts.attempts ?? 2;
  let lastError: unknown;
  let lastLog = '';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const port = await pickFreePort();
    const server = startDevServer(port);
    try {
      await waitForAppReady(server.baseUrl, { timeoutMs: opts.timeoutMs, output: server.output });
      return server;
    } catch (e) {
      lastError = e;
      lastLog = server.output();
      server.stop();
      console.error(`· next dev 启动失败（第 ${attempt}/${attempts} 次，port=${port}）：${errText(e)}`);
      if (attempt < attempts) await sleep(1500);
    }
  }
  console.error(`· next dev 启动最终失败，dev-server 日志尾部：\n${lastLog.slice(-2000)}`);
  throw new Error(`next dev 启动失败（已重试 ${attempts} 次）：${errText(lastError)}`);
}

// --- deterministic fixture state -----------------------------------------------------------------

/**
 * The ISOLATED E2E SQLite file + its WAL/SHM/journal sidecars, relative to the project's `prisma/`
 * dir. The harness NEVER touches the shared `prisma/dev.db` — every E2E run gets its own database.
 */
const E2E_DB_FILES = ['e2e.db', 'e2e.db-wal', 'e2e.db-shm', 'e2e.db-journal'] as const;

/**
 * Absolute `file:` URL for the ISOLATED E2E SQLite DB.
 *
 * Prisma requires FORWARD SLASHES inside a `file:` URL (a Windows `C:\…` backslash path is rejected
 * as invalid), so the OS path is normalised via `split(path.sep).join('/')`. `REPO_ROOT` is absolute,
 * so the result is absolute on both Windows (`file:D:/…/prisma/e2e.db`) and POSIX
 * (`file:/…/prisma/e2e.db`).
 */
export const E2E_DB_URL = `file:${path.join(REPO_ROOT, 'prisma', 'e2e.db').split(path.sep).join('/')}`;

/**
 * Point this process — and EVERYTHING it spawns (the provisioning CLIs via `runCliStep`, the dev
 * server via `startDevServer`) — at the ISOLATED E2E DB by setting `process.env.DATABASE_URL`.
 *
 * `lib/db/client.ts` reads `process.env.DATABASE_URL` FIRST (only falling back to `prisma/dev.db`),
 * and Next dev does NOT override an already-set `process.env` value with `.env`, so this reliably
 * isolates every E2E run from the shared dev database. Returns the URL (for logging).
 */
export function useIsolatedDatabase(): string {
  process.env['DATABASE_URL'] = E2E_DB_URL;
  return E2E_DB_URL;
}

/** Synchronous sleep — the reset runs BEFORE any async work, so it cannot `await`. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Project-local Prisma CLI entry (`node_modules/prisma/build/index.js`), or `undefined` if absent. */
function resolvePrismaBin(): string | undefined {
  const bin = path.join(REPO_ROOT, 'node_modules', 'prisma', 'build', 'index.js');
  return existsSync(bin) ? bin : undefined;
}

/** Project-local tsx CLI entry (`node_modules/tsx/dist/cli.mjs`), or `undefined` if absent. */
function resolveTsxBin(): string | undefined {
  const bin = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  return existsSync(bin) ? bin : undefined;
}

/**
 * Build a directly-launchable CLI invocation for `npxArgs` (e.g. `['prisma','db','push']`).
 *
 * PREFERRED — the project-local binary launched with the SAME Node that runs this harness
 * (`<process.execPath> node_modules/…`): no `npx`/`.cmd` shim resolution. FALLBACK (only when the
 * local binary is missing, e.g. a hoisted `node_modules`) — `cmd.exe /d /s /c "npx …"` on Windows
 * (there is no `npx` binary, only `npx.cmd`) / the plain command on POSIX.
 */
function cliCommand(localBin: string | undefined, npxArgs: readonly string[]): { command: string; args: string[] } {
  if (localBin !== undefined) return { command: process.execPath, args: [localBin, ...npxArgs.slice(1)] };
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `npx ${npxArgs.join(' ')}`] };
  }
  return { command: npxArgs[0]!, args: [...npxArgs.slice(1)] };
}

/** Run one CLI step synchronously in the project root; throws with the captured output on failure. */
function runCliStep(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    cwd: REPO_ROOT,
    windowsHide: true,
    encoding: 'utf8',
    // Provision the ISOLATED E2E DB — never the shared dev DB (see `useIsolatedDatabase`/`E2E_DB_URL`).
    env: { ...process.env, DATABASE_URL: process.env['DATABASE_URL'] ?? E2E_DB_URL },
  });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    const spawnError = result.error ? `（无法启动进程：${result.error.message}）` : '';
    throw new Error(`退出码 ${result.status ?? 'null'}${spawnError}：${out.slice(-800)}`);
  }
  return out;
}

/** Delete a SQLite file + its sidecars (a missing file is not an error). */
function removeSqliteFiles(files: readonly string[]): void {
  for (const name of files) {
    try {
      rmSync(path.join(REPO_ROOT, 'prisma', name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}

/**
 * Absolute path of the marker file a successful `prisma generate` writes into the generated Prisma
 * Client (the schema copy). It is ABSENT from the `@prisma/client` POSTINSTALL STUB that a bare
 * `npm install` leaves behind, so its presence is a reliable "the client is generated" signal.
 */
function prismaClientMarkerPath(): string {
  return path.join(REPO_ROOT, 'node_modules', '.prisma', 'client', 'schema.prisma');
}

/**
 * Ensure the Prisma Client is GENERATED before any DB step needs it.
 *
 * WHY: the repo-root `package.json` has NO `postinstall` hook and `prisma generate` is a SEPARATE
 * script (`db:generate`), so a clean `npm install`-only checkout leaves `node_modules/.prisma/client`
 * holding ONLY the `@prisma/client` stub, whose `PrismaClient` throws
 * `@prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.`
 * The reset below pushes the schema with `--skip-generate` (it deliberately skips generation), so the
 * seed (`tsx prisma/seed.ts`, which imports `@prisma/client`) would then crash and every journey would
 * FAIL as an infrastructure error — exactly the bug this guards against.
 *
 * Runs `prisma generate` ONLY when the generated client is missing (marker absent — see
 * `prismaClientMarkerPath`), so repeat runs on an already-provisioned checkout stay fast. Uses the same
 * project-local CLI invocation (`resolvePrismaBin` + `cliCommand`) and `DATABASE_URL` propagation
 * (`runCliStep`) as the other steps; `generate` needs no live DB, the env is only carried through for
 * consistency.
 */
function ensurePrismaClientGenerated(): void {
  if (existsSync(prismaClientMarkerPath())) return;
  console.log('· 未检测到已生成的 Prisma Client → 运行 prisma generate（清理环境自举步骤）');
  const generate = cliCommand(resolvePrismaBin(), ['prisma', 'generate']);
  runCliStep(generate.command, generate.args);
}

/**
 * One reset attempt: ensure the Prisma Client is generated → delete the ISOLATED E2E DB → create a
 * fresh schema → seed (all against `E2E_DB_URL`).
 */
function resetDemoDatabaseOnce(): void {
  ensurePrismaClientGenerated();
  removeSqliteFiles(E2E_DB_FILES);
  const push = cliCommand(resolvePrismaBin(), ['prisma', 'db', 'push', '--skip-generate']);
  runCliStep(push.command, push.args);
  const seed = cliCommand(resolveTsxBin(), ['tsx', path.join('prisma', 'seed.ts')]);
  runCliStep(seed.command, seed.args);
}

/**
 * Reset the ISOLATED E2E SQLite DB (`prisma/e2e.db`) to the canonical seeded demo state —
 * SYNCHRONOUSLY and BEFORE the dev server boots (no open connection ⇒ no Windows SQLite file-lock).
 * The shared `prisma/dev.db` is NEVER touched.
 *
 * WHY: money-moving journeys are tiered from the FROZEN demo day's accumulated outgoing transfers
 * (`lib/clock.ts` `demoNow()` = 2026-09-25 12:00; `security/risk-engine.ts` ⇒ transfer is YELLOW only
 * while `dayTotal + amount ≤ ¥1000`). Every transfer is stamped with `demoNow()`, so executed
 * transfers ACCUMULATE across harness runs against a persistent DB — a second run would start with
 * the previous run's transfers already inside the day and the YELLOW-transfer journeys would escalate
 * to RED. Resetting gives every run the SAME known starting state.
 *
 * HOW (deliberately NOT `prisma db push --force-reset`): on Windows the force-reset path was observed
 * to leave the SQLite file as a 0-byte image and then fail with `Error code 11: The database disk
 * image is malformed`, aborting the seed. Instead we DELETE the DB file + sidecars, re-create a fresh
 * schema with `db push --skip-generate`, then seed (`tsx prisma/seed.ts`). The Prisma Client is
 * GENERATED first when missing (`ensurePrismaClientGenerated`), so a bare `npm install`-only checkout
 * works without a manual `npx prisma generate`. Every CLI step is given `DATABASE_URL` = `E2E_DB_URL`
 * (see `runCliStep`). The whole attempt is retried ONCE with a short backoff (SQLite on Windows is
 * occasionally lock-prone), and each step's combined stdout+stderr is
 * captured into the thrown error.
 *
 * Set `E2E_SKIP_DB_RESET=1` to keep the current DB (e.g. to inspect post-run data); the journeys then
 * require a freshly seeded DB. Deprecated-`package.json#prisma` warning lines in the captured output
 * are harmless — success is decided by the EXIT CODE, never by stderr text.
 */
export function resetDemoDatabase(opts: { attempts?: number } = {}): void {
  if (process.env['E2E_SKIP_DB_RESET'] === '1') {
    console.log('· 跳过演示数据库重置（E2E_SKIP_DB_RESET=1）');
    return;
  }
  const attempts = opts.attempts ?? 2;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      resetDemoDatabaseOnce();
      return;
    } catch (e) {
      lastError = e;
      console.error(`· 重置演示数据库失败（第 ${attempt}/${attempts} 次）：${errText(e)}`);
      if (attempt < attempts) sleepSync(1200);
    }
  }
  throw new Error(`重置演示数据库失败（已重试 ${attempts} 次）：${errText(lastError)}`);
}

// --- browser factory ----------------------------------------------------------------------------

/** Well-known Windows browser locations (Chrome first, Edge as fallback). */
const CANDIDATE_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** Resolve the real Chrome (or Edge) executable; `E2E_BROWSER_PATH` overrides detection. */
export function resolveBrowserExecutable(): string | undefined {
  const override = process.env['E2E_BROWSER_PATH'];
  if (override && existsSync(override)) return override;
  return CANDIDATE_BROWSER_PATHS.find((candidate) => existsSync(candidate));
}

/** Launch the real headless browser (never downloads browsers; uses the given executable path). */
export function launchBrowser(executablePath: string): Promise<Browser> {
  return chromium.launch({ executablePath, headless: true });
}

export interface WithPageOptions {
  timeoutMs?: number;
  navigationTimeoutMs?: number;
  /** Label used for a failure screenshot. */
  label?: string;
}

let screenshotSeq = 0;

/** Best-effort full-page screenshot into the git-ignored `screenshots/` dir (never throws). */
export async function captureScreenshot(page: Page, label: string): Promise<string | undefined> {
  try {
    mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    screenshotSeq += 1;
    const safe = label.replace(/[^\w.-]+/g, '_').slice(0, 60);
    const file = path.join(SCREENSHOTS_DIR, `${String(screenshotSeq).padStart(2, '0')}-${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

/**
 * Run `fn` with a FRESH browser context (isolated cookies) + one page. The context is always
 * closed. On failure a screenshot is captured and page errors are appended to the error message.
 */
export async function withPage<T>(
  browser: Browser,
  fn: (page: Page) => Promise<T>,
  opts: WithPageOptions = {},
): Promise<T> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(opts.navigationTimeoutMs ?? NAV_TIMEOUT_MS);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  try {
    return await fn(page);
  } catch (e) {
    await captureScreenshot(page, opts.label ?? 'failure');
    if (pageErrors.length > 0) {
      throw new Error(`${errText(e)} ｜ 页面错误：${pageErrors.slice(0, 3).join(' ;; ')}`);
    }
    throw e;
  } finally {
    await context.close().catch(() => undefined);
  }
}

// --- DOM selectors + interactions ---------------------------------------------------------------

/** DOM selectors verified against the real components. */
export const SELECTORS = {
  /** `components/chat/Composer.tsx` — the one chat input. */
  composer: 'textarea[placeholder="描述你的需求，例如：帮我看下这个月的消费"]',
  /** `components/chat/MessageBubble.tsx` — assistant bubble body text (`<p>` in the white bubble). */
  assistantText: 'div.bg-white p.whitespace-pre-wrap',
  /** `components/chat/cards/MfaCard.tsx` — the verification code input. */
  mfaInput: 'input[aria-label="验证码"]',
} as const;

/**
 * Wait until the SSR composer `<textarea>` has been HYDRATED by React.
 *
 * Before hydration the DOM node exists (it is server-rendered) but carries NO React own-property
 * (`__reactProps$…` / `__reactFiber$…`): a `fill()`/click at that instant is silently DROPPED (no
 * `POST /api/chat`) AND React's hydration re-renders the controlled `<textarea>` back to empty
 * (resetting the fill). Waiting for the React own-property key is a real DOM condition — never a
 * fixed sleep — so the first turn is landed deterministically instead of racing hydration.
 */
export async function waitForComposerHydration(page: Page, timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction(
    (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      return Object.keys(el).some(
        (key) => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$'),
      );
    },
    SELECTORS.composer,
    { timeout: timeoutMs },
  );
}

/** Navigate to the chat page and wait for the composer to render AND hydrate (fail-fast on SSR error). */
export async function gotoAgent(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const deadline = Date.now() + NAV_TIMEOUT_MS;
  for (;;) {
    const composer = page.locator(SELECTORS.composer).first();
    if ((await composer.count()) > 0 && (await composer.isVisible().catch(() => false))) break;
    const ssrError = await readSsrPageError(page);
    if (ssrError !== undefined) {
      throw new Error(`/agent 页面渲染失败（应用端 SSR 报错，非测试问题）：${ssrError}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 /agent 聊天输入框超时（${NAV_TIMEOUT_MS}ms）`);
    }
    await sleep(250);
  }
  // The composer is server-rendered; do NOT interact until React has hydrated it (see the helper).
  await waitForComposerHydration(page, Math.max(1, deadline - Date.now()));
}

/**
 * Read the Next dev SSR error message when the page rendered Next's error shell
 * (`<html id="__next_error__">` + `<template data-next-error-message=...>`), else `undefined`.
 * Lets callers fail fast on a broken page instead of waiting the whole DOM timeout.
 */
export async function readSsrPageError(page: Page): Promise<string | undefined> {
  const shell = page.locator('html#__next_error__');
  if ((await shell.count()) === 0) return undefined;
  const template = page.locator('template[data-next-error-message]').first();
  const message =
    (await template.count()) > 0
      ? await template.getAttribute('data-next-error-message').catch(() => null)
      : null;
  return message ?? '页面渲染失败（未知 SSR 错误）';
}

/** Click the first match of `locator` once it exists and is enabled (waits on the real DOM). */
async function clickWhenEnabled(locator: Locator, description: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await waitFor(
    async () => {
      if ((await locator.count()) === 0) return false;
      return (await locator.first().isEnabled()) ? true : false;
    },
    { timeoutMs, description },
  );
  await locator.first().click();
}

/** Type `text` into the composer and submit it (waits for hydration + the input to be free first). */
export async function submitChat(page: Page, text: string, timeoutMs = 60_000): Promise<void> {
  const composer = page.locator(SELECTORS.composer).first();
  await composer.waitFor({ state: 'visible', timeout: timeoutMs });
  // React must have hydrated the controlled <textarea> BEFORE we interact: otherwise the click is
  // dropped and hydration resets the fill (see `waitForComposerHydration`).
  await waitForComposerHydration(page, timeoutMs);
  await waitFor(async () => ((await composer.isEnabled()) ? true : false), {
    timeoutMs,
    description: '聊天输入框可用（上一轮已完成）',
  });
  await composer.fill(text);
  await clickWhenEnabled(page.getByRole('button', { name: '发送', exact: true }), '发送按钮', timeoutMs);
}

/** All rendered assistant message texts (from the assistant message bubbles). */
export async function assistantTexts(page: Page): Promise<string[]> {
  return page.locator(SELECTORS.assistantText).allTextContents();
}

/** Does any rendered assistant message contain `needle`? */
export async function hasAssistantText(page: Page, needle: string): Promise<boolean> {
  const texts = await assistantTexts(page);
  return texts.some((text) => text.includes(needle));
}

/** Wait until an assistant message containing `needle` is rendered. */
export async function waitForAssistantText(page: Page, needle: string, timeoutMs = 60_000): Promise<void> {
  await waitFor(async () => ((await hasAssistantText(page, needle)) ? needle : false), {
    timeoutMs,
    description: `助手消息包含「${needle}」`,
  });
}

/** Wait for a YELLOW/RED confirmation card (its `确认` button) to be visible. */
export async function waitForConfirmCard(page: Page, timeoutMs = 90_000): Promise<void> {
  const confirm = page.getByRole('button', { name: '确认', exact: true });
  await waitFor(async () => ((await confirm.count()) > 0 ? true : false), {
    timeoutMs,
    description: '确认卡片（「确认」按钮）',
  });
  await confirm.first().waitFor({ state: 'visible', timeout: timeoutMs });
}

/** Click the confirmation card's `确认` button. */
export async function clickConfirm(page: Page, timeoutMs = 30_000): Promise<void> {
  await clickWhenEnabled(page.getByRole('button', { name: '确认', exact: true }), '确认按钮', timeoutMs);
}

/** Is an MFA card (verification code input) currently rendered? */
export async function mfaCardPresent(page: Page): Promise<boolean> {
  return (await page.locator(SELECTORS.mfaInput).count()) > 0;
}

/** Wait for the MFA card (`身份验证` + code input) to be visible. */
export async function waitForMfaCard(page: Page, timeoutMs = 90_000): Promise<void> {
  await waitFor(async () => ((await page.locator(SELECTORS.mfaInput).count()) > 0 ? true : false), {
    timeoutMs,
    description: 'MFA 卡片（身份验证 / 验证码输入框）',
  });
  await page.locator(SELECTORS.mfaInput).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

/** Fill the MFA code and click `验证`. */
export async function submitMfa(page: Page, code: string, timeoutMs = 45_000): Promise<void> {
  const input = page.locator(SELECTORS.mfaInput).first();
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  await input.fill(code);
  await clickWhenEnabled(page.getByRole('button', { name: '验证', exact: true }), 'MFA 验证按钮', timeoutMs);
}

/** Wait for the MFA card's `验证` button to be enabled again (the verify round-trip has settled). */
export async function waitForMfaSettled(page: Page, timeoutMs = 45_000): Promise<void> {
  await waitFor(
    async () => {
      const button = page.getByRole('button', { name: '验证', exact: true }).first();
      if ((await button.count()) === 0) return false;
      return (await button.isEnabled()) ? true : false;
    },
    { timeoutMs, description: 'MFA 卡片结束忙碌（验证按钮重新可用）' },
  );
}

/** Wait for a `role=status` element whose whitespace-stripped text contains `needle`. */
export async function waitForStatusText(page: Page, needle: string, timeoutMs = 45_000): Promise<void> {
  await waitFor(
    async () => {
      const texts = await page.locator('[role="status"]').allInnerTexts();
      return texts.some((text) => text.replace(/\s+/g, '').includes(needle)) ? true : false;
    },
    { timeoutMs, description: `role=status 文本包含「${needle}」` },
  );
}

// --- read-model (HTTP) helpers ------------------------------------------------------------------

/** A `TransactionView` from the bills read model (signed amount: negative = DEBIT/expense). */
export interface LedgerTransaction {
  id: string;
  amount: number;
  direction: 'DEBIT' | 'CREDIT';
  category: string;
  merchant: string;
  occurredAt: number;
}

/** The `GET /api/bills` payload (the subset the harness asserts on). */
export interface LedgerView {
  transactions: LedgerTransaction[];
}

/** The `GET /api/dashboard` payload (the subset the harness asserts on). */
export interface DashboardView {
  checkingBalance: number;
}

/** A `CardView` limit row (`GET /api/cards`). */
export interface CardLimitView {
  category: string;
  amount: number;
}

/** A `CardView` (`GET /api/cards`). */
export interface CardView {
  id: string;
  status: string;
  limits: CardLimitView[];
}

/** A non-terminal `PendingAction` from `GET /api/actions`. */
export interface PendingActionView {
  id: string;
  sessionId: string;
  toolName: string;
  status: string;
  tier: string;
}

/**
 * GET `url`, require a 2xx JSON envelope `{ ok:true, data }`, and return the unwrapped `data`.
 * Throws a descriptive error on a non-2xx status, a non-JSON body, or a non-`ok` envelope — so a
 * DB/ledger assertion can never silently pass on a malformed response.
 */
export async function getJson<T>(url: string, cookie?: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (cookie !== undefined) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}：${text.slice(0, 200)}`);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`GET ${url} 返回非 JSON：${text.slice(0, 200)}`);
  }
  const envelope = body as Record<string, unknown> | null;
  if (!envelope || envelope['ok'] !== true) {
    throw new Error(`GET ${url} 未返回 { ok:true } 信封：${text.slice(0, 200)}`);
  }
  return envelope['data'] as T;
}

/** `GET /api/dashboard` → the demo user's dashboard summary (no identity required). */
export function fetchDashboardSummary(baseUrl: string): Promise<DashboardView> {
  return getJson<DashboardView>(`${baseUrl}/api/dashboard`);
}

/** `GET /api/bills` → the transaction ledger (newest ≤50, no date filter; no identity required). */
export function fetchLedger(baseUrl: string): Promise<LedgerView> {
  return getJson<LedgerView>(`${baseUrl}/api/bills`);
}

/** `GET /api/cards` → the demo user's cards (incl. per-category limits; no identity required). */
export async function fetchCards(baseUrl: string): Promise<CardView[]> {
  const data = await getJson<{ cards: CardView[] }>(`${baseUrl}/api/cards`);
  return data.cards;
}

/** `GET /api/actions` → the caller session's NON-TERMINAL actions (identity = the cookie). */
export function fetchPendingActions(baseUrl: string, cookie: string): Promise<PendingActionView[]> {
  return getJson<PendingActionView[]>(`${baseUrl}/api/actions`, cookie);
}

/** The `value` of one card's per-category limit, or `undefined` when the card/category is absent. */
export function cardCategoryLimit(cards: readonly CardView[], cardId: string, category: string): number | undefined {
  const card = cards.find((candidate) => candidate.id === cardId);
  return card?.limits.find((limit) => limit.category === category)?.amount;
}

/** Ledger rows that appeared (`added`) / disappeared (`removed`) between two snapshots. */
export interface LedgerDiff {
  added: LedgerTransaction[];
  removed: LedgerTransaction[];
}

/** Diff two ledger snapshots by transaction id (order-independent). */
export function diffLedger(before: readonly LedgerTransaction[], after: readonly LedgerTransaction[]): LedgerDiff {
  const beforeIds = new Set(before.map((tx) => tx.id));
  const afterIds = new Set(after.map((tx) => tx.id));
  return {
    added: after.filter((tx) => !beforeIds.has(tx.id)),
    removed: before.filter((tx) => !afterIds.has(tx.id)),
  };
}

/** The `banking_session` cookie as a `Cookie` header value, or `undefined` when it is not set yet. */
export async function readSessionCookie(page: Page, name = 'banking_session'): Promise<string | undefined> {
  const cookies = await page.context().cookies();
  const found = cookies.find((cookie) => cookie.name === name);
  return found ? `${found.name}=${found.value}` : undefined;
}

// --- plan card (task plan) ----------------------------------------------------------------------

/**
 * XPath for the ACTIVE `PlanCard` root: the LAST-rendered ancestor `<div class="… rounded-2xl …">` of
 * the `依赖关系` heading (a `PlanCard`-only marker).
 *
 * A plan turn renders the DAG snapshot TWICE: once INLINE inside the assistant message bubble
 * (`MessageBubble` → `CardRenderer`), and once as the LIVE `stream.activePlan` card which
 * `ChatWindow` renders AFTER all messages. The inline card's `plan.status` is FROZEN at the value the
 * turn ended with (nothing rewrites `message.cards`), so pausing/cancelling a plan updates only the
 * LIVE card. Reading `[1]` (the stale inline card) made this harness observe 等待确认 forever. We
 * therefore select the LAST match — the live, app-authoritative plan view that reflects plan-control
 * outcomes. Falls back to the only card when just one is rendered.
 */
const PLAN_CARD_XPATH =
  'xpath=(//h4[normalize-space(string(.))="依赖关系"]/ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-2xl ")][1])[last()]';

/** Locator for the rendered, LIVE `PlanCard` root (the app-authoritative plan view). */
export function planCard(page: Page): Locator {
  return page.locator(PLAN_CARD_XPATH);
}

/**
 * The plan's own status label — read from the FIRST status badge inside the card (the header badge,
 * which precedes the per-node timeline badges in DOM order). Returns `undefined` when no plan card
 * is rendered.
 */
export async function planStatus(page: Page): Promise<string | undefined> {
  const badge = planCard(page).locator('span.rounded-full').first();
  if ((await badge.count()) === 0) return undefined;
  return (await badge.innerText()).replace(/\s+/g, '').trim();
}

/** Wait until the plan reaches one of the `accept` status labels; returns the observed label. */
export async function waitForPlanStatus(page: Page, accept: string | readonly string[], timeoutMs = 90_000): Promise<string> {
  const wanted = typeof accept === 'string' ? [accept] : [...accept];
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    last = await planStatus(page);
    if (last !== undefined && wanted.includes(last)) return last;
    if (Date.now() > deadline) {
      throw new Error(
        `等待计划状态 [${wanted.join('|')}] 超时（${timeoutMs}ms），当前状态：${last ?? '未找到计划卡片'}`,
      );
    }
    await sleep(200);
  }
}

/** Click one of the plan card's control buttons (`暂停`/`继续`/`取消`/`重试`), scoped to the card. */
export async function clickPlanControl(page: Page, label: string, timeoutMs = 30_000): Promise<void> {
  await clickWhenEnabled(
    planCard(page).getByRole('button', { name: label, exact: true }),
    `计划控制按钮「${label}」`,
    timeoutMs,
  );
}

/** Is a plan-card control button (`暂停`/`继续`/`取消`/`重试`) currently rendered? */
export async function planControlPresent(page: Page, label: string): Promise<boolean> {
  return (await planCard(page).getByRole('button', { name: label, exact: true }).count()) > 0;
}

/** Wait until a plan card is rendered (its `依赖关系` section exists), then return its status label. */
export async function waitForPlanCard(page: Page, timeoutMs = 90_000): Promise<string> {
  let status: string | undefined;
  await waitFor(
    async () => {
      status = await planStatus(page);
      return status === undefined ? false : status;
    },
    { timeoutMs, description: '计划卡片（依赖关系）渲染' },
  );
  return status ?? '';
}

// --- plan node timeline (per-node status badges) ------------------------------------------------

/** One row of the plan card's node timeline: the node name + its rendered status label. */
export interface PlanNodeRow {
  name: string;
  status: string;
}

/**
 * Read EVERY per-node row of the LIVE plan card's timeline from RENDERED DOM.
 *
 * The timeline is `AgentTaskTimeline` → `<ol class="space-y-3">` with one `<li>` per node; each row
 * carries the node name (`span.text-sm.font-medium.text-banking-deep`) plus a status `<Badge>`
 * (`span.rounded-full`). Node labels are whitespace-stripped. Scoping to `ol.space-y-3 > li` avoids
 * the SECOND copy of every node name that the card's 依赖关系 dependency list also renders.
 */
export async function planNodeRows(page: Page): Promise<PlanNodeRow[]> {
  const rows = planCard(page).locator('ol.space-y-3 > li');
  const count = await rows.count();
  const out: PlanNodeRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = rows.nth(i);
    const byClass = row.locator('span.text-sm.font-medium.text-banking-deep').first();
    const nameEl = (await byClass.count()) > 0 ? byClass : row.locator('span:not([aria-hidden="true"])').first();
    const name = (await nameEl.innerText().catch(() => '')).replace(/\s+/g, '').trim();
    const status = (await row.locator('span.rounded-full').first().innerText().catch(() => ''))
      .replace(/\s+/g, '')
      .trim();
    out.push({ name, status });
  }
  return out;
}

/** The rendered status label of the plan node whose name CONTAINS `nodeNameContains`, or `undefined`. */
export async function nodeStatus(page: Page, nodeNameContains: string): Promise<string | undefined> {
  const rows = await planNodeRows(page);
  return rows.find((row) => row.name.includes(nodeNameContains))?.status;
}

/** Wait until a plan node's status label is one of `accept`; returns the observed label (or throws). */
export async function waitForNodeStatus(
  page: Page,
  nodeNameContains: string,
  accept: string | readonly string[],
  timeoutMs = 90_000,
): Promise<string> {
  const wanted = typeof accept === 'string' ? [accept] : [...accept];
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    last = await nodeStatus(page, nodeNameContains);
    if (last !== undefined && wanted.includes(last)) return last;
    if (Date.now() > deadline) {
      const snapshot = (await planNodeRows(page).catch(() => []))
        .map((row) => `${row.name}=${row.status}`)
        .join(', ');
      throw new Error(
        `等待计划节点「${nodeNameContains}」状态 [${wanted.join('|')}] 超时（${timeoutMs}ms），当前：${last ?? '未找到'}（时间线：${snapshot}）`,
      );
    }
    await sleep(200);
  }
}
