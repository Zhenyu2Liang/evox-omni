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
import { existsSync, mkdirSync } from 'node:fs';
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

/**
 * The platform-specific command that boots Next dev.
 *
 * On Windows we MUST go through `cmd.exe /d /s /c` (there is no `npx` binary, only `npx.cmd`) and we
 * deliberately do NOT use Node's `shell: true`: `shell:true` + args re-serialization produced an EMPTY
 * stdout pipe in this environment (the child never reported its ready line). Spawning `cmd.exe` with a
 * single pre-quoted command string reproduces the known-good manual boot exactly.
 */
function devServerCommand(port: number): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', `npx next dev -p ${port}`] };
  }
  return { command: 'npx', args: ['next', 'dev', '-p', String(port)] };
}

/**
 * Boot `npx next dev -p <port>` detached (its own process group/tree, so it can be killed whole).
 * Starts the process only — callers must `waitForHealth` before driving the UI.
 */
export function startDevServer(port: number): DevServer {
  const { command, args } = devServerCommand(port);
  const child: ChildProcess = spawn(command, args, {
    cwd: REPO_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
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

/**
 * Poll `GET <baseUrl>/api/health` until it reports `{ ok:true, data:{ status:'ok' } }`.
 * Generous default timeout — the first request triggers Next dev's cold compile.
 */
export async function waitForHealth(baseUrl: string, opts: { timeoutMs?: number; output?: () => string } = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? NAV_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let last = '尚无响应';
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { headers: { Accept: 'application/json' } });
      if (res.ok) {
        const body: unknown = await res.json();
        if (isHealthOk(body)) return;
        last = `非预期响应体：${JSON.stringify(body).slice(0, 160)}`;
      } else {
        last = `HTTP ${res.status}`;
      }
    } catch (e) {
      last = errText(e);
    }
    if (Date.now() > deadline) {
      const tail = opts.output ? ` ｜ dev-server 输出尾部：${opts.output().slice(-800)}` : '';
      throw new Error(`/api/health 未就绪（${timeoutMs}ms）：${last}${tail}`);
    }
    await sleep(500);
  }
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

/** Navigate to the chat page and wait for the composer to render. */
export async function gotoAgent(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await page.locator(SELECTORS.composer).first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
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

/** Type `text` into the composer and submit it (waits for the input to be free first). */
export async function submitChat(page: Page, text: string, timeoutMs = 60_000): Promise<void> {
  const composer = page.locator(SELECTORS.composer).first();
  await composer.waitFor({ state: 'visible', timeout: timeoutMs });
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

// --- plan card (task plan) ----------------------------------------------------------------------

/**
 * XPath for the `PlanCard` root: the nearest ancestor `<div class="… rounded-2xl …">` of the
 * `依赖关系` heading (a `PlanCard`-only marker). `ancestor::…[1]` picks the NEAREST such ancestor,
 * which is the plan card itself — not the nested timeline card or any wrapper.
 */
const PLAN_CARD_XPATH =
  'xpath=//h4[normalize-space(string(.))="依赖关系"]/ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-2xl ")][1]';

/** Locator for the rendered `PlanCard` root. */
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
