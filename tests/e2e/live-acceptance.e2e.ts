/**
 * `tests/e2e/live-acceptance.e2e.ts` — REAL-BROWSER, **LIVE-LLM** acceptance harness.
 *
 * Unlike `acceptance.e2e.ts` (which scripts the model with `LLM_MODE=mock`), this harness boots the
 * REAL Next.js dev server against the REAL DeepSeek API (`LLM_MODE=live`, `LLM_PROVIDER=deepseek`)
 * and drives the REAL `/agent` UI through a REAL headless Chrome. Only the bank is simulated (SQLite).
 *
 * ------------------------------------------------------------------------------------------------
 * MODEL ID — PROVIDED CONFIG BY DEFAULT, OPT-IN FORCE OVERRIDE
 * ------------------------------------------------------------------------------------------------
 * The installed Pi model catalog registers `deepseek-flash` at https://api.deepseek.com.
 * By default the harness uses the provided .env.local model id unchanged.
 * This exercises the native Models collection and the real DeepSeek adapter.
 *
 * Set `LIVE_FORCE_MODEL=<id>` (non-empty) to FORCE `process.env.LLM_MODEL=<id>` for the spawned server
 * (logged as a forced override); every result is then labelled "LIVE with forced model-id override".
 * Everything else (key, provider, model, mock off) is the provided `.env.local` unchanged.
 * By default the run therefore exercises `resolveLiveModel` on the PROVIDED id, not an override.
 *
 * Environment loading uses the application's Next.js loader before any process is spawned.
 * The harness does not read or parse environment files directly and never displays their values.
 * Run: pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
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
import nextEnv from '@next/env';

const { loadEnvConfig } = nextEnv;
import path from 'node:path';
import type { Browser, Page } from 'playwright-core';
import type { PrismaClient } from '../../lib/db/prisma';
import {
  cliCommand,
  ensurePrismaClientGenerated,
  provisionSchemaLadder,
  resolveTsxBin,
  runCliStep as runCliStepShared,
} from '../helpers/prisma-cli';
import { centsToMoney, formatCNY, moneyToCents, subtractMoney } from '../../lib/money';
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
  readDemoSessionId,
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
  type PendingActionView,
  type Reporter,
} from './helpers';
import { journeySharedDemo } from './shared-demo.e2e-helper';
import { journeyToolLifecycle } from './tool-lifecycle.e2e-helper';
import { journeyMultiCardFreeze } from './card-freeze.e2e-helper';
import { journeyCardManagement } from './card-management.e2e-helper';
import { journeyNaturalConversation, journeyDialogueRegressions, journeySubscriptionAdvice, journeyCompleteFraudDiscussion } from './conversation.e2e-helper';
import { journeyLiveCompaction } from './compaction.e2e-helper';

// --- isolated LIVE database ---------------------------------------------------------------------

const LIVE_DB_FILES = ['live-acceptance.db', 'live-acceptance.db-wal', 'live-acceptance.db-shm', 'live-acceptance.db-journal'] as const;
/** Absolute `file:` URL (forward slashes — Prisma rejects a Windows backslash URL). */
const LIVE_DB_URL = `file:${path.join(REPO_ROOT, 'prisma', 'live-acceptance.db').split(path.sep).join('/')}`;

const DEMO_CHECKING_ID = 'acct_checking';
const RECIPIENT_NAME = '张伟';
const RECIPIENT_CONTACT_ID = 'contact_zhangwei';
const CREDIT_CARD_ID = 'card_credit';

/**
 * Apply the same environment precedence as Next.js without inspecting file contents or logging values.
 */
function loadRuntimeEnvironment(): void {
  loadEnvConfig(REPO_ROOT, true, { info: () => undefined, error: () => { throw new Error('Live environment configuration could not be loaded.'); } });
  console.log('Live environment configuration loaded without displaying values.');
}

/** Point this process — provisioning CLIs + the spawned dev server — at the ISOLATED live DB. */function configureLiveEnv(): void {
  process.env['DATABASE_URL'] = LIVE_DB_URL;
  process.env['DEMO_USER_ID'] = 'user_liming';
  process.env['LLM_MODE'] = 'live';
  process.env['LLM_PROVIDER'] = 'deepseek';
  // MODEL ID — PROVIDED CONFIG BY DEFAULT, OPT-IN FORCE OVERRIDE.
  // By default we do NOT set `LLM_MODEL`, so the spawned `next dev` loads the PROVIDED `.env.local`
  // value (LLM_MODEL=deepseek-flash), registered directly by the installed Pi catalog.
  // Set LIVE_FORCE_MODEL=<id> to force a different model id.
  const forced = process.env['LIVE_FORCE_MODEL']?.trim();
  if (forced) {
    process.env['LLM_MODEL'] = forced;
  }
}

/** Probe the freshly provisioned live DB (node child, so DATABASE_URL is applied before construction). */
function probeLiveDatabaseUsable(): void {
  const script = `
const { createDatabaseClient } = require('./lib/db/database.ts');
const client = createDatabaseClient();
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
  const { createDatabaseClient } = await import('../../lib/db/database');
  const db = createDatabaseClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

/** The CHECKING account balance (authoritative, straight from SQLite). */
function readCheckingBalance(): Promise<string> {
  return withDb(async (db) => {
    const account = await db.account.findUnique({ where: { id: DEMO_CHECKING_ID } });
    if (!account) throw new Error(`缺少账户 ${DEMO_CHECKING_ID}`);
    return centsToMoney(account.balanceMinor);
  });
}

/** DEBIT `Transaction` rows on the CHECKING account, newest first. */
function readCheckingDebits(): Promise<{ id: string; amountMinor: bigint; merchant: string }[]> {
  return withDb(async (db) =>
    db.transaction.findMany({
      where: { accountId: DEMO_CHECKING_ID, direction: 'DEBIT' },
      orderBy: { occurredAt: 'desc' },
      take: 20,
      select: { id: true, amountMinor: true, merchant: true },
    }),
  );
}

/** The persisted status + result of one `PendingAction`. */
function readPendingAction(actionId: string, sessionId?: string): Promise<{ status: string; resultJson: string | null } | null> {
  return withDb(async (db) => {
    const row = await db.pendingAction.findUnique({
      where: { id: actionId, ...(sessionId ? { sessionId } : {}) },
      select: { status: true, resultJson: true },
    });
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

/** The seeded recipient phone straight from the DB (never throws — a failure is reported as text). */
async function readSeedRecipientPhone(): Promise<string> {
  try {
    return await readContactPhone(RECIPIENT_CONTACT_ID);
  } catch (e) {
    return `读取失败：${errText(e)}`;
  }
}

/**
 * Read-only `GET /api/actions` cross-check using the configured shared demo identity.
 * Verify the page exposes its server-owned session before querying; API access needs no cookie.
 * Transport errors are rethrown so malformed responses cannot silently pass.
 */
async function fetchParkedActions(page: Page, baseUrl: string): Promise<PendingActionView[] | undefined> {
  await readDemoSessionId(page);
  return fetchPendingActions(baseUrl);
}

/** One-line rendering of `GET /api/actions` evidence (never throws). */
function describeActions(actions: PendingActionView[] | undefined): string {
  if (actions === undefined) return '(No action snapshot)';
  if (actions.length === 0) return '[]';
  return actions
    .map((a) => `{id:${a.id},tool:${a.toolName},tier:${a.tier},status:${a.status},attention:${a.attention ?? '-'}}`)
    .join(' ');
}

/**
 * EVIDENCE DUMP: every persisted `transfer_money` / `search_contact` tool call across ALL
 * `AgentSession` rows, with the tool-call ARGUMENT OBJECT printed VERBATIM (the exact arg shape the
 * LIVE model produced, including which of `contactId` / `phone` / `name` it populated).
 *
 * The frozen client stream contract (`lib/contracts/agent.ts`) exposes no raw tool args, but
 * `AgentSession.stateJson` persists `agentState.messages`, so the model's arguments are recoverable
 * from the SAME DB the run used. Read-only; never throws (a row-level parse failure is reported).
 */
async function persistedRecipientCalls(): Promise<string> {
  return withDb(async (db) => {
    const sessions = await db.agentSession.findMany({ orderBy: { createdAt: 'asc' }, select: { id: true, stateJson: true } });
    const lines: string[] = [];
    for (const session of sessions) {
      let messages: unknown[] = [];
      try {
        const parsed = JSON.parse(session.stateJson) as { agentState?: { messages?: unknown } };
        const raw = parsed.agentState?.messages;
        messages = Array.isArray(raw) ? raw : [];
      } catch {
        lines.push(`session=${session.id} stateJson 解析失败`);
        continue;
      }
      messages.forEach((rawMessage, index) => {
        if (typeof rawMessage !== 'object' || rawMessage === null) return;
        const message = rawMessage as Record<string, unknown>;
        const role = typeof message['role'] === 'string' ? message['role'] : '?';
        if (role === 'assistant' && Array.isArray(message['content'])) {
          for (const rawPart of message['content'] as unknown[]) {
            if (typeof rawPart !== 'object' || rawPart === null) continue;
            const part = rawPart as Record<string, unknown>;
            if (part['type'] !== 'toolCall') continue;
            const name = typeof part['name'] === 'string' ? part['name'] : '';
            if (name !== 'transfer_money' && name !== 'search_contact') continue;
            lines.push(`session=${session.id} msg#${index} assistant→ toolCall ${name} args=${JSON.stringify(part['arguments'])}`);
          }
        } else if (role === 'toolResult') {
          const name = typeof message['toolName'] === 'string' ? message['toolName'] : '?';
          if (name !== 'transfer_money' && name !== 'search_contact') return;
          const content = Array.isArray(message['content']) ? (message['content'] as unknown[]) : [];
          const text = content
            .map((p) => (typeof p === 'object' && p !== null && typeof (p as Record<string, unknown>)['text'] === 'string' ? ((p as Record<string, unknown>)['text'] as string) : ''))
            .join(' ');
          lines.push(`session=${session.id} msg#${index} toolResult ${name} isError=${String(message['isError'])} text=${text.replace(/\s+/g, ' ').slice(0, 400)}`);
        }
      });
    }
    return lines.length > 0 ? lines.join('\n') : '（无持久化的 transfer_money/search_contact 调用）';
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

/** Read fields from the actionable dock, excluding historical approval receipts. */
async function readConfirmFields(page: Page): Promise<Record<string, string>> {
  const dls = page.locator('[data-approval-request="true"] dl');
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
  const button = page.locator('[data-approval-request="true"]').getByRole('button', { name: '取消', exact: true });
  await waitFor(async () => ((await button.count()) > 0 ? true : false), { timeoutMs, description: '确认卡「取消」按钮' });
  await button.first().click();
}

/** The number of rendered `确认` buttons (0 once a card is settled / gone). */
async function confirmButtonCount(page: Page): Promise<number> {
  return page.locator('[data-approval-request="true"]').getByRole('button', { name: '确认', exact: true }).count();
}

/** The demo user's money state via the app's REAL read routes. */
async function snapshot(baseUrl: string): Promise<{ balance: string; ledger: LedgerView }> {
  const [dashboard, ledger] = await Promise.all([fetchDashboardSummary(baseUrl), fetchLedger(baseUrl)]);
  return { balance: dashboard.checkingBalance, ledger };
}

/**
 * Wait until a transfer DEBIT of exactly `amount` shows up in the DB + ledger and the balance drops by it.
 *
 * `occurrences` counts the RAW-SQLite debits of that amount that are NEW for THIS transfer — scoped by
 * the ids already present in `before.ledger`, because a `TransactionView.id` IS the `Transaction.id`
 * (`banking-sdk/transaction.ts#toTransactionView`). Without that scope an EARLIER scenario's legitimate
 * same-amount transfer would be miscounted as a double-charge (a cross-scenario artefact, never a real
 * duplicate write).
 */
async function waitForTransferSettled(
  baseUrl: string,
  before: { balance: string; ledger: LedgerView },
  amount: string,
  timeoutMs = 120_000,
): Promise<{ balance: string; dbBalance: string; txIds: string[]; occurrences: number }> {
  const preexistingIds = new Set(before.ledger.transactions.map((tx) => tx.id));
  return waitFor(
    async () => {
      const [after, dbBalance, debits] = await Promise.all([
        snapshot(baseUrl),
        readCheckingBalance(),
        readCheckingDebits(),
      ]);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added.filter(
        (tx) => moneyToCents(tx.amount) === -moneyToCents(amount) && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
      );
      const matching = debits.filter(
        (tx) => tx.amountMinor === -moneyToCents(amount) && tx.merchant.includes(RECIPIENT_NAME) && !preexistingIds.has(tx.id),
      );
      const expected = subtractMoney(before.balance, amount);
      if (after.balance !== expected || dbBalance !== expected || added.length !== 1) return false;
      return { balance: after.balance, dbBalance, txIds: added.map((tx) => tx.id), occurrences: matching.length };
    },
    {
      timeoutMs,
      description: `Transfer ${amount}: balance ${before.balance} -> ${subtractMoney(before.balance, amount)} with one debit.`,
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

// --- failure diagnostics (why did no card render?) -----------------------------------------------

/**
 * When a confirmation/MFA card never renders, capture the OBSERVABLE evidence that distinguishes a
 * MODEL-BEHAVIOUR cause (the model narrated/asked a question WITHOUT calling the gated tool, so the
 * gateway never parked a `PendingAction`) from a UI/HARNESS cause (the model DID ask the user to
 * confirm, but no card rendered). Appended to the thrown error — it never weakens the wait itself.
 */
async function noCardDiagnostics(page: Page, baseUrl: string): Promise<string> {
  const texts = await assistantTexts(page);
  const dom = await bodyText(page);
  let actions: string;
  try {
    actions = JSON.stringify(await fetchPendingActions(baseUrl));
  } catch (e) {
    actions = `Action snapshot unavailable: ${errText(e)}`;
  }
  const last = (texts[texts.length - 1] ?? '').replace(/\s+/g, ' ').slice(-600);
  return `【诊断】助手消息数=${texts.length}；最后一条=「${last}」；/api/actions=${actions.slice(0, 600)}；页面文本尾部=「${dom.replace(/\s+/g, ' ').slice(-400)}」`;
}

/** `waitForConfirmCard` with an evidence dump on timeout (the wait + assertion are unchanged). */
async function awaitConfirmCard(page: Page, baseUrl: string, timeoutMs = 90_000): Promise<void> {
  try {
    await waitForConfirmCard(page, timeoutMs);
  } catch (e) {
    throw new Error(`${errText(e)} ｜ ${await noCardDiagnostics(page, baseUrl)}`);
  }
}

/** `waitForMfaCard` with an evidence dump on timeout (the wait + assertion are unchanged). */
async function awaitMfaCard(page: Page, baseUrl: string, timeoutMs = 90_000): Promise<void> {
  try {
    await waitForMfaCard(page, timeoutMs);
  } catch (e) {
    throw new Error(`${errText(e)} ｜ ${await noCardDiagnostics(page, baseUrl)}`);
  }
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
  /**
   * Optional pre-flight guard. When it returns a reason the scenario is reported `SKIP` (NOT VERIFIED)
   * with that concrete reason and `run` is never called — it never asserts a success the demo data
   * cannot produce.
   */
  skipReason?(): Promise<string | undefined> | string | undefined;
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

/**
 * LIVE-experiment OVERRIDES for the two transfer prompts (default: the canonical `MSG` prompts).
 * Lets a diagnostic run pin a DIFFERENT identifier phrasing (`LIVE_S2_PROMPT` / `LIVE_S3_PROMPT`,
 * e.g. `给联系人张伟转200元`) WITHOUT editing the scenarios. Assertions and the default prompt are
 * unchanged; the values are read once at module load.
 */
const PROMPT_S2 = process.env['LIVE_S2_PROMPT']?.trim() || MSG.transferByName;
const PROMPT_S3 = process.env['LIVE_S3_PROMPT']?.trim() || MSG.transferDecimal;

const TRANSFER_AMOUNT = '200.00';
const DECIMAL_AMOUNT = '200.37';
const LARGE_AMOUNT = '5000.00';

/**
 * Scenario 7 park-robustness knobs. The LIVE model SOMETIMES answers the transfer prompt with only
 * `search_contact` + a question ("请确认是否向张伟转账 ¥200.00？") WITHOUT calling `transfer_money`, so
 * the gateway never parks a `PendingAction`, `GET /api/actions` stays `[]` and the park times out.
 * The park therefore POLLS `/api/actions` and, when nothing is parked, NUDGES the model in the SAME
 * session and re-checks — bounded attempts, never a fabricated park.
 */
const PARK_ATTEMPTS = 3;
const PARK_POLL_MS = 60_000;
const PARK_NUDGES = ['确认，请发起转账', '请直接调用转账工具发起这笔转账'] as const;

/** The parked `transfer_money` action from `GET /api/actions` (awaiting a human decision), or `undefined`. */
function findParkedTransfer(
  actions: readonly PendingActionView[],
): PendingActionView | undefined {
  return actions.find(
    (action) => action.toolName === 'transfer_money' && (action.status === 'pending' || action.status === 'awaiting_mfa'),
  );
}

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

// --- scenario 2: transfer by NAME / by PHONE → correct recipient, then CANCEL --------------------

/** By-NAME leg: a YELLOW transfer to a contact NAME must render a card with the SERVER-resolved recipient. */
async function scenarioTransferRecipientByName(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      await submitChat(page, PROMPT_S2);
      try {
        await awaitConfirmCard(page, ctx.baseUrl);
      } catch (error) {
        await captureLive(page, 's2-no-card');
        const phone = await readSeedRecipientPhone();
        throw new Error(
          `${errText(error)}；种子库 ${RECIPIENT_NAME} 手机号=${phone}；持久化工具调用：${await persistedRecipientCalls()}`,
        );
      }
      const fields = await readConfirmFields(page);
      const resolved = assertRecipient(fields, RECIPIENT_NAME);
      // READ-ONLY cross-check: the parked YELLOW action must be visible on `GET /api/actions`.
      const parked = await fetchParkedActions(page, ctx.baseUrl);
      if (parked === undefined || !parked.some((a) => a.toolName === 'transfer_money')) {
        throw new Error(`确认卡已渲染但 GET /api/actions 未返回 transfer_money 待处理操作：${describeActions(parked)}`);
      }
      await captureLive(page, 's2-by-name');
      await clickCancel(page);
      const after = await snapshot(ctx.baseUrl);
      if (after.balance !== before.balance) throw new Error(`取消后余额变化：${before.balance} → ${after.balance}`);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`取消后账本新增：${added.map((tx) => tx.id).join('、')}`);
      return `「${PROMPT_S2}」→ 确认卡收款人=${resolved}（真实姓名 + 掩码手机号）；GET /api/actions → ${describeActions(parked)}；取消 → 余额 ${before.balance} 未变、账本无新增`;
    },
    { label: 's2-by-name' },
  );
}

/** The seeded contact's DE-MASKED phone (`139****0002` → `13900000002`) — the raw by-phone leg. */
const RAW_RECIPIENT_PHONE = '13900000002';

/**
 * One by-PHONE leg: a transfer addressed by `phone` must resolve to the seeded contact through the
 * mask-aware recipient resolution (`security/recipient-resolution.ts`), render a confirmation card
 * with the SERVER-RESOLVED real name + a masked phone, and then CANCEL without moving money.
 */
async function transferByPhoneLeg(ctx: Ctx, phone: string, label: string): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);
      const before = await snapshot(ctx.baseUrl);
      await submitChat(page, MSG.transferByPhone(phone));
      try {
        await awaitConfirmCard(page, ctx.baseUrl);
      } catch (error) {
        await captureLive(page, `${label}-no-card`);
        const seeded = await readSeedRecipientPhone();
        throw new Error(
          `${errText(error)}；种子库 ${RECIPIENT_NAME} 手机号=${seeded}；持久化工具调用：${await persistedRecipientCalls()}`,
        );
      }
      const fields = await readConfirmFields(page);
      const resolved = assertRecipient(fields, RECIPIENT_NAME);
      // READ-ONLY cross-check: the parked YELLOW action must be visible on `GET /api/actions`.
      const parked = await fetchParkedActions(page, ctx.baseUrl);
      if (parked === undefined || !parked.some((a) => a.toolName === 'transfer_money')) {
        throw new Error(`确认卡已渲染但 GET /api/actions 未返回 transfer_money 待处理操作：${describeActions(parked)}`);
      }
      await captureLive(page, label);
      await clickCancel(page);
      const after = await snapshot(ctx.baseUrl);
      if (after.balance !== before.balance) throw new Error(`取消后余额变化：${before.balance} → ${after.balance}`);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`取消后账本新增：${added.map((tx) => tx.id).join('、')}`);
      return `「${MSG.transferByPhone(phone)}」→ 确认卡收款人=${resolved}；GET /api/actions → ${describeActions(parked)}；取消 → 余额 ${before.balance} 未变、账本无新增`;
    },
    { label },
  );
}

/**
 * By-PHONE leg: a transfer addressed by a contact's phone must resolve to that contact. Because the
 * seeded contact stores a MASKED phone (`139****0002`), BOTH the masked form (as seeded) AND its
 * DE-MASKED raw form (`13900000002`) are exercised end-to-end and asserted on the rendered DOM.
 */
async function scenarioTransferRecipientByPhone(ctx: Ctx): Promise<string> {
  const maskedPhone = await readContactPhone(RECIPIENT_CONTACT_ID);
  const masked = await transferByPhoneLeg(ctx, maskedPhone, 's2-by-phone-masked');
  const raw = await transferByPhoneLeg(ctx, RAW_RECIPIENT_PHONE, 's2-by-phone-raw');
  return `掩码号（种子 ${maskedPhone}）：${masked} ｜ 真实号（${RAW_RECIPIENT_PHONE}）：${raw}`;
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
      await submitChat(page, PROMPT_S3);
      try {
        await awaitConfirmCard(page, ctx.baseUrl);
      } catch (error) {
        await captureLive(page, 's3-no-card');
        const phone = await readSeedRecipientPhone();
        throw new Error(
          `${errText(error)}；种子库 ${RECIPIENT_NAME} 手机号=${phone}；持久化工具调用：${await persistedRecipientCalls()}`,
        );
      }
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
      // READ-ONLY cross-check: the parked YELLOW action must be visible on `GET /api/actions` BEFORE confirm.
      const parked = await fetchParkedActions(page, ctx.baseUrl);
      if (parked === undefined || !parked.some((a) => a.toolName === 'transfer_money')) {
        throw new Error(`确认卡已渲染但 GET /api/actions 未返回 transfer_money 待处理操作：${describeActions(parked)}`);
      }
      await captureLive(page, 's3-decimal-preconfirm');
      await page.getByRole('button', { name: '确认', exact: true }).first().click();
      const settled = await waitForTransferSettled(ctx.baseUrl, before, DECIMAL_AMOUNT);
      const afterDb = await readCheckingBalance();
      await captureLive(page, 's3-decimal-settled');
      if (settled.occurrences !== 1) {
        throw new Error(`SQLite 中 -200.37 的 DEBIT 行应为 1 条，实际 ${settled.occurrences} 条`);
      }
      return `「${PROMPT_S3}」→ 卡片金额 200.37；GET /api/actions → ${describeActions(parked)}；确认前余额未变（API=${mid.balance}，DB=${midDb}）→ 确认 → API 余额 ${settled.balance}、SQLite Account.balance=${afterDb}，账本新增 -200.37 DEBIT 一条（${settled.txIds[0]}），扣款 -200.37 恰好一次`;
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
      await awaitConfirmCard(page, ctx.baseUrl);
      const sessionId = await readDemoSessionId(page);
      const actions = await fetchPendingActions(ctx.baseUrl);
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
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const cancelBody = (await cancelAgain.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string } };
      const cancelRejected = cancelBody.ok === false || cancelBody.data?.ok === false;

      // repeat-confirm on the TERMINAL action → rejected, and NO double deduction.
      const confirmAgain = await fetch(`${ctx.baseUrl}/api/actions/${parked.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      const dbRow = await readPendingAction(parked.id, sessionId);
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
      await awaitConfirmCard(page, ctx.baseUrl);
      await page.getByRole('button', { name: '确认', exact: true }).first().click();
      const afterYellow = await waitForTransferSettled(ctx.baseUrl, before, TRANSFER_AMOUNT);

      // turn 3 — MFA a RED transfer (post-MFA model continuation)
      await submitChat(page, MSG.transferLarge);
      await awaitMfaCard(page, ctx.baseUrl);
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
      await awaitMfaCard(page, ctx.baseUrl);
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
      await awaitMfaCard(page, ctx.baseUrl);
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
 * Engineer "the SDK write commits, the model continuation fails": DETERMINISTICALLY park a YELLOW
 * `transfer_money` — read the canonical server-owned session from the page and poll `/api/actions` for the
 * parked row and, when the live model merely narrated without calling the tool, NUDGE it in the SAME
 * session (bounded attempts) — then reboot the SAME app on the SAME DB with `DEEPSEEK_API_KEY='invalid'`
 * so ONLY the continuation LLM call fails, then hit the confirm endpoint under the shared demo identity.
 * The action must still settle `executed` with exactly ONE debit. (Read-only against app code.)
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
  let sessionId = '';
  await withPage(
    browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, baseUrl);
      sessionId = await readDemoSessionId(page);
      await submitChat(page, MSG.transferByName);
      // ROBUST / DETERMINISTIC PARK — the model is not trusted to CALL the gated tool on the first
      // turn (it often only narrates a question). Poll the persisted server state, and NUDGE in the
      // SAME session until a `transfer_money` action is actually parked (bounded attempts).
      let parked: PendingActionView | undefined;
      for (let attempt = 1; attempt <= PARK_ATTEMPTS && parked === undefined; attempt += 1) {
        try {
          parked = await waitFor(
            async () => findParkedTransfer(await fetchPendingActions(baseUrl)) ?? false,
            {
              timeoutMs: PARK_POLL_MS,
              description: `GET /api/actions 出现 pending/awaiting_mfa 的 transfer_money 待处理项（第 ${attempt}/${PARK_ATTEMPTS} 次）`,
            },
          );
        } catch {
          parked = undefined; // a timeout is expected when the model only narrated — nudge and retry
        }
        if (parked === undefined && attempt < PARK_ATTEMPTS) {
          const nudge = PARK_NUDGES[Math.min(attempt - 1, PARK_NUDGES.length - 1)];
          console.log(`· 场景7：第 ${attempt} 次未出现待确认转账（模型可能只叙述未调用工具），发送跟进消息「${nudge}」`);
          await submitChat(page, nudge);
        }
      }
      if (parked === undefined) {
        await captureLive(page, 's7-no-park');
        throw new Error(
          `场景7 未能停放 transfer_money 待处理项（已尝试 ${PARK_ATTEMPTS} 次，含 ${PARK_ATTEMPTS - 1} 次跟进消息）｜ ${await noCardDiagnostics(page, baseUrl)}`,
        );
      }
      actionId = parked.id;
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
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = (await res.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string; message?: string } };
  netLog.issues.push({ method: 'POST', url: `${baseUrl}/api/actions/${actionId}/confirm`, status: res.status, body: JSON.stringify(body).slice(0, 500) });

  const settled = await waitForTransferSettled(baseUrl, before, TRANSFER_AMOUNT);
  const row = await readPendingAction(actionId, sessionId);
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

/** Verify transport completion and exact text preservation using persisted wire events. */
async function verifyProviderCompletionEvidence(): Promise<string> {
  return withDb(async db => {
    const requests = await db.modelRequest.findMany({ where: { status: 'completed' } });
    if (!requests.length) throw new Error('No completed model request was recorded.');
    const records = await db.agentRunEvent.findMany({ where: { eventType: { startsWith: 'provider_' } }, orderBy: { sequence: 'asc' } });
    for (const request of requests) {
      const evidence = records.map(record => ({ type: record.eventType, ...JSON.parse(record.payloadJson) }))
        .filter(record => record.modelRequestId === request.id);
      if (!evidence.some(record => record.type === 'provider_request_payload' && record.payload.stream === true) ||
          !evidence.some(record => record.type === 'provider_response_headers' && record.payload.status === 200) ||
          !evidence.some(record => record.type === 'provider_response_event' && record.payload.kind === 'transport_end' &&
            record.payload.completed === true && record.payload.terminator === '[DONE]')) {
        throw new Error(`Model request ${request.id} has no complete wire evidence.`);
      }
      const wireText = evidence.flatMap(record => record.type === 'provider_response_event' && Array.isArray(record.payload.choices)
        ? record.payload.choices.flatMap((choice: { delta?: { content?: unknown } }) => typeof choice.delta?.content === 'string' ? [choice.delta.content] : []) : []).join('');
      const result = JSON.parse(request.resultJson!);
      const normalizedText = result.content.filter((block: { type: string }) => block.type === 'text')
        .map((block: { text: string }) => block.text).join('');
      if (wireText !== normalizedText) throw new Error(`Pi text differs from the provider response for ${request.id}.`);
    }
    return `Verified [DONE] and exact provider-to-Pi text equality for ${requests.length} model requests.`;
  });
}

const SCENARIOS: readonly Scenario[] = [
  { id: '15', name: '15-live-complete-fraud-choice-discussion', run: async ctx => {
    const result = await journeyCompleteFraudDiscussion(ctx.browser, ctx.baseUrl);
    return `${result} ${await verifyProviderCompletionEvidence()}`;
  } },
  { id: '14', name: '14-live-subscription-advice-confirmation-and-context', run: ctx => journeySubscriptionAdvice(ctx.browser, ctx.baseUrl) },
  { id: '13', name: '13-live-context-compaction-and-retained-archive', run: ctx => journeyLiveCompaction(ctx.browser, ctx.baseUrl) },
  { id: '12', name: '12-live-signed-amount-memory-and-subscription-analysis', run: ctx => journeyDialogueRegressions(ctx.browser, ctx.baseUrl) },
  { id: '11', name: '11-live-natural-conversation-and-financial-boundary', run: ctx => journeyNaturalConversation(ctx.browser, ctx.baseUrl) },
  { id: '10', name: '10-live-manual-card-management-and-agent-boundary', run: ctx => journeyCardManagement(ctx.browser, ctx.baseUrl) },
  { id: '9', name: '9-live-multi-card-freeze-audit-history', run: ctx => journeyMultiCardFreeze(ctx.browser, ctx.baseUrl) },
  { id: '8', name: '8-live-subscription-tool-lifecycle', run: ctx => journeyToolLifecycle(ctx.browser, ctx.baseUrl) },
  { id: '0', name: '0-live-conversation-and-shared-demo', run: ctx => journeySharedDemo(ctx.browser, ctx.baseUrl) },
  { id: '1', name: '1-live-balance-matches-db', run: scenarioBalance },
  { id: '2', name: '2-live-transfer-recipient-by-name', run: scenarioTransferRecipientByName },
  { id: '2p', name: '2p-live-transfer-recipient-by-phone', run: scenarioTransferRecipientByPhone },
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
  // Spawned server processes inherit the application loader's environment without exposing values.
  loadRuntimeEnvironment();
  const reporter = createReporter();
  const only = selectedIds();
  // Selecting `2` also pulls in its `2p` (by-phone) companion leg.
  const chosen = only
    ? SCENARIOS.filter((s) => only.includes(s.id) || (s.id === '2p' && only.includes('2')))
    : SCENARIOS;
  const runSeven = !only || only.includes('7');
  const originalKey = process.env['DEEPSEEK_API_KEY'];

  let browser: Browser | undefined;
  let devServer: DevServer | undefined;
  // The ACTIVE server handle. Scenario 7 reboots the app by reassigning `server.current`, so teardown
  // must always stop the CURRENT one — stopping only the initially booted `devServer` leaked scenario
  // 7's last server, which kept `prisma/live-acceptance.db` locked (next run: EPERM) and held an open
  // stdout pipe (hanging the PowerShell invocation).
  let server: ServerHandle | undefined;
  const cleanup = () => {
    const active = server?.current ?? devServer;
    if (active) {
      try {
        active.stop();
      } catch {
        /* best-effort */
      }
    }
    devServer = undefined;
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
  const forcedModel = process.env['LIVE_FORCE_MODEL']?.trim();
  console.log(
    forcedModel
      ? 'Live run uses an explicitly requested model override.'
      : 'Live run uses the configured model.',
  );

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
    if (chosen.some(scenario => scenario.id === '13')) {
      process.env.AGENT_COMPACTION_THRESHOLD_TOKENS = '16000';
      process.env.AGENT_COMPACTION_KEEP_RECENT_TOKENS = '512';
      process.env.AGENT_COMPACTION_SUMMARY_TOKENS = '2048';
      console.log('The synthetic compaction journey uses a 16000-token threshold and retains complete recent turns.');
    }
    console.log(`· 隔离 LIVE 数据库：${LIVE_DB_URL}（prisma/dev.db 与 prisma/test.db 不受影响）`);
    console.log('· 重置 LIVE 数据库 →（缺 Prisma Client 时先 prisma generate）→ db push 阶梯 → probe → tsx prisma/seed.ts');
    resetLiveDatabase();

    console.log(
      'Live provider configuration is applied; configuration values are not displayed.',
    );
    devServer = await bootDevServer({ timeoutMs: NAV_TIMEOUT_MS, attempts: 2 });
    const baseUrl = devServer.baseUrl;
    console.log(`· next dev (pid=${devServer.pid}) → ${baseUrl}（/api/health 与 /agent 均已就绪）`);

    // LIVE-mode confirmation: read the RESOLVED config the app actually serves (mock vs live) and,
    // when running scenario 1, observe a narration the scripted mock cannot produce.
    const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as { ok?: boolean; data?: Record<string, unknown> };
    console.log(`· /api/health=${JSON.stringify(health).slice(0, 200)}`);

    console.log(`· 真实浏览器：${executablePath}`);
    browser = await launchBrowser(executablePath);
    const activeServer: ServerHandle = { current: devServer };
    server = activeServer;

    for (const scenario of chosen) {
      try {
        const skip = scenario.skipReason ? await scenario.skipReason() : undefined;
        if (skip !== undefined) {
          reporter.skip(scenario.name, skip);
          continue;
        }
        reporter.pass(scenario.name, await scenario.run({ browser, baseUrl, server: activeServer }));
      } catch (error) {
        reporter.fail(scenario.name, errText(error));
      }
    }

    if (runSeven) {
      try {
        reporter.pass(
          '7-live-committed-continuation-failed',
          await scenarioCommittedContinuationFailed(browser, activeServer, originalKey),
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

  // TASK-A EVIDENCE: the ACTUAL arg shape the LIVE model produced, recovered from the SAME DB the run
  // used (`AgentSession.stateJson` → `agentState.messages`). Printed verbatim for every run.
  console.log('· 【证据】持久化的 transfer_money / search_contact 工具调用（AgentSession.stateJson，参数对象逐字）：');
  console.log(await persistedRecipientCalls());
  console.log(`· 【证据】种子库收款人 ${RECIPIENT_NAME} 手机号=${await readSeedRecipientPhone()}`);

  console.log(`== 汇总：PASS ${reporter.passes} ｜ FAIL ${reporter.failures} ｜ SKIP ${reporter.skips} ==`);
  process.exitCode = reporter.failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`入口脚本失败：${errText(error)}`);
  process.exitCode = 1;
});

// Referenced so `captureScreenshot` stays part of the public harness surface used by `withPage`.
void captureScreenshot;
