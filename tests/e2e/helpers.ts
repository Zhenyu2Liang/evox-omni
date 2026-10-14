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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { centsToMoney, formatCNY, moneyToCents } from '../../lib/money';
import { DEVELOPER_MODE_COOKIE, DEVELOPER_MODE_ENABLED } from '../../lib/developer-mode/shared';
import type { Browser, Locator, Page } from 'playwright-core';
import {
  cliCommand,
  diagnosticCliOutput,
  ensurePrismaClientGenerated,
  pinSchemaEngineLogging,
  provisionSchemaLadder,
  resolveRepoRoot,
  resolveTsxBin,
  runCliStep as runCliStepShared,
  spawnErrorText,
} from '../helpers/prisma-cli';

// Pin the Prisma schema engine's log level to `info` BEFORE anything spawns a CLI (the provisioning
// `db push`/seed AND the dev server): an ambient `RUST_LOG≥warn` suppresses the engine's INFO banner,
// which makes Prisma DROP the engine's ERROR line and report an EMPTY `Error: Schema engine error:`,
// so a cold-checkout E2E provision fails for no real reason. See
// `../helpers/prisma-cli.ts#SCHEMA_ENGINE_RUST_LOG` for the full mechanism.
pinSchemaEngineLogging();

/** Generous default for DOM waits (Next dev client hydration can lag on a cold compile). */
export const DEFAULT_TIMEOUT_MS = 45_000;
/** Navigation timeout — the first `/agent` request can trigger a 60s+ dev-server compile. */
export const NAV_TIMEOUT_MS = 180_000;

/** The repository root (contains `package.json` + `next.config.mjs`), found by walking up from cwd. */
export const REPO_ROOT = resolveRepoRoot();
/** Scratch dir for failure screenshots (git-ignored — never committed). */
export const SCREENSHOTS_DIR = path.join(REPO_ROOT, 'output', 'playwright');

// --- standalone gated-action WEDGE recovery (journey `f-wedge-refresh-recover`) -------------------
//
// These helpers let the harness SEED the exact wedge the app's own commit path can leave behind — a
// `PendingAction` stuck at `status='confirmed'` with `resultJson=null` because the Banking SDK side
// effect committed but its result+status transaction was lost — and then query the persisted outcome.
// The id derivations MIRROR `lib/ledger.ts` (`idempotentTransferTxId` / `executionReceiptId` /
// `requestDigest`, all sha256-based with a `\u0000` separator) so the seeded rows are byte-identical
// to what `banking-sdk/transfer.ts#createTransfer` would have written. They are re-implemented here
// (not imported) to honour this node's "no `@/` alias, node built-ins + relative imports only" rule.

/** Lowercase sha256 hex of a UTF-8 string. */
function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Deterministic transfer `Transaction` id for a ledger key — mirrors `lib/ledger.ts#idempotentTransferTxId`. */
export function idempotentTransferTxId(userId: string, key: string): string {
  return `txidem_${sha256Hex(`${userId}\u0000${key}`).slice(0, 32)}`;
}

/** Deterministic `ExecutionReceipt` id for a ledger key — mirrors `lib/ledger.ts#executionReceiptId`. */
export function executionReceiptId(userId: string, key: string): string {
  return `rcpt_${sha256Hex(`${userId}\u0000${key}`).slice(0, 32)}`;
}

/** Recursively key-sorted clone (`undefined` → `null`) — mirrors `lib/ledger.ts#canonicalize`. */
function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

/** sha256 of the canonical JSON — mirrors `lib/ledger.ts#requestDigest`. */
export function requestDigest(parts: unknown): string {
  return sha256Hex(JSON.stringify(canonicalize(parts)));
}

/** The fixed wedge identifiers used by journey `f-wedge-refresh-recover`. */
export const WEDGE_ACTION_ID = 'pa_ewedge_1';
/** A STANDALONE action's ledger key IS its id (no `taskId`/`nodeId`). */
export const WEDGE_LEDGER_KEY = WEDGE_ACTION_ID;
/** The committed DEBIT `Transaction` id for the wedge. */
export const WEDGE_TX_ID = idempotentTransferTxId('user_liming', WEDGE_LEDGER_KEY);
/** The committed `ExecutionReceipt` id for the wedge. */
export const WEDGE_RECEIPT_ID = executionReceiptId('user_liming', WEDGE_LEDGER_KEY);
/** The amount (CNY) of the committed debit. */
export const WEDGE_AMOUNT = '200.00';
/** The sticky (YELLOW) risk level of the wedge action. */
export const WEDGE_TIER = 'YELLOW';
/** The recovery audit `dedupeKey` written by `landStandalone` (`'exec:' + actionId`). */
export const WEDGE_AUDIT_DEDUPE_KEY = `exec:${WEDGE_ACTION_ID}`;
/** The demo clock instant (`demoNow()` = 2026-09-25 12:00 LOCAL) used for the seeded timestamps. */
export const WEDGE_DEMO_NOW = new Date('2026-09-25T12:00:00+08:00');

/**
 * SEED the standalone wedge directly into the isolated E2E DB (`prisma/e2e.db`), inserting ONLY the
 * wedge rows in ONE transaction — never a wipe/re-seed. It mirrors the app's real commit path:
 *   (i)  decrement `acct_checking.balance` by the amount (the COMMITTED debit — already on the ledger);
 *   (ii) insert the DEBIT `Transaction` (id = `WEDGE_TX_ID`);
 *   (iii) insert the committed `ExecutionReceipt` (the evidence recovery settles FROM, no re-debit);
 *   (iv) insert the `PendingAction` `pa_ewedge_1` at `status='confirmed'` with `resultJson=null`
 *        (the WEDGE: side effect committed, result+status write lost).
 * Returns the seeded ids. A fresh `PrismaClient` is used and always disconnected.
 */
export async function seedStandaloneWedge(params: { sessionId: string }): Promise<{ txId: string; receiptId: string }> {
  const { createDatabaseClient } = await import('../../lib/db/database');
  const prisma = createDatabaseClient();
  const occurredAt = WEDGE_DEMO_NOW;
  try {
    await prisma.$transaction(async (tx) => {
      const recipient = await tx.contact.findUniqueOrThrow({ where: { id: 'contact_zhangwei' } });
      const updatedAccount = await tx.account.update({
        where: { id: 'acct_checking' },
        data: { balanceMinor: { decrement: moneyToCents(WEDGE_AMOUNT) } },
      });
      await tx.transaction.create({
        data: {
          id: WEDGE_TX_ID,
          accountId: 'acct_checking',
          userId: 'user_liming',
          amountMinor: -moneyToCents(WEDGE_AMOUNT),
          currency: 'CNY',
          direction: 'DEBIT',
          category: '转账',
          merchant: `转账给张伟`,
          channel: 'TRANSFER',
          counterpartyId: 'contact_zhangwei',
          occurredAt,
        },
      });
      await tx.executionReceipt.create({
        data: {
          id: WEDGE_RECEIPT_ID,
          userId: 'user_liming',
          key: WEDGE_LEDGER_KEY,
          toolName: 'transfer_money',
          requestDigest: requestDigest({
            userId: 'user_liming',
            toolName: 'transfer_money',
            name: '张伟',
            contactId: null,
            phone: null,
            amount: WEDGE_AMOUNT,
            sourceAccountId: null,
            remark: null,
          }),
          resultJson: JSON.stringify({
            success: true,
            transactionId: WEDGE_TX_ID,
            sourceAccountId: updatedAccount.id,
            newBalance: centsToMoney(updatedAccount.balanceMinor),
            recipient: { contactId: recipient.id, name: recipient.name, phone: recipient.phone, bank: recipient.bank ?? undefined },
            amount: WEDGE_AMOUNT,
            occurredAt: occurredAt.getTime(),
          }),
          txId: WEDGE_TX_ID,
        },
      });
      await tx.pendingAction.create({
        data: {
          id: WEDGE_ACTION_ID,
          sessionId: params.sessionId,
          userId: 'user_liming',
          toolName: 'transfer_money',
          argsJson: JSON.stringify({ name: '张伟', amount: WEDGE_AMOUNT }),
          riskLevel: WEDGE_TIER,
          requiresMfa: false,
          status: 'confirmed',
          summaryJson: JSON.stringify({
            title: '转账给张伟',
            toolName: 'transfer_money',
            tier: WEDGE_TIER,
            fields: [
              { label: '收款人', value: '张伟' },
              { label: '金额', value: formatCNY(WEDGE_AMOUNT) },
            ],
            amount: WEDGE_AMOUNT,
            requiresMfa: false,
          }),
          resultJson: null,
          userRequest: '给张伟转200元',
          taskId: null,
          nodeId: null,
          executionLeaseOwner: null,
          executionLeaseExpiresAt: null,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
    });
    return { txId: WEDGE_TX_ID, receiptId: WEDGE_RECEIPT_ID };
  } finally {
    await prisma.$disconnect();
  }
}

/** Read the persisted `status` (+ `resultJson`) of a `PendingAction` by id, or `null` when absent. */
export async function queryPendingActionStatus(
  actionId: string,
): Promise<{ status: string; resultJson: string | null } | null> {
  const { createDatabaseClient } = await import('../../lib/db/database');
  const prisma = createDatabaseClient();
  try {
    const row = await prisma.pendingAction.findUnique({
      where: { id: actionId },
      select: { status: true, resultJson: true },
    });
    return row ? { status: row.status, resultJson: row.resultJson ?? null } : null;
  } finally {
    await prisma.$disconnect();
  }
}

/** The durable `AuditLog` row for a recovery `dedupeKey`, or `null`. */
export interface ExecutionAuditRow {
  status: string;
  toolName: string;
  riskLevel: string;
  sessionId: string;
  confirmationRequired: boolean;
  confirmed: boolean;
  mfaRequired: boolean;
}

/** Read the newest `AuditLog` row for a `dedupeKey`, or `null` when none was written. */
export async function queryExecutionAudit(dedupeKey: string): Promise<ExecutionAuditRow | null> {
  const { createDatabaseClient } = await import('../../lib/db/database');
  const prisma = createDatabaseClient();
  try {
    const row = await prisma.auditLog.findFirst({
      where: { dedupeKey },
      orderBy: { timestamp: 'desc' },
    });
    if (row === null) return null;
    return {
      status: row.status,
      toolName: row.toolName,
      riskLevel: row.riskLevel,
      sessionId: row.sessionId,
      confirmationRequired: row.confirmationRequired,
      confirmed: row.confirmed,
      mfaRequired: row.mfaRequired,
    };
  } finally {
    await prisma.$disconnect();
  }
}

/** A `SecurityEvent` row read straight from the isolated E2E DB (`securityEvent` table). */
export interface SecurityEventRow {
  kind: string;
  severity: string;
  sessionId: string;
  message: string;
  /** The `detail` JSON parsed back into a value, or `undefined` when the row carries none. */
  detail: Record<string, unknown> | undefined;
}

/**
 * Read `SecurityEvent` rows from the isolated E2E DB, newest first, optionally filtered by
 * `sessionId` and/or `kind`. Persistence is the source of truth for the breaker audit
 * (`CIRCUIT_BREAKER_TRIPPED` / `SECURITY_RESET`), so a DOM assertion can be cross-checked here.
 */
export async function querySecurityEvents(
  filter: { sessionId?: string; kind?: string } = {},
): Promise<SecurityEventRow[]> {
  const { createDatabaseClient } = await import('../../lib/db/database');
  const prisma = createDatabaseClient();
  try {
    const rows = await prisma.securityEvent.findMany({
      where: {
        ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
        ...(filter.kind !== undefined ? { kind: filter.kind } : {}),
      },
      orderBy: { timestamp: 'desc' },
      take: 50,
    });
    return rows.map((row) => ({
      kind: row.kind,
      severity: row.severity,
      sessionId: row.sessionId,
      message: row.message,
      detail:
        row.detail === null ? undefined : (JSON.parse(row.detail) as Record<string, unknown>),
    }));
  } finally {
    await prisma.$disconnect();
  }
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
 * The Next CLI entry (`node_modules/next/dist/bin/next`), or `undefined` if it truly cannot be found.
 *
 * TWO resolution strategies, tried in order — the FIRST is the normal case, the SECOND is what makes
 * boot reliable in a worktree that deliberately has NO local `node_modules`:
 *
 *  1. PROJECT-LOCAL — `REPO_ROOT/node_modules/next/dist/bin/next`. Used when this checkout has its own
 *     `node_modules` (the usual case).
 *  2. NODE RESOLUTION — Node's OWN algorithm (`require.resolve('next/dist/bin/next')`, via
 *     `createRequire`), which walks UP the directory tree from this harness into any hoisted/shared
 *     `node_modules` (e.g. the monorepo-root `next`). Without it a no-local-`node_modules` worktree
 *     resolves NOTHING here, so {@link devServerCommand} would fall back to the KNOWN-FLAKY
 *     `npx next dev` path (empty stdout pipe / never-ready server).
 *
 * A resolved path is accepted only when the file actually EXISTS on disk.
 */
function resolveNextBin(): string | undefined {
  const localBin = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (existsSync(localBin)) return localBin;
  try {
    const resolved = createRequire(import.meta.url).resolve('next/dist/bin/next');
    return existsSync(resolved) ? resolved : undefined;
  } catch {
    return undefined;
  }
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
      BANKING_NEXT_DIST_DIR: '.next-e2e',
      DEMO_USER_ID: 'user_liming',
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
  // Boot can be interrupted before its caller receives a server handle. Own cleanup from spawn
  // time so the detached server cannot outlive a failed or cancelled readiness check.
  const stop = () => {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', stop);
    killProcessTree(pid);
    try { child.unref(); } catch { /* non-fatal */ }
  };
  process.once('exit', stop);
  return {
    port,
    baseUrl: `http://localhost:${port}`,
    pid,
    output: () => log,
    stop,
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
    return html.includes('data-chat-composer="true"') ? undefined : 'The assistant page did not render its message composer';
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

/**
 * Run one CLI step synchronously in the project root against the ISOLATED E2E database; throws with the
 * FULL captured stdout+stderr on failure (see `runCliStep` in `../helpers/prisma-cli`, shared with the
 * Vitest global setup). `DATABASE_URL` defaults to `E2E_DB_URL`, so every provisioning step
 * (`db push` / seed) targets `prisma/e2e.db` — NEVER the shared `prisma/dev.db`.
 */
function runCliStep(command: string, args: readonly string[]): string {
  return runCliStepShared(command, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: process.env['DATABASE_URL'] ?? E2E_DB_URL },
  });
}


/**
 * Sanity-probe the freshly provisioned E2E DB: spawn a throwaway Node process that CONNECTS to the
 * isolated DB through the generated Prisma Client and checks that the canonical `User` table exists.
 *
 * WHY: `prisma db push` can occasionally report success (exit 0) while leaving a DB image that cannot
 * actually be opened (a truncated/zeroed file, a Windows file-lock, or a schema-engine hiccup). Without
 * this probe the breakage would only surface later inside the seed or mid-journey.
 * A failure here reports the unusable database with full captured stdout and stderr.
 */
function probeDatabaseUsable(): void {
  const script = `
const { createDatabaseClient } = require('./lib/db/database.ts');
const client = createDatabaseClient();
const check = "SELECT name FROM sqlite_master WHERE type='table' AND name='User'";
(async () => {
  try {
    const rows = await client.$queryRawUnsafe(check);
    if (!Array.isArray(rows) || rows.length === 0) {
      console.error('schema 未应用：缺少 User 表');
      process.exitCode = 3;
    }
  } catch (e) {
    console.error((e && e.stack) || String(e));
    process.exitCode = 2;
  } finally {
    await client.$disconnect().catch(() => {});
  }
})();
`;
  const probe = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: REPO_ROOT,
    windowsHide: true,
    encoding: 'utf8',
    // Probe the ISOLATED E2E DB — never the shared dev DB (see `useIsolatedDatabase`/`E2E_DB_URL`).
    env: { ...process.env, DATABASE_URL: process.env['DATABASE_URL'] ?? E2E_DB_URL },
  });
  if (probe.status !== 0) {
    throw new Error(
      `db push 完成后 E2E 数据库探测失败（退出码 ${probe.status ?? 'null'}）${spawnErrorText(probe.error)}\n` +
        diagnosticCliOutput(probe.stdout, probe.stderr),
    );
  }
}

/** Seed the ISOLATED E2E DB via `tsx prisma/seed.ts` (honours `DATABASE_URL` = `E2E_DB_URL`). */
function seedIsolatedDatabase(): void {
  const seed = cliCommand(resolveTsxBin(REPO_ROOT), ['tsx', path.join('prisma', 'seed.ts')]);
  runCliStep(seed.command, seed.args);
}

/** Reset fixture rows between independent journeys, retaining the open database file. */
export async function reseedDemoDatabase(): Promise<void> {
  if (process.env.DATABASE_URL !== E2E_DB_URL) throw new Error('Reseeding requires the isolated acceptance database');
  const { createDatabaseClient } = await import('../../lib/db/database');
  const fixture = createDatabaseClient(E2E_DB_URL);
  try {
    await waitFor(async () => await fixture.agentSession.count({ where: { activeRunId: { not: null } } }) === 0,
      { timeoutMs: 10_000, description: 'Completed browser journeys have released their run leases' });
    await fixture.$transaction([
      fixture.agentRunEvent.deleteMany(), fixture.toolInvocation.deleteMany(), fixture.modelRequest.deleteMany(),
      fixture.agentRun.deleteMany(), fixture.authorizationDecision.deleteMany(), fixture.riskSignal.deleteMany(),
      fixture.manualReview.deleteMany(), fixture.mfaChallenge.deleteMany(), fixture.pendingAction.deleteMany(),
      fixture.executionReceipt.deleteMany(), fixture.agentTaskNode.deleteMany(), fixture.agentTask.deleteMany(),
      fixture.auditLog.deleteMany(), fixture.securityEvent.deleteMany(), fixture.circuitBreakerState.deleteMany(),
      fixture.agentSession.deleteMany(),
    ]);
  } finally { await fixture.$disconnect(); }
  seedIsolatedDatabase();
}

/**
 * One reset attempt: ensure the Prisma Client is generated, then provision the schema + seed through
 * the shared ORDERED provisioning LADDER (`provisionSchemaLadder` in `../helpers/prisma-cli`), against
 * the ISOLATED E2E DB.
 *
 * Each rung runs ONLY after the previous one FAILED; `provisionSchemaLadder` deletes the isolated DB +
 * sidecars before pushing, so the CLI only creates a fresh file: delete → push → probe → seed.
 * Generation is explicit and checked before provisioning. Any failure retains full CLI output
 * and environment diagnostics. `prisma/dev.db` is never referenced.
 */
function resetDemoDatabaseOnce(): void {
  ensurePrismaClientGenerated(REPO_ROOT);
  provisionSchemaLadder({
    repoRoot: REPO_ROOT,
    dbDir: path.join(REPO_ROOT, 'prisma'),
    dbFiles: E2E_DB_FILES,
    env: { ...process.env, DATABASE_URL: process.env['DATABASE_URL'] ?? E2E_DB_URL },
    rungs: [
      { label: 'db push', args: ['prisma', 'db', 'push'] },
    ],
    afterPush: () => {
      // Check the new database before seeding; an unusable file fails provisioning.
      probeDatabaseUsable();
      seedIsolatedDatabase();
    },
  });
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
 * HOW: ensure a GENERATED, USABLE Prisma Client (`ensurePrismaClientGenerated`; a bare `npm install`
 * checkout self-bootstraps via `prisma generate`). Then provision the schema + seed through the shared
 * Provisioning (`resetDemoDatabaseOnce` → `provisionSchemaLadder`) uses plain `prisma db push`
 * after deleting the isolated file, followed by `probeDatabaseUsable` and seed.
 * Prisma 7 requires separate client generation; no redundant CLI reset is needed.
 *
 * Every CLI step is given `DATABASE_URL` = `E2E_DB_URL` (see `runCliStep`), and any CLI failure throws
 * the FULL captured stdout+stderr (tail preserved — see `runCliStep`/`diagnosticCliOutput`); when EVERY
 * ladder rung fails, the thrown message embeds each rung's FULL output plus environment diagnostics.
 * The whole attempt is retried `opts.attempts` times (default 2) with a short backoff — SQLite on
 * Windows is occasionally lock-prone.
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

/** Common installed browser locations; an explicit executable override still takes precedence. */
const CANDIDATE_BROWSER_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
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
    await page.screenshot({ path: file, fullPage: true, timeout: 15000 });
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
  composer: 'textarea[data-chat-composer="true"]',
  /** `components/chat/MessageBubble.tsx` — assistant bubble body text (`<p>` in the white bubble). */
  assistantText: '[data-message-role="assistant"] [data-assistant-content="true"]',
  /** The single actionable authorization surface, outside the transcript. */
  approvalRequest: '[data-approval-request="true"]',
  /** The dock's verification input; historical receipts never contain one. */
  mfaInput: '[data-approval-request="true"] input[aria-label="验证码"]',
  /** `app/security/ResetBreakerButton.tsx` — the GATED unlock control's 6-digit code input. */
  breakerCodeInput: 'input[aria-label="6 位验证码"]',
} as const;

/**
 * Wait until a server-rendered DOM node has been HYDRATED by React: it carries a React own-property
 * (`__reactProps$…` / `__reactFiber$…`).
 *
 * A client component's SSR HTML is visible (and "actionable" by shape) BEFORE hydration, but its
 * `onClick` is not attached yet — a click at that instant is silently DROPPED (no network request).
 * Waiting for the React own-property key is a real DOM condition — never a fixed sleep.
 */
export async function waitForElementHydration(
  page: Page,
  selector: string,
  timeoutMs = NAV_TIMEOUT_MS,
): Promise<void> {
  await page.waitForFunction(
    (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      return Object.keys(el).some(
        (key) => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$'),
      );
    },
    selector,
    { timeout: timeoutMs },
  );
}

/**
 * Wait until the SSR composer `<textarea>` has been HYDRATED by React. Before hydration the node
 * exists (server-rendered) but carries NO React own-property, so a `fill()`/click is silently
 * DROPPED (no `POST /api/chat`) AND hydration re-renders the controlled `<textarea>` back to empty
 * (resetting the fill) — landing the first turn deterministically instead of racing hydration.
 */
export async function waitForComposerHydration(page: Page, timeoutMs = NAV_TIMEOUT_MS): Promise<void> {
  await page.waitForFunction((selector: string) =>
    document.querySelector(selector)?.getAttribute('data-chat-ready') === 'true', SELECTORS.composer,
  { timeout: timeoutMs });
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

/** Click the latest enabled decision control in the chronological tool-message timeline. */
async function clickLastWhenEnabled(locator: Locator, description: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  await waitFor(
    async () => {
      if ((await locator.count()) === 0) return false;
      return (await locator.last().isEnabled()) ? true : false;
    },
    { timeoutMs, description },
  );
  await locator.last().click();
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
  await Promise.all([
    page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat', { timeout: timeoutMs }),
    clickWhenEnabled(page.getByRole('button', { name: /^(Send|发送)$/ }), 'Send button', timeoutMs),
  ]);
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

/** Wait for the dock's confirmation control, excluding read-only historical receipts. */
export async function waitForConfirmCard(page: Page, timeoutMs = 90_000): Promise<void> {
  const confirm = page.locator(SELECTORS.approvalRequest).getByRole('button', { name: '确认', exact: true });
  await waitFor(async () => ((await confirm.count()) > 0 ? true : false), {
    timeoutMs,
    description: '确认卡片（「确认」按钮）',
  });
  await confirm.first().waitFor({ state: 'visible', timeout: timeoutMs });
}

/** Click the confirmation card's `确认` button. */
export async function clickConfirm(page: Page, timeoutMs = 30_000): Promise<void> {
  await clickWhenEnabled(page.locator(SELECTORS.approvalRequest).getByRole('button', { name: '确认', exact: true }), '确认按钮', timeoutMs);
}

/** Is an MFA card (verification code input) currently rendered? */
export async function mfaCardPresent(page: Page): Promise<boolean> {
  return (await page.locator(SELECTORS.mfaInput).count()) > 0;
}

/** Wait for actionable MFA requests in the dock; receipts have no verification inputs. */
export async function waitForMfaCard(page: Page, timeoutMs = 90_000, minCount = 1): Promise<void> {
  await waitFor(async () => ((await page.locator(SELECTORS.mfaInput).count()) >= minCount ? true : false), {
    timeoutMs,
    description: minCount <= 1 ? 'MFA 卡片（身份验证 / 验证码输入框）' : `MFA 卡片 ≥ ${minCount} 张（身份验证 / 验证码输入框）`,
  });
  await page.locator(SELECTORS.mfaInput).last().waitFor({ state: 'visible', timeout: timeoutMs });
}

/** Fill the verification code and submit the matching actionable request. */
export async function submitMfa(page: Page, code: string, timeoutMs = 45_000): Promise<void> {
  const input = page.locator(SELECTORS.mfaInput).last();
  await input.waitFor({ state: 'visible', timeout: timeoutMs });
  await input.fill(code);
  await clickLastWhenEnabled(page.locator(SELECTORS.approvalRequest).getByRole('button', { name: '验证', exact: true }), 'MFA 验证按钮', timeoutMs);
}

/**
 * Wait for the MFA round-trip to SETTLE, decided by RENDERED DOM:
 *   - the card is GONE (count 0) → the decision SUCCEEDED and its pending action was cleared, or
 *   - the card stayed but its `验证` button is enabled again → the decision FAILED (retry allowed).
 * A successful verify REMOVES the whole card (`ChatWindow` renders it only while a pending action
 * exists), so requiring a re-enabled `验证` button would never settle on the success path.
 */
export async function waitForMfaSettled(page: Page, timeoutMs = 45_000): Promise<void> {
  await waitFor(
    async () => {
      const button = page.locator(SELECTORS.approvalRequest).getByRole('button', { name: '验证', exact: true }).first();
      if ((await button.count()) === 0) return true;
      return (await button.isEnabled()) ? true : false;
    },
    { timeoutMs, description: 'MFA 回合已结束（验证成功移除卡片 / 验证失败按钮重新可用）' },
  );
}

/** Wait for a `role=status` element whose whitespace-stripped text contains `needle`. */
export async function waitForStatusText(page: Page, needle: string, timeoutMs = 45_000): Promise<void> {
  await waitFor(
    async () => {
      const texts = await page.locator('[role="status"]').allInnerTexts();
      return texts.some((text) => text.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''))) ? true : false;
    },
    { timeoutMs, description: `role=status 文本包含「${needle}」` },
  );
}

// --- read-model (HTTP) helpers ------------------------------------------------------------------

/** A `TransactionView` from the bills read model (signed amount: negative = DEBIT/expense). */
export interface LedgerTransaction {
  id: string;
  amount: string;
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
  checkingBalance: string;
}

/** A `CardView` limit row (`GET /api/cards`). */
export interface CardLimitView {
  category: string;
  amount: string;
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
  requiresMfa: boolean;
  /** How `GET /api/actions` surfaces the row: `decision` | `processing` | `recoverable` | `reconciliation`. */
  attention?: string;
}

/**
 * GET `url`, require a 2xx JSON envelope `{ ok:true, data }`, and return the unwrapped `data`.
 * Throws a descriptive error on a non-2xx status, a non-JSON body, or a non-`ok` envelope — so a
 * DB/ledger assertion can never silently pass on a malformed response.
 */
export async function getJson<T>(url: string, extraHeaders: Record<string, string> = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', ...extraHeaders };
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

/** Read technical evidence with an explicit preference without enabling the user's browser. */
export function getDeveloperJson<T>(url: string): Promise<T> {
  return getJson<T>(url, { Cookie: `${DEVELOPER_MODE_COOKIE}=${DEVELOPER_MODE_ENABLED}` });
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

/** `GET /api/actions` returns the shared demo workspace's pending actions. */
export function fetchPendingActions(baseUrl: string): Promise<PendingActionView[]> {
  return getJson<PendingActionView[]>(`${baseUrl}/api/actions`);
}

/** The `value` of one card's per-category limit, or `undefined` when the card/category is absent. */
export function cardCategoryLimit(cards: readonly CardView[], cardId: string, category: string): string | undefined {
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

/** The server-selected workspace identity is already present when the page opens. */
export async function readDemoSessionId(page: Page): Promise<string> {
  const sessionId = await page.locator('[data-demo-session-id]').getAttribute('data-demo-session-id');
  if (!sessionId) throw new Error('The shared demo conversation is missing from the page');
  return sessionId;
}

// --- plan card (task plan) ----------------------------------------------------------------------

/** Locate the latest plan by its typed card marker inside its owning tool message. */
export function planCard(page: Page): Locator {
  return page.locator('[data-message-role="tool"] [data-chat-card-type="plan"]').last();
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
