/**
 * `tests/e2e/live-acceptance.e2e.ts` — REAL-BROWSER, **LIVE-LLM** acceptance harness.
 *
 * Unlike `acceptance.e2e.ts` (which scripts the model with `LLM_MODE=mock`), this harness boots the
 * REAL Next.js dev server against the REAL DeepSeek API (`LLM_MODE=live`, `LLM_PROVIDER=deepseek`)
 * and drives the REAL `/agent` UI through a REAL headless Chrome. Only the bank is simulated (SQLite).
 *
 * ------------------------------------------------------------------------------------------------
 * DISCLOSED MODEL-ID OVERRIDE
 * ------------------------------------------------------------------------------------------------
 * The provided `.env.local` sets `LLM_MODEL=deepseek-flash`, which is NOT a registered pi-ai model id:
 * pi-ai's `deepseek` registry exposes ONLY `deepseek-v4-flash` / `deepseek-v4-pro`. When the id is
 * unregistered, `agent/providers/provider-live.ts` (lines 18-19, 59-70) falls back to a literal
 * `Model` with `baseUrl: 'https://api.openai.com/v1'`, so the DeepSeek key is sent to OpenAI and every
 * LLM call fails with `401 Incorrect API key provided: ...`. (App DEFECT — reported, never patched.)
 *
 * To still exercise the LIVE DeepSeek API this harness sets `process.env.LLM_MODEL='deepseek-v4-flash'`
 * (a REGISTERED id → baseUrl `https://api.deepseek.com`, api `openai-completions`) BEFORE booting.
 * Everything else (key, provider, base URL, mock off) is the provided `.env.local` unchanged. Every
 * result below is therefore labelled "LIVE with disclosed model-id override".
 *
 * Run:  npx tsx tests/e2e/live-acceptance.e2e.ts
 * Subset: `LIVE_SCENARIOS=1,3` (comma-separated scenario ids) runs only those journeys.
 *
 * Output contract: one `PASS|FAIL|SKIP <scenario> — <evidence>` line per scenario; exit non-zero iff
 * any scenario FAILED. The whole dev-server process tree and the browser are always torn down.
 *
 * Isolation: provisions and uses its OWN SQLite DB (`prisma/live-acceptance.db`); the shared
 * `prisma/dev.db` and the Vitest `prisma/test.db` are NEVER referenced.
 *
 * A filename ending in `.e2e.ts` does NOT match vitest's `tests/**\/*.{test,spec}.ts` glob, so this
 * harness never runs under `npm run test`.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import type { PrismaClient } from '@prisma/client';
import {
  cliCommand,
  ensurePrismaClientGenerated,
  provisionSchemaLadder,
  resolveTsxBin,
  runPrismaGenerate,
  runCliStep as runCliStepShared,
} from '../helpers/prisma-cli';
import { formatCNY } from '../../lib/money';
import {
  NAV_TIMEOUT_MS,
  REPO_ROOT,
  SCREENSHOTS_DIR,
  assistantTexts,
  bootDevServer,
  captureScreenshot,
  createReporter,
  diffLedger,
  errText,
  fetchDashboardSummary,
  fetchLedger,
  fetchPendingActions,
  gotoAgent,
  launchBrowser,
  readSessionCookie,
  resolveBrowserExecutable,
  sleep,
  submitChat,
  submitMfa,
  waitFor,
  waitForConfirmCard,
  waitForMfaCard,
  waitForStatusText,
  withPage,
  type DevServer,
  type LedgerView,
  type Reporter,
} from './helpers';

// --- isolated LIVE database ---------------------------------------------------------------------

const LIVE_DB_FILES = ['live-acceptance.db', 'live-acceptance.db-wal', 'live-acceptance.db-shm', 'live-acceptance.db-journal'] as const;
/** Absolute `file:` URL (forward slashes — Prisma rejects a Windows backslash URL). */
const LIVE_DB_URL = `file:${path.join(REPO_ROOT, 'prisma', 'live-acceptance.db').split(path.sep).join('/')}`;

const DEMO_CHECKING_ID = 'acct_checking';
const RECIPIENT_NAME = '张伟';
const RECIPIENT_CONTACT_ID = 'contact_zhangwei';
const CREDIT_CARD_ID = 'card_credit';

/** Point this process — provisioning CLIs + the spawned dev server — at the ISOLATED live DB. */
function configureLiveEnv(): void {
  process.env['DATABASE_URL'] = LIVE_DB_URL;
  process.env['LLM_MODE'] = 'live';
  process.env['LLM_PROVIDER'] = 'deepseek';
  // DISCLOSED OVERRIDE — see the file header. `deepseek-flash` is not a registered pi-ai id.
  process.env['LLM_MODEL'] = 'deepseek-v4-flash';
}

/** Probe the freshly provisioned live DB (node child, so DATABASE_URL is applied before construction). */
function probeLiveDatabaseUsable(): void {
  const script = `
const { PrismaClient } = require('@prisma/client');
const client = new PrismaClient();
const check = "SELECT name FROM sqlite_master WHERE type='table' AND name='User'";
(async () => {
  try {
    const rows = await client.$queryRawUnsafe(check);
    if (!Array.isArray(rows) || rows.length === 0) { console.error('schema 未应用：缺少 User 表'); process.exitCode = 3; }
  } catch (e) { console.error((e && e.stack) || String(e)); process.exitCode = 2; }
  finally { await client.$disconnect().catch(() => {}); }
})();
`;
  const probe = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    windowsHide: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: LIVE_DB_URL },
  });
  if (probe.status !== 0) {
    throw new Error(`live DB 探测失败（退出码 ${probe.status ?? 'null'}）：${(probe.stderr ?? '').slice(-800)}`);
  }
}

/** Seed the isolated live DB via `tsx prisma/seed.ts` (honours DATABASE_URL). */
function seedLiveDatabase(): void {
  const seed = cliCommand(resolveTsxBin(REPO_ROOT), ['tsx', path.join('prisma', 'seed.ts')]);
  runCliStepShared(seed.command, seed.args, { cwd: REPO_ROOT, env: { ...process.env, DATABASE_URL: LIVE_DB_URL } });
}

/** Delete + re-provision + re-seed the ISOLATED live DB through the shared ordered push ladder. */
function resetLiveDatabase(): void {
  ensurePrismaClientGenerated(REPO_ROOT);
  provisionSchemaLadder({
    repoRoot: REPO_ROOT,
    dbDir: path.join(REPO_ROOT, 'prisma'),
    dbFiles: LIVE_DB_FILES,
    env: { ...process.env, DATABASE_URL: LIVE_DB_URL },
    rungs: [
      { label: 'db push --skip-generate', args: ['prisma', 'db', 'push', '--skip-generate'] },
      {
        label: 'prisma generate → db push --force-reset --skip-generate',
        args: ['prisma', 'db', 'push', '--force-reset', '--skip-generate'],
        before: () => runPrismaGenerate(REPO_ROOT, { ...process.env, DATABASE_URL: LIVE_DB_URL }),
      },
      { label: 'db push', args: ['prisma', 'db', 'push'] },
    ],
    afterPush: () => {
      probeLiveDatabaseUsable();
      seedLiveDatabase();
    },
  });
}

// --- authoritative DB cross-checks (throwaway PrismaClient) --------------------------------------

/** Run `fn` on a throwaway PrismaClient bound to the isolated live DB. */
async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const mod = (await import('@prisma/client')) as unknown as { PrismaClient: new () => PrismaClient };
  const db = new mod.PrismaClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

/** The CHECKING account balance (authoritative, straight from SQLite). */
function readCheckingBalance(): Promise<number> {
  return withDb(async (db) => {
    const account = await db.account.findUnique({ where: { id: DEMO_CHECKING_ID } });
    if (!account) throw new Error(`缺少账户 ${DEMO_CHECKING_ID}`);
    return account.balance;
  });
}

/** DEBIT `Transaction` rows on the CHECKING account, newest first. */
function readCheckingDebits(): Promise<{ id: string; amount: number; merchant: string }[]> {
  return withDb(async (db) =>
    db.transaction.findMany({
      where: { accountId: DEMO_CHECKING_ID, direction: 'DEBIT' },
      orderBy: { occurredAt: 'desc' },
      take: 20,
      select: { id: true, amount: true, merchant: true },
    }),
  );
}

/** The persisted status + result of one `PendingAction`. */
function readPendingAction(actionId: string): Promise<{ status: string; resultJson: string | null } | null> {
  return withDb(async (db) => {
    const row = await db.pendingAction.findUnique({ where: { id: actionId }, select: { status: true, resultJson: true } });
    return row ?? null;
  });
}

/** The seeded contact's phone (already masked in the seed) — used to phrase the by-phone prompt. */
function readContactPhone(contactId: string): Promise<string> {
  return withDb(async (db) => {
    const contact = await db.contact.findUnique({ where: { id: contactId }, select: { phone: true } });
    if (!contact) throw new Error(`缺少联系人 ${contactId}`);
    return contact.phone;
  });
}

// --- network / console instrumentation ----------------------------------------------------------

interface HttpIssue {
  method: string;
  url: string;
  status: number;
  body: string;
}

/** The provider's message-ordering violation (scenario 6 must prove it NEVER happens live). */
const TOOL_ORDER_MARKER = "must be a response to a preceding message with 'tool_calls'";

/** Collects every 4xx/5xx response, console error and page error across the whole run. */
const netLog: { issues: HttpIssue[]; consoleErrors: string[]; pageErrors: string[] } = {
  issues: [],
  consoleErrors: [],
  pageErrors: [],
};

function attachCollectors(page: Page): void {
  page.on('response', (res) => {
    const status = res.status();
    if (status < 400) return;
    const method = res.request().method();
    const url = res.url();
    void res
      .text()
      .then((text) => {
        netLog.issues.push({ method, url, status, body: text.slice(0, 800) });
        console.log(`· [net ${status}] ${method} ${url} — ${text.slice(0, 300).replace(/\s+/g, ' ')}`);
      })
      .catch(() => netLog.issues.push({ method, url, status, body: '<unreadable>' }));
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    netLog.consoleErrors.push(text);
    console.log(`· [console error] ${text.slice(0, 300)}`);
  });
  page.on('pageerror', (error) => {
    netLog.pageErrors.push(error.message);
    console.log(`· [pageerror] ${error.message.slice(0, 300)}`);
  });
}

function findToolOrderViolation(): HttpIssue | undefined {
  return netLog.issues.find((issue) => issue.status === 400 && issue.body.includes(TOOL_ORDER_MARKER));
}

// --- screenshots (live) -------------------------------------------------------------------------

const LIVE_SHOTS_DIR = path.join(SCREENSHOTS_DIR, 'live');
let liveShotSeq = 0;

/** Full-page screenshot into the git-ignored `screenshots/live/` dir (never throws). */
async function captureLive(page: Page, label: string): Promise<string | undefined> {
  try {
    mkdirSync(LIVE_SHOTS_DIR, { recursive: true });
    liveShotSeq += 1;
    const safe = label.replace(/[^\w.-]+/g, '_').slice(0, 60);
    const file = path.join(LIVE_SHOTS_DIR, `${String(liveShotSeq).padStart(2, '0')}-${safe}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return undefined;
  }
}

// --- DOM + read-model helpers -------------------------------------------------------------------

async function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText().catch(() => '');
}

/** Read the LAST rendered confirmation card's `dt`/`dd` label→value map (empty when none). */
async function readConfirmFields(page: Page): Promise<Record<string, string>> {
  const dls = page.locator('dl');
  const count = await dls.count();
  for (let i = count - 1; i >= 0; i -= 1) {
    const dl = dls.nth(i);
    const labels = (await dl.locator('dt').allInnerTexts()).map((l) => l.replace(/\s+/g, '').trim());
    if (!labels.includes('收款人')) continue;
    const values = (await dl.locator('dd').allInnerTexts()).map((v) => v.replace(/\s+/g, '').trim());
    const out: Record<string, string> = {};
    labels.forEach((label, index) => {
      out[label] = values[index] ?? '';
    });
    return out;
  }
  return {};
}

/** Click the confirmation card's `取消` button. */
async function clickCancel(page: Page, timeoutMs = 30_000): Promise<void> {
  const button = page.getByRole('button', { name: '取消', exact: true });
  await waitFor(async () => ((await button.count()) > 0 ? true : false), { timeoutMs, description: '确认卡「取消」按钮' });
  await button.first().click();
}

/** The number of rendered `确认` buttons (0 once a card is settled / gone). */
async function confirmButtonCount(page: Page): Promise<number> {
  return page.getByRole('button', { name: '确认', exact: true }).count();
}

/** The demo user's money state via the app's REAL read routes. */
async function snapshot(baseUrl: string): Promise<{ balance: number; ledger: LedgerView }> {
  const [dashboard, ledger] = await Promise.all([fetchDashboardSummary(baseUrl), fetchLedger(baseUrl)]);
  return { balance: dashboard.checkingBalance, ledger };
}

/** Wait until a transfer DEBIT of exactly `amount` shows up in the DB + ledger and the balance drops by it. */
async function waitForTransferSettled(
  baseUrl: string,
  before: { balance: number; ledger: LedgerView },
  amount: number,
  timeoutMs = 120_000,
): Promise<{ balance: number; dbBalance: number; txIds: string[]; occurrences: number }> {
  return waitFor(
    async () => {
      const [after, dbBalance, debits] = await Promise.all([
        snapshot(baseUrl),
        readCheckingBalance(),
        readCheckingDebits(),
      ]);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added.filter(
        (tx) => tx.amount === -amount && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
      );
      const matching = debits.filter((tx) => tx.amount === -amount && tx.merchant.includes(RECIPIENT_NAME));
      const expected = Math.round((before.balance - amount) * 100) / 100;
      if (after.balance !== expected || dbBalance !== expected || added.length !== 1) return false;
      return { balance: after.balance, dbBalance, txIds: added.map((tx) => tx.id), occurrences: matching.length };
    },
    {
      timeoutMs,
      description: `转账 ${amount} 已落库：余额 ${before.balance} → ${before.balance - amount}，账本新增 1 条 -${amount} DEBIT`,
    },
  );
}

/** Assert a confirmation card's recipient is the SERVER-RESOLVED real name with a MASKED phone. */
function assertRecipient(fields: Record<string, string>, expectName: string): string {
  const name = fields['收款人'] ?? '';
  const phone = fields['收款手机号'] ?? '';
  const joined = JSON.stringify(fields);
  if (joined.includes('（未指定）')) throw new Error(`确认卡出现「（未指定）」：${joined}`);
  if (name !== expectName) throw new Error(`确认卡收款人应为「${expectName}」，实际「${name}」（字段：${joined}）`);
  if (!/^\d{3}\*{4}\d{3,4}$/.test(phone)) throw new Error(`确认卡收款手机号应为掩码号码，实际「${phone}」（字段：${joined}）`);
  return `${name} / ${phone}`;
}

// --- scenario scaffolding ------------------------------------------------------------------------

interface ServerHandle {
  current: DevServer;
}
interface Ctx {
  browser: Browser;
  baseUrl: string;
  server: ServerHandle;
}
interface Scenario {
  id: string;
  name: string;
  run(ctx: Ctx): Promise<string>;
}

// Prompts phrased against the real tool schemas / seed (see prisma/seed.ts + agent/system-prompt.ts).
const MSG = {
  balance: '查一下我的余额',
  transferByName: `给${RECIPIENT_NAME}转200元`,
  transferByPhone: (phone: string) => `给${phone}转200元`,
  transferDecimal: `给${RECIPIENT_NAME}转200.37元`,
  transferLarge: `给${RECIPIENT_NAME}转5000元`,
  cardLimit: '我的信用卡额度是多少',
} as const;

const TRANSFER_AMOUNT = 200;
const DECIMAL_AMOUNT = 200.37;
const LARGE_AMOUNT = 5000;

// --- scenario 1: balance matches the DB ---------------------------------------------------------

async function scenarioBalance(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const dbBalance = await readCheckingBalance();
      const apiBalance = (await fetchDashboardSummary(ctx.baseUrl)).checkingBalance;
      if (dbBalance !== apiBalance) {
        throw new Error(`/api/dashboard 余额 ${apiBalance} 与 SQLite Account.balance ${dbBalance} 不一致`);
      }
      const expected = formatCNY(dbBalance);
      await submitChat(page, MSG.balance);
      await waitFor(async () => ((await bodyText(page)).includes(expected) ? true : false), {
        timeoutMs: 120_000,
        description: `页面渲染余额 ${expected}`,
      });
      const texts = await assistantTexts(page);
      const narration = texts.find((t) => t.includes(expected)) ?? texts[texts.length - 1] ?? '';
      await captureLive(page, 's1-balance');
      const inNarration = narration.includes(expected);
      return `「${MSG.balance}」→ 页面出现 ${expected}；SQLite Account.balance=${dbBalance}，/api/dashboard=${apiBalance}（一致）；助手叙述${inNarration ? '含' : '不含'}该金额：${narration.slice(0, 120)}`;
    },
    { label: 's1-balance' },
  );
}

// --- scenario 2: transfer by NAME and by PHONE → correct recipient, then CANCEL -------------------

async function scenarioTransferRecipients(ctx: Ctx): Promise<string> {
  const byName = await withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      await submitChat(page, MSG.transferByName);
      await waitForConfirmCard(page);
      const fields = await readConfirmFields(page);
      const resolved = assertRecipient(fields, RECIPIENT_NAME);
      await captureLive(page, 's2-by-name');
      await clickCancel(page);
      const after = await snapshot(ctx.baseUrl);
      if (after.balance !== before.balance) throw new Error(`取消后余额变化：${before.balance} → ${after.balance}`);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`取消后账本新增：${added.map((tx) => tx.id).join('、')}`);
      return `「${MSG.transferByName}」→ 确认卡收款人=${resolved}（真实姓名 + 掩码手机号）；取消 → 余额 ${before.balance} 未变、账本无新增`;
    },
    { label: 's2-by-name' },
  );

  const phone = await readContactPhone(RECIPIENT_CONTACT_ID);
  const byPhone = await withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      await submitChat(page, MSG.transferByPhone(phone));
      await waitForConfirmCard(page);
      const fields = await readConfirmFields(page);
      const resolved = assertRecipient(fields, RECIPIENT_NAME);
      await captureLive(page, 's2-by-phone');
      await clickCancel(page);
      const after = await snapshot(ctx.baseUrl);
      if (after.balance !== before.balance) throw new Error(`取消后余额变化：${before.balance} → ${after.balance}`);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`取消后账本新增：${added.map((tx) => tx.id).join('、')}`);
      return `「${MSG.transferByPhone(phone)}」（库里手机号 ${phone}）→ 确认卡收款人=${resolved}；取消 → 未动账`;
    },
    { label: 's2-by-phone' },
  );

  return `按姓名：${byName} ｜ 按手机号：${byPhone}`;
}

// --- scenario 3: decimal transfer ¥200.37 --------------------------------------------------------

async function scenarioDecimalTransfer(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      const beforeDb = await readCheckingBalance();
      await submitChat(page, MSG.transferDecimal);
      await waitForConfirmCard(page);
      const fields = await readConfirmFields(page);
      if (!JSON.stringify(fields).includes('200.37')) {
        throw new Error(`确认卡金额应为 200.37，实际字段：${JSON.stringify(fields)}`);
      }
      // BEFORE confirm: NOTHING has moved.
      const mid = await snapshot(ctx.baseUrl);
      const midDb = await readCheckingBalance();
      if (mid.balance !== before.balance || midDb !== beforeDb) {
        throw new Error(`确认前余额已变化：API ${before.balance}→${mid.balance}，DB ${beforeDb}→${midDb}`);
      }
      await captureLive(page, 's3-decimal-preconfirm');
      await page.getByRole('button', { name: '确认', exact: true }).first().click();
      const settled = await waitForTransferSettled(ctx.baseUrl, before, DECIMAL_AMOUNT);
      const afterDb = await readCheckingBalance();
      await captureLive(page, 's3-decimal-settled');
      if (settled.occurrences !== 1) {
        throw new Error(`SQLite 中 -200.37 的 DEBIT 行应为 1 条，实际 ${settled.occurrences} 条`);
      }
      return `「${MSG.transferDecimal}」→ 卡片金额 200.37；确认前余额未变（API=${mid.balance}，DB=${midDb}）→ 确认 → API 余额 ${settled.balance}、SQLite Account.balance=${afterDb}，账本新增 -200.37 DEBIT 一条（${settled.txIds[0]}），扣款 -200.37 恰好一次`;
    },
    { label: 's3-decimal' },
  );
}

// --- scenario 5: cancel → no deduction; repeat-confirm → idempotent; terminal UX ------------------

async function scenarioCancelAndIdempotency(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      await submitChat(page, MSG.transferByName);
      await waitForConfirmCard(page);
      const cookie = await readSessionCookie(page);
      if (!cookie) throw new Error('未取得 banking_session cookie');
      const actions = await fetchPendingActions(ctx.baseUrl, cookie);
      const parked = actions.find((a) => a.toolName === 'transfer_money');
      if (!parked) throw new Error(`GET /api/actions 未返回 transfer_money 待处理项：${JSON.stringify(actions)}`);
      await captureLive(page, 's5-parked');
      await clickCancel(page);

      // terminal UX: the card no longer offers 确认 and shows 已取消.
      await waitFor(async () => ((await confirmButtonCount(page)) === 0 ? true : false), {
        timeoutMs: 60_000,
        description: '取消后确认卡不再提供「确认」按钮',
      });
      const dom = await bodyText(page);
      if (!dom.includes('已取消')) throw new Error('取消后确认卡未渲染「已取消」终态徽章');
      const afterCancel = await snapshot(ctx.baseUrl);
      if (afterCancel.balance !== before.balance) throw new Error(`取消后余额变化：${before.balance} → ${afterCancel.balance}`);
      const addedAfterCancel = diffLedger(before.ledger.transactions, afterCancel.ledger.transactions).added;
      if (addedAfterCancel.length > 0) throw new Error(`取消后账本新增：${addedAfterCancel.map((tx) => tx.id).join('、')}`);

      // cancel-on-terminal: the SAME action is already cancelled → the server must reject gracefully.
      const cancelAgain = await fetch(`${ctx.baseUrl}/api/actions/${parked.id}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const cancelBody = (await cancelAgain.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string } };
      const cancelRejected = cancelBody.ok === false || cancelBody.data?.ok === false;

      // repeat-confirm on the TERMINAL action → rejected, and NO double deduction.
      const confirmAgain = await fetch(`${ctx.baseUrl}/api/actions/${parked.id}/confirm`, {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const confirmBody = (await confirmAgain.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string } };
      const confirmRejected = confirmBody.ok === false || confirmBody.data?.ok === false;
      const afterConfirm = await snapshot(ctx.baseUrl);
      if (afterConfirm.balance !== before.balance) {
        throw new Error(`重复确认后余额变化：${before.balance} → ${afterConfirm.balance}（不应扣款）`);
      }
      const addedAfterConfirm = diffLedger(before.ledger.transactions, afterConfirm.ledger.transactions).added;
      if (addedAfterConfirm.length > 0) {
        throw new Error(`重复确认后账本新增：${addedAfterConfirm.map((tx) => tx.id).join('、')}`);
      }
      const dbRow = await readPendingAction(parked.id);
      if (!dbRow) throw new Error(`PendingAction ${parked.id} 不存在`);

      return `「${MSG.transferByName}」→ 取消（DB 状态 ${dbRow.status}，卡片显示「已取消」、确认按钮数 0）→ 未扣款；对终态动作重复取消 ${cancelRejected ? '被拒' : '未被拒'}、重复确认 ${confirmRejected ? '被拒' : '未被拒'} → 余额 ${before.balance} 不变、账本无新增（幂等）`;
    },
    { label: 's5-cancel-idempotent' },
  );
}

// --- scenario 6: multi-turn session + post-confirm / post-MFA continuations ----------------------

async function scenarioMultiTurn(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);

      // turn 1 — GREEN read
      await submitChat(page, MSG.balance);
      await waitFor(async () => ((await assistantTexts(page)).length >= 1 ? true : false), {
        timeoutMs: 120_000,
        description: '第 1 轮助手回复',
      });

      // turn 2 — confirm a YELLOW transfer (post-confirm model continuation)
      await submitChat(page, MSG.transferByName);
      await waitForConfirmCard(page);
      await page.getByRole('button', { name: '确认', exact: true }).first().click();
      const afterYellow = await waitForTransferSettled(ctx.baseUrl, before, TRANSFER_AMOUNT);

      // turn 3 — MFA a RED transfer (post-MFA model continuation)
      await submitChat(page, MSG.transferLarge);
      await waitForMfaCard(page);
      await submitMfa(page, '123456');
      const afterRed = await waitForTransferSettled(
        ctx.baseUrl,
        { balance: afterYellow.balance, ledger: await fetchLedger(ctx.baseUrl) },
        LARGE_AMOUNT,
      );

      // turn 4 — a follow-up read in the SAME session
      await submitChat(page, MSG.cardLimit);
      await waitFor(async () => ((await assistantTexts(page)).length >= 4 ? true : false), {
        timeoutMs: 120_000,
        description: '第 4 轮助手回复',
      });
      const texts = await assistantTexts(page);
      await captureLive(page, 's6-multiturn');
      const violation = findToolOrderViolation();
      if (violation) {
        throw new Error(`出现 tool/tool_calls 400：${violation.method} ${violation.url} — ${violation.body.slice(0, 300)}`);
      }
      return `同一会话 4 轮（余额 → 转账200确认 → 转账5000验证码 → 信用卡额度），助手消息 ${texts.length} 条；确认后余额 ${afterYellow.balance}、验证码后 ${afterRed.balance}；全程无 "tool message must answer tool_calls" 400（累计网络 4xx/5xx：${netLog.issues.length}）`;
    },
    { label: 's6-multiturn' },
  );
}

// --- scenario 4: large transfer MFA (wrong code → nothing; correct code → exactly once) ----------

async function scenarioLargeTransferMfa(ctx: Ctx): Promise<string> {
  const wrong = await withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      const beforeDb = await readCheckingBalance();
      await submitChat(page, MSG.transferLarge);
      await waitForMfaCard(page);
      await submitMfa(page, '000000');
      await waitForStatusText(page, '验证失败，已尝试1次');
      if ((await page.locator('input[aria-label="验证码"]').count()) === 0) {
        throw new Error('错误验证码后 MFA 卡片消失（应保留以允许重试）');
      }
      const after = await snapshot(ctx.baseUrl);
      const afterDb = await readCheckingBalance();
      if (after.balance !== before.balance || afterDb !== beforeDb) {
        throw new Error(`错误验证码后余额变化：API ${before.balance}→${after.balance}，DB ${beforeDb}→${afterDb}`);
      }
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`错误验证码后账本新增：${added.map((tx) => tx.id).join('、')}`);
      await captureLive(page, 's4-mfa-wrong');
      return `错误码 000000 → role=status「验证失败，已尝试 1 次」，MFA 卡片保留；余额（API=${after.balance}，DB=${afterDb}）与账本均未变`;
    },
    { label: 's4-mfa-wrong' },
  );

  const ok = await withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      await submitChat(page, MSG.transferLarge);
      await waitForMfaCard(page);
      await submitMfa(page, '123456');
      const settled = await waitForTransferSettled(ctx.baseUrl, before, LARGE_AMOUNT);
      await captureLive(page, 's4-mfa-ok');
      if (settled.occurrences !== 1) {
        throw new Error(`SQLite 中 -5000 的 DEBIT 行应为 1 条，实际 ${settled.occurrences} 条`);
      }
      const afterDb = await readCheckingBalance();
      return `正确码 123456 → 余额 API=${settled.balance}、DB=${afterDb}（−5000 恰好一次），账本新增 -5000 DEBIT 一条（${settled.txIds[0]}）`;
    },
    { label: 's4-mfa-ok' },
  );

  return `错误码：${wrong} ｜ 正确码：${ok}`;
}

// --- scenario 7: SDK committed but the model continuation FAILS ----------------------------------

/**
 * Engineer "the SDK write commits, the model continuation fails": park a YELLOW `transfer_money`, then
 * reboot the SAME app on the SAME DB with `DEEPSEEK_API_KEY='invalid'` so ONLY the continuation LLM
 * call fails, then hit the confirm endpoint with the SAME session cookie. The action must still settle
 * `executed` with exactly ONE debit. (Read-only against app code.)
 */
async function scenarioCommittedContinuationFailed(
  browser: Browser,
  server: ServerHandle,
  originalKey: string | undefined,
): Promise<string> {
  server.current.stop();
  await sleep(1500);
  configureLiveEnv();
  resetLiveDatabase(); // zero the demo-day transfer total → the parked transfer is deterministically YELLOW
  server.current = await bootDevServer({ timeoutMs: NAV_TIMEOUT_MS, attempts: 2 });
  let baseUrl = server.current.baseUrl;

  let actionId = '';
  let cookie = '';
  await withPage(
    browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferByName);
      await waitForConfirmCard(page);
      cookie = (await readSessionCookie(page)) ?? '';
      if (!cookie) throw new Error('未取得 banking_session cookie');
      const actions = await fetchPendingActions(baseUrl, cookie);
      actionId = actions.find((a) => a.toolName === 'transfer_money')?.id ?? '';
      if (!actionId) throw new Error(`GET /api/actions 未返回 transfer_money：${JSON.stringify(actions)}`);
      await captureLive(page, 's7-parked');
    },
    { label: 's7-park' },
  );

  const before = await snapshot(baseUrl);
  const beforeDb = await readCheckingBalance();

  // Reboot the SAME app on the SAME DB with an INVALID provider key → only the continuation fails.
  server.current.stop();
  await sleep(1500);
  process.env['DEEPSEEK_API_KEY'] = 'invalid';
  server.current = await bootDevServer({ timeoutMs: NAV_TIMEOUT_MS, attempts: 2 });
  baseUrl = server.current.baseUrl;

  const res = await fetch(`${baseUrl}/api/actions/${actionId}/confirm`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string; message?: string } };
  netLog.issues.push({ method: 'POST', url: `${baseUrl}/api/actions/${actionId}/confirm`, status: res.status, body: JSON.stringify(body).slice(0, 500) });

  const settled = await waitForTransferSettled(baseUrl, before, TRANSFER_AMOUNT);
  const row = await readPendingAction(actionId);
  const afterDb = await readCheckingBalance();

  // Restore the real key for any later work.
  if (originalKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
  else process.env['DEEPSEEK_API_KEY'] = originalKey;

  if (row?.status !== 'executed') {
    throw new Error(`PendingAction.status 应为 executed，实际 ${row?.status ?? 'null'}`);
  }
  if (settled.occurrences !== 1) {
    throw new Error(`SQLite 中 -200 的 DEBIT 行应为 1 条，实际 ${settled.occurrences} 条`);
  }
  const statusOk = body.ok === true && body.data?.ok === true && body.data?.status === 'executed';
  return `重启后在无效 key 下确认：HTTP ${res.status} ok=${body.ok} status=${body.data?.status}（statusOk=${statusOk}）；DB PendingAction.status=${row.status}，余额 ${before.balance}→${settled.balance}（DB=${afterDb}），-200 DEBIT 恰 1 条（${settled.txIds[0]}）；DB=${JSON.stringify(row.resultJson)?.slice(0, 80)}`;
}

// --- scenario table ------------------------------------------------------------------------------

const SCENARIOS: readonly Scenario[] = [
  { id: '1', name: '1-live-balance-matches-db', run: scenarioBalance },
  { id: '2', name: '2-live-transfer-recipient-name-and-phone', run: scenarioTransferRecipients },
  { id: '3', name: '3-live-decimal-transfer-200.37', run: scenarioDecimalTransfer },
  { id: '5', name: '5-live-cancel-idempotent-terminal-ux', run: scenarioCancelAndIdempotency },
  { id: '6', name: '6-live-multiturn-and-continuations', run: scenarioMultiTurn },
  { id: '4', name: '4-live-large-transfer-mfa', run: scenarioLargeTransferMfa },
];

/** `LIVE_SCENARIOS=1,3` (comma separated) runs only those scenario ids (plus scenario 7 if `7`). */
function selectedIds(): string[] | undefined {
  const raw = process.env['LIVE_SCENARIOS'];
  if (!raw) return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const reporter = createReporter();
  const only = selectedIds();
  const chosen = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  const runSeven = !only || only.includes('7');
  const originalKey = process.env['DEEPSEEK_API_KEY'];

  let browser: Browser | undefined;
  let devServer: DevServer | undefined;
  const cleanup = () => {
    if (devServer) {
      try {
        devServer.stop();
      } catch {
        /* best-effort */
      }
      devServer = undefined;
    }
    if (browser) {
      void browser.close().catch(() => undefined);
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.on('uncaughtException', (error) => {
    console.error(`未捕获异常：${errText(error)}`);
    cleanup();
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error(`未处理的 rejection：${errText(error)}`);
    cleanup();
    process.exit(1);
  });

  console.log('== AI Banking Agent 真实浏览器 + 真实 DeepSeek 在线验收 (tests/e2e/live) ==');
  console.log(`· LIVE with disclosed model-id override（提供的 'deepseek-flash' 不是合法 pi-ai id；使用 '${process.env['LLM_MODEL'] ?? '(未设置)'}'）`);

  const executablePath = resolveBrowserExecutable();
  if (executablePath === undefined) {
    for (const scenario of [...chosen, { name: '7-live-committed-continuation-failed' }]) {
      reporter.skip(scenario.name, '未找到真实浏览器（Chrome/Edge）；可设置 E2E_BROWSER_PATH 覆盖');
    }
    console.log(`== 汇总：PASS ${reporter.passes} ｜ FAIL ${reporter.failures} ｜ SKIP ${reporter.skips} ==`);
    process.exitCode = reporter.failures > 0 ? 1 : 0;
    return;
  }

  try {
    configureLiveEnv();
    console.log(`· 隔离 LIVE 数据库：${LIVE_DB_URL}（prisma/dev.db 与 prisma/test.db 不受影响）`);
    console.log('· 重置 LIVE 数据库 →（缺 Prisma Client 时先 prisma generate）→ db push 阶梯 → probe → tsx prisma/seed.ts');
    resetLiveDatabase();

    console.log(`· LLM_MODE=${process.env['LLM_MODE']} LLM_PROVIDER=${process.env['LLM_PROVIDER']} LLM_MODEL=${process.env['LLM_MODEL']}（真实 DeepSeek API）`);
    devServer = await bootDevServer({ timeoutMs: NAV_TIMEOUT_MS, attempts: 2 });
    const baseUrl = devServer.baseUrl;
    console.log(`· next dev (pid=${devServer.pid}) → ${baseUrl}（/api/health 与 /agent 均已就绪）`);

    // LIVE-mode confirmation: read the RESOLVED config the app actually serves (mock vs live) and,
    // when running scenario 1, observe a narration the scripted mock cannot produce.
    const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as { ok?: boolean; data?: Record<string, unknown> };
    console.log(`· /api/health=${JSON.stringify(health).slice(0, 200)}`);

    console.log(`· 真实浏览器：${executablePath}`);
    browser = await launchBrowser(executablePath);
    const server: ServerHandle = { current: devServer };

    for (const scenario of chosen) {
      try {
        reporter.pass(scenario.name, await scenario.run({ browser, baseUrl, server }));
      } catch (error) {
        reporter.fail(scenario.name, errText(error));
      }
    }

    if (runSeven) {
      try {
        reporter.pass(
          '7-live-committed-continuation-failed',
          await scenarioCommittedContinuationFailed(browser, server, originalKey),
        );
      } catch (error) {
        reporter.fail('7-live-committed-continuation-failed', errText(error));
        if (originalKey === undefined) delete process.env['DEEPSEEK_API_KEY'];
        else process.env['DEEPSEEK_API_KEY'] = originalKey;
      }
    }
  } catch (error) {
    console.error(`· 基础设施失败：${errText(error)}`);
    reporter.fail('infrastructure', errText(error));
  } finally {
    cleanup();
  }

  // Scenario 6's global invariant: no provider "tool message must answer tool_calls" 400 anywhere.
  const violation = findToolOrderViolation();
  if (violation) {
    console.error(`· 全程捕获到 tool/tool_calls 400：${violation.method} ${violation.url} — ${violation.body.slice(0, 400)}`);
  }
  console.log(`· 累计网络 4xx/5xx：${netLog.issues.length}，console error：${netLog.consoleErrors.length}，pageerror：${netLog.pageErrors.length}`);
  for (const issue of netLog.issues.slice(0, 20)) {
    console.log(`· [4xx/5xx] ${issue.method} ${issue.status} ${issue.url} — ${issue.body.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  console.log(`== 汇总：PASS ${reporter.passes} ｜ FAIL ${reporter.failures} ｜ SKIP ${reporter.skips} ==`);
  process.exitCode = reporter.failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`入口脚本失败：${errText(error)}`);
  process.exitCode = 1;
});

// Referenced so `captureScreenshot` stays part of the public harness surface used by `withPage`.
void captureScreenshot;
