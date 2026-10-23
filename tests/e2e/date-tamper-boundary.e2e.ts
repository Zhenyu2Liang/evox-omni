/**
 * `tests/e2e/date-tamper-boundary.e2e.ts` — RAW-HTTP **BOUNDARY** TEST (standalone tsx entry).
 *
 * ------------------------------------------------------------------------------------------------
 * WHAT THIS IS — and what it deliberately is NOT
 * ------------------------------------------------------------------------------------------------
 * This is NOT a browser / interaction flow. It drives NO UI, launches NO Playwright browser and uses
 * NO model: every step is a plain `fetch` against the RUNNING Next.js app, and every financial claim
 * is proven against the authoritative SQLite rows read back afterwards.
 *
 * The browser harnesses in this directory (`acceptance.e2e.ts`, `live-acceptance.e2e.ts`) answer
 * "does the PRODUCT WORK end-to-end for a user?"; this file answers a much narrower question — "does
 * the HTTP EDGE / SDK boundary refuse a caller-forged booking time, and does a refusal leave the
 * ledger untouched?" — so it is a SEPARATE artefact with its own isolated database and its own
 * summary. It is intentionally not folded into either browser entry.
 *
 * ------------------------------------------------------------------------------------------------
 * THE BOUNDARY UNDER TEST: CONSUMPTION TIME IS SERVER-OWNED
 * ------------------------------------------------------------------------------------------------
 * `POST /api/cards/[id]/consume` books a virtual-card spend at the project BUSINESS clock
 * (`lib/clock.ts#demoNow`, UTC+08:00 monthly window). A caller must not be able to back-date a spend
 * out of the current billing month (that would silently free monthly-limit headroom) nor future-date
 * one. A body that CONTAINS an `occurredAt` key is therefore REJECTED UP FRONT — never silently
 * stripped — with `400 { ok:false, error:{ code:'VALIDATION', ... } }`, and NOTHING moves: no balance
 * change, no `Transaction`, no `CardConsumption`.
 *
 * Replayed over real HTTP exactly as the repro describes:
 *   0. create a VIRTUAL card with a 100 CNY monthly limit bound to the owned CHECKING account
 *      (`POST /api/cards` proposal → `POST /api/cards/changes/[id]/verify`, i.e. the REAL product
 *      route incl. its MFA step; no direct DB write, no SDK call standing in for HTTP),
 *   1. consume 10.00 normally                                  → success,
 *   2. consume 90.00 with a PREVIOUS-month `occurredAt`         → 400 VALIDATION, zero side effects,
 *   3. consume 1.00 normally                                   → success; this month is exactly 11.00,
 *   4. future `occurredAt` and malformed `occurredAt`          → 400 VALIDATION, zero side effects,
 *   5. the 90.00 never entered any month's booked total, and the visible payable amount reflects
 *      exactly 11.00 of headroom use (89.00 left of the 100.00 limit).
 *
 * ------------------------------------------------------------------------------------------------
 * ISOLATION
 * ------------------------------------------------------------------------------------------------
 * Own SQLite database: `prisma/live-acceptance-date-tamper.db` (+ `-wal`/`-shm`/`-journal`), deleted
 * and re-provisioned (`prisma db push`) then seeded (`tsx prisma/seed.ts`) on EVERY run, so a second
 * run is byte-for-byte identical. The shared `prisma/dev.db`, a user backup, `prisma/test.db`
 * (Vitest) and `prisma/e2e.db` (the mock browser suite) are NEVER referenced. The app is booted on a
 * FREE port with that DATABASE_URL and `LLM_MODE=mock` in its environment (nothing calls a live LLM;
 * no `.env.local` is read) and its whole process tree is stopped on exit.
 *
 * Run: `pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts`
 * Output: one `PASS|FAIL|SKIP <case-id> — …` line per case, a `SUMMARY …` line, and
 * `process.exitCode = failures > 0 ? 1 : 0`. Machine-readable evidence:
 * `logs/date-tamper-evidence.json`.
 *
 * A filename ending in `.e2e.ts` does NOT match vitest's `tests/**\/*.{test,spec}.ts` glob, so this
 * harness never runs under `pnpm test`.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { PrismaClient } from '../../lib/db/prisma';
import { demoNow } from '../../lib/clock';
import { businessCalendarParts, monthRange, previousMonthRange } from '../../lib/date';
import { centsToMoney, moneyToCents } from '../../lib/money';
import {
  cliCommand,
  ensurePrismaClientGenerated,
  provisionSchemaLadder,
  resolveRepoRoot,
  resolveTsxBin,
  runCliStep,
} from '../helpers/prisma-cli';

// --- isolated database ---------------------------------------------------------------------------

const REPO_ROOT = resolveRepoRoot();
const LOGS_DIR = path.join(REPO_ROOT, 'logs');
const EVIDENCE_PATH = path.join(LOGS_DIR, 'date-tamper-evidence.json');

/** The harness' OWN SQLite file plus its sidecars — nothing else is ever deleted. */
const DB_FILE = 'live-acceptance-date-tamper.db';
const DB_FILES = [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, `${DB_FILE}-journal`] as const;
const DB_PATH = path.join(REPO_ROOT, 'prisma', DB_FILE);
/** Absolute `file:` URL (forward slashes — Prisma rejects a Windows backslash URL). */
const DB_URL = `file:${DB_PATH.split(path.sep).join('/')}`;

/** Business data + identities (the demo user's workspace; never another user's). */
const DEMO_USER_ID = 'user_liming';
const CHECKING_ACCOUNT_ID = 'acct_checking';
const MFA_CODE = '123456';

/** The card this case establishes and spends from: a VIRTUAL card with a 100.00 CNY monthly limit. */
const CARD_MONTHLY_LIMIT = '100.00';
const CARD_MONTHLY_LIMIT_MINOR = 10_000n;
/** Case amounts: two legal spends (10.00 + 1.00 = 11.00) and the forged 90.00 that must never book. */
const FIRST_SPEND = '10.00';
const SECOND_SPEND = '1.00';
const FORGED_SPEND = '90.00';
const FORGED_SPEND_MINOR = 9_000n;
const EXPECTED_MONTH_TOTAL = '11.00';
const EXPECTED_MONTH_TOTAL_MINOR = 1_100n;
/** Remaining monthly headroom after 11.00 of legal spending (100.00 - 11.00). */
const EXPECTED_REMAINING_LIMIT = '89.00';
/** The exact refusal text the route owns (asserted, not guessed). */
const SERVER_OWNED_MESSAGE_FRAGMENTS = ['server-owned', 'occurredAt'] as const;

/**
 * Next build dir. Deliberately the SAME one the browser harnesses use: `tsconfig.json` (a file this
 * suite does not own) already whitelists `.next-e2e/types/**` and `.next-e2e/dev/types/**`, so Next
 * never rewrites it. A bespoke dist dir would make `next dev` inject two new `include` entries into
 * the tracked `tsconfig.json` on every cold run — an out-of-scope edit this suite must not cause.
 * Consequence: like `acceptance.e2e.ts` vs `live-acceptance.e2e.ts`, this entry must not be run
 * CONCURRENTLY with another Next process on this repo (they would share the build dir).
 */
const NEXT_DIST_DIR = '.next-e2e';
const READY_TIMEOUT_MS = 300_000;

// --- evidence ------------------------------------------------------------------------------------

interface Exchange {
  method: string;
  path: string;
  body: unknown;
  status: number;
  responseBody: unknown;
}

type CaseStatus = 'PASS' | 'FAIL' | 'SKIP';
type CaseKind = 'SETUP' | 'CASE' | 'EXTRA';

interface CaseEvidence {
  id: string;
  kind: CaseKind;
  status: CaseStatus;
  detail: string;
  exchanges: Exchange[];
  db: Record<string, unknown>;
  error?: string;
}

const cases: CaseEvidence[] = [];
const exchanges: Exchange[] = [];
let failures = 0;
let passes = 0;
let skips = 0;
/** The card id this run established (set by the setup case). */
let cardId: string | undefined;
/** Current business-month window (UTC+08:00), derived from the app's own clock. */
let businessMonth: { start: Date; end: Date } = { start: new Date(0), end: new Date(0) };

/** Safe single-line text for ANY throwable (never a raw stack). */
function errText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

/** Compact one-line JSON for console evidence (bounded, so a case line stays readable). */
function compact(value: unknown, cap = 700): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

/** Record ONE case outcome and print its evidence line. Never throws. */
function record(entry: { id: string; kind: CaseKind; status: CaseStatus; detail: string; db?: Record<string, unknown>; exchangeSlice: Exchange[]; error?: string }): void {
  const evidence: CaseEvidence = {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    detail: entry.detail,
    exchanges: entry.exchangeSlice,
    db: entry.db ?? {},
  };
  if (entry.error !== undefined) evidence.error = entry.error;
  cases.push(evidence);

  if (entry.status === 'PASS') passes += 1;
  else if (entry.status === 'FAIL') failures += 1;
  else skips += 1;

  const calls = entry.exchangeSlice
    .map((x) => `${x.method} ${x.path}${x.body === null ? '' : ` body=${compact(x.body, 240)}`} → ${x.status} ${compact(x.responseBody, 400)}`)
    .join(' ｜ ');
  const db = Object.keys(evidence.db).length > 0 ? ` ｜ db ${compact(evidence.db, 500)}` : '';
  const callsPart = calls === '' ? '' : ` ｜ ${calls}`;
  console.log(`${entry.status} ${entry.id} — ${entry.detail}${callsPart}${db}`);
}

/**
 * Run one case: captures the exchanges it makes, its DB evidence and any thrown failure.
 * A thrown assertion is recorded as `FAIL` (never swallowed, never converted into a skip).
 */
async function runCase(
  id: string,
  kind: CaseKind,
  fn: (note: (key: string, value: unknown) => void) => Promise<string>,
): Promise<void> {
  const start = exchanges.length;
  const db: Record<string, unknown> = {};
  const note = (key: string, value: unknown): void => {
    db[key] = value;
  };
  try {
    const detail = await fn(note);
    record({ id, kind, status: 'PASS', detail, db, exchangeSlice: exchanges.slice(start) });
  } catch (e) {
    record({ id, kind, status: 'FAIL', detail: '未通过', db, exchangeSlice: exchanges.slice(start), error: errText(e) });
    console.error(`   ↳ 失败原因（${id}）：${errText(e)}`);
  }
}

// --- HTTP plumbing -------------------------------------------------------------------------------

let baseUrl = '';

/** Perform ONE real HTTP request against the running app and record it as evidence. */
async function call(method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<Exchange> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, init);
  const text = await res.text();
  let responseBody: unknown;
  try {
    responseBody = text === '' ? null : JSON.parse(text);
  } catch {
    responseBody = text.slice(0, 800);
  }
  const exchange: Exchange = { method, path: urlPath, body: body ?? null, status: res.status, responseBody };
  exchanges.push(exchange);
  return exchange;
}

/** Assert the HTTP status and return the parsed body object. */
function expectStatus(exchange: Exchange, expected: number): Record<string, unknown> {
  if (exchange.status !== expected) {
    throw new Error(`期望 HTTP ${expected}，实际 ${exchange.status}：${compact(exchange.responseBody, 900)}`);
  }
  const body = exchange.responseBody;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`期望 JSON 对象响应体，实际：${compact(body, 900)}`);
  }
  return body as Record<string, unknown>;
}

/** Assert `{ ok:true, data:{…} }` and return `data`. */
function expectOkData(exchange: Exchange): Record<string, unknown> {
  const body = expectStatus(exchange, 200);
  if (body.ok !== true) throw new Error(`期望 ok:true，实际：${compact(body, 900)}`);
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`期望 data 对象，实际：${compact(body, 900)}`);
  }
  return data as Record<string, unknown>;
}

/** Assert the shared failure envelope `{ ok:false, error:{ code, message } }` and return `error`. */
function expectErrorEnvelope(exchange: Exchange, expectedStatus: number, expectedCode: string): { code: string; message: string } {
  const body = expectStatus(exchange, expectedStatus);
  if (body.ok !== false) throw new Error(`期望 ok:false，实际：${compact(body, 900)}`);
  const error = body.error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    throw new Error(`期望 error 对象，实际：${compact(body, 900)}`);
  }
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code !== expectedCode) throw new Error(`期望 error.code=${expectedCode}，实际 ${String(code)}：${compact(body, 900)}`);
  if (typeof message !== 'string' || message.trim() === '') {
    throw new Error(`期望非空 error.message，实际：${compact(body, 900)}`);
  }
  return { code, message };
}

/** Assert a text field of an already-validated object. */
function field(record: Record<string, unknown>, key: string): unknown {
  if (!(key in record)) throw new Error(`响应缺少字段 ${key}：${compact(record, 900)}`);
  return record[key];
}

// --- authoritative SQLite reads -------------------------------------------------------------------

let dbClientHandle: PrismaClient | undefined;

/** ONE throwaway PrismaClient bound to the ISOLATED database (authoritative cross-checks only). */
async function db(): Promise<PrismaClient> {
  if (dbClientHandle === undefined) {
    const { createDatabaseClient } = await import('../../lib/db/database');
    dbClientHandle = createDatabaseClient(DB_URL);
  }
  return dbClientHandle;
}

/** The exact DB numbers a case compares before/after (all money as CNY minor-unit strings). */
interface DbSnapshot {
  checkingBalance: string;
  cardConsumptionCount: number;
  cardConsumptionTotal: string;
  cardMonthConsumptionTotal: string;
  cardChannelDebitCount: number;
  cardChannelMonthDebitTotal: string;
  forgedAmountRows: number;
}

/**
 * Read the authoritative counters.
 *
 *  - `card*` figures are scoped to the card THIS run created (a brand-new row, so its totals are
 *    absolute — no seeded spend is ever attributed to it);
 *  - `cardChannel*` figures are account-wide CARD/DEBIT ledger counters, so they include seeded
 *    spends and are only ever compared as a DELTA;
 *  - `forgedAmountRows` counts ANY persisted row of the forged 90.00 (card consumption or CARD
 *    ledger) across ALL months — it must stay 0 forever.
 */
async function snapshot(): Promise<DbSnapshot> {
  if (cardId === undefined) throw new Error('读取数据库快照前必须先确定卡片 id');
  const client = await db();
  const account = await client.account.findUnique({ where: { id: CHECKING_ACCOUNT_ID } });
  if (!account) throw new Error(`缺少账户 ${CHECKING_ACCOUNT_ID}`);
  const consumptions = await client.cardConsumption.findMany({
    where: { cardId, userId: DEMO_USER_ID },
    select: { amountMinor: true, occurredAt: true },
  });
  const ledger = await client.transaction.findMany({
    where: { accountId: CHECKING_ACCOUNT_ID, channel: 'CARD', direction: 'DEBIT' },
    select: { amountMinor: true, occurredAt: true },
  });
  const inMonth = (at: Date): boolean => at.getTime() >= businessMonth.start.getTime() && at.getTime() < businessMonth.end.getTime();
  const sumMinor = (rows: readonly { amountMinor: bigint }[]): bigint => rows.reduce((total, row) => total + (row.amountMinor < 0n ? -row.amountMinor : row.amountMinor), 0n);
  const allConsumptions = await client.cardConsumption.findMany({ where: { userId: DEMO_USER_ID }, select: { amountMinor: true } });
  const forgedRows = allConsumptions.filter((row) => row.amountMinor === FORGED_SPEND_MINOR).length
    + ledger.filter((row) => row.amountMinor === -FORGED_SPEND_MINOR).length;

  return {
    checkingBalance: centsToMoney(account.balanceMinor),
    cardConsumptionCount: consumptions.length,
    cardConsumptionTotal: centsToMoney(sumMinor(consumptions)),
    cardMonthConsumptionTotal: centsToMoney(sumMinor(consumptions.filter((row) => inMonth(row.occurredAt)))),
    cardChannelDebitCount: ledger.length,
    cardChannelMonthDebitTotal: centsToMoney(sumMinor(ledger.filter((row) => inMonth(row.occurredAt)))),
    forgedAmountRows: forgedRows,
  };
}

/** Difference of two CNY minor-unit figures (as exact text). */
function deltaCents(after: string, before: string): string {
  return centsToMoney(moneyToCents(after) - moneyToCents(before));
}

/** Assert two CNY figures are equal, with the exact delta in the failure message. */
function assertMoney(actual: string, expected: string, what: string): void {
  if (moneyToCents(actual) !== moneyToCents(expected)) {
    throw new Error(`${what} 期望 ${expected}，实际 ${actual}`);
  }
}

/** Assert `a === b` for numbers, with a descriptive message. */
function assertEqual(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) throw new Error(`${what} 期望 ${String(expected)}，实际 ${String(actual)}`);
}

// --- database provisioning ------------------------------------------------------------------------

/** Probe the freshly pushed DB from a child process (so DATABASE_URL applies before construction). */
function probeDatabaseUsable(): void {
  const script = `
const { createDatabaseClient } = require('./lib/db/database.ts');
const client = createDatabaseClient(process.env.DATABASE_URL);
const check = "SELECT name FROM sqlite_master WHERE type='table' AND name='User'";
(async () => {
  try {
    const rows = await client.$queryRawUnsafe(check);
    if (!Array.isArray(rows) || rows.length === 0) { console.error('schema 未应用：缺少 User 表'); process.exitCode = 3; }
  } catch (e) { console.error((e && e.stack) || String(e)); process.exitCode = 2; }
  finally { await client.$disconnect().catch(() => {}); }
})();
`;
  const probe = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: REPO_ROOT,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DB_URL },
  });
  if (probe.status !== 0) {
    throw new Error(`隔离数据库探测失败（退出码 ${probe.status ?? 'null'}）：${(probe.stderr ?? '').slice(-800)}`);
  }
}

/** Seed the isolated DB via `tsx prisma/seed.ts` (honours DATABASE_URL). */
function seedDatabase(): void {
  const seed = cliCommand(resolveTsxBin(REPO_ROOT), ['tsx', path.join('prisma', 'seed.ts')]);
  runCliStep(seed.command, seed.args, { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: DB_URL } });
}

/** Delete + re-provision (current schema) + re-seed the ISOLATED DB. Idempotent on every run. */
function resetIsolatedDatabase(): void {
  ensurePrismaClientGenerated(REPO_ROOT);
  provisionSchemaLadder({
    repoRoot: REPO_ROOT,
    dbDir: path.join(REPO_ROOT, 'prisma'),
    dbFiles: DB_FILES,
    env: { ...process.env, DATABASE_URL: DB_URL },
    rungs: [{ label: 'db push', args: ['prisma', 'db', 'push'] }],
    afterPush: () => {
      probeDatabaseUsable();
      seedDatabase();
    },
  });
}

// --- app server -----------------------------------------------------------------------------------

interface ServerHandle {
  readonly port: number;
  readonly baseUrl: string;
  readonly pid: number;
  readonly output: () => string;
  readonly stop: () => void;
}

let activeServer: ServerHandle | undefined;

/** Pick a free TCP port at runtime (bind :0, read the assigned port, close). */
function pickFreePort(): Promise<number> {
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

/** Kill a process and all of its descendants (Windows needs `taskkill /T`; POSIX uses the group). */
function killProcessTree(pid: number): void {
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

/** The project-local Next CLI, launched with the SAME Node that runs this harness. */
function nextBin(): string {
  const local = path.join(REPO_ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  if (!existsSync(local)) throw new Error(`找不到本地 Next CLI：${local}（请先 pnpm install）`);
  return local;
}

/** Boot `next dev` on `port` with the ISOLATED DB and `LLM_MODE=mock` (no live model, no `.env.local`). */
function startServer(port: number): ServerHandle {
  const child: ChildProcess = spawn(process.execPath, [nextBin(), 'dev', '-p', String(port)], {
    cwd: REPO_ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      BANKING_NEXT_DIST_DIR: NEXT_DIST_DIR,
      DEMO_USER_ID: DEMO_USER_ID,
      DATABASE_URL: DB_URL,
      // Nothing in this harness talks to a model; pin the deterministic provider so a stray call
      // can never reach a real LLM.
      LLM_MODE: 'mock',
    },
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error('无法启动 next dev（未获得 pid）');

  let log = '';
  const append = (chunk: Buffer | string): void => {
    log = (log + chunk.toString()).slice(-16_000);
  };
  child.stdout?.on('data', append);
  child.stderr?.on('data', append);
  child.on('error', (e) => append(`[spawn error] ${e.message}\n`));

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    process.removeListener('exit', stop);
    killProcessTree(pid);
    try {
      child.unref();
    } catch {
      /* non-fatal */
    }
  };
  process.once('exit', stop);
  return { port, baseUrl: `http://localhost:${port}`, pid, output: () => log, stop };
}

/** One readiness probe of `GET /api/health`. */
async function probeHealth(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/api/health`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return `HTTP ${res.status}`;
    const body = (await res.json()) as { ok?: unknown; data?: { status?: unknown; llmMode?: unknown } };
    if (body.ok !== true || body.data?.status !== 'ok') return `非预期响应体：${compact(body, 200)}`;
    if (body.data.llmMode !== 'mock') return `llmMode 期望 mock，实际 ${String(body.data.llmMode)}`;
    return undefined;
  } catch (e) {
    return errText(e);
  }
}

/** One readiness probe of `GET /agent` (the SSR page must serve its composer). */
async function probeAgentPage(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${url}/agent`, { headers: { Accept: 'text/html' } });
    if (!res.ok) return `HTTP ${res.status}`;
    const html = await res.text();
    return html.includes('data-chat-composer="true"') ? undefined : 'The assistant page did not render its message composer';
  } catch (e) {
    return errText(e);
  }
}

/** Poll `/api/health` AND `/agent` until both are ready (bounded). */
async function waitForReady(handle: ServerHandle, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let health = '尚无响应';
  let page = '尚未请求';
  let healthOk = false;
  for (;;) {
    if (!healthOk) {
      const detail = await probeHealth(handle.baseUrl);
      if (detail === undefined) healthOk = true;
      else health = detail;
    }
    if (healthOk) {
      const detail = await probeAgentPage(handle.baseUrl);
      if (detail === undefined) return;
      page = detail;
    }
    if (Date.now() > deadline) {
      throw new Error(`应用未就绪（${timeoutMs}ms）：/api/health=${health}；/agent=${page}；dev-server 尾部：${handle.output().slice(-1200)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Stop the server (whole tree) and prove the port is free again by binding it. */
async function stopServerAndProvePortFree(handle: ServerHandle): Promise<boolean> {
  handle.stop();
  // `taskkill` is synchronous, but Next's children may take a moment to release the listener.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.listen(handle.port, '127.0.0.1', () => probe.close(() => resolve(true)));
    });
    if (free) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

// --- the cases ------------------------------------------------------------------------------------

interface CaseEnvelopeCard {
  id: string;
  type: string;
  status: string;
  monthlyLimit?: string;
  linkedAccountId?: string;
  payableAmount?: string;
  accountAvailableBalance?: string;
}

/** Read one card from the HTTP read model `GET /api/cards`. */
async function readCardHttp(id: string): Promise<CaseEnvelopeCard | undefined> {
  const data = expectOkData(await call('GET', '/api/cards'));
  const cards = field(data, 'cards');
  if (!Array.isArray(cards)) throw new Error(`GET /api/cards 的 cards 不是数组：${compact(cards, 400)}`);
  return (cards as CaseEnvelopeCard[]).find((card) => card.id === id);
}

/**
 * SETUP — establish a VIRTUAL card with a 100.00 CNY monthly limit on `acct_checking` through the
 * REAL product route: a manual card proposal (`POST /api/cards`) committed by its MFA verification
 * (`POST /api/cards/changes/[id]/verify`). No direct DB write and no SDK call stands in for HTTP.
 */
async function setupVirtualCard(note: (key: string, value: unknown) => void): Promise<string> {
  const requestId = crypto.randomUUID();
  const proposal = expectOkData(await call('POST', '/api/cards', {
    requestId,
    type: 'VIRTUAL',
    monthlyLimit: CARD_MONTHLY_LIMIT,
    linkedAccountId: CHECKING_ACCOUNT_ID,
  }));
  const change = field(proposal, 'change');
  if (!change || typeof change !== 'object') throw new Error(`卡片提案响应缺少 change：${compact(proposal, 600)}`);
  const changeRecord = change as Record<string, unknown>;
  const changeId = field(changeRecord, 'id');
  if (typeof changeId !== 'string' || changeId === '') throw new Error(`卡片提案缺少 change.id：${compact(changeRecord, 600)}`);
  note('changeId', changeId);
  note('proposalStatus', changeRecord.status);

  const verified = expectOkData(await call('POST', `/api/cards/changes/${encodeURIComponent(changeId)}/verify`, { code: MFA_CODE }));
  if (verified.ok !== true) throw new Error(`MFA 校验未通过：${compact(verified, 800)}`);
  const verifiedChange = field(verified, 'change');
  if (!verifiedChange || typeof verifiedChange !== 'object') throw new Error(`校验响应缺少 change：${compact(verified, 600)}`);
  const verifiedRecord = verifiedChange as Record<string, unknown>;
  assertEqual(verifiedRecord.status, 'executed', '卡片变更状态');
  const card = field(verifiedRecord, 'card');
  if (!card || typeof card !== 'object') throw new Error(`校验响应缺少 card：${compact(verifiedRecord, 600)}`);
  const cardRecord = card as Record<string, unknown>;
  const id = field(cardRecord, 'id');
  if (typeof id !== 'string' || id === '') throw new Error(`新卡片缺少 id：${compact(cardRecord, 600)}`);
  cardId = id;
  note('cardId', id);
  assertEqual(cardRecord.type, 'VIRTUAL', '新卡片类型');
  assertEqual(cardRecord.status, 'ACTIVE', '新卡片状态');
  assertMoney(String(field(cardRecord, 'monthlyLimit')), CARD_MONTHLY_LIMIT, '新卡片月限额');
  assertEqual(cardRecord.linkedAccountId, CHECKING_ACCOUNT_ID, '新卡片绑定账户');

  // The authoritative row must agree with the HTTP projection.
  const client = await db();
  const row = await client.card.findUnique({ where: { id } });
  if (!row) throw new Error(`SQLite 中缺少卡片 ${id}`);
  assertEqual(row.type, 'VIRTUAL', 'DB 卡片类型');
  assertEqual(row.status, 'ACTIVE', 'DB 卡片状态');
  assertEqual(row.monthlyLimitMinor, CARD_MONTHLY_LIMIT_MINOR, 'DB 月限额（minor）');
  assertEqual(row.linkedAccountId, CHECKING_ACCOUNT_ID, 'DB 绑定结算账户');

  // The read model must expose the same limit and the derived payable amount.
  const httpCard = await readCardHttp(id);
  if (!httpCard) throw new Error(`GET /api/cards 未返回卡片 ${id}`);
  assertMoney(String(httpCard.monthlyLimit), CARD_MONTHLY_LIMIT, 'GET /api/cards 月限额');
  const created = await snapshot();
  note('card', { id: row.id, type: row.type, status: row.status, monthlyLimit: centsToMoney(row.monthlyLimitMinor ?? 0n), linkedAccountId: row.linkedAccountId });
  note('db', created);

  return `虚拟卡 ${id} 经 POST /api/cards + /verify 建立：type=VIRTUAL、status=ACTIVE、monthlyLimit=${CARD_MONTHLY_LIMIT}、linkedAccountId=${CHECKING_ACCOUNT_ID}（HTTP 与 SQLite 一致）`;
}

/**
 * CASE c1 — consume 10.00 with NO `occurredAt`: must succeed and move exactly 10.00, once.
 */
async function caseNormalFirstSpend(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const before = await snapshot();
  note('before', before);
  const data = expectOkData(await call('POST', `/api/cards/${encodeURIComponent(cardId)}/consume`, {
    amount: FIRST_SPEND,
    category: '购物',
    merchant: '边界测试商户',
  }));
  const consumption = field(data, 'consumption');
  if (!consumption || typeof consumption !== 'object') throw new Error(`消费响应缺少 consumption：${compact(data, 600)}`);
  assertMoney(String(field(consumption as Record<string, unknown>, 'amount')), FIRST_SPEND, '响应消费金额');
  assertMoney(String(field(data, 'accountAvailableBalance')), centsToMoney(moneyToCents(before.checkingBalance) - moneyToCents(FIRST_SPEND)), '消费后可用余额');

  const after = await snapshot();
  note('after', after);
  assertMoney(deltaCents(after.checkingBalance, before.checkingBalance), `-${FIRST_SPEND}`, '活期余额变化');
  assertEqual(after.cardConsumptionCount - before.cardConsumptionCount, 1, 'CardConsumption 新增条数');
  assertMoney(deltaCents(after.cardConsumptionTotal, before.cardConsumptionTotal), FIRST_SPEND, 'CardConsumption 新增金额');
  assertEqual(after.cardChannelDebitCount - before.cardChannelDebitCount, 1, 'channel=CARD/DEBIT 流水新增条数');
  assertMoney(deltaCents(after.cardChannelMonthDebitTotal, before.cardChannelMonthDebitTotal), FIRST_SPEND, '本月 CARD 流水新增金额');
  assertEqual(after.forgedAmountRows, 0, `库中 ${FORGED_SPEND} 行数`);

  return `正常消费 ${FIRST_SPEND}：余额 ${before.checkingBalance} → ${after.checkingBalance}（恰好 -${FIRST_SPEND}）、CARD/DEBIT 流水 +1、CardConsumption +1`;
}

/**
 * CASE c2 — replay the repro's tamper: 90.00 with a PREVIOUS business month `occurredAt`.
 * Must be refused as VALIDATION and must leave the ledger byte-identical.
 */
async function casePreviousMonthTamper(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const previous = previousMonthRange(new Date(demoNow()));
  const forgedInstant = previous.start.getTime() + 12 * 60 * 60 * 1000;
  const forgedAt = new Date(forgedInstant).toISOString();
  // `businessCalendarParts` takes an INSTANT (Date | epoch ms) — handing it the ISO STRING would
  // concatenate instead of add (string + number) and yield NaN, making the guard below vacuous.
  const forgedParts = businessCalendarParts(forgedInstant);
  const currentParts = businessCalendarParts(demoNow());
  note('occurredAt', forgedAt);
  note('forgedMonth', forgedParts);
  note('currentMonth', currentParts);
  if (!Number.isFinite(forgedParts.year) || !Number.isFinite(forgedParts.month)) {
    throw new Error(`无法解析伪造时间的业务月：${forgedAt} → ${compact(forgedParts, 200)}`);
  }
  if (forgedParts.year === currentParts.year && forgedParts.month === currentParts.month) {
    throw new Error(`伪造时间 ${forgedAt} 与当前业务月相同，用例失去意义`);
  }

  const before = await snapshot();
  note('before', before);
  const error = expectErrorEnvelope(
    await call('POST', `/api/cards/${encodeURIComponent(cardId)}/consume`, { amount: FORGED_SPEND, occurredAt: forgedAt }),
    400,
    'VALIDATION',
  );
  note('error', error);
  for (const fragment of SERVER_OWNED_MESSAGE_FRAGMENTS) {
    if (!error.message.includes(fragment)) {
      throw new Error(`拒绝信息缺少「${fragment}」：${error.message}`);
    }
  }
  const after = await snapshot();
  note('after', after);
  assertMoney(after.checkingBalance, before.checkingBalance, '拒绝后活期余额');
  assertEqual(after.cardConsumptionCount, before.cardConsumptionCount, '拒绝后 CardConsumption 条数');
  assertMoney(after.cardConsumptionTotal, before.cardConsumptionTotal, '拒绝后 CardConsumption 金额');
  assertEqual(after.cardChannelDebitCount, before.cardChannelDebitCount, '拒绝后 CARD/DEBIT 流水条数');
  assertMoney(after.cardChannelMonthDebitTotal, before.cardChannelMonthDebitTotal, '拒绝后本月 CARD 流水金额');
  assertEqual(after.forgedAmountRows, 0, `库中 ${FORGED_SPEND} 行数`);

  const noBody = await call('GET', `/api/cards/${encodeURIComponent(cardId)}/consumptions?limit=50`);
  const consumptions = expectOkData(noBody).consumptions;
  if (!Array.isArray(consumptions)) throw new Error(`consumptions 不是数组：${compact(consumptions, 400)}`);
  assertEqual(consumptions.length, before.cardConsumptionCount, 'HTTP 消费列表条数');
  note('httpConsumptions', consumptions.length);

  return `上月伪造时间 ${forgedAt}（${forgedParts.year}-${forgedParts.month + 1}）消费 ${FORGED_SPEND} → 400 VALIDATION「${error.message}」；余额仍 ${after.checkingBalance}、无新流水、无新 CardConsumption`;
}

/**
 * CASE c3 — a legal 1.00 spend; the current business month must then total EXACTLY 11.00.
 */
async function caseSecondSpendAndMonthTotal(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const before = await snapshot();
  note('before', before);
  const data = expectOkData(await call('POST', `/api/cards/${encodeURIComponent(cardId)}/consume`, {
    amount: SECOND_SPEND,
    category: '餐饮',
    merchant: '边界测试商户2',
  }));
  assertMoney(String(field(data as Record<string, unknown>, 'accountAvailableBalance')), centsToMoney(moneyToCents(before.checkingBalance) - moneyToCents(SECOND_SPEND)), '消费后可用余额');
  const after = await snapshot();
  note('after', after);

  assertMoney(after.cardMonthConsumptionTotal, EXPECTED_MONTH_TOTAL, '本业务月该卡 CardConsumption 合计');
  assertMoney(deltaCents(after.cardChannelMonthDebitTotal, before.cardChannelMonthDebitTotal), SECOND_SPEND, '本月 CARD 流水新增金额');
  assertEqual(after.cardConsumptionCount, 2, '该卡 CardConsumption 总条数');
  assertMoney(after.cardConsumptionTotal, EXPECTED_MONTH_TOTAL, '该卡 CardConsumption 累计（全部月份）');
  assertEqual(after.forgedAmountRows, 0, `库中 ${FORGED_SPEND} 行数`);
  return `正常消费 ${SECOND_SPEND}：本业务月该卡入账合计 = ${after.cardMonthConsumptionTotal}（期望 ${EXPECTED_MONTH_TOTAL}），${FORGED_SPEND} 从未进入任何月份的入账合计`;
}

/**
 * CASE c4 — a FUTURE `occurredAt` is refused identically (same status, code, message and zero side effects).
 */
async function caseFutureTamper(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const futureAt = new Date(demoNow() + 90 * 24 * 60 * 60 * 1000).toISOString();
  note('occurredAt', futureAt);
  const before = await snapshot();
  note('before', before);
  const error = expectErrorEnvelope(
    await call('POST', `/api/cards/${encodeURIComponent(cardId)}/consume`, { amount: FORGED_SPEND, occurredAt: futureAt }),
    400,
    'VALIDATION',
  );
  note('error', error);
  for (const fragment of SERVER_OWNED_MESSAGE_FRAGMENTS) {
    if (!error.message.includes(fragment)) throw new Error(`拒绝信息缺少「${fragment}」：${error.message}`);
  }
  const after = await snapshot();
  note('after', after);
  assertMoney(after.checkingBalance, before.checkingBalance, '拒绝后活期余额');
  assertEqual(after.cardConsumptionCount, before.cardConsumptionCount, '拒绝后 CardConsumption 条数');
  assertMoney(after.cardMonthConsumptionTotal, before.cardMonthConsumptionTotal, '拒绝后本月合计');
  assertEqual(after.cardChannelDebitCount, before.cardChannelDebitCount, '拒绝后 CARD/DEBIT 流水条数');
  assertEqual(after.forgedAmountRows, 0, `库中 ${FORGED_SPEND} 行数`);
  return `未来时间 ${futureAt} 消费 ${FORGED_SPEND} → 400 VALIDATION「${error.message}」；余额仍 ${after.checkingBalance}、无新流水`;
}

/**
 * CASE c5 — a MALFORMED `occurredAt` ("not-a-date") is refused by the SAME server-owned rule
 * (not by a generic body-shape error), with zero side effects.
 */
async function caseMalformedTamper(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const before = await snapshot();
  note('before', before);
  const error = expectErrorEnvelope(
    await call('POST', `/api/cards/${encodeURIComponent(cardId)}/consume`, { amount: FORGED_SPEND, occurredAt: 'not-a-date' }),
    400,
    'VALIDATION',
  );
  note('error', error);
  for (const fragment of SERVER_OWNED_MESSAGE_FRAGMENTS) {
    if (!error.message.includes(fragment)) {
      throw new Error(`畸形 occurredAt 未命中「服务端拥有时间」拒绝，实际信息：${error.message}`);
    }
  }
  const after = await snapshot();
  note('after', after);
  assertMoney(after.checkingBalance, before.checkingBalance, '拒绝后活期余额');
  assertEqual(after.cardConsumptionCount, before.cardConsumptionCount, '拒绝后 CardConsumption 条数');
  assertMoney(after.cardMonthConsumptionTotal, before.cardMonthConsumptionTotal, '拒绝后本月合计');
  assertEqual(after.forgedAmountRows, 0, `库中 ${FORGED_SPEND} 行数`);
  return `畸形 occurredAt="not-a-date" 消费 ${FORGED_SPEND} → 400 VALIDATION「${error.message}」；零副作用`;
}

/**
 * CASE c6 — a body carrying `occurredAt: null` is ALSO refused (key presence decides, not the value).
 */
async function caseNullTamper(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const before = await snapshot();
  note('before', before);
  const error = expectErrorEnvelope(
    await call('POST', `/api/cards/${encodeURIComponent(cardId)}/consume`, { amount: FORGED_SPEND, occurredAt: null }),
    400,
    'VALIDATION',
  );
  note('error', error);
  for (const fragment of SERVER_OWNED_MESSAGE_FRAGMENTS) {
    if (!error.message.includes(fragment)) throw new Error(`occurredAt:null 未命中服务端时间拒绝，实际信息：${error.message}`);
  }
  const after = await snapshot();
  note('after', after);
  assertMoney(after.checkingBalance, before.checkingBalance, '拒绝后活期余额');
  assertEqual(after.cardConsumptionCount, before.cardConsumptionCount, '拒绝后 CardConsumption 条数');
  assertEqual(after.forgedAmountRows, 0, `库中 ${FORGED_SPEND} 行数`);
  return `occurredAt:null 消费 ${FORGED_SPEND} → 400 VALIDATION「${error.message}」；零副作用`;
}

/**
 * CASE c7 — the VISIBLE remaining allowance proves the forged 90.00 never consumed headroom:
 * `payableAmount = min(account cash, 100.00 - 11.00) = 89.00`.
 */
async function casePayableAllowance(note: (key: string, value: unknown) => void): Promise<string> {
  if (cardId === undefined) throw new Error('setup 未提供卡片 id');
  const httpCard = await readCardHttp(cardId);
  if (!httpCard) throw new Error(`GET /api/cards 未返回卡片 ${cardId}`);
  const availableMinor = moneyToCents(String(httpCard.accountAvailableBalance));
  const remainingMinor = CARD_MONTHLY_LIMIT_MINOR - EXPECTED_MONTH_TOTAL_MINOR;
  const expectedMinor = availableMinor < remainingMinor ? availableMinor : remainingMinor;
  const expected = centsToMoney(expectedMinor);
  note('httpCard', httpCard);
  note('expectedPayable', expected);
  assertMoney(String(httpCard.payableAmount), expected, 'GET /api/cards 可支付金额');
  assertMoney(centsToMoney(remainingMinor), EXPECTED_REMAINING_LIMIT, `剩余月限额（${CARD_MONTHLY_LIMIT} - ${EXPECTED_MONTH_TOTAL}）`);
  const snap = await snapshot();
  note('db', snap);
  assertMoney(snap.cardMonthConsumptionTotal, EXPECTED_MONTH_TOTAL, '本业务月该卡入账合计');
  return `GET /api/cards 可支付金额 = ${String(httpCard.payableAmount)}（min(账户余额 ${String(httpCard.accountAvailableBalance)}, 剩余月限额 ${EXPECTED_REMAINING_LIMIT})）；若 ${FORGED_SPEND} 曾入账，此处会是 ${centsToMoney(remainingMinor - FORGED_SPEND_MINOR)}`;
}

// --- main ------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(LOGS_DIR, { recursive: true });
  console.log('=== date-tamper-boundary.e2e.ts — RAW-HTTP BOUNDARY TEST (no browser, no model) ===');
  console.log(`repo        : ${REPO_ROOT}`);
  console.log(`isolated db : ${DB_PATH}`);
  console.log(`dist dir    : ${NEXT_DIST_DIR}`);
  const current = businessCalendarParts(demoNow());
  // The SAME half-open UTC+08:00 month window the app books consumes into (`demoMonthRange`).
  businessMonth = monthRange(new Date(demoNow()));
  console.log(`business    : now=${new Date(demoNow()).toISOString()} month=${current.year}-${current.month + 1} window=[${businessMonth.start.toISOString()}, ${businessMonth.end.toISOString()})`);

  // 1) Provision the ISOLATED database (delete + db push + seed) so every run starts identically.
  console.log('· 准备隔离数据库（删除 → prisma db push → tsx prisma/seed.ts）…');
  resetIsolatedDatabase();
  console.log('· 隔离数据库就绪');

  // 2) Boot the app on a free port against that DB.
  const port = await pickFreePort();
  const server = startServer(port);
  activeServer = server;
  baseUrl = server.baseUrl;
  console.log(`· next dev 启动中：port=${port} pid=${server.pid}`);
  await waitForReady(server);
  console.log(`· 应用就绪：${baseUrl}（llmMode=mock 已由 /api/health 校验）`);

  // 3) SETUP — establish the 100.00-limit VIRTUAL card over HTTP.
  await runCase('s0-virtual-card-100-limit', 'SETUP', setupVirtualCard);
  if (cardId === undefined) {
    // Every remaining case depends on the card; report them honestly instead of crashing.
    for (const id of ['c1-consume-normal', 'c2-prev-month-tamper', 'c3-month-total-11', 'c4-future-tamper', 'c5-malformed-tamper', 'c6-null-tamper', 'c7-payable-allowance']) {
      record({ id, kind: 'CASE', status: 'SKIP', detail: 'setup 未建立虚拟卡，用例未执行（未验证）', exchangeSlice: [] });
    }
  } else {
    await runCase('c1-consume-normal', 'CASE', caseNormalFirstSpend);
    await runCase('c2-prev-month-tamper', 'CASE', casePreviousMonthTamper);
    await runCase('c3-month-total-11', 'CASE', caseSecondSpendAndMonthTotal);
    await runCase('c4-future-tamper', 'CASE', caseFutureTamper);
    await runCase('c5-malformed-tamper', 'CASE', caseMalformedTamper);
    await runCase('c6-null-tamper', 'CASE', caseNullTamper);
    await runCase('c7-payable-allowance', 'CASE', casePayableAllowance);
  }

  // 4) EXTRA — model-facing seam is not reachable over HTTP in mock mode (SKIP, never PASS).
  const seamStart = exchanges.length;
  record({
    id: 'x1-model-seam-http',
    kind: 'EXTRA',
    status: 'SKIP',
    detail:
      '模型侧接缝（agent/tools/card.ts#runConsumeVirtualCard 的时间字段拒绝）无法在无真实模型的前提下经 HTTP 驱动：mock 提供者未脚本化 consume_virtual_card，也没有携带任意工具参数创建 PendingAction 的 HTTP 路由；本用例只断言路由层契约（POST /api/cards/[id]/consume），不声称覆盖模型侧。',
    db: {
      notVerified: [
        'agent/tools/card.ts:319-338 CLIENT_TIME_FIELDS 拒绝逻辑未执行',
        'agent/providers/mock/card-intents.ts 无 consume_virtual_card 意图',
        '无 HTTP 路由可用任意工具参数创建 PendingAction（POST /api/cards 仅创建手工卡片变更）',
      ],
    },
    exchangeSlice: exchanges.slice(seamStart),
  });
}

/** Persist the machine-readable evidence (written even when cases failed). */
function writeEvidence(extra: Record<string, unknown>): void {
  const payload = {
    generatedAt: new Date().toISOString(),
    entry: 'tests/e2e/date-tamper-boundary.e2e.ts',
    kind: 'raw-http-boundary',
    model: 'mock (no model involvement)',
    isolatedDatabase: { path: DB_PATH, url: DB_URL, files: DB_FILES },
    baseUrl,
    cardId: cardId ?? null,
    businessClock: { demoNow: demoNow(), month: businessCalendarParts(demoNow()), previousMonth: previousMonthRange(new Date(demoNow())) },
    cases,
    summary: { total: cases.length, pass: passes, fail: failures, skip: skips },
    ...extra,
  };
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2)}\n`, 'utf8');
  console.log(`evidence    : ${EVIDENCE_PATH}`);
}

async function run(): Promise<void> {
  let setupError: string | undefined;
  try {
    await main();
  } catch (e) {
    setupError = errText(e);
    failures += 1;
    record({ id: 's9-harness', kind: 'SETUP', status: 'FAIL', detail: 'harness 启动/准备失败（未执行任何断言）', exchangeSlice: [], error: setupError });
    console.error(`HARNESS FAILURE — ${setupError}`);
  } finally {
    let portFreed: boolean | undefined;
    if (activeServer !== undefined) {
      portFreed = await stopServerAndProvePortFree(activeServer);
      console.log(`port ${activeServer.port} freed: ${portFreed ? 'YES' : 'NO'}`);
    }
    if (dbClientHandle !== undefined) {
      await dbClientHandle.$disconnect().catch(() => undefined);
    }
    try {
      writeEvidence({ serverPort: activeServer?.port ?? null, serverPortFreed: portFreed ?? null, setupError: setupError ?? null });
    } catch (e) {
      console.error(`证据写入失败：${errText(e)}`);
      failures += 1;
    }
    const total = cases.length;
    console.log(
      `SUMMARY cases=${total} pass=${passes} fail=${failures} skip=${skips} → exit code ${failures > 0 ? 1 : 0}` +
        '（本入口为 RAW-HTTP 边界测试：不驱动浏览器、不调用模型、结论仅覆盖 HTTP 响应 + SQLite 行）',
    );
    process.exitCode = failures > 0 ? 1 : 0;
  }
}

void run();
