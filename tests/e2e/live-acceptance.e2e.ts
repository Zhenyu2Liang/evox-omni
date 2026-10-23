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
import type { Browser, Locator, Page } from 'playwright-core';
import {
  cliCommand,
  ensurePrismaClientGenerated,
  provisionSchemaLadder,
  resolveTsxBin,
  runCliStep as runCliStepShared,
} from '../helpers/prisma-cli';
import { addMoney, centsToMoney, formatCNY, moneyToCents, subtractMoney } from '../../lib/money';
import { addDecimal, compareDecimal, formatDecimalCNY, formatDecimalFixed, subtractDecimal } from '../../lib/decimal';
import { marketValueFromShares, redeemedCostMinor, settlementFromShares } from '../../banking-sdk/net-value';
import { DEMO_NOW } from '../../lib/constants';
import {
  NAV_TIMEOUT_MS,
  REPO_ROOT,
  SCREENSHOTS_DIR,
  SELECTORS,
  assertNoFabricatedConfirmationPanel,
  assistantTexts,
  bootDevServer,
  captureScreenshot,
  clickConfirm,
  createReporter,
  diffLedger,
  errText,
  fetchDashboardSummary,
  fetchLedger,
  fetchPendingActions,
  gotoAgent,
  launchBrowser,
  mfaCardPresent,
  readDemoSessionId,
  resolveBrowserExecutable,
  sleep,
  submitChat,
  submitMfa,
  waitFor,
  waitForConfirmCard,
  waitForElementHydration,
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
// Virtual-card live scenarios (lD/lE) are built ON TOP of this shared helper module. Its read-model /
// DB primitives (`LiveCardRecord`, `cardById`, `fetchLiveCards`, `readCardTileRows`, `readDialogRows`,
// `withDb`) are the ONLY definitions in the repository: this entry script imports them instead of
// keeping local copies, so lA / lB / lC and lD / lE share one implementation of each primitive.
import {
  VC_CHECKING_ACCOUNT_ID,
  VC_FIRST_SPEND,
  VC_LIMIT_EXCEEDED_TEXT,
  VC_MERCHANT_APPLY,
  VC_MERCHANT_PRE_LOST,
  VC_MERCHANT_REFUSED,
  VC_MERCHANT_REPLACE,
  VC_MONTHLY_LIMIT,
  VC_OVER_LIMIT_SPEND,
  VC_SECOND_SPEND,
  VC_SPEND_CATEGORY,
  VC_TINY_SPEND,
  applyVirtualCardViaAgent,
  assertNoSpend,
  assertSingleSpend,
  assertVirtualCardTile,
  assertVirtualCardView,
  attemptConsumeExpectingRefusal,
  awaitRawCard,
  cardById,
  consumeSuccessfully,
  expectedPayableMinor,
  fetchLiveCards,
  gotoCards,
  liveModelId,
  openConsumeDialog,
  readCardSpendState,
  readCardTileRows,
  readCardTileText,
  readDialogRows,
  vcReplaceTurns,
  vcReportLostTurns,
  withDb,
  writeScenarioEvidence,
  type LiveCardRecord,
  type RawCardRow,
} from './live-virtual-card.e2e-helper';
// The Chinese `CardTile` / `CardConsumeDialog` row labels are NOT hard-coded here: they come from the
// single source module that derives them from the very catalogue those components render from.
import { CARD_LABEL } from './card-labels.e2e-helper';
// Card-loss / replace chain scenarios (lF: fresh-session credit lost->replace; lG: ONE session full chain).
// The scenario bodies live in this module; the entry only registers them.
import { scenarioCreditReplaceNewSession, scenarioFullCardChain } from './card-replace-chain.e2e-helper';
import { scenarioDebitCardLinkedAccount } from './live-debit-card.e2e-helper';

// --- isolated LIVE database ---------------------------------------------------------------------

const LIVE_DB_FILES = ['live-acceptance.db', 'live-acceptance.db-wal', 'live-acceptance.db-shm', 'live-acceptance.db-journal'] as const;
/** Absolute `file:` URL (forward slashes — Prisma rejects a Windows backslash URL). */
const LIVE_DB_URL = `file:${path.join(REPO_ROOT, 'prisma', 'live-acceptance.db').split(path.sep).join('/')}`;

const DEMO_CHECKING_ID = 'acct_checking';
const RECIPIENT_NAME = '张伟';
const RECIPIENT_CONTACT_ID = 'contact_zhangwei';
const CREDIT_CARD_ID = 'card_credit';
const DEBIT_CARD_ID = 'card_debit';
const VIRTUAL_CARD_ID = 'card_virtual';

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
//
// `withDb` itself is the shared definition exported by `./live-virtual-card.e2e-helper`; this section
// only holds the live-specific readers built on top of it.

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

/** Is the chat composer (its controlled `<textarea>`) ENABLED? It is disabled while a turn streams. */
async function composerEnabled(page: Page): Promise<boolean> {
  const composer = page.locator(SELECTORS.composer).first();
  return (await composer.count()) > 0 && (await composer.isEnabled());
}

/**
 * Bounded natural-language DRIVER for a RED (MFA) tool. Both live targets below are RED tier, so a
 * successful model turn parks an MFA card — but the LIVE model sometimes asks a plain confirmation
 * question first and never invokes the gated tool. This driver sends ONLY natural Chinese (never an
 * internal tool/parameter name) and, when a turn ends WITHOUT a card, nudges with the next short
 * confirmation in the same spirit. It returns the prompts actually sent once the verification code
 * has been submitted.
 *
 * A turn that ends with prose but NO card is checked for a FABRICATED confirmation-panel claim
 * (`assertNoFabricatedConfirmationPanel`): a claim that a panel ALREADY exists while nothing is parked
 * FAILS here instead of being nudged past. A plain clarifying question (no panel claim) keeps nudging.
 *
 * `requireCardAtEnd` (default `true`): when the bounded turns never park a card the driver falls
 * through to the UNWEAKENED `awaitMfaCard` (a REAL model-behaviour failure), never a skip or a
 * substituted mock. Pass `false` ONLY for a leg where an explicit model REFUSAL is acceptable (e.g.
 * an idempotency re-request): it then settles the turn without requiring a second MFA/tool execution.
 */
async function driveRedTool(
  page: Page,
  baseUrl: string,
  turns: readonly string[],
  perTurnTimeoutMs = 30_000,
  requireCardAtEnd = true,
): Promise<string[]> {
  if (turns.length === 0) throw new Error('driveRedTool 至少需要一条自然语言消息');
  const sent: string[] = [];
  /** Complete a parked card (confirm if needed, then MFA) so the turn settles. */
  const settleCard = async (outcome: 'mfa' | 'confirm'): Promise<void> => {
    if (outcome === 'confirm') {
      await awaitConfirmCard(page, baseUrl, perTurnTimeoutMs);
      await clickConfirm(page);
    }
    await awaitMfaCard(page, baseUrl, perTurnTimeoutMs);
    await submitMfa(page, '123456');
  };
  for (const turn of turns) {
    const baseline = (await assistantTexts(page)).length;
    await submitChat(page, turn);
    sent.push(turn);
    // A turn ends when the composer frees up: either the gated tool parked an MFA card, or the model
    // answered with a plain question (no card). Re-poll a still-streaming (silent) turn.
    const outcome = await waitFor(
      async () => {
        if (await mfaCardPresent(page)) return 'mfa' as const;
        if ((await confirmButtonCount(page)) > 0) return 'confirm' as const;
        return (await assistantTexts(page)).length > baseline && (await composerEnabled(page)) ? 'reply' as const : false;
      },
      { timeoutMs: perTurnTimeoutMs, intervalMs: 1_000, description: `等待 LIVE 模型调用受控工具（自然轮次，MFA 卡片）：${turn}` },
    ).catch(() => 'timeout' as const);
    if (outcome === 'mfa' || outcome === 'confirm') {
      await settleCard(outcome);
      return sent;
    }
    if (outcome === 'reply') {
      // Prose with NO card: FAIL now if that prose fabricates a panel that does not exist; a plain
      // clarifying question is not a claim and keeps the existing nudge flow.
      const prose = (await assistantTexts(page)).slice(baseline).join('\n');
      await assertNoFabricatedConfirmationPanel({ page, prose, actions: await fetchPendingActions(baseUrl) });
    }
    // 'reply' (model asked a plain question) or 'timeout' (still working): send the next natural turn.
  }
  if (!requireCardAtEnd) {
    // Optional-card leg: settle the turn (a late card is still completed) but never REQUIRE one.
    const finalOutcome = await waitFor(
      async () => {
        if (await mfaCardPresent(page)) return 'mfa' as const;
        if ((await confirmButtonCount(page)) > 0) return 'confirm' as const;
        return (await composerEnabled(page)) ? 'settled' as const : false;
      },
      { timeoutMs: perTurnTimeoutMs, intervalMs: 1_000, description: 'RED 工具自然轮次结算（本轮不要求二次 MFA）' },
    ).catch(() => 'settled' as const);
    if (finalOutcome === 'mfa' || finalOutcome === 'confirm') await settleCard(finalOutcome);
    return sent;
  }
  // Bounded turns produced no MFA card — one UNWEAKENED final wait (throws with the failure evidence).
  await awaitMfaCard(page, baseUrl, perTurnTimeoutMs);
  await submitMfa(page, '123456');
  return sent;
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
        let snapshot: PendingActionView[] = [];
        try {
          parked = await waitFor(
            async () => {
              snapshot = await fetchPendingActions(baseUrl);
              return findParkedTransfer(snapshot) ?? false;
            },
            {
              timeoutMs: PARK_POLL_MS,
              description: `GET /api/actions 出现 pending/awaiting_mfa 的 transfer_money 待处理项（第 ${attempt}/${PARK_ATTEMPTS} 次）`,
            },
          );
        } catch {
          parked = undefined; // a timeout is expected when the model only narrated — nudge and retry
        }
        if (parked === undefined) {
          // A prose-only claim that a confirmation panel ALREADY exists while nothing is parked is a
          // FABRICATION: FAIL it here instead of nudging past it (distinguishes model vs UI cause).
          await assertNoFabricatedConfirmationPanel({
            page,
            prose: (await assistantTexts(page)).join('\n'),
            actions: snapshot,
          });
          if (attempt < PARK_ATTEMPTS) {
            const nudge = PARK_NUDGES[Math.min(attempt - 1, PARK_NUDGES.length - 1)];
            console.log(`· 场景7：第 ${attempt} 次未出现待确认转账（模型可能只叙述未调用工具），发送跟进消息「${nudge}」`);
            await submitChat(page, nudge);
          }
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

// --- scenarios lA / lB: LIVE card replacement + partial investment redemption ---------------------

const HOLDING_WENJIANA_ID = 'holding_wenjiana';
const CARD_REPLACE_PROMPT = '请为我挂失的信用卡补办一张新卡';

/** The UNIQUE `CREDIT` + `ACTIVE` card, or `undefined` when there is none / more than one. */
function uniqueActiveCreditCard(cards: readonly LiveCardRecord[]): LiveCardRecord | undefined {
  const matches = cards.filter((card) => card.type === 'CREDIT' && card.status === 'ACTIVE');
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * TOTAL available credit that may actually be SPENT: every `CREDIT` card that is NOT `LOST`.
 * A 补办 card stays in the read model as `LOST` and KEEPS its recorded `availableLimit`, so the
 * family's allowance must be counted exactly ONCE — through the replacement, never the source too.
 */
function nonLostCreditAvailableTotalMinor(cards: readonly LiveCardRecord[]): bigint {
  return cards
    .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST' && card.availableLimit !== undefined)
    .reduce((sum, card) => sum + moneyToCents(card.availableLimit as string), 0n);
}

/** The NAIVE total over ALL `CREDIT` cards INCLUDING `LOST` ones — recorded only to expose the trap. */
function allCreditAvailableTotalMinor(cards: readonly LiveCardRecord[]): bigint {
  return cards
    .filter((card) => card.type === 'CREDIT' && card.availableLimit !== undefined)
    .reduce((sum, card) => sum + moneyToCents(card.availableLimit as string), 0n);
}

/** Poll the real `/api/cards` route until `predicate` holds (a business condition, never a fixed sleep). */
function awaitLiveCards(
  baseUrl: string,
  predicate: (cards: LiveCardRecord[]) => boolean,
  description: string,
  timeoutMs = 180_000,
): Promise<LiveCardRecord[]> {
  return waitFor(
    async () => {
      const cards = await fetchLiveCards(baseUrl);
      return predicate(cards) ? cards : false;
    },
    { timeoutMs, intervalMs: 1_000, description },
  );
}

/**
 * SCENARIO lA (LIVE-LLM, REAL BROWSER): report the demo credit card lost (RED `report_lost_card`) and
 * replace it (RED `replace_card`) purely through the `/agent` chat + MFA, then verify the replacement
 * on the REAL `/cards` page, `GET /api/cards` and SQLite — and prove `replace_card` is IDEMPOTENT for
 * the SAME source card: a SECOND UI request must NOT mint a second card.
 *
 * Idempotency rule: a repeat request may REPLAY the original result, RETURN the existing result, or
 * explicitly REFUSE the duplicate — all three are acceptable and a SECOND MFA / tool execution is NOT
 * required. The leg is therefore judged ONLY by the authoritative `GET /api/cards` state (still 3
 * cards, unchanged single ACTIVE credit card), never by waiting for a second MFA card to appear or
 * disappear.
 */
async function scenarioCreditReplace(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      await gotoAgent(page, ctx.baseUrl);

      // BASELINE — the usable available credit BEFORE 挂失/补办, straight from the read route, so the
      // post-补办 total can be compared against it (a 补办 must never ADD credit).
      const cardsBeforeReplace = await fetchLiveCards(ctx.baseUrl);
      const sourceBefore = cardById(cardsBeforeReplace, CREDIT_CARD_ID);
      if (sourceBefore?.type !== 'CREDIT' || sourceBefore.status !== 'ACTIVE' || sourceBefore.availableLimit === undefined) {
        throw new Error(`挂失前 ${CREDIT_CARD_ID} 应为带 availableLimit 的 ACTIVE CREDIT 卡，实际 ${JSON.stringify(sourceBefore)}`);
      }
      const totalAvailableBeforeMinor = nonLostCreditAvailableTotalMinor(cardsBeforeReplace);
      const naiveAllCreditBeforeMinor = allCreditAvailableTotalMinor(cardsBeforeReplace);

      // A1 — RED `report_lost_card`: bounded natural turns until the model parks the MFA card.
      const sentA1 = await driveRedTool(page, ctx.baseUrl, [
        '我的信用卡丢失了，请帮我正式挂失尾号6688的信用卡',
        '确认，请办理',
        '界面上方没有出现确认面板，请重新发起这张卡的挂失',
        '请直接帮我办理挂失，我已经确认',
      ]);
      await awaitLiveCards(
        ctx.baseUrl,
        (cards) => cards.find((card) => card.id === CREDIT_CARD_ID)?.status === 'LOST',
        `挂失后 GET /api/cards 中 ${CREDIT_CARD_ID}.status === LOST`,
      );

      // A2 — RED `replace_card`: same bounded natural turns (a short confirmation if the model asks).
      const sentA2 = await driveRedTool(page, ctx.baseUrl, [
        CARD_REPLACE_PROMPT,
        '确认，请为我补办',
        '界面上方没有出现确认面板，请重新发起补办',
        '请直接为我补办一张新卡，我已确认',
      ]);
      const replaced = await awaitLiveCards(
        ctx.baseUrl,
        (cards) =>
          cardById(cards, DEBIT_CARD_ID)?.type === 'DEBIT' &&
          cardById(cards, DEBIT_CARD_ID)?.status === 'ACTIVE' &&
          cardById(cards, VIRTUAL_CARD_ID)?.type === 'VIRTUAL' &&
          cardById(cards, VIRTUAL_CARD_ID)?.status === 'ACTIVE' &&
          cards.find((card) => card.id === CREDIT_CARD_ID)?.replacedByCardId !== undefined &&
          uniqueActiveCreditCard(cards) !== undefined,
        '补卡后：card_credit 已关联补办卡、恰有一张 ACTIVE 信用卡，且 DEBIT / VIRTUAL 演示卡仍为 ACTIVE',
      );
      const activeCredit = uniqueActiveCreditCard(replaced);
      if (activeCredit === undefined) throw new Error('补卡后未找到唯一的 ACTIVE 信用卡');
      const newId = activeCredit.id;

      // REAL PAGE — the replacement tile's limits/status and the source card's LOST + 已补卡 badges.
      await page.goto(`${ctx.baseUrl}/cards`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, '[data-card-add] button');
      const newRows = await readCardTileRows(page, newId);
      const newTileText = (await page.locator(`[data-card-id="${newId}"]`).first().innerText()).replace(/\s+/g, ' ');
      const sourceTileText = (await page.locator(`[data-card-id="${CREDIT_CARD_ID}"]`).first().innerText()).replace(/\s+/g, ' ');
      const cardsShot = await captureLive(page, 'lA-cards');
      if (newRows[CARD_LABEL.creditLimit] !== '¥18,000.00' || newRows[CARD_LABEL.availableLimit] !== '¥18,000.00') {
        throw new Error(`补办信用卡 ${newId} 应显示 信用额度=可用额度=¥18,000.00，实际 ${JSON.stringify(newRows)}`);
      }
      if (!newTileText.includes('正常')) {
        throw new Error(`补办信用卡 ${newId} 未显示「正常」状态：${newTileText.slice(0, 200)}`);
      }
      if (!sourceTileText.includes('已挂失') || !sourceTileText.includes('已补卡')) {
        throw new Error(`${CREDIT_CARD_ID} 应同时显示「已挂失」与「已补卡」，实际：${sourceTileText.slice(0, 200)}`);
      }

      // AUTHORITATIVE cross-check via the raw `/api/cards` route (NOT the narrow `fetchCards` helper).
      const cards = await fetchLiveCards(ctx.baseUrl);
      const actives = cards.filter((card) => card.type === 'CREDIT' && card.status === 'ACTIVE');
      if (actives.length !== 1) {
        throw new Error(`应恰有 1 张 ACTIVE 信用卡，实际 ${actives.length}：${JSON.stringify(cards)}`);
      }
      const active = actives[0];
      if (active.creditLimit !== '18000.00' || active.availableLimit !== '18000.00') {
        throw new Error(`ACTIVE 信用卡额度应为 creditLimit=availableLimit=18000.00，实际 creditLimit=${active.creditLimit}、availableLimit=${active.availableLimit}`);
      }
      const source = cardById(cards, CREDIT_CARD_ID);
      if (source?.status !== 'LOST') throw new Error(`${CREDIT_CARD_ID} 应仍为 LOST，实际 ${source?.status}`);
      if (source?.replacedByCardId !== active.id) {
        throw new Error(`${CREDIT_CARD_ID}.replacedByCardId 应指向 ${active.id}，实际 ${source?.replacedByCardId}`);
      }
      // The replacement CREDIT card inherits the source's monthly limit; the OTHER two seeded cards are
      // untouched and keep their EXACT type / status / limits — asserted by type/status, never by count alone.
      if (active.monthlyLimit !== '18000.00') {
        throw new Error(`补办信用卡月限额应继承原卡（18000.00），实际 ${active.monthlyLimit}`);
      }
      const debitCard = cardById(cards, DEBIT_CARD_ID);
      if (debitCard?.type !== 'DEBIT' || debitCard.status !== 'ACTIVE' || debitCard.creditLimit !== undefined
        || debitCard.availableLimit !== undefined || debitCard.monthlyLimit !== undefined) {
        throw new Error(`${DEBIT_CARD_ID} 应为不带任何额度字段的 ACTIVE DEBIT 卡，实际 ${JSON.stringify(debitCard)}`);
      }
      const virtualCard = cardById(cards, VIRTUAL_CARD_ID);
      if (virtualCard?.type !== 'VIRTUAL' || virtualCard.status !== 'ACTIVE'
        || virtualCard.monthlyLimit !== '5000.00' || virtualCard.linkedAccountId !== DEMO_CHECKING_ID) {
        throw new Error(`${VIRTUAL_CARD_ID} 应为绑定 ${DEMO_CHECKING_ID}、月限额 5000.00 的 ACTIVE VIRTUAL 卡，实际 ${JSON.stringify(virtualCard)}`);
      }
      if (cards.filter((card) => card.type === 'DEBIT').length !== 1 || cards.filter((card) => card.type === 'VIRTUAL').length !== 1) {
        throw new Error(`应恰有 1 张 DEBIT 与 1 张 VIRTUAL 卡，实际 ${cards.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }
      if (cards.length !== 4) {
        throw new Error(`卡片总数应为 4（1 张 ACTIVE 补办卡 + 1 张 LOST 源卡 + 1 张 DEBIT + 1 张 VIRTUAL），实际 ${cards.length}：${cards.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }

      // NO-DOUBLING — 补办 must not create credit: the replacement INHERITS the source's available
      // limit and the `LOST` source stops counting toward usable credit, so the spendable total is
      // unchanged. A total that DOUBLED here would let the demo user spend the same allowance twice.
      const totalAvailableAfterMinor = nonLostCreditAvailableTotalMinor(cards);
      const naiveAllCreditAfterMinor = allCreditAvailableTotalMinor(cards);
      if (active.availableLimit !== sourceBefore.availableLimit) {
        throw new Error(`补办卡可用额度应继承原卡 ${sourceBefore.availableLimit}（不得放大），实际 ${active.availableLimit}`);
      }
      if (totalAvailableAfterMinor !== totalAvailableBeforeMinor) {
        throw new Error(`补办前后「非 LOST 信用卡可用额度合计」必须不变（额度不得算两次）：补办前 ${centsToMoney(totalAvailableBeforeMinor)} → 补办后 ${centsToMoney(totalAvailableAfterMinor)}（明细：${cards.filter((card) => card.type === 'CREDIT').map((card) => `${card.id}:${card.status}:可用=${card.availableLimit ?? '无'}`).join(' ')}）`);
      }

      // IDEMPOTENCY — a SECOND `replace_card` request through the UI must NOT mint a second card. The
      // repeat request may replay the original result, return the existing result, or explicitly refuse
      // the duplicate; a second MFA / tool execution is NOT required (`requireCardAtEnd = false`). The
      // leg is judged solely by the authoritative `GET /api/cards` route state below.
      await gotoAgent(page, ctx.baseUrl);
      const sentIdem = await driveRedTool(
        page,
        ctx.baseUrl,
        [
          CARD_REPLACE_PROMPT,
          '确认，请为我补办',
          '请再提交一次这张卡的补办申请，我要确认不会重复发卡',
        ],
        undefined,
        false,
      );
      const afterSecond = await fetchLiveCards(ctx.baseUrl);
      const activeAfter = uniqueActiveCreditCard(afterSecond);
      if (afterSecond.length !== 4) {
        throw new Error(`第二次补卡后卡片总数应仍为 4（未新增第二张补办卡），实际 ${afterSecond.length}：${afterSecond.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }
      if (activeAfter?.id !== newId) {
        throw new Error(`第二次补卡后 ACTIVE 信用卡 id 应仍为 ${newId}（未新增第二张），实际 ${activeAfter?.id ?? '无'}`);
      }

      // …and the repeat request must not release a SECOND allowance either.
      const totalAvailableAfterIdemMinor = nonLostCreditAvailableTotalMinor(afterSecond);
      if (totalAvailableAfterIdemMinor !== totalAvailableBeforeMinor) {
        throw new Error(`重复补卡请求后「非 LOST 信用卡可用额度合计」仍须为 ${centsToMoney(totalAvailableBeforeMinor)}（不得重复发卡/放额度），实际 ${centsToMoney(totalAvailableAfterIdemMinor)}：${afterSecond.filter((card) => card.type === 'CREDIT').map((card) => `${card.id}:${card.status}:可用=${card.availableLimit ?? '无'}`).join(' ')}`);
      }

      return `A1 实际发送：${sentA1.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → card_credit=LOST；A2 实际发送：${sentA2.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 新卡 ${newId}（信用额度=${newRows[CARD_LABEL.creditLimit]}、可用额度=${newRows[CARD_LABEL.availableLimit]}，状态含「正常」）；/cards 上 ${CREDIT_CARD_ID} 显示「已挂失」+「已补卡」；GET /api/cards：共 ${cards.length} 张、唯一 ACTIVE 信用卡 id=${active.id}、creditLimit=${active.creditLimit}、availableLimit=${active.availableLimit}、card_credit.status=${source?.status}、replacedByCardId=${source?.replacedByCardId}；再次补卡实际发送：${sentIdem.map((t) => `「${t}」`).join(' → ')}（重复请求，允许重放/返回既有结果/显式拒绝，不要求二次 MFA/工具执行）后仍为 ${afterSecond.length} 张、ACTIVE id=${activeAfter?.id ?? '无'}（未新增第二张）；可用信用额度（非 LOST 信用卡合计）：补办前 ${centsToMoney(totalAvailableBeforeMinor)}（${CREDIT_CARD_ID}:ACTIVE:可用=${sourceBefore.availableLimit}）→ 补办后 ${centsToMoney(totalAvailableAfterMinor)}（唯一 ACTIVE 补办卡 ${newId}:可用=${active.availableLimit}；${CREDIT_CARD_ID}:LOST:可用=${source?.availableLimit ?? '无'}，已排除）；把 LOST 源卡也计入的朴素合计 ${centsToMoney(naiveAllCreditBeforeMinor)} → ${centsToMoney(naiveAllCreditAfterMinor)}（重复计额度，已被断言排除）；重复补卡后合计=${centsToMoney(totalAvailableAfterIdemMinor)}；截图 ${cardsShot ?? '未落盘'}`;
    },
    { label: 'lA-credit-report-lost-and-replace' },
  );
}

/** The `holding_wenjiana` row subset the redemption scenario asserts on. */
interface LiveHoldingRow {
  principalAmountMinor: bigint;
  estimatedMarketValue: string | null;
  shares: string | null;
  status: string;
}

/** One read of the position in 「净值 + 份额」 terms: shares, remaining cost, market value, net value. */
interface LiveHoldingSnapshot {
  shares: string;
  costMinor: bigint;
  marketValue: string;
  status: string;
  realizedProfitMinor: bigint;
  netValue: string;
}

/** Poll SQLite for the `holding_wenjiana` row until `predicate` holds (a business condition). */
function awaitHolding(
  predicate: (row: LiveHoldingRow) => boolean,
  description: string,
  timeoutMs = 180_000,
): Promise<LiveHoldingRow> {
  return waitFor(
    async () =>
      withDb(async (db) => {
        const row = await db.investmentHolding.findUnique({
          where: { id: HOLDING_WENJIANA_ID },
          select: { principalAmountMinor: true, estimatedMarketValue: true, shares: true, status: true },
        });
        return row && predicate(row) ? row : false;
      }),
    { timeoutMs, intervalMs: 1_000, description },
  );
}

/**
 * Read the position in 「净值 + 份额」 terms straight from SQLite. Every expected figure of the
 * scenario is derived HERE, so the assertions state the contract (到账 = 赎回份额 × 成交净值 rounded
 * HALF_UP once, the consumed cost is proportional to the redeemed shares, and 收益 = 到账 − 成本)
 * instead of a hard-coded principal plus a fixed yield.
 */
async function readHoldingSnapshot(): Promise<LiveHoldingSnapshot> {
  return withDb(async (db) => {
    const holding = await db.investmentHolding.findUniqueOrThrow({ where: { id: HOLDING_WENJIANA_ID } });
    const product = await db.investmentProduct.findUniqueOrThrow({ where: { id: holding.productId } });
    const netValue = product.latestNetValuePerUnit;
    if (netValue === null) throw new Error('稳健理财A 未发布净值，无法按「净值 + 份额」核对赎回');
    if (holding.shares === null || holding.estimatedMarketValue === null) {
      throw new Error('稳健理财A 持仓缺少份额或市值，无法按「净值 + 份额」核对');
    }
    return {
      shares: holding.shares,
      costMinor: holding.principalAmountMinor,
      marketValue: holding.estimatedMarketValue,
      status: holding.status,
      realizedProfitMinor: holding.realizedProfitMinor,
      netValue,
    };
  });
}

/** Read one labelled `label → value` row (two adjacent spans) from a rendered investment tile. */
async function readTileRow(tile: Locator, label: string): Promise<string> {
  return tile.evaluate((el, wanted) => {
    for (const span of Array.from(el.querySelectorAll('span'))) {
      if ((span.textContent ?? '').trim() !== wanted) continue;
      const cells = span.parentElement ? Array.from(span.parentElement.querySelectorAll('span')) : [];
      if (cells.length >= 2) return (cells[1].textContent ?? '').trim();
    }
    return '';
  }, label);
}

/** Parse a rendered `[+-]?¥1,234.56` cell back to SIGNED cents (presentation → comparable figure). */
function renderedMinor(text: string): bigint {
  const negative = text.startsWith('-');
  const minor = moneyToCents(text.replace(/[+\-¥,]/g, ''));
  return negative ? -minor : minor;
}

/** A signed decimal valuation rendered the way `DecimalMoney` renders it (`+` only when positive). */
function signedDecimalCNY(amount: string): string {
  return (compareDecimal(amount, '0') > 0 ? '+' : '') + formatDecimalCNY(amount);
}

/**
 * SCENARIO lB (LIVE-LLM, REAL BROWSER): subscribe an extra ¥1,000 into 稳健理财A (RED) and then
 * PARTIALLY redeem BY AMOUNT (¥2,000 — the口径 must be explicit, a bare number only earns a
 * clarification) through the `/agent` chat + MFA, then verify the resulting 「净值 + 份额」 position
 * (remaining shares / remaining cost / market value / realized profit) on the REAL `/investments`
 * page, the ledger + balance and the full-precision valuation stored in SQLite.
 */
async function scenarioPartialRedeem(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      const beforeHolding = await readHoldingSnapshot();
      const beforeBalance = (await fetchDashboardSummary(ctx.baseUrl)).checkingBalance;
      const beforeLedger = (await fetchLedger(ctx.baseUrl)).transactions;
      await gotoAgent(page, ctx.baseUrl);

      // B1 — RED `subscribe_investment` (¥1,000 into 稳健理财A): the cost basis grows by exactly
      // ¥1,000.00 AND the share count grows. Bounded natural turns; if the model insists on a failing
      // plan/submission path, one mild natural rephrase.
      const sentB1 = await driveRedTool(page, ctx.baseUrl, [
        '追加申购稳健理财A 1000元',
        '确认，请办理',
        '界面上方没有出现确认面板，请重新发起这笔追加申购',
        '现在就用我的账户追加申购稳健理财A 1000元',
      ]);
      const costAfterSubscribeMinor = beforeHolding.costMinor + 100_000n;
      await awaitHolding(
        (row) => row.principalAmountMinor === costAfterSubscribeMinor,
        `B1 后 holding_wenjiana 剩余持仓成本 ${centsToMoney(costAfterSubscribeMinor)}（申购前 + ¥1,000.00）`,
      );
      const subscribed = await readHoldingSnapshot();
      if (subscribed.shares === beforeHolding.shares) {
        throw new Error(`追加申购后持仓份额应增加，实际仍为 ${subscribed.shares}（净值 ${subscribed.netValue}）`);
      }
      const subscribedMarketValue = marketValueFromShares(subscribed.shares, subscribed.netValue);
      if (subscribed.marketValue !== subscribedMarketValue) {
        throw new Error(`追加申购后市值应为「份额 × 净值」= ${subscribedMarketValue}，实际 ${subscribed.marketValue}`);
      }

      // B2 — RED `redeem_investment` BY AMOUNT (¥2,000, explicit 口径 in the prompt): bounded natural turns.
      const sentB2 = await driveRedTool(page, ctx.baseUrl, [
        '我持有的稳健理财A按金额部分赎回2000元，保留剩余持仓',
        '确认，请办理',
        '界面上方没有出现确认面板，请重新发起这笔部分赎回',
      ]);
      await awaitHolding(
        (row) => row.status === 'HOLDING'
          && row.shares !== null
          && row.shares !== subscribed.shares
          && row.principalAmountMinor < subscribed.costMinor,
        'B2 后持仓仍为 HOLDING 且份额与剩余成本都下降（部分赎回，未清仓）',
      );
      const redeemed = await readHoldingSnapshot();

      // 「份额 × 净值」 accounting: 到账 = HALF_UP(赎回份额 × 成交净值) to cents, the consumed cost is
      // proportional to the redeemed shares, and the difference is the realized profit.
      const redeemedShares = subtractDecimal(subscribed.shares, redeemed.shares);
      if (compareDecimal(redeemedShares, '0') <= 0) {
        throw new Error(`部分赎回后份额应减少，实际 ${subscribed.shares} → ${redeemed.shares}`);
      }
      const expectedSettlement = settlementFromShares(redeemedShares, redeemed.netValue);
      const expectedSettlementMinor = moneyToCents(expectedSettlement);
      const consumedCostMinor = redeemedCostMinor(subscribed.costMinor, redeemedShares, subscribed.shares);
      if (consumedCostMinor <= 0n || redeemed.costMinor <= 0n) {
        throw new Error(`部分赎回后扣减成本与剩余成本都应大于零：扣减 ${centsToMoney(consumedCostMinor)}、剩余 ${centsToMoney(redeemed.costMinor)}`);
      }
      if (consumedCostMinor + redeemed.costMinor !== subscribed.costMinor) {
        throw new Error(`扣减成本 ${centsToMoney(consumedCostMinor)} + 剩余成本 ${centsToMoney(redeemed.costMinor)} 应等于赎回前成本 ${centsToMoney(subscribed.costMinor)}`);
      }
      const redeemedMarketValue = marketValueFromShares(redeemed.shares, redeemed.netValue);
      if (redeemed.marketValue !== redeemedMarketValue) {
        throw new Error(`部分赎回后市值应为「剩余份额 × 净值」= ${redeemedMarketValue}，实际 ${redeemed.marketValue}`);
      }
      const realizedDelta = redeemed.realizedProfitMinor - subscribed.realizedProfitMinor;
      if (realizedDelta !== expectedSettlementMinor - consumedCostMinor) {
        throw new Error(`本次已实现收益应为 到账 ${expectedSettlement} − 扣减成本 ${centsToMoney(consumedCostMinor)} = ${centsToMoney(expectedSettlementMinor - consumedCostMinor)}，实际 ${centsToMoney(realizedDelta)}`);
      }

      // REAL PAGE — the 净值 + 份额 facts rendered on `/investments` agree with SQLite.
      await page.goto(`${ctx.baseUrl}/investments`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, '[data-investment-holdings]');
      const tiles = page.locator('[data-investment-holdings] div.rounded-2xl').filter({ hasText: '稳健理财A' });
      const tileCount = await tiles.count();
      if (tileCount !== 1) throw new Error(`/investments 持仓区「稳健理财A」卡片应恰 1 张，实际 ${tileCount}`);
      const labels = ['持有金额', '剩余持仓成本', '持仓份额', '最新净值', '市值', '持仓收益', '累计收益', '已实现收益'];
      const shown: Record<string, string> = {};
      for (const label of labels) {
        const value = await readTileRow(tiles.first(), label);
        if (value === '') throw new Error(`/investments 未渲染「${label}」行（净值 + 份额口径的持仓卡应展示该行）`);
        shown[label] = value;
      }
      await captureLive(page, 'lB-investments');
      for (const label of ['持有金额', '剩余持仓成本', '市值', '持仓收益', '累计收益', '已实现收益']) {
        if (/\.\d{3,}/.test(shown[label])) throw new Error(`「${label}」展示了未结算的过高精度：${shown[label]}`);
        if (!/^[+-]?¥[\d,]+\.\d{2}$/.test(shown[label])) throw new Error(`「${label}」显示值格式不正确：${shown[label]}`);
      }
      // 剩余持仓成本 (and the booked 持有金额 that mirrors it) is money, not a share of the old principal.
      const expectedCost = formatCNY(centsToMoney(redeemed.costMinor));
      if (shown['持有金额'] !== expectedCost) throw new Error(`持有金额应为 ${expectedCost}（剩余持仓成本），实际 ${shown['持有金额']}`);
      if (shown['剩余持仓成本'] !== expectedCost) throw new Error(`剩余持仓成本应为 ${expectedCost}，实际 ${shown['剩余持仓成本']}`);
      const expectedShares = `${formatDecimalFixed(redeemed.shares, 6)} 份`;
      if (shown['持仓份额'] !== expectedShares) throw new Error(`持仓份额应为 ${expectedShares}，实际 ${shown['持仓份额']}`);
      const expectedNetValue = `${formatDecimalFixed(redeemed.netValue, 4)} 元/份`;
      if (shown['最新净值'] !== expectedNetValue) throw new Error(`最新净值应为 ${expectedNetValue}，实际 ${shown['最新净值']}`);
      const expectedMarketValue = formatDecimalCNY(redeemed.marketValue);
      if (shown['市值'] !== expectedMarketValue) throw new Error(`市值应为 ${expectedMarketValue}（剩余份额 × 最新净值），实际 ${shown['市值']}`);
      const unrealized = subtractDecimal(redeemed.marketValue, centsToMoney(redeemed.costMinor));
      if (shown['持仓收益'] !== signedDecimalCNY(unrealized)) {
        throw new Error(`持仓收益应为 ${signedDecimalCNY(unrealized)}（市值 − 剩余持仓成本），实际 ${shown['持仓收益']}`);
      }
      const realizedShown = centsToMoney(redeemed.realizedProfitMinor);
      if (shown['已实现收益'] !== formatDecimalCNY(realizedShown)) {
        throw new Error(`已实现收益应为 ${formatDecimalCNY(realizedShown)}，实际 ${shown['已实现收益']}`);
      }
      const cumulative = addDecimal(realizedShown, unrealized);
      if (shown['累计收益'] !== signedDecimalCNY(cumulative)) {
        throw new Error(`累计收益应为 ${signedDecimalCNY(cumulative)}（已实现收益 + 持仓收益），实际 ${shown['累计收益']}`);
      }
      // Cross-field consistency: 持仓收益 = 市值 − 持有金额 and 累计收益 = 已实现收益 + 持仓收益.
      if (renderedMinor(shown['持仓收益']) !== renderedMinor(shown['市值']) - renderedMinor(shown['持有金额'])) {
        throw new Error(`持仓收益与「市值 − 持有金额」不自洽：${shown['持仓收益']} vs ${shown['市值']} − ${shown['持有金额']}`);
      }
      if (renderedMinor(shown['累计收益']) !== renderedMinor(shown['已实现收益']) + renderedMinor(shown['持仓收益'])) {
        throw new Error(`累计收益与「已实现收益 + 持仓收益」不自洽：${shown['累计收益']} vs ${shown['已实现收益']} + ${shown['持仓收益']}`);
      }

      // LEDGER + BALANCE — one investment DEBIT (认购) and one investment CREDIT (赎回到账).
      const afterBalance = (await fetchDashboardSummary(ctx.baseUrl)).checkingBalance;
      const afterLedger = (await fetchLedger(ctx.baseUrl)).transactions;
      const added = diffLedger(beforeLedger, afterLedger).added;
      const describe = added.map((tx) => `${tx.id}:${tx.amount}:${tx.direction}:${tx.merchant}/${tx.category}`).join(' ');
      const debits = added.filter(
        (tx) => tx.direction === 'DEBIT' && moneyToCents(tx.amount) === -100_000n && tx.merchant === '认购稳健理财A' && tx.category === '投资',
      );
      const credits = added.filter(
        (tx) => tx.direction === 'CREDIT'
          && moneyToCents(tx.amount) === expectedSettlementMinor
          && tx.merchant === '赎回'
          && tx.category === '投资',
      );
      if (debits.length !== 1) throw new Error(`账本应新增 1 条 -1000.00 的投资 DEBIT（认购稳健理财A），实际 ${debits.length}：${describe}`);
      if (credits.length !== 1) {
        throw new Error(`账本应新增 1 条 ${expectedSettlement} 的投资 CREDIT（赎回份额 ${redeemedShares} × 成交净值 ${redeemed.netValue}，HALF_UP 到分，费用口径 SIMULATED_NONE），实际 ${credits.length}：${describe}`);
      }
      const expectedBalance = addMoney(subtractMoney(beforeBalance, '1000.00'), expectedSettlement);
      if (afterBalance !== expectedBalance) throw new Error(`活期余额应为 ${expectedBalance}，实际 ${afterBalance}`);

      return `口径=按金额部分赎回（¥2,000.00，费用口径 SIMULATED_NONE）；B1 实际发送：${sentB1.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 剩余持仓成本 ${centsToMoney(subscribed.costMinor)}、持仓份额 ${subscribed.shares}（最新净值 ${subscribed.netValue}）、市值 ${subscribed.marketValue}（全精度）；B2 实际发送：${sentB2.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 赎回份额 ${redeemedShares} × 成交净值 ${redeemed.netValue} = 预计到账 ${expectedSettlement}；剩余份额 ${redeemed.shares}、剩余成本 ${centsToMoney(redeemed.costMinor)}（本次扣减 ${centsToMoney(consumedCostMinor)}）、市值 ${redeemed.marketValue}（全精度）、本次已实现收益 ${centsToMoney(realizedDelta)}；/investments 显示 ${labels.map((label) => `${label}=${shown[label]}`).join('、')}；账本新增 DEBIT ${debits[0].amount}（${debits[0].id}，${debits[0].merchant}/${debits[0].category}）与 CREDIT ${credits[0].amount}（${credits[0].id}，${credits[0].merchant}/${credits[0].category}）；活期余额 ${beforeBalance} → ${afterBalance}`;
    },
    { label: 'lB-investment-partial-redemption' },
  );
}

// --- scenario table ------------------------------------------------------------------------------

/** Verify transport completion and exact text preservation using persisted wire events. */
// --- scenario lC: LIVE virtual-card consumption --------------------------------------------------

/** UI-driven consumption for scenario lC (a unique merchant keeps the ledger row unambiguous). */
const VIRTUAL_CONSUME_AMOUNT = '88.00';
const VIRTUAL_CONSUME_CATEGORY = '购物';
const VIRTUAL_CONSUME_MERCHANT = '虚拟卡消费验证';
/** Natural (Chinese-only) turns asking the model to CONFIRM the EXISTING virtual card — never to mint one. */
const VIRTUAL_CONFIRM_PROMPT = '我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？';
const VIRTUAL_PAYABLE_PROMPT = '那我这张虚拟卡当前最多可以支付多少钱？';

/** The raw SQLite state scenario lC cross-checks (authoritative). */
interface VirtualConsumeSnapshot {
  cardDebits: { id: string; amountMinor: bigint; channel: string | null; direction: string; category: string; merchant: string; occurredAt: Date }[];
  consumptions: { id: string; cardId: string; accountId: string; amountMinor: bigint; category: string; merchant: string; occurredAt: Date }[];
  balanceMinor: bigint;
}

/** Read the CARD-channel debits, the virtual card's consumption rows and the checking balance from SQLite. */
function readVirtualConsumeSnapshot(): Promise<VirtualConsumeSnapshot> {
  return withDb(async (db) => {
    const [cardDebits, consumptions, account] = await Promise.all([
      db.transaction.findMany({
        where: { accountId: DEMO_CHECKING_ID, channel: 'CARD', direction: 'DEBIT' },
        select: { id: true, amountMinor: true, channel: true, direction: true, category: true, merchant: true, occurredAt: true },
      }),
      db.cardConsumption.findMany({
        where: { cardId: VIRTUAL_CARD_ID },
        select: { id: true, cardId: true, accountId: true, amountMinor: true, category: true, merchant: true, occurredAt: true },
      }),
      db.account.findUnique({ where: { id: DEMO_CHECKING_ID }, select: { balanceMinor: true } }),
    ]);
    if (!account) throw new Error(`缺少账户 ${DEMO_CHECKING_ID}`);
    return { cardDebits, consumptions, balanceMinor: account.balanceMinor };
  });
}

/**
 * SCENARIO lC (LIVE-LLM, REAL BROWSER): confirm the SEEDED virtual card (`card_virtual` — a VIRTUAL debit
 * instrument bound to `acct_checking` with monthly limit ¥5,000.00) through a natural `/agent` request,
 * then spend WITHIN limits through the REAL front-end consume dialog (`CardManager` 消费 button →
 * `CardConsumeDialog` form → `POST /api/cards/[id]/consume`).
 *
 * The spend is verified at the API + SQLite level: exactly ONE `channel='CARD'`/`direction='DEBIT'`
 * `Transaction` of the exact amount, exactly ONE `CardConsumption` row, the checking-account balance
 * reduced EXACTLY ONCE, and `payableAmount` recomputed as `min(available cash, remaining monthly limit)`.
 * The card is never duplicated (an informational request mints nothing).
 */
async function scenarioVirtualCardConsume(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      // Baseline FIRST — the seeded virtual card must be an ACTIVE VIRTUAL bound to the checking account,
      // and the DB balance / CARD debits / consumptions are the authoritative start state.
      const baselineCards = await awaitLiveCards(
        ctx.baseUrl,
        (cards) => cardById(cards, VIRTUAL_CARD_ID)?.type === 'VIRTUAL' && cardById(cards, VIRTUAL_CARD_ID)?.status === 'ACTIVE',
        `${VIRTUAL_CARD_ID} 应为 ACTIVE 的 VIRTUAL 卡`,
      );
      const virtualBefore = cardById(baselineCards, VIRTUAL_CARD_ID);
      if (!virtualBefore) throw new Error(`GET /api/cards 缺少 ${VIRTUAL_CARD_ID}`);
      if (virtualBefore.linkedAccountId !== DEMO_CHECKING_ID) {
        throw new Error(`${VIRTUAL_CARD_ID}.linkedAccountId 应为 ${DEMO_CHECKING_ID}，实际 ${virtualBefore.linkedAccountId}`);
      }
      const monthlyLimit = virtualBefore.monthlyLimit;
      const availableBefore = virtualBefore.accountAvailableBalance;
      const payableBefore = virtualBefore.payableAmount;
      if (monthlyLimit === undefined || availableBefore === undefined || payableBefore === undefined) {
        throw new Error(`${VIRTUAL_CARD_ID} 应暴露 monthlyLimit/accountAvailableBalance/payableAmount，实际 ${JSON.stringify(virtualBefore)}`);
      }
      const before = await readVirtualConsumeSnapshot();
      const limitMinor = moneyToCents(monthlyLimit);
      const amountMinor = moneyToCents(VIRTUAL_CONSUME_AMOUNT);
      if (amountMinor <= 0n) throw new Error(`消费金额必须为正：${VIRTUAL_CONSUME_AMOUNT}`);
      const spentBeforeMinor = before.consumptions.reduce((sum, row) => sum + row.amountMinor, 0n);
      const remainingBeforeMinor = limitMinor > spentBeforeMinor ? limitMinor - spentBeforeMinor : 0n;
      const expectedPayableBeforeMinor = before.balanceMinor < remainingBeforeMinor ? before.balanceMinor : remainingBeforeMinor;
      if (moneyToCents(payableBefore) !== expectedPayableBeforeMinor) {
        throw new Error(`${VIRTUAL_CARD_ID}.payableAmount 应为 min(可用余额 ${centsToMoney(before.balanceMinor)}, 剩余月限额 ${centsToMoney(remainingBeforeMinor)}) = ${centsToMoney(expectedPayableBeforeMinor)}，实际 ${payableBefore}`);
      }

      // C1 — natural `/agent` request CONFIRMING the existing virtual card (never a create request). It is
      // driven through `driveRedTool`, which applies the `assertNoFabricatedConfirmationPanel` guard on
      // every prose-only turn; `requireCardAtEnd = false` because a plain status answer parks no card.
      await gotoAgent(page, ctx.baseUrl);
      const confirmBaseline = (await assistantTexts(page)).length;
      const sentC1 = await driveRedTool(page, ctx.baseUrl, [VIRTUAL_CONFIRM_PROMPT, VIRTUAL_PAYABLE_PROMPT], undefined, false);
      await assertNoFabricatedConfirmationPanel({
        page,
        prose: (await assistantTexts(page)).slice(confirmBaseline).join('\n'),
        actions: await fetchPendingActions(ctx.baseUrl),
      });
      // The informational request must NOT mint a second virtual card: the total card COUNT must stay at the BASELINE captured at scenario start (a preceding lA leg may legitimately add a replacement credit card); still one VIRTUAL.
      const afterConfirm = await fetchLiveCards(ctx.baseUrl);
      const virtuals = afterConfirm.filter((card) => card.type === 'VIRTUAL');
      if (virtuals.length !== 1 || virtuals[0].id !== VIRTUAL_CARD_ID) {
        throw new Error(`确认虚拟卡后应仍恰有 1 张 VIRTUAL 卡（${VIRTUAL_CARD_ID}），实际 ${JSON.stringify(virtuals)}`);
      }
      if (afterConfirm.length !== baselineCards.length) {
        throw new Error(`确认虚拟卡后卡片总数应保持不变（基线 ${baselineCards.length} 张），实际 ${afterConfirm.length}：${afterConfirm.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }

      // C2 — spend THROUGH THE REAL FRONT-END (CardManager 消费 button → CardConsumeDialog form).
      await page.goto(`${ctx.baseUrl}/cards`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, `[data-card-id="${VIRTUAL_CARD_ID}"] [data-card-consume] button`);
      const consumeButton = page.locator(`[data-card-id="${VIRTUAL_CARD_ID}"] [data-card-consume] button`).first();
      await waitFor(async () => ((await consumeButton.isEnabled()) ? true : false), {
        timeoutMs: 60_000,
        description: `${VIRTUAL_CARD_ID} 的「消费」按钮可用`,
      });
      await consumeButton.click();
      await waitForElementHydration(page, '[data-card-consume-form]');
      const dialogCardId = await page.locator('[data-card-consume-dialog]').first().getAttribute('data-card-consume-card-id');
      if (dialogCardId !== VIRTUAL_CARD_ID) {
        throw new Error(`消费弹窗应绑定 ${VIRTUAL_CARD_ID}，实际 data-card-consume-card-id=${dialogCardId}`);
      }
      const summary = await readDialogRows(page, '[data-card-consume-summary]');
      if (summary[CARD_LABEL.monthlyLimit] !== formatCNY(monthlyLimit)) {
        throw new Error(`消费弹窗「${CARD_LABEL.monthlyLimit}」应为 ${formatCNY(monthlyLimit)}，实际 ${summary[CARD_LABEL.monthlyLimit]}（${JSON.stringify(summary)}）`);
      }
      if (summary[CARD_LABEL.linkedAccount] !== '****8821') {
        throw new Error(`消费弹窗「${CARD_LABEL.linkedAccount}」应为 ****8821，实际 ${summary[CARD_LABEL.linkedAccount]}（${JSON.stringify(summary)}）`);
      }
      if (summary[CARD_LABEL.usableBalance] !== formatCNY(payableBefore)) {
        throw new Error(`消费弹窗「${CARD_LABEL.usableBalance}」应为 ${formatCNY(payableBefore)}，实际 ${summary[CARD_LABEL.usableBalance]}（${JSON.stringify(summary)}）`);
      }
      const form = page.locator('[data-card-consume-form]').first();
      // The dialog must offer NO time control at all: the booking instant is SERVER-owned.
      const formFieldNames = await form.locator('input').evaluateAll((els) => els.map((el) => el.getAttribute('name') ?? ''));
      if (formFieldNames.some((name) => /occurred|date|time/i.test(name))) {
        throw new Error(`消费表单不得包含任何时间字段（记账时间由服务端拥有），实际 ${JSON.stringify(formFieldNames)}`);
      }
      for (const required of ['amount', 'category', 'merchant']) {
        if (!formFieldNames.includes(required)) {
          throw new Error(`消费表单缺少 ${required} 字段，实际 ${JSON.stringify(formFieldNames)}`);
        }
      }
      await form.locator('input[name="amount"]').fill(VIRTUAL_CONSUME_AMOUNT);
      await form.locator('input[name="category"]').fill(VIRTUAL_CONSUME_CATEGORY);
      await form.locator('input[name="merchant"]').fill(VIRTUAL_CONSUME_MERCHANT);
      const formShot = await captureLive(page, 'lC-consume-form');
      // Capture the EXACT body the dialog sends: it must carry no booking time.
      const consumeRequest = page.waitForRequest(
        (req) => req.method() === 'POST' && req.url().includes(`/api/cards/${VIRTUAL_CARD_ID}/consume`),
        { timeout: 60_000 },
      );
      await form.getByRole('button', { name: '提交消费', exact: true }).click();
      const sentBodyText = (await consumeRequest).postData() ?? '';
      if (sentBodyText === '') throw new Error('消费请求没有请求体，无法核对是否提交了记账时间');
      const sentBody = JSON.parse(sentBodyText) as Record<string, unknown>;
      if ('occurredAt' in sentBody) {
        throw new Error(`消费请求体不得携带 occurredAt（记账时间由服务端拥有），实际 ${sentBodyText}`);
      }
      // The dialog may also send its retry `executionKey` (an idempotency identity, NOT a time), so the
      // property pinned here is precisely the one that matters: the body carries NO time-shaped key and
      // nothing outside the four accepted fields.
      const sentKeys = Object.keys(sentBody).sort().join(',');
      const allowedKeys = new Set(['amount', 'category', 'merchant', 'executionKey']);
      const unexpectedKeys = Object.keys(sentBody).filter((key) => !allowedKeys.has(key));
      if (unexpectedKeys.length > 0) {
        throw new Error(`消费请求体只允许 amount/category/merchant/executionKey，实际多出 ${unexpectedKeys.join(',')}（${sentBodyText}）`);
      }
      const timeShapedKeys = Object.keys(sentBody).filter((key) => /occurred|date|time/i.test(key));
      if (timeShapedKeys.length > 0) {
        throw new Error(`消费请求体不得携带任何时间字段（记账时间由服务端拥有），实际 ${timeShapedKeys.join(',')}（${sentBodyText}）`);
      }
      for (const required of ['amount', 'category', 'merchant']) {
        if (!(required in sentBody)) {
          throw new Error(`消费请求体缺少 ${required}，实际 ${sentBodyText}`);
        }
      }
      if (sentBody['amount'] !== VIRTUAL_CONSUME_AMOUNT) {
        throw new Error(`消费请求体 amount 应为 ${VIRTUAL_CONSUME_AMOUNT}，实际 ${String(sentBody['amount'])}`);
      }
      await waitForStatusText(page, '消费成功', 60_000);
      // The dialog reloads this card's consumptions after a successful spend → exactly ONE new record.
      await waitFor(
        async () => ((await page.locator('[data-card-consumption]').count()) === before.consumptions.length + 1 ? true : false),
        { timeoutMs: 60_000, description: '消费成功后弹窗「消费记录」新增 1 条' },
      );
      const recordText = (await page.locator('[data-card-consumption]').last().innerText()).replace(/\s+/g, ' ');
      if (!recordText.includes(VIRTUAL_CONSUME_MERCHANT) || !recordText.includes(formatCNY(VIRTUAL_CONSUME_AMOUNT))) {
        throw new Error(`弹窗消费记录应包含「${VIRTUAL_CONSUME_MERCHANT}」与 ${formatCNY(VIRTUAL_CONSUME_AMOUNT)}，实际「${recordText}」`);
      }
      const successShot = await captureLive(page, 'lC-consume-success');

      // AUTHORITATIVE cross-check: exactly ONE new CARD DEBIT, ONE CardConsumption, ONE balance drop.
      const after = await readVirtualConsumeSnapshot();
      const newDebits = after.cardDebits.filter((row) => !before.cardDebits.some((prev) => prev.id === row.id));
      const newConsumptions = after.consumptions.filter((row) => !before.consumptions.some((prev) => prev.id === row.id));
      const describeDebits = newDebits.map((row) => `${row.id}:${row.amountMinor}:${row.direction}:${row.channel}:${row.category}/${row.merchant}`).join(' ');
      const describeConsumptions = newConsumptions.map((row) => `${row.id}:${row.cardId}:${row.accountId}:${row.amountMinor}:${row.category}/${row.merchant}`).join(' ');
      if (after.cardDebits.length !== before.cardDebits.length + 1) {
        throw new Error(`应恰新增 1 条 channel=CARD 的 DEBIT 流水，实际新增 ${after.cardDebits.length - before.cardDebits.length}：${describeDebits}`);
      }
      const debitRow = newDebits[0];
      if (!debitRow) throw new Error('新增 CARD 流水为空');
      if (debitRow.amountMinor !== -amountMinor || debitRow.direction !== 'DEBIT' || debitRow.channel !== 'CARD'
        || debitRow.category !== VIRTUAL_CONSUME_CATEGORY || debitRow.merchant !== VIRTUAL_CONSUME_MERCHANT) {
        throw new Error(`新增 CARD 流水应为 -${amountMinor}（${VIRTUAL_CONSUME_CATEGORY}/${VIRTUAL_CONSUME_MERCHANT}），实际 ${describeDebits}`);
      }
      if (after.consumptions.length !== before.consumptions.length + 1) {
        throw new Error(`应恰新增 1 条 CardConsumption，实际新增 ${after.consumptions.length - before.consumptions.length}：${describeConsumptions}`);
      }
      const consumptionRow = newConsumptions[0];
      if (!consumptionRow) throw new Error('新增 CardConsumption 为空');
      if (consumptionRow.cardId !== VIRTUAL_CARD_ID || consumptionRow.accountId !== DEMO_CHECKING_ID
        || consumptionRow.amountMinor !== amountMinor || consumptionRow.category !== VIRTUAL_CONSUME_CATEGORY
        || consumptionRow.merchant !== VIRTUAL_CONSUME_MERCHANT) {
        throw new Error(`新增 CardConsumption 应为 cardId=${VIRTUAL_CARD_ID}、accountId=${DEMO_CHECKING_ID}、amountMinor=${amountMinor}（${VIRTUAL_CONSUME_CATEGORY}/${VIRTUAL_CONSUME_MERCHANT}），实际 ${describeConsumptions}`);
      }
      // SERVER-OWNED TIME — both rows carry the SAME server business instant (the pinned demo clock
      // DEMO_NOW), never a client value: the dialog body captured above carried no time field at all.
      const serverInstantMs = DEMO_NOW;
      if (debitRow.occurredAt.getTime() !== serverInstantMs) {
        throw new Error(`CARD 流水的 occurredAt 应为服务端业务时钟 ${new Date(serverInstantMs).toISOString()}，实际 ${debitRow.occurredAt.toISOString()}`);
      }
      if (consumptionRow.occurredAt.getTime() !== serverInstantMs) {
        throw new Error(`CardConsumption 的 occurredAt 应为服务端业务时钟 ${new Date(serverInstantMs).toISOString()}，实际 ${consumptionRow.occurredAt.toISOString()}`);
      }
      if (after.balanceMinor !== before.balanceMinor - amountMinor) {
        throw new Error(`活期余额应减少恰 ${amountMinor}（${centsToMoney(before.balanceMinor)} → ${centsToMoney(before.balanceMinor - amountMinor)}），实际 ${centsToMoney(after.balanceMinor)}`);
      }
      // EXACTLY ONCE — the ledger must carry no second, equal CARD debit for this spend.
      const duplicates = after.cardDebits.filter((row) => row.amountMinor === -amountMinor && row.merchant === VIRTUAL_CONSUME_MERCHANT);
      if (duplicates.length !== 1) {
        throw new Error(`本次虚拟卡消费应恰有 1 条流水（不得重复扣款），实际 ${duplicates.length}：${duplicates.map((row) => row.id).join(',')}`);
      }

      // payableAmount is recomputed from the NEW cash + the remaining monthly limit.
      const spentAfterMinor = spentBeforeMinor + amountMinor;
      const remainingAfterMinor = limitMinor > spentAfterMinor ? limitMinor - spentAfterMinor : 0n;
      const availableAfterMinor = before.balanceMinor - amountMinor;
      const expectedPayableAfterMinor = availableAfterMinor < remainingAfterMinor ? availableAfterMinor : remainingAfterMinor;
      const afterCards = await awaitLiveCards(
        ctx.baseUrl,
        (cards) => cardById(cards, VIRTUAL_CARD_ID)?.payableAmount === centsToMoney(expectedPayableAfterMinor),
        `${VIRTUAL_CARD_ID}.payableAmount === ${centsToMoney(expectedPayableAfterMinor)}`,
      );
      const virtualAfter = cardById(afterCards, VIRTUAL_CARD_ID);
      if (virtualAfter?.accountAvailableBalance !== centsToMoney(availableAfterMinor)) {
        throw new Error(`${VIRTUAL_CARD_ID}.accountAvailableBalance 应为 ${centsToMoney(availableAfterMinor)}，实际 ${virtualAfter?.accountAvailableBalance}`);
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, `[data-card-id="${VIRTUAL_CARD_ID}"]`);
      const tileRows = await readCardTileRows(page, VIRTUAL_CARD_ID);
      const tileShot = await captureLive(page, 'lC-card-tile');
      if (tileRows[CARD_LABEL.usableBalance] !== formatCNY(centsToMoney(expectedPayableAfterMinor))) {
        throw new Error(`${VIRTUAL_CARD_ID} 卡片「${CARD_LABEL.usableBalance}」应为 ${formatCNY(centsToMoney(expectedPayableAfterMinor))}，实际 ${tileRows[CARD_LABEL.usableBalance]}（${JSON.stringify(tileRows)}）`);
      }

      return `C1 实际发送：${sentC1.map((t) => `「${t}」`).join(' → ')} → 仍恰 1 张 VIRTUAL 卡（${VIRTUAL_CARD_ID}，未被重复开通）；C2 前端消费弹窗（绑定 ${dialogCardId}，月限额 ${summary[CARD_LABEL.monthlyLimit]}、关联账户 ${summary[CARD_LABEL.linkedAccount]}、消费前可用余额 ${summary[CARD_LABEL.usableBalance]}）提交 ${formatCNY(VIRTUAL_CONSUME_AMOUNT)}（${VIRTUAL_CONSUME_CATEGORY}/${VIRTUAL_CONSUME_MERCHANT}）→ 消费成功；SQLite：新增 1 条 channel=CARD/DEBIT 流水 ${debitRow.amountMinor}（${debitRow.id}）、1 条 CardConsumption amountMinor=${consumptionRow.amountMinor}（${consumptionRow.id}）；活期余额 ${centsToMoney(before.balanceMinor)} → ${centsToMoney(after.balanceMinor)}（恰扣一次）；${VIRTUAL_CARD_ID}.payableAmount ${payableBefore} → ${virtualAfter?.payableAmount} = min(可用余额 ${virtualAfter?.accountAvailableBalance}、剩余月限额 ${centsToMoney(remainingAfterMinor)})；卡片「可用余额」=${tileRows[CARD_LABEL.usableBalance]}；记账时间由服务端拥有：弹窗请求体逐字 ${sentBodyText}（键=${sentKeys}，无 occurredAt），落账 Transaction.occurredAt 与 CardConsumption.occurredAt 均为 ${debitRow.occurredAt.toISOString()}（= DEMO_NOW 服务端业务时钟 2026-09-25T12:00:00+08:00）；截图 ${formShot ?? '未落盘'} / ${successShot ?? '未落盘'} / ${tileShot ?? '未落盘'}`;
    },
    { label: 'lC-virtual-card-consumption' },
  );
}

// --- scenarios lD / lE: LIVE virtual-card apply/limit, and 挂失→补办 continuity ---------------------
//
// Both scenarios are built ON TOP of `./live-virtual-card.e2e-helper`: that module owns the shared
// apply/consume primitives, the raw-SQLite cross-checks and the payable maths. This file only
// SEQUENCES them and owns the bounded RED-tool driver (`driveRedTool`, injected as `RedToolDriver`)
// so the `assertNoFabricatedConfirmationPanel` guard stays in force on every prose-only turn.

/** The mask tail (last 4 digits) the natural-language 挂失/补办 turns refer to. */
function vcMaskTail(numberMasked: string): string {
  const digits = numberMasked.replace(/\D+/g, '');
  if (digits.length < 4) throw new Error(`卡片掩码「${numberMasked}」不含可用的尾号 4 位`);
  return digits.slice(-4);
}

interface AppliedVirtualCardLeg {
  cardId: string;
  /** The prompts the RED driver actually sent. */
  sent: string[];
  /** The RAW SQLite `Card` row of the just-opened card. */
  raw: RawCardRow;
  maskTail: string;
}

/**
 * The SHARED opening act of lD + lE — ONE function, so the two scenarios cannot drift apart: open a NEW
 * virtual card with the stated ¥100.00 monthly limit through the REAL `/agent` chat (RED
 * `apply_virtual_card` ⇒ confirmation/MFA, completed by `driveRedTool` with the real code), then verify
 * the RAW SQLite `Card` row: a VIRTUAL/ACTIVE DEBIT instrument bound to the checking account with
 * `monthlyLimitMinor = 10000`, NO credit columns, and a card number no pre-existing card carries.
 */
async function applyVirtualCardLeg(ctx: Ctx, page: Page): Promise<AppliedVirtualCardLeg> {
  const existing = await fetchLiveCards(ctx.baseUrl);
  const applied = await applyVirtualCardViaAgent(
    page,
    ctx.baseUrl,
    (turns) => driveRedTool(page, ctx.baseUrl, turns),
    {
      excludeCardIds: [CREDIT_CARD_ID, DEBIT_CARD_ID, VIRTUAL_CARD_ID],
      monthlyLimit: VC_MONTHLY_LIMIT,
    },
  );
  const raw = await awaitRawCard(
    applied.cardId,
    (row) => row.type === 'VIRTUAL' && row.status === 'ACTIVE',
    `RAW Card ${applied.cardId} 应为 ACTIVE 的 VIRTUAL 卡`,
  );
  const limitMinor = moneyToCents(VC_MONTHLY_LIMIT);
  if (raw.monthlyLimitMinor !== limitMinor) {
    throw new Error(`RAW Card ${applied.cardId}.monthlyLimitMinor 应为 ${limitMinor}（${VC_MONTHLY_LIMIT}），实际 ${raw.monthlyLimitMinor}`);
  }
  if (raw.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
    throw new Error(`RAW Card ${applied.cardId}.linkedAccountId 应为 ${VC_CHECKING_ACCOUNT_ID}，实际 ${raw.linkedAccountId}`);
  }
  if (raw.creditLimitMinor !== null || raw.availableLimitMinor !== null) {
    throw new Error(`虚拟卡是借记工具，RAW 行不得有信用额度：creditLimitMinor=${raw.creditLimitMinor}、availableLimitMinor=${raw.availableLimitMinor}`);
  }
  for (const card of existing) {
    if (card.numberMasked !== undefined && card.numberMasked === raw.numberMasked) {
      throw new Error(`新虚拟卡卡号 ${raw.numberMasked} 与既有卡片 ${card.id}（${card.numberMasked}）相同`);
    }
  }
  return { cardId: applied.cardId, sent: applied.sent, raw, maskTail: vcMaskTail(raw.numberMasked) };
}

/** Poll `GET /api/cards` until `cardId.payableAmount === expected`, then return the settled card list. */
function awaitPayable(baseUrl: string, cardId: string, expected: string): Promise<LiveCardRecord[]> {
  return waitFor(
    async () => {
      const cards = await fetchLiveCards(baseUrl);
      return cardById(cards, cardId)?.payableAmount === expected ? cards : false;
    },
    {
      timeoutMs: 180_000,
      intervalMs: 1_000,
      description: `${cardId}.payableAmount === ${expected}（min(账户余额, 剩余月限额)）`,
    },
  );
}

/**
 * SCENARIO lD (LIVE-LLM, REAL BROWSER): open a NEW virtual card with a stated ¥100.00 monthly limit
 * through natural `/agent` turns + real MFA, prove the MONTHLY LIMIT (never the ~23k of checking cash)
 * is the binding constraint, spend ¥30.00 through the REAL card-page dialog, and prove an ¥80.00
 * over-limit spend is refused with NOTHING moved.
 *
 * Every assertion is a BEFORE/AFTER DIFF: the live DB is not empty (the seed already carries cards and
 * ledger rows), so "zero rows" would be a vacuous or wrong check.
 */
async function scenarioVirtualCardApplyAndLimit(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      const before = await readCardSpendState();
      const cashBefore = centsToMoney(before.balanceMinor);
      const leg = await applyVirtualCardLeg(ctx, page);
      const cardId = leg.cardId;
      const limitMinor = moneyToCents(VC_MONTHLY_LIMIT);
      const firstSpendMinor = moneyToCents(VC_FIRST_SPEND);
      if (expectedPayableMinor(limitMinor, 0n, before.balanceMinor) !== limitMinor) {
        throw new Error(`活期余额 ${cashBefore} 不高于月限额 ${VC_MONTHLY_LIMIT}，「限额绑定」断言将为空`);
      }

      // PROJECTION + RENDERED TILE of the brand-new card: the ¥100 limit binds, not the checking cash.
      const cardsAfterApply = await awaitPayable(ctx.baseUrl, cardId, VC_MONTHLY_LIMIT);
      assertVirtualCardView(cardById(cardsAfterApply, cardId), {
        cardId,
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: cashBefore,
        payableAmount: VC_MONTHLY_LIMIT,
      });
      await gotoCards(page, ctx.baseUrl);
      await waitForElementHydration(page, `[data-card-id="${cardId}"]`);
      const applyTileRows = await readCardTileRows(page, cardId);
      const applyTileText = await readCardTileText(page, cardId);
      const applyShot = await captureLive(page, 'lD-new-virtual-card');
      assertVirtualCardTile(cardId, applyTileRows, applyTileText, {
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: cashBefore,
        payableAmount: VC_MONTHLY_LIMIT,
      });

      // WITHIN-LIMIT SPEND through the REAL consume dialog (`POST /api/cards/[id]/consume`).
      const summary = await openConsumeDialog(page, cardId);
      if (summary[CARD_LABEL.monthlyLimit] !== formatCNY(VC_MONTHLY_LIMIT)) {
        throw new Error(`消费弹窗「${CARD_LABEL.monthlyLimit}」应为 ${formatCNY(VC_MONTHLY_LIMIT)}，实际 ${summary[CARD_LABEL.monthlyLimit]}（${JSON.stringify(summary)}）`);
      }
      if (summary[CARD_LABEL.usableBalance] !== formatCNY(VC_MONTHLY_LIMIT)) {
        throw new Error(`消费弹窗「${CARD_LABEL.usableBalance}」应为 ${formatCNY(VC_MONTHLY_LIMIT)}，实际 ${summary[CARD_LABEL.usableBalance]}（${JSON.stringify(summary)}）`);
      }
      const spend = await consumeSuccessfully(
        page,
        { amount: VC_FIRST_SPEND, category: VC_SPEND_CATEGORY, merchant: VC_MERCHANT_APPLY },
        before.consumptions.filter((row) => row.cardId === cardId).length + 1,
      );
      const afterSpend = await readCardSpendState();
      const delta = assertSingleSpend(before, afterSpend, {
        cardId,
        amountMinor: firstSpendMinor,
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_APPLY,
        label: `lD 限额内消费 ${VC_FIRST_SPEND}`,
      });
      const payableAfterSpendMinor = expectedPayableMinor(limitMinor, firstSpendMinor, afterSpend.balanceMinor);
      const payableAfterSpend = centsToMoney(payableAfterSpendMinor);
      if (payableAfterSpend !== '70.00') {
        throw new Error(`消费 ${VC_FIRST_SPEND} 后 payableAmount 应为 100.00 − 30.00 = 70.00，实际 ${payableAfterSpend}（可用余额 ${centsToMoney(afterSpend.balanceMinor)}）`);
      }
      const cashAfterSpend = centsToMoney(afterSpend.balanceMinor);
      const cardsAfterSpend = await awaitPayable(ctx.baseUrl, cardId, payableAfterSpend);
      assertVirtualCardView(cardById(cardsAfterSpend, cardId), {
        cardId,
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: cashAfterSpend,
        payableAmount: payableAfterSpend,
      });
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, `[data-card-id="${cardId}"]`);
      const spendTileRows = await readCardTileRows(page, cardId);
      const spendTileText = await readCardTileText(page, cardId);
      const spendShot = await captureLive(page, 'lD-after-spend');
      assertVirtualCardTile(cardId, spendTileRows, spendTileText, {
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: cashAfterSpend,
        payableAmount: payableAfterSpend,
      });

      // OVER-LIMIT SPEND — the dialog must surface the localized refusal and NOTHING may move.
      await openConsumeDialog(page, cardId);
      const refusalText = await attemptConsumeExpectingRefusal(page, {
        amount: VC_OVER_LIMIT_SPEND,
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_REFUSED,
      });
      if (!refusalText.includes(VC_LIMIT_EXCEEDED_TEXT)) {
        throw new Error(`超限消费 ${VC_OVER_LIMIT_SPEND} 应提示「${VC_LIMIT_EXCEEDED_TEXT}」，实际「${refusalText}」`);
      }
      const refusalShot = await captureLive(page, 'lD-over-limit-refusal');
      const afterRefusal = await readCardSpendState();
      assertNoSpend(afterSpend, afterRefusal, `lD 超限消费 ${VC_OVER_LIMIT_SPEND}（${VC_MERCHANT_REFUSED}）被拒绝`);
      const cardsAfterRefusal = await awaitPayable(ctx.baseUrl, cardId, payableAfterSpend);
      const payableAfterRefusal = cardById(cardsAfterRefusal, cardId)?.payableAmount;

      const evidenceFile = writeScenarioEvidence('lD', {
        scenario: 'lD-live-virtual-card-apply-and-limit',
        model: liveModelId(),
        sentTurns: leg.sent,
        cardId,
        rawCard: leg.raw,
        monthlyLimit: VC_MONTHLY_LIMIT,
        cashBeforeMinor: before.balanceMinor,
        dialogSummary: summary,
        acceptedSpend: {
          amount: VC_FIRST_SPEND,
          category: VC_SPEND_CATEGORY,
          merchant: VC_MERCHANT_APPLY,
          notice: spend.notice,
          debitId: delta.debit.id,
          consumptionId: delta.consumption.id,
          balanceBeforeMinor: delta.balanceBeforeMinor,
          balanceAfterMinor: delta.balanceAfterMinor,
        },
        payable: { afterApply: VC_MONTHLY_LIMIT, afterSpend: payableAfterSpend, afterRefusal: payableAfterRefusal },
        refusedSpend: { amount: VC_OVER_LIMIT_SPEND, merchant: VC_MERCHANT_REFUSED, text: refusalText },
        tileRows: { afterApply: applyTileRows, afterSpend: spendTileRows },
        screenshots: { applyShot, spendShot, refusalShot },
      });

      return `lD 实际发送：${leg.sent.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 新虚拟卡 ${cardId}（RAW：type=VIRTUAL、status=ACTIVE、monthlyLimitMinor=${leg.raw.monthlyLimitMinor}（${VC_MONTHLY_LIMIT}）、linkedAccountId=${leg.raw.linkedAccountId}、creditLimitMinor=${leg.raw.creditLimitMinor}、availableLimitMinor=${leg.raw.availableLimitMinor}、卡号 ${leg.raw.numberMasked} 与既有卡片均不同）；payableAmount=${VC_MONTHLY_LIMIT}（月限额绑定，账户余额 ${cashBefore}）；/cards 渲染 ${JSON.stringify(applyTileRows)}（无「信用额度」/「可用额度」）；消费 ${VC_FIRST_SPEND}（${VC_SPEND_CATEGORY}/${VC_MERCHANT_APPLY}）→ ${spend.notice}：新增 CARD/DEBIT 流水 ${delta.debit.amountMinor}（${delta.debit.id}）+ 1 条 CardConsumption amountMinor=${delta.consumption.amountMinor}（${delta.consumption.id}），活期余额 ${centsToMoney(delta.balanceBeforeMinor)} → ${centsToMoney(delta.balanceAfterMinor)}（恰扣一次）；payableAmount → ${payableAfterSpend}，刷新后卡片「可用余额」=${spendTileRows[CARD_LABEL.usableBalance]}；超限 ${VC_OVER_LIMIT_SPEND}（${VC_MERCHANT_REFUSED}）被拒绝：「${refusalText}」，流水/余额/CardConsumption 零变化，payableAmount 仍 ${payableAfterRefusal}；截图 ${applyShot ?? '未落盘'} / ${spendShot ?? '未落盘'} / ${refusalShot ?? '未落盘'}；证据 JSON ${evidenceFile ?? '未落盘'}`;
    },
    { label: 'lD-virtual-card-apply-and-limit' },
  );
}

/**
 * SCENARIO lE (LIVE-LLM, REAL BROWSER): open a virtual card (the SAME shared apply leg as lD), spend
 * ¥30.00, then 挂失 (lose) and 补办 (replace) it purely through natural `/agent` turns + real MFA, and
 * prove FAMILY-CONTINUOUS allowance: the replacement inherits the monthly limit's already-spent part
 * (`payableAmount` = 70.00, NEVER a reset to 100.00), the linking account and — until it is exhausted —
 * the family's remaining allowance.
 */
async function scenarioVirtualCardReplaceContinuity(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      const leg = await applyVirtualCardLeg(ctx, page);
      const sourceId = leg.cardId;
      const limitMinor = moneyToCents(VC_MONTHLY_LIMIT);
      const before = await readCardSpendState();

      // PRE-LOST SPEND — ¥30 of the ¥100 monthly allowance through the REAL card-page dialog.
      await gotoCards(page, ctx.baseUrl);
      await waitForElementHydration(page, `[data-card-id="${sourceId}"]`);
      await openConsumeDialog(page, sourceId);
      await consumeSuccessfully(
        page,
        { amount: VC_FIRST_SPEND, category: VC_SPEND_CATEGORY, merchant: VC_MERCHANT_PRE_LOST },
        before.consumptions.filter((row) => row.cardId === sourceId).length + 1,
      );
      const afterSpend = await readCardSpendState();
      const firstDelta = assertSingleSpend(before, afterSpend, {
        cardId: sourceId,
        amountMinor: moneyToCents(VC_FIRST_SPEND),
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_PRE_LOST,
        label: `lE 挂失前消费 ${VC_FIRST_SPEND}`,
      });

      // 挂失 — natural turns + real MFA. The source becomes terminal LOST and NO funds move.
      await gotoAgent(page, ctx.baseUrl);
      const sentLost = await driveRedTool(page, ctx.baseUrl, vcReportLostTurns(leg.maskTail));
      const lostRaw = await awaitRawCard(sourceId, (row) => row.status === 'LOST', `RAW Card ${sourceId} 挂失后 status='LOST'`);
      const afterLost = await readCardSpendState();
      assertNoSpend(afterSpend, afterLost, `lE 挂失 ${sourceId}`);
      if (lostRaw.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
        throw new Error(`挂失后 RAW Card ${sourceId}.linkedAccountId 应为 ${VC_CHECKING_ACCOUNT_ID}，实际 ${lostRaw.linkedAccountId}`);
      }

      // 补办 — natural turns + real MFA. Exactly ONE new ACTIVE VIRTUAL card, bound to the SAME account.
      const idsBeforeReplace = new Set((await fetchLiveCards(ctx.baseUrl)).map((card) => card.id));
      const sentReplace = await driveRedTool(page, ctx.baseUrl, vcReplaceTurns(leg.maskTail));
      const sourceAfterReplace = await awaitRawCard(
        sourceId,
        (row) => typeof row.replacedByCardId === 'string' && row.replacedByCardId !== '',
        `RAW Card ${sourceId} 补办后 replacedByCardId 指向新卡`,
      );
      const replacementId = sourceAfterReplace.replacedByCardId as string;
      const replacement = await awaitRawCard(
        replacementId,
        (row) => row.type === 'VIRTUAL' && row.status === 'ACTIVE',
        `RAW Card ${replacementId} 应为 ACTIVE 的 VIRTUAL 卡`,
      );
      // THE INHERITANCE FIX: the replacement is bound to the SAME checking account as its source.
      if (replacement.linkedAccountId !== sourceAfterReplace.linkedAccountId) {
        throw new Error(`补办卡 ${replacementId}.linkedAccountId（${replacement.linkedAccountId}）应继承原卡 ${sourceId} 的 ${sourceAfterReplace.linkedAccountId}`);
      }
      if (replacement.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
        throw new Error(`补办卡 ${replacementId}.linkedAccountId 应为 ${VC_CHECKING_ACCOUNT_ID}，实际 ${replacement.linkedAccountId}`);
      }
      if (replacement.numberMasked === sourceAfterReplace.numberMasked) {
        throw new Error(`补办卡卡号应不同于原卡，实际均为 ${replacement.numberMasked}`);
      }
      if (replacement.monthlyLimitMinor !== limitMinor) {
        throw new Error(`补办卡 ${replacementId}.monthlyLimitMinor 应为 ${limitMinor}（${VC_MONTHLY_LIMIT}），实际 ${replacement.monthlyLimitMinor}`);
      }
      if (replacement.creditLimitMinor !== null || replacement.availableLimitMinor !== null) {
        throw new Error(`补办虚拟卡是借记工具，RAW 行不得有信用额度：creditLimitMinor=${replacement.creditLimitMinor}、availableLimitMinor=${replacement.availableLimitMinor}`);
      }
      await waitFor(
        async () => {
          const cards = await fetchLiveCards(ctx.baseUrl);
          const created = cards.filter((card) => !idsBeforeReplace.has(card.id));
          return created.length === 1 && created[0].id === replacementId
            && created[0].type === 'VIRTUAL' && created[0].status === 'ACTIVE'
            ? cards
            : false;
        },
        {
          timeoutMs: 180_000,
          intervalMs: 1_000,
          description: `补办后 GET /api/cards 应恰新增 1 张 ACTIVE VIRTUAL 卡（${replacementId}）`,
        },
      );

      // FAMILY-CONTINUOUS ALLOWANCE — 100.00 − 30.00 = 70.00 left for the card family, never 100.00.
      const familySpentMinor = afterLost.consumptions
        .filter((row) => row.cardId === sourceId || row.cardId === replacementId)
        .reduce((sum, row) => sum + row.amountMinor, 0n);
      const familyPayable = centsToMoney(expectedPayableMinor(limitMinor, familySpentMinor, afterLost.balanceMinor));
      if (familyPayable !== '70.00') {
        throw new Error(`补办卡的家庭剩余月限额应为 ${VC_MONTHLY_LIMIT} − ${VC_FIRST_SPEND} = 70.00，实际 ${familyPayable}（家庭已用 ${familySpentMinor}、账户余额 ${centsToMoney(afterLost.balanceMinor)}）`);
      }
      const cardsAfterReplace = await awaitPayable(ctx.baseUrl, replacementId, familyPayable);
      const replacementView = cardById(cardsAfterReplace, replacementId);
      assertVirtualCardView(replacementView, {
        cardId: replacementId,
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: centsToMoney(afterLost.balanceMinor),
        payableAmount: '70.00',
      });
      if (replacementView?.payableAmount === VC_MONTHLY_LIMIT) {
        throw new Error(`补办卡 ${replacementId}.payableAmount 不得重置为满额 ${VC_MONTHLY_LIMIT}（月限额必须在卡家族内连续）`);
      }
      await gotoCards(page, ctx.baseUrl);
      await waitForElementHydration(page, `[data-card-id="${replacementId}"]`);
      const replaceTileRows = await readCardTileRows(page, replacementId);
      const replaceTileText = await readCardTileText(page, replacementId);
      const replaceShot = await captureLive(page, 'lE-replacement-card');
      assertVirtualCardTile(replacementId, replaceTileRows, replaceTileText, {
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: centsToMoney(afterLost.balanceMinor),
        payableAmount: '70.00',
      });

      // EXHAUST the family allowance on the NEW card, once, exactly.
      await openConsumeDialog(page, replacementId);
      await consumeSuccessfully(
        page,
        { amount: VC_SECOND_SPEND, category: VC_SPEND_CATEGORY, merchant: VC_MERCHANT_REPLACE },
        afterLost.consumptions.filter((row) => row.cardId === replacementId).length + 1,
      );
      const afterSecondSpend = await readCardSpendState();
      const secondDelta = assertSingleSpend(afterLost, afterSecondSpend, {
        cardId: replacementId,
        amountMinor: moneyToCents(VC_SECOND_SPEND),
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_REPLACE,
        label: `lE 补办卡消费 ${VC_SECOND_SPEND}`,
      });
      const exhaustedPayable = centsToMoney(
        expectedPayableMinor(limitMinor, familySpentMinor + moneyToCents(VC_SECOND_SPEND), afterSecondSpend.balanceMinor),
      );
      if (exhaustedPayable !== '0.00') {
        throw new Error(`家庭月限额用尽后 payableAmount 应为 0.00，实际 ${exhaustedPayable}（账户余额 ${centsToMoney(afterSecondSpend.balanceMinor)}）`);
      }
      const cardsExhausted = await awaitPayable(ctx.baseUrl, replacementId, exhaustedPayable);
      assertVirtualCardView(cardById(cardsExhausted, replacementId), {
        cardId: replacementId,
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: centsToMoney(afterSecondSpend.balanceMinor),
        payableAmount: exhaustedPayable,
      });
      // A ¥1.00 spend against the exhausted family allowance must be refused with NOTHING moved.
      const refusalText = await attemptConsumeExpectingRefusal(page, {
        amount: VC_TINY_SPEND,
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_REFUSED,
      });
      if (!refusalText.includes(VC_LIMIT_EXCEEDED_TEXT)) {
        throw new Error(`额度用尽后 ${VC_TINY_SPEND} 消费应提示「${VC_LIMIT_EXCEEDED_TEXT}」，实际「${refusalText}」`);
      }
      const refusalShot = await captureLive(page, 'lE-exhausted-refusal');
      const afterRefusal = await readCardSpendState();
      assertNoSpend(afterSecondSpend, afterRefusal, `lE 额度用尽后的 ${VC_TINY_SPEND} 消费（${VC_MERCHANT_REFUSED}）被拒绝`);
      const cardsAfterRefusal = await awaitPayable(ctx.baseUrl, replacementId, exhaustedPayable);
      const payableAfterRefusal = cardById(cardsAfterRefusal, replacementId)?.payableAmount;

      const evidenceFile = writeScenarioEvidence('lE', {
        scenario: 'lE-live-virtual-card-replace-continuity',
        model: liveModelId(),
        applyTurns: leg.sent,
        lostTurns: sentLost,
        replaceTurns: sentReplace,
        sourceCardId: sourceId,
        sourceRawAfterLost: lostRaw,
        sourceRawAfterReplace: sourceAfterReplace,
        replacementRaw: replacement,
        monthlyLimit: VC_MONTHLY_LIMIT,
        preLostSpend: {
          amount: VC_FIRST_SPEND,
          category: VC_SPEND_CATEGORY,
          merchant: VC_MERCHANT_PRE_LOST,
          debitId: firstDelta.debit.id,
          consumptionId: firstDelta.consumption.id,
          balanceBeforeMinor: firstDelta.balanceBeforeMinor,
          balanceAfterMinor: firstDelta.balanceAfterMinor,
        },
        familySpentMinor,
        payableAfterReplace: replacementView?.payableAmount,
        secondSpend: {
          amount: VC_SECOND_SPEND,
          category: VC_SPEND_CATEGORY,
          merchant: VC_MERCHANT_REPLACE,
          debitId: secondDelta.debit.id,
          consumptionId: secondDelta.consumption.id,
          balanceBeforeMinor: secondDelta.balanceBeforeMinor,
          balanceAfterMinor: secondDelta.balanceAfterMinor,
        },
        payableAfterExhaustion: exhaustedPayable,
        payableAfterRefusal,
        refusedSpend: { amount: VC_TINY_SPEND, merchant: VC_MERCHANT_REFUSED, text: refusalText },
        tileRows: replaceTileRows,
        screenshots: { replaceShot, refusalShot },
      });

      return `lE 实际发送（开卡）：${leg.sent.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 新虚拟卡 ${sourceId}（monthlyLimitMinor=${leg.raw.monthlyLimitMinor}、linkedAccountId=${leg.raw.linkedAccountId}）；挂失前消费 ${VC_FIRST_SPEND}（${VC_SPEND_CATEGORY}/${VC_MERCHANT_PRE_LOST}）= 新增 CARD/DEBIT 流水 ${firstDelta.debit.amountMinor}（${firstDelta.debit.id}）+ 1 条 CardConsumption（${firstDelta.consumption.id}），活期余额 ${centsToMoney(firstDelta.balanceBeforeMinor)} → ${centsToMoney(firstDelta.balanceAfterMinor)}；挂失实际发送：${sentLost.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → RAW status=${lostRaw.status}、资金零变化；补办实际发送：${sentReplace.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → ${sourceId}.replacedByCardId=${replacementId}（恰新增 1 张 VIRTUAL/ACTIVE 卡）；补办卡 RAW：linkedAccountId=${replacement.linkedAccountId}（= 原卡 ${sourceAfterReplace.linkedAccountId}，继承修复生效）、monthlyLimitMinor=${replacement.monthlyLimitMinor}、卡号 ${replacement.numberMasked} ≠ 原卡 ${sourceAfterReplace.numberMasked}、无信用额度；家庭月限额连续：已用 ${familySpentMinor} → payableAmount=${replacementView?.payableAmount}（=70.00，不是 100.00），卡片渲染 ${JSON.stringify(replaceTileRows)}；补办卡消费 ${VC_SECOND_SPEND}（${VC_SPEND_CATEGORY}/${VC_MERCHANT_REPLACE}）= 新增 CARD/DEBIT 流水 ${secondDelta.debit.amountMinor}（${secondDelta.debit.id}）+ 1 条 CardConsumption（${secondDelta.consumption.id}），活期余额 ${centsToMoney(secondDelta.balanceBeforeMinor)} → ${centsToMoney(secondDelta.balanceAfterMinor)}（恰扣一次）→ payableAmount=${exhaustedPayable}；额度用尽后 ${VC_TINY_SPEND}（${VC_MERCHANT_REFUSED}）被拒绝：「${refusalText}」，流水/余额/CardConsumption 零变化，payableAmount 仍 ${payableAfterRefusal}；截图 ${replaceShot ?? '未落盘'} / ${refusalShot ?? '未落盘'}；证据 JSON ${evidenceFile ?? '未落盘'}`;
    },
    { label: 'lE-virtual-card-replace-continuity' },
  );
}

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
  { id: 'lA', name: 'lA-live-credit-card-report-lost-and-replace', run: scenarioCreditReplace },
  { id: 'lB', name: 'lB-live-investment-partial-redemption', run: scenarioPartialRedeem },
  { id: 'lC', name: 'lC-live-virtual-card-consumption', run: scenarioVirtualCardConsume },
  { id: 'lD', name: 'lD-live-virtual-card-apply-and-limit', run: scenarioVirtualCardApplyAndLimit },
  { id: 'lE', name: 'lE-live-virtual-card-replace-continuity', run: scenarioVirtualCardReplaceContinuity },
  { id: 'lF', name: 'lF-live-credit-report-lost-and-replace-new-session', run: (ctx) => withPage(ctx.browser, async (page) => { attachCollectors(page); return scenarioCreditReplaceNewSession({ page, baseUrl: ctx.baseUrl, drive: (turns) => driveRedTool(page, ctx.baseUrl, turns), captureShot: captureLive }); }, { label: 'lF-live-credit-report-lost-and-replace-new-session' }) },
  { id: 'lG', name: 'lG-live-full-card-loss-replace-chain-single-session', run: (ctx) => withPage(ctx.browser, async (page) => { attachCollectors(page); return scenarioFullCardChain({ page, baseUrl: ctx.baseUrl, drive: (turns) => driveRedTool(page, ctx.baseUrl, turns), captureShot: captureLive }); }, { label: 'lG-live-full-card-loss-replace-chain-single-session' }) },
  { id: 'lJ', name: 'lJ-live-debit-card-linked-account-balance', run: (ctx) => withPage(ctx.browser, async (page) => { attachCollectors(page); return scenarioDebitCardLinkedAccount({ page, baseUrl: ctx.baseUrl, drive: (turns) => driveRedTool(page, ctx.baseUrl, turns), captureShot: captureLive }); }, { label: 'lJ-live-debit-card-linked-account-balance' }) },
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

  /** Stop the CURRENT dev-server handle (scenario 7 may have reassigned `server.current`), best-effort. */
  const stopActiveServer = (): void => {
    const active = server?.current ?? devServer;
    if (active) {
      try {
        active.stop();
      } catch {
        /* best-effort */
      }
    }
    devServer = undefined;
  };

  /**
   * Normal-path teardown, AWAITED in the `finally` below: stop the active server, then `await` the
   * browser close so its exceptions are captured (the previous fire-and-forget close let the process
   * exit while Chrome was still shutting down). Never throws — a close failure must not flip a PASS run.
   */
  const teardown = async (): Promise<void> => {
    stopActiveServer();
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.warn(`· 关闭浏览器失败（不影响验收结论）：${errText(error)}`);
      }
    }
  };

  /**
   * SYNCHRONOUS best-effort fallback for `process.on('exit')` and the signal handlers: `exit` cannot
   * await an async close, so this stops the server and fires `browser.close()` WITHOUT awaiting.
   */
  const cleanup = (): void => {
    stopActiveServer();
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

    // Post-scenario diagnostics + the TASK-A evidence dump run HERE — INSIDE the `try`, BEFORE the
    // `finally` tears the dev server down, so the isolated WAL database is still served. They are
    // wrapped in their own try/catch so a diagnostic/evidence read can NEVER reject `main()` (which
    // `void main().catch(...)` would turn into exit 1 AFTER the PASS lines printed). A read failure
    // only warns; it never changes `process.exitCode`.
    try {
      // Scenario 6's global invariant: no provider "tool message must answer tool_calls" 400 anywhere.
      const violation = findToolOrderViolation();
      if (violation) {
        console.error(`· 全程捕获到 tool/tool_calls 400：${violation.method} ${violation.url} — ${violation.body.slice(0, 400)}`);
      }
      console.log(`· 累计网络 4xx/5xx：${netLog.issues.length}，console error：${netLog.consoleErrors.length}，pageerror：${netLog.pageErrors.length}`);
      for (const issue of netLog.issues.slice(0, 20)) {
        console.log(`· [4xx/5xx] ${issue.method} ${issue.status} ${issue.url} — ${issue.body.slice(0, 200).replace(/\s+/g, ' ')}`);
      }

      // TASK-A EVIDENCE: the ACTUAL arg shape the LIVE model produced, recovered from the SAME DB the
      // run used (`AgentSession.stateJson` → `agentState.messages`). Printed verbatim for every run.
      console.log('· 【证据】持久化的 transfer_money / search_contact 工具调用（AgentSession.stateJson，参数对象逐字）：');
      console.log(await persistedRecipientCalls());
      console.log(`· 【证据】种子库收款人 ${RECIPIENT_NAME} 手机号=${await readSeedRecipientPhone()}`);
    } catch (error) {
      console.warn(`· 场景后诊断/证据收集失败（不影响验收结论，退出码不变）：${errText(error)}`);
    }
  } catch (error) {
    console.error(`· 基础设施失败：${errText(error)}`);
    reporter.fail('infrastructure', errText(error));
  } finally {
    await teardown();
  }

  // The summary and the exit code are ALWAYS reached on the normal path (teardown never throws).
  console.log(`== 汇总：PASS ${reporter.passes} ｜ FAIL ${reporter.failures} ｜ SKIP ${reporter.skips} ==`);
  process.exitCode = reporter.failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`入口脚本失败：${errText(error)}`);
  process.exitCode = 1;
});

// Referenced so `captureScreenshot` stays part of the public harness surface used by `withPage`.
void captureScreenshot;
