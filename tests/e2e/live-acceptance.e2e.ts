/**
 * `tests/e2e/live-acceptance.e2e.ts` 鈥?REAL-BROWSER, **LIVE-LLM** acceptance harness.
 *
 * Unlike `acceptance.e2e.ts` (which scripts the model with `LLM_MODE=mock`), this harness boots the
 * REAL Next.js dev server against the REAL DeepSeek API (`LLM_MODE=live`, `LLM_PROVIDER=deepseek`)
 * and drives the REAL `/agent` UI through a REAL headless Chrome. Only the bank is simulated (SQLite).
 *
 * ------------------------------------------------------------------------------------------------
 * MODEL ID 鈥?PROVIDED CONFIG BY DEFAULT, OPT-IN FORCE OVERRIDE
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
 * Output contract: one `PASS|FAIL|SKIP <scenario> 鈥?<evidence>` line per scenario; exit non-zero iff
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
// Card-loss / replace chain scenarios (lF: fresh-session credit lost->replace; lG: ONE session full chain).
// The scenario bodies live in this module; the entry only registers them.
import { scenarioCreditReplaceNewSession, scenarioFullCardChain } from './card-replace-chain.e2e-helper';

// --- isolated LIVE database ---------------------------------------------------------------------

const LIVE_DB_FILES = ['live-acceptance.db', 'live-acceptance.db-wal', 'live-acceptance.db-shm', 'live-acceptance.db-journal'] as const;
/** Absolute `file:` URL (forward slashes 鈥?Prisma rejects a Windows backslash URL). */
const LIVE_DB_URL = `file:${path.join(REPO_ROOT, 'prisma', 'live-acceptance.db').split(path.sep).join('/')}`;

const DEMO_CHECKING_ID = 'acct_checking';
const RECIPIENT_NAME = '寮犱紵';
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

/** Point this process 鈥?provisioning CLIs + the spawned dev server 鈥?at the ISOLATED live DB. */function configureLiveEnv(): void {
  process.env['DATABASE_URL'] = LIVE_DB_URL;
  process.env['DEMO_USER_ID'] = 'user_liming';
  process.env['LLM_MODE'] = 'live';
  process.env['LLM_PROVIDER'] = 'deepseek';
  // MODEL ID 鈥?PROVIDED CONFIG BY DEFAULT, OPT-IN FORCE OVERRIDE.
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
    if (!Array.isArray(rows) || rows.length === 0) { console.error('schema 鏈簲鐢細缂哄皯 User 琛?); process.exitCode = 3; }
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
    throw new Error(`live DB 鎺㈡祴澶辫触锛堥€€鍑虹爜 ${probe.status ?? 'null'}锛夛細${(probe.stderr ?? '').slice(-800)}`);
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
    if (!account) throw new Error(`缂哄皯璐︽埛 ${DEMO_CHECKING_ID}`);
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

/** The seeded contact's phone (already masked in the seed) 鈥?used to phrase the by-phone prompt. */
function readContactPhone(contactId: string): Promise<string> {
  return withDb(async (db) => {
    const contact = await db.contact.findUnique({ where: { id: contactId }, select: { phone: true } });
    if (!contact) throw new Error(`缂哄皯鑱旂郴浜?${contactId}`);
    return contact.phone;
  });
}

/** The seeded recipient phone straight from the DB (never throws 鈥?a failure is reported as text). */
async function readSeedRecipientPhone(): Promise<string> {
  try {
    return await readContactPhone(RECIPIENT_CONTACT_ID);
  } catch (e) {
    return `璇诲彇澶辫触锛?{errText(e)}`;
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
        lines.push(`session=${session.id} stateJson 瑙ｆ瀽澶辫触`);
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
            lines.push(`session=${session.id} msg#${index} assistant鈫?toolCall ${name} args=${JSON.stringify(part['arguments'])}`);
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
    return lines.length > 0 ? lines.join('\n') : '锛堟棤鎸佷箙鍖栫殑 transfer_money/search_contact 璋冪敤锛?;
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
        console.log(`路 [net ${status}] ${method} ${url} 鈥?${text.slice(0, 300).replace(/\s+/g, ' ')}`);
      })
      .catch(() => netLog.issues.push({ method, url, status, body: '<unreadable>' }));
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    netLog.consoleErrors.push(text);
    console.log(`路 [console error] ${text.slice(0, 300)}`);
  });
  page.on('pageerror', (error) => {
    netLog.pageErrors.push(error.message);
    console.log(`路 [pageerror] ${error.message.slice(0, 300)}`);
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
    if (!labels.includes('鏀舵浜?)) continue;
    const values = (await dl.locator('dd').allInnerTexts()).map((v) => v.replace(/\s+/g, '').trim());
    const out: Record<string, string> = {};
    labels.forEach((label, index) => {
      out[label] = values[index] ?? '';
    });
    return out;
  }
  return {};
}

/** Click the confirmation card's `鍙栨秷` button. */
async function clickCancel(page: Page, timeoutMs = 30_000): Promise<void> {
  const button = page.locator('[data-approval-request="true"]').getByRole('button', { name: '鍙栨秷', exact: true });
  await waitFor(async () => ((await button.count()) > 0 ? true : false), { timeoutMs, description: '纭鍗°€屽彇娑堛€嶆寜閽? });
  await button.first().click();
}

/** The number of rendered `纭` buttons (0 once a card is settled / gone). */
async function confirmButtonCount(page: Page): Promise<number> {
  return page.locator('[data-approval-request="true"]').getByRole('button', { name: '纭', exact: true }).count();
}

/** The demo user's money state via the app's REAL read routes. */
async function snapshot(baseUrl: string): Promise<{ balance: string; ledger: LedgerView }> {
  const [dashboard, ledger] = await Promise.all([fetchDashboardSummary(baseUrl), fetchLedger(baseUrl)]);
  return { balance: dashboard.checkingBalance, ledger };
}

/**
 * Wait until a transfer DEBIT of exactly `amount` shows up in the DB + ledger and the balance drops by it.
 *
 * `occurrences` counts the RAW-SQLite debits of that amount that are NEW for THIS transfer 鈥?scoped by
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
  const name = fields['鏀舵浜?] ?? '';
  const phone = fields['鏀舵鎵嬫満鍙?] ?? '';
  const joined = JSON.stringify(fields);
  if (joined.includes('锛堟湭鎸囧畾锛?)) throw new Error(`纭鍗″嚭鐜般€岋紙鏈寚瀹氾級銆嶏細${joined}`);
  if (name !== expectName) throw new Error(`纭鍗℃敹娆句汉搴斾负銆?{expectName}銆嶏紝瀹為檯銆?{name}銆嶏紙瀛楁锛?{joined}锛塦);
  if (!/^\d{3}\*{4}\d{3,4}$/.test(phone)) throw new Error(`纭鍗℃敹娆炬墜鏈哄彿搴斾负鎺╃爜鍙风爜锛屽疄闄呫€?{phone}銆嶏紙瀛楁锛?{joined}锛塦);
  return `${name} / ${phone}`;
}

// --- failure diagnostics (why did no card render?) -----------------------------------------------

/**
 * When a confirmation/MFA card never renders, capture the OBSERVABLE evidence that distinguishes a
 * MODEL-BEHAVIOUR cause (the model narrated/asked a question WITHOUT calling the gated tool, so the
 * gateway never parked a `PendingAction`) from a UI/HARNESS cause (the model DID ask the user to
 * confirm, but no card rendered). Appended to the thrown error 鈥?it never weakens the wait itself.
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
  return `銆愯瘖鏂€戝姪鎵嬫秷鎭暟=${texts.length}锛涙渶鍚庝竴鏉?銆?{last}銆嶏紱/api/actions=${actions.slice(0, 600)}锛涢〉闈㈡枃鏈熬閮?銆?{dom.replace(/\s+/g, ' ').slice(-400)}銆峘;
}

/** `waitForConfirmCard` with an evidence dump on timeout (the wait + assertion are unchanged). */
async function awaitConfirmCard(page: Page, baseUrl: string, timeoutMs = 90_000): Promise<void> {
  try {
    await waitForConfirmCard(page, timeoutMs);
  } catch (e) {
    throw new Error(`${errText(e)} 锝?${await noCardDiagnostics(page, baseUrl)}`);
  }
}

/** `waitForMfaCard` with an evidence dump on timeout (the wait + assertion are unchanged). */
async function awaitMfaCard(page: Page, baseUrl: string, timeoutMs = 90_000): Promise<void> {
  try {
    await waitForMfaCard(page, timeoutMs);
  } catch (e) {
    throw new Error(`${errText(e)} 锝?${await noCardDiagnostics(page, baseUrl)}`);
  }
}

/** Is the chat composer (its controlled `<textarea>`) ENABLED? It is disabled while a turn streams. */
async function composerEnabled(page: Page): Promise<boolean> {
  const composer = page.locator(SELECTORS.composer).first();
  return (await composer.count()) > 0 && (await composer.isEnabled());
}

/**
 * Bounded natural-language DRIVER for a RED (MFA) tool. Both live targets below are RED tier, so a
 * successful model turn parks an MFA card 鈥?but the LIVE model sometimes asks a plain confirmation
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
  if (turns.length === 0) throw new Error('driveRedTool 鑷冲皯闇€瑕佷竴鏉¤嚜鐒惰瑷€娑堟伅');
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
      { timeoutMs: perTurnTimeoutMs, intervalMs: 1_000, description: `绛夊緟 LIVE 妯″瀷璋冪敤鍙楁帶宸ュ叿锛堣嚜鐒惰疆娆★紝MFA 鍗＄墖锛夛細${turn}` },
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
      { timeoutMs: perTurnTimeoutMs, intervalMs: 1_000, description: 'RED 宸ュ叿鑷劧杞缁撶畻锛堟湰杞笉瑕佹眰浜屾 MFA锛? },
    ).catch(() => 'settled' as const);
    if (finalOutcome === 'mfa' || finalOutcome === 'confirm') await settleCard(finalOutcome);
    return sent;
  }
  // Bounded turns produced no MFA card 鈥?one UNWEAKENED final wait (throws with the failure evidence).
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
   * with that concrete reason and `run` is never called 鈥?it never asserts a success the demo data
   * cannot produce.
   */
  skipReason?(): Promise<string | undefined> | string | undefined;
}

// Prompts phrased against the real tool schemas / seed (see prisma/seed.ts + agent/system-prompt.ts).
const MSG = {
  balance: '鏌ヤ竴涓嬫垜鐨勪綑棰?,
  transferByName: `缁?{RECIPIENT_NAME}杞?00鍏僠,
  transferByPhone: (phone: string) => `缁?{phone}杞?00鍏僠,
  transferDecimal: `缁?{RECIPIENT_NAME}杞?00.37鍏僠,
  transferLarge: `缁?{RECIPIENT_NAME}杞?000鍏僠,
  cardLimit: '鎴戠殑淇＄敤鍗￠搴︽槸澶氬皯',
} as const;

/**
 * LIVE-experiment OVERRIDES for the two transfer prompts (default: the canonical `MSG` prompts).
 * Lets a diagnostic run pin a DIFFERENT identifier phrasing (`LIVE_S2_PROMPT` / `LIVE_S3_PROMPT`,
 * e.g. `缁欒仈绯讳汉寮犱紵杞?00鍏僠) WITHOUT editing the scenarios. Assertions and the default prompt are
 * unchanged; the values are read once at module load.
 */
const PROMPT_S2 = process.env['LIVE_S2_PROMPT']?.trim() || MSG.transferByName;
const PROMPT_S3 = process.env['LIVE_S3_PROMPT']?.trim() || MSG.transferDecimal;

const TRANSFER_AMOUNT = '200.00';
const DECIMAL_AMOUNT = '200.37';
const LARGE_AMOUNT = '5000.00';

/**
 * Scenario 7 park-robustness knobs. The LIVE model SOMETIMES answers the transfer prompt with only
 * `search_contact` + a question ("璇风‘璁ゆ槸鍚﹀悜寮犱紵杞处 楼200.00锛?) WITHOUT calling `transfer_money`, so
 * the gateway never parks a `PendingAction`, `GET /api/actions` stays `[]` and the park times out.
 * The park therefore POLLS `/api/actions` and, when nothing is parked, NUDGES the model in the SAME
 * session and re-checks 鈥?bounded attempts, never a fabricated park.
 */
const PARK_ATTEMPTS = 3;
const PARK_POLL_MS = 60_000;
const PARK_NUDGES = ['纭锛岃鍙戣捣杞处', '璇风洿鎺ヨ皟鐢ㄨ浆璐﹀伐鍏峰彂璧疯繖绗旇浆璐?] as const;

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
        throw new Error(`/api/dashboard 浣欓 ${apiBalance} 涓?SQLite Account.balance ${dbBalance} 涓嶄竴鑷碻);
      }
      const expected = formatCNY(dbBalance);
      await submitChat(page, MSG.balance);
      await waitFor(async () => ((await bodyText(page)).includes(expected) ? true : false), {
        timeoutMs: 120_000,
        description: `椤甸潰娓叉煋浣欓 ${expected}`,
      });
      const texts = await assistantTexts(page);
      const narration = texts.find((t) => t.includes(expected)) ?? texts[texts.length - 1] ?? '';
      await captureLive(page, 's1-balance');
      const inNarration = narration.includes(expected);
      return `銆?{MSG.balance}銆嶁啋 椤甸潰鍑虹幇 ${expected}锛汼QLite Account.balance=${dbBalance}锛?api/dashboard=${apiBalance}锛堜竴鑷达級锛涘姪鎵嬪彊杩?{inNarration ? '鍚? : '涓嶅惈'}璇ラ噾棰濓細${narration.slice(0, 120)}`;
    },
    { label: 's1-balance' },
  );
}

// --- scenario 2: transfer by NAME / by PHONE 鈫?correct recipient, then CANCEL --------------------

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
          `${errText(error)}锛涚瀛愬簱 ${RECIPIENT_NAME} 鎵嬫満鍙?${phone}锛涙寔涔呭寲宸ュ叿璋冪敤锛?{await persistedRecipientCalls()}`,
        );
      }
      const fields = await readConfirmFields(page);
      const resolved = assertRecipient(fields, RECIPIENT_NAME);
      // READ-ONLY cross-check: the parked YELLOW action must be visible on `GET /api/actions`.
      const parked = await fetchParkedActions(page, ctx.baseUrl);
      if (parked === undefined || !parked.some((a) => a.toolName === 'transfer_money')) {
        throw new Error(`纭鍗″凡娓叉煋浣?GET /api/actions 鏈繑鍥?transfer_money 寰呭鐞嗘搷浣滐細${describeActions(parked)}`);
      }
      await captureLive(page, 's2-by-name');
      await clickCancel(page);
      const after = await snapshot(ctx.baseUrl);
      if (after.balance !== before.balance) throw new Error(`鍙栨秷鍚庝綑棰濆彉鍖栵細${before.balance} 鈫?${after.balance}`);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`鍙栨秷鍚庤处鏈柊澧烇細${added.map((tx) => tx.id).join('銆?)}`);
      return `銆?{PROMPT_S2}銆嶁啋 纭鍗℃敹娆句汉=${resolved}锛堢湡瀹炲鍚?+ 鎺╃爜鎵嬫満鍙凤級锛汫ET /api/actions 鈫?${describeActions(parked)}锛涘彇娑?鈫?浣欓 ${before.balance} 鏈彉銆佽处鏈棤鏂板`;
    },
    { label: 's2-by-name' },
  );
}

/** The seeded contact's DE-MASKED phone (`139****0002` 鈫?`13900000002`) 鈥?the raw by-phone leg. */
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
          `${errText(error)}锛涚瀛愬簱 ${RECIPIENT_NAME} 鎵嬫満鍙?${seeded}锛涙寔涔呭寲宸ュ叿璋冪敤锛?{await persistedRecipientCalls()}`,
        );
      }
      const fields = await readConfirmFields(page);
      const resolved = assertRecipient(fields, RECIPIENT_NAME);
      // READ-ONLY cross-check: the parked YELLOW action must be visible on `GET /api/actions`.
      const parked = await fetchParkedActions(page, ctx.baseUrl);
      if (parked === undefined || !parked.some((a) => a.toolName === 'transfer_money')) {
        throw new Error(`纭鍗″凡娓叉煋浣?GET /api/actions 鏈繑鍥?transfer_money 寰呭鐞嗘搷浣滐細${describeActions(parked)}`);
      }
      await captureLive(page, label);
      await clickCancel(page);
      const after = await snapshot(ctx.baseUrl);
      if (after.balance !== before.balance) throw new Error(`鍙栨秷鍚庝綑棰濆彉鍖栵細${before.balance} 鈫?${after.balance}`);
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`鍙栨秷鍚庤处鏈柊澧烇細${added.map((tx) => tx.id).join('銆?)}`);
      return `銆?{MSG.transferByPhone(phone)}銆嶁啋 纭鍗℃敹娆句汉=${resolved}锛汫ET /api/actions 鈫?${describeActions(parked)}锛涘彇娑?鈫?浣欓 ${before.balance} 鏈彉銆佽处鏈棤鏂板`;
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
  return `鎺╃爜鍙凤紙绉嶅瓙 ${maskedPhone}锛夛細${masked} 锝?鐪熷疄鍙凤紙${RAW_RECIPIENT_PHONE}锛夛細${raw}`;
}

// --- scenario 3: decimal transfer 楼200.37 --------------------------------------------------------

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
          `${errText(error)}锛涚瀛愬簱 ${RECIPIENT_NAME} 鎵嬫満鍙?${phone}锛涙寔涔呭寲宸ュ叿璋冪敤锛?{await persistedRecipientCalls()}`,
        );
      }
      const fields = await readConfirmFields(page);
      if (!JSON.stringify(fields).includes('200.37')) {
        throw new Error(`纭鍗￠噾棰濆簲涓?200.37锛屽疄闄呭瓧娈碉細${JSON.stringify(fields)}`);
      }
      // BEFORE confirm: NOTHING has moved.
      const mid = await snapshot(ctx.baseUrl);
      const midDb = await readCheckingBalance();
      if (mid.balance !== before.balance || midDb !== beforeDb) {
        throw new Error(`纭鍓嶄綑棰濆凡鍙樺寲锛欰PI ${before.balance}鈫?{mid.balance}锛孌B ${beforeDb}鈫?{midDb}`);
      }
      // READ-ONLY cross-check: the parked YELLOW action must be visible on `GET /api/actions` BEFORE confirm.
      const parked = await fetchParkedActions(page, ctx.baseUrl);
      if (parked === undefined || !parked.some((a) => a.toolName === 'transfer_money')) {
        throw new Error(`纭鍗″凡娓叉煋浣?GET /api/actions 鏈繑鍥?transfer_money 寰呭鐞嗘搷浣滐細${describeActions(parked)}`);
      }
      await captureLive(page, 's3-decimal-preconfirm');
      await page.getByRole('button', { name: '纭', exact: true }).first().click();
      const settled = await waitForTransferSettled(ctx.baseUrl, before, DECIMAL_AMOUNT);
      const afterDb = await readCheckingBalance();
      await captureLive(page, 's3-decimal-settled');
      if (settled.occurrences !== 1) {
        throw new Error(`SQLite 涓?-200.37 鐨?DEBIT 琛屽簲涓?1 鏉★紝瀹為檯 ${settled.occurrences} 鏉);
      }
      return `銆?{PROMPT_S3}銆嶁啋 鍗＄墖閲戦 200.37锛汫ET /api/actions 鈫?${describeActions(parked)}锛涚‘璁ゅ墠浣欓鏈彉锛圓PI=${mid.balance}锛孌B=${midDb}锛夆啋 纭 鈫?API 浣欓 ${settled.balance}銆丼QLite Account.balance=${afterDb}锛岃处鏈柊澧?-200.37 DEBIT 涓€鏉★紙${settled.txIds[0]}锛夛紝鎵ｆ -200.37 鎭板ソ涓€娆;
    },
    { label: 's3-decimal' },
  );
}

// --- scenario 5: cancel 鈫?no deduction; repeat-confirm 鈫?idempotent; terminal UX ------------------

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
      if (!parked) throw new Error(`GET /api/actions 鏈繑鍥?transfer_money 寰呭鐞嗛」锛?{JSON.stringify(actions)}`);
      await captureLive(page, 's5-parked');
      await clickCancel(page);

      // terminal UX: the card no longer offers 纭 and shows 宸插彇娑?
      await waitFor(async () => ((await confirmButtonCount(page)) === 0 ? true : false), {
        timeoutMs: 60_000,
        description: '鍙栨秷鍚庣‘璁ゅ崱涓嶅啀鎻愪緵銆岀‘璁ゃ€嶆寜閽?,
      });
      const dom = await bodyText(page);
      if (!dom.includes('宸插彇娑?)) throw new Error('鍙栨秷鍚庣‘璁ゅ崱鏈覆鏌撱€屽凡鍙栨秷銆嶇粓鎬佸窘绔?);
      const afterCancel = await snapshot(ctx.baseUrl);
      if (afterCancel.balance !== before.balance) throw new Error(`鍙栨秷鍚庝綑棰濆彉鍖栵細${before.balance} 鈫?${afterCancel.balance}`);
      const addedAfterCancel = diffLedger(before.ledger.transactions, afterCancel.ledger.transactions).added;
      if (addedAfterCancel.length > 0) throw new Error(`鍙栨秷鍚庤处鏈柊澧烇細${addedAfterCancel.map((tx) => tx.id).join('銆?)}`);

      // cancel-on-terminal: the SAME action is already cancelled 鈫?the server must reject gracefully.
      const cancelAgain = await fetch(`${ctx.baseUrl}/api/actions/${parked.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const cancelBody = (await cancelAgain.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string } };
      const cancelRejected = cancelBody.ok === false || cancelBody.data?.ok === false;

      // repeat-confirm on the TERMINAL action 鈫?rejected, and NO double deduction.
      const confirmAgain = await fetch(`${ctx.baseUrl}/api/actions/${parked.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      const confirmBody = (await confirmAgain.json()) as { ok?: boolean; data?: { ok?: boolean; status?: string } };
      const confirmRejected = confirmBody.ok === false || confirmBody.data?.ok === false;
      const afterConfirm = await snapshot(ctx.baseUrl);
      if (afterConfirm.balance !== before.balance) {
        throw new Error(`閲嶅纭鍚庝綑棰濆彉鍖栵細${before.balance} 鈫?${afterConfirm.balance}锛堜笉搴旀墸娆撅級`);
      }
      const addedAfterConfirm = diffLedger(before.ledger.transactions, afterConfirm.ledger.transactions).added;
      if (addedAfterConfirm.length > 0) {
        throw new Error(`閲嶅纭鍚庤处鏈柊澧烇細${addedAfterConfirm.map((tx) => tx.id).join('銆?)}`);
      }
      const dbRow = await readPendingAction(parked.id, sessionId);
      if (!dbRow) throw new Error(`PendingAction ${parked.id} 涓嶅瓨鍦╜);

      return `銆?{MSG.transferByName}銆嶁啋 鍙栨秷锛圖B 鐘舵€?${dbRow.status}锛屽崱鐗囨樉绀恒€屽凡鍙栨秷銆嶃€佺‘璁ゆ寜閽暟 0锛夆啋 鏈墸娆撅紱瀵圭粓鎬佸姩浣滈噸澶嶅彇娑?${cancelRejected ? '琚嫆' : '鏈鎷?}銆侀噸澶嶇‘璁?${confirmRejected ? '琚嫆' : '鏈鎷?} 鈫?浣欓 ${before.balance} 涓嶅彉銆佽处鏈棤鏂板锛堝箓绛夛級`;
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

      // turn 1 鈥?GREEN read
      await submitChat(page, MSG.balance);
      await waitFor(async () => ((await assistantTexts(page)).length >= 1 ? true : false), {
        timeoutMs: 120_000,
        description: '绗?1 杞姪鎵嬪洖澶?,
      });

      // turn 2 鈥?confirm a YELLOW transfer (post-confirm model continuation)
      await submitChat(page, MSG.transferByName);
      await awaitConfirmCard(page, ctx.baseUrl);
      await page.getByRole('button', { name: '纭', exact: true }).first().click();
      const afterYellow = await waitForTransferSettled(ctx.baseUrl, before, TRANSFER_AMOUNT);

      // turn 3 鈥?MFA a RED transfer (post-MFA model continuation)
      await submitChat(page, MSG.transferLarge);
      await awaitMfaCard(page, ctx.baseUrl);
      await submitMfa(page, '123456');
      const afterRed = await waitForTransferSettled(
        ctx.baseUrl,
        { balance: afterYellow.balance, ledger: await fetchLedger(ctx.baseUrl) },
        LARGE_AMOUNT,
      );

      // turn 4 鈥?a follow-up read in the SAME session
      await submitChat(page, MSG.cardLimit);
      await waitFor(async () => ((await assistantTexts(page)).length >= 4 ? true : false), {
        timeoutMs: 120_000,
        description: '绗?4 杞姪鎵嬪洖澶?,
      });
      const texts = await assistantTexts(page);
      await captureLive(page, 's6-multiturn');
      const violation = findToolOrderViolation();
      if (violation) {
        throw new Error(`鍑虹幇 tool/tool_calls 400锛?{violation.method} ${violation.url} 鈥?${violation.body.slice(0, 300)}`);
      }
      return `鍚屼竴浼氳瘽 4 杞紙浣欓 鈫?杞处200纭 鈫?杞处5000楠岃瘉鐮?鈫?淇＄敤鍗￠搴︼級锛屽姪鎵嬫秷鎭?${texts.length} 鏉★紱纭鍚庝綑棰?${afterYellow.balance}銆侀獙璇佺爜鍚?${afterRed.balance}锛涘叏绋嬫棤 "tool message must answer tool_calls" 400锛堢疮璁＄綉缁?4xx/5xx锛?{netLog.issues.length}锛塦;
    },
    { label: 's6-multiturn' },
  );
}

// --- scenario 4: large transfer MFA (wrong code 鈫?nothing; correct code 鈫?exactly once) ----------

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
      await waitForStatusText(page, '楠岃瘉澶辫触锛屽凡灏濊瘯1娆?);
      if ((await page.locator('input[aria-label="楠岃瘉鐮?]').count()) === 0) {
        throw new Error('閿欒楠岃瘉鐮佸悗 MFA 鍗＄墖娑堝け锛堝簲淇濈暀浠ュ厑璁搁噸璇曪級');
      }
      const after = await snapshot(ctx.baseUrl);
      const afterDb = await readCheckingBalance();
      if (after.balance !== before.balance || afterDb !== beforeDb) {
        throw new Error(`閿欒楠岃瘉鐮佸悗浣欓鍙樺寲锛欰PI ${before.balance}鈫?{after.balance}锛孌B ${beforeDb}鈫?{afterDb}`);
      }
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) throw new Error(`閿欒楠岃瘉鐮佸悗璐︽湰鏂板锛?{added.map((tx) => tx.id).join('銆?)}`);
      await captureLive(page, 's4-mfa-wrong');
      return `閿欒鐮?000000 鈫?role=status銆岄獙璇佸け璐ワ紝宸插皾璇?1 娆°€嶏紝MFA 鍗＄墖淇濈暀锛涗綑棰濓紙API=${after.balance}锛孌B=${afterDb}锛変笌璐︽湰鍧囨湭鍙榒;
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
        throw new Error(`SQLite 涓?-5000 鐨?DEBIT 琛屽簲涓?1 鏉★紝瀹為檯 ${settled.occurrences} 鏉);
      }
      const afterDb = await readCheckingBalance();
      return `姝ｇ‘鐮?123456 鈫?浣欓 API=${settled.balance}銆丏B=${afterDb}锛堚垝5000 鎭板ソ涓€娆★級锛岃处鏈柊澧?-5000 DEBIT 涓€鏉★紙${settled.txIds[0]}锛塦;
    },
    { label: 's4-mfa-ok' },
  );

  return `閿欒鐮侊細${wrong} 锝?姝ｇ‘鐮侊細${ok}`;
}

// --- scenario 7: SDK committed but the model continuation FAILS ----------------------------------

/**
 * Engineer "the SDK write commits, the model continuation fails": DETERMINISTICALLY park a YELLOW
 * `transfer_money` 鈥?read the canonical server-owned session from the page and poll `/api/actions` for the
 * parked row and, when the live model merely narrated without calling the tool, NUDGE it in the SAME
 * session (bounded attempts) 鈥?then reboot the SAME app on the SAME DB with `DEEPSEEK_API_KEY='invalid'`
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
  resetLiveDatabase(); // zero the demo-day transfer total 鈫?the parked transfer is deterministically YELLOW
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
      // ROBUST / DETERMINISTIC PARK 鈥?the model is not trusted to CALL the gated tool on the first
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
              description: `GET /api/actions 鍑虹幇 pending/awaiting_mfa 鐨?transfer_money 寰呭鐞嗛」锛堢 ${attempt}/${PARK_ATTEMPTS} 娆★級`,
            },
          );
        } catch {
          parked = undefined; // a timeout is expected when the model only narrated 鈥?nudge and retry
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
            console.log(`路 鍦烘櫙7锛氱 ${attempt} 娆℃湭鍑虹幇寰呯‘璁よ浆璐︼紙妯″瀷鍙兘鍙彊杩版湭璋冪敤宸ュ叿锛夛紝鍙戦€佽窡杩涙秷鎭€?{nudge}銆峘);
            await submitChat(page, nudge);
          }
        }
      }
      if (parked === undefined) {
        await captureLive(page, 's7-no-park');
        throw new Error(
          `鍦烘櫙7 鏈兘鍋滄斁 transfer_money 寰呭鐞嗛」锛堝凡灏濊瘯 ${PARK_ATTEMPTS} 娆★紝鍚?${PARK_ATTEMPTS - 1} 娆¤窡杩涙秷鎭級锝?${await noCardDiagnostics(page, baseUrl)}`,
        );
      }
      actionId = parked.id;
      await captureLive(page, 's7-parked');
    },
    { label: 's7-park' },
  );
  const before = await snapshot(baseUrl);
  const beforeDb = await readCheckingBalance();

  // Reboot the SAME app on the SAME DB with an INVALID provider key 鈫?only the continuation fails.
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
    throw new Error(`PendingAction.status 搴斾负 executed锛屽疄闄?${row?.status ?? 'null'}`);
  }
  if (settled.occurrences !== 1) {
    throw new Error(`SQLite 涓?-200 鐨?DEBIT 琛屽簲涓?1 鏉★紝瀹為檯 ${settled.occurrences} 鏉);
  }
  const statusOk = body.ok === true && body.data?.ok === true && body.data?.status === 'executed';
  return `閲嶅惎鍚庡湪鏃犳晥 key 涓嬬‘璁わ細HTTP ${res.status} ok=${body.ok} status=${body.data?.status}锛坰tatusOk=${statusOk}锛夛紱DB PendingAction.status=${row.status}锛屼綑棰?${before.balance}鈫?{settled.balance}锛圖B=${afterDb}锛夛紝-200 DEBIT 鎭?1 鏉★紙${settled.txIds[0]}锛夛紱DB=${JSON.stringify(row.resultJson)?.slice(0, 80)}`;
}

// --- scenarios lA / lB: LIVE card replacement + partial investment redemption ---------------------

const HOLDING_WENJIANA_ID = 'holding_wenjiana';
const CARD_REPLACE_PROMPT = '璇蜂负鎴戞寕澶辩殑淇＄敤鍗¤ˉ鍔炰竴寮犳柊鍗?;

/** The UNIQUE `CREDIT` + `ACTIVE` card, or `undefined` when there is none / more than one. */
function uniqueActiveCreditCard(cards: readonly LiveCardRecord[]): LiveCardRecord | undefined {
  const matches = cards.filter((card) => card.type === 'CREDIT' && card.status === 'ACTIVE');
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * TOTAL available credit that may actually be SPENT: every `CREDIT` card that is NOT `LOST`.
 * A 琛ュ姙 card stays in the read model as `LOST` and KEEPS its recorded `availableLimit`, so the
 * family's allowance must be counted exactly ONCE 鈥?through the replacement, never the source too.
 */
function nonLostCreditAvailableTotalMinor(cards: readonly LiveCardRecord[]): bigint {
  return cards
    .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST' && card.availableLimit !== undefined)
    .reduce((sum, card) => sum + moneyToCents(card.availableLimit as string), 0n);
}

/** The NAIVE total over ALL `CREDIT` cards INCLUDING `LOST` ones 鈥?recorded only to expose the trap. */
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
 * on the REAL `/cards` page, `GET /api/cards` and SQLite 鈥?and prove `replace_card` is IDEMPOTENT for
 * the SAME source card: a SECOND UI request must NOT mint a second card.
 *
 * Idempotency rule: a repeat request may REPLAY the original result, RETURN the existing result, or
 * explicitly REFUSE the duplicate 鈥?all three are acceptable and a SECOND MFA / tool execution is NOT
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

      // BASELINE 鈥?the usable available credit BEFORE 鎸傚け/琛ュ姙, straight from the read route, so the
      // post-琛ュ姙 total can be compared against it (a 琛ュ姙 must never ADD credit).
      const cardsBeforeReplace = await fetchLiveCards(ctx.baseUrl);
      const sourceBefore = cardById(cardsBeforeReplace, CREDIT_CARD_ID);
      if (sourceBefore?.type !== 'CREDIT' || sourceBefore.status !== 'ACTIVE' || sourceBefore.availableLimit === undefined) {
        throw new Error(`鎸傚け鍓?${CREDIT_CARD_ID} 搴斾负甯?availableLimit 鐨?ACTIVE CREDIT 鍗★紝瀹為檯 ${JSON.stringify(sourceBefore)}`);
      }
      const totalAvailableBeforeMinor = nonLostCreditAvailableTotalMinor(cardsBeforeReplace);
      const naiveAllCreditBeforeMinor = allCreditAvailableTotalMinor(cardsBeforeReplace);

      // A1 鈥?RED `report_lost_card`: bounded natural turns until the model parks the MFA card.
      const sentA1 = await driveRedTool(page, ctx.baseUrl, [
        '鎴戠殑淇＄敤鍗′涪澶变簡锛岃甯垜姝ｅ紡鎸傚け灏惧彿6688鐨勪俊鐢ㄥ崱',
        '纭锛岃鍔炵悊',
        '鐣岄潰涓婃柟娌℃湁鍑虹幇纭闈㈡澘锛岃閲嶆柊鍙戣捣杩欏紶鍗＄殑鎸傚け',
        '璇风洿鎺ュ府鎴戝姙鐞嗘寕澶憋紝鎴戝凡缁忕‘璁?,
      ]);
      await awaitLiveCards(
        ctx.baseUrl,
        (cards) => cards.find((card) => card.id === CREDIT_CARD_ID)?.status === 'LOST',
        `鎸傚け鍚?GET /api/cards 涓?${CREDIT_CARD_ID}.status === LOST`,
      );

      // A2 鈥?RED `replace_card`: same bounded natural turns (a short confirmation if the model asks).
      const sentA2 = await driveRedTool(page, ctx.baseUrl, [
        CARD_REPLACE_PROMPT,
        '纭锛岃涓烘垜琛ュ姙',
        '鐣岄潰涓婃柟娌℃湁鍑虹幇纭闈㈡澘锛岃閲嶆柊鍙戣捣琛ュ姙',
        '璇风洿鎺ヤ负鎴戣ˉ鍔炰竴寮犳柊鍗★紝鎴戝凡纭',
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
        '琛ュ崱鍚庯細card_credit 宸插叧鑱旇ˉ鍔炲崱銆佹伆鏈変竴寮?ACTIVE 淇＄敤鍗★紝涓?DEBIT / VIRTUAL 婕旂ず鍗′粛涓?ACTIVE',
      );
      const activeCredit = uniqueActiveCreditCard(replaced);
      if (activeCredit === undefined) throw new Error('琛ュ崱鍚庢湭鎵惧埌鍞竴鐨?ACTIVE 淇＄敤鍗?);
      const newId = activeCredit.id;

      // REAL PAGE 鈥?the replacement tile's limits/status and the source card's LOST + 宸茶ˉ鍗?badges.
      await page.goto(`${ctx.baseUrl}/cards`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, '[data-card-add] button');
      const newRows = await readCardTileRows(page, newId);
      const newTileText = (await page.locator(`[data-card-id="${newId}"]`).first().innerText()).replace(/\s+/g, ' ');
      const sourceTileText = (await page.locator(`[data-card-id="${CREDIT_CARD_ID}"]`).first().innerText()).replace(/\s+/g, ' ');
      const cardsShot = await captureLive(page, 'lA-cards');
      if (newRows['淇＄敤棰濆害'] !== '楼18,000.00' || newRows['鍙敤棰濆害'] !== '楼18,000.00') {
        throw new Error(`琛ュ姙淇＄敤鍗?${newId} 搴旀樉绀?淇＄敤棰濆害=鍙敤棰濆害=楼18,000.00锛屽疄闄?${JSON.stringify(newRows)}`);
      }
      if (!newTileText.includes('姝ｅ父')) {
        throw new Error(`琛ュ姙淇＄敤鍗?${newId} 鏈樉绀恒€屾甯搞€嶇姸鎬侊細${newTileText.slice(0, 200)}`);
      }
      if (!sourceTileText.includes('宸叉寕澶?) || !sourceTileText.includes('宸茶ˉ鍗?)) {
        throw new Error(`${CREDIT_CARD_ID} 搴斿悓鏃舵樉绀恒€屽凡鎸傚け銆嶄笌銆屽凡琛ュ崱銆嶏紝瀹為檯锛?{sourceTileText.slice(0, 200)}`);
      }

      // AUTHORITATIVE cross-check via the raw `/api/cards` route (NOT the narrow `fetchCards` helper).
      const cards = await fetchLiveCards(ctx.baseUrl);
      const actives = cards.filter((card) => card.type === 'CREDIT' && card.status === 'ACTIVE');
      if (actives.length !== 1) {
        throw new Error(`搴旀伆鏈?1 寮?ACTIVE 淇＄敤鍗★紝瀹為檯 ${actives.length}锛?{JSON.stringify(cards)}`);
      }
      const active = actives[0];
      if (active.creditLimit !== '18000.00' || active.availableLimit !== '18000.00') {
        throw new Error(`ACTIVE 淇＄敤鍗￠搴﹀簲涓?creditLimit=availableLimit=18000.00锛屽疄闄?creditLimit=${active.creditLimit}銆乤vailableLimit=${active.availableLimit}`);
      }
      const source = cardById(cards, CREDIT_CARD_ID);
      if (source?.status !== 'LOST') throw new Error(`${CREDIT_CARD_ID} 搴斾粛涓?LOST锛屽疄闄?${source?.status}`);
      if (source?.replacedByCardId !== active.id) {
        throw new Error(`${CREDIT_CARD_ID}.replacedByCardId 搴旀寚鍚?${active.id}锛屽疄闄?${source?.replacedByCardId}`);
      }
      // The replacement CREDIT card inherits the source's monthly limit; the OTHER two seeded cards are
      // untouched and keep their EXACT type / status / limits 鈥?asserted by type/status, never by count alone.
      if (active.monthlyLimit !== '18000.00') {
        throw new Error(`琛ュ姙淇＄敤鍗℃湀闄愰搴旂户鎵垮師鍗★紙18000.00锛夛紝瀹為檯 ${active.monthlyLimit}`);
      }
      const debitCard = cardById(cards, DEBIT_CARD_ID);
      if (debitCard?.type !== 'DEBIT' || debitCard.status !== 'ACTIVE' || debitCard.creditLimit !== undefined
        || debitCard.availableLimit !== undefined || debitCard.monthlyLimit !== undefined) {
        throw new Error(`${DEBIT_CARD_ID} 搴斾负涓嶅甫浠讳綍棰濆害瀛楁鐨?ACTIVE DEBIT 鍗★紝瀹為檯 ${JSON.stringify(debitCard)}`);
      }
      const virtualCard = cardById(cards, VIRTUAL_CARD_ID);
      if (virtualCard?.type !== 'VIRTUAL' || virtualCard.status !== 'ACTIVE'
        || virtualCard.monthlyLimit !== '5000.00' || virtualCard.linkedAccountId !== DEMO_CHECKING_ID) {
        throw new Error(`${VIRTUAL_CARD_ID} 搴斾负缁戝畾 ${DEMO_CHECKING_ID}銆佹湀闄愰 5000.00 鐨?ACTIVE VIRTUAL 鍗★紝瀹為檯 ${JSON.stringify(virtualCard)}`);
      }
      if (cards.filter((card) => card.type === 'DEBIT').length !== 1 || cards.filter((card) => card.type === 'VIRTUAL').length !== 1) {
        throw new Error(`搴旀伆鏈?1 寮?DEBIT 涓?1 寮?VIRTUAL 鍗★紝瀹為檯 ${cards.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }
      if (cards.length !== 4) {
        throw new Error(`鍗＄墖鎬绘暟搴斾负 4锛? 寮?ACTIVE 琛ュ姙鍗?+ 1 寮?LOST 婧愬崱 + 1 寮?DEBIT + 1 寮?VIRTUAL锛夛紝瀹為檯 ${cards.length}锛?{cards.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }

      // NO-DOUBLING 鈥?琛ュ姙 must not create credit: the replacement INHERITS the source's available
      // limit and the `LOST` source stops counting toward usable credit, so the spendable total is
      // unchanged. A total that DOUBLED here would let the demo user spend the same allowance twice.
      const totalAvailableAfterMinor = nonLostCreditAvailableTotalMinor(cards);
      const naiveAllCreditAfterMinor = allCreditAvailableTotalMinor(cards);
      if (active.availableLimit !== sourceBefore.availableLimit) {
        throw new Error(`琛ュ姙鍗″彲鐢ㄩ搴﹀簲缁ф壙鍘熷崱 ${sourceBefore.availableLimit}锛堜笉寰楁斁澶э級锛屽疄闄?${active.availableLimit}`);
      }
      if (totalAvailableAfterMinor !== totalAvailableBeforeMinor) {
        throw new Error(`琛ュ姙鍓嶅悗銆岄潪 LOST 淇＄敤鍗″彲鐢ㄩ搴﹀悎璁°€嶅繀椤讳笉鍙橈紙棰濆害涓嶅緱绠椾袱娆★級锛氳ˉ鍔炲墠 ${centsToMoney(totalAvailableBeforeMinor)} 鈫?琛ュ姙鍚?${centsToMoney(totalAvailableAfterMinor)}锛堟槑缁嗭細${cards.filter((card) => card.type === 'CREDIT').map((card) => `${card.id}:${card.status}:鍙敤=${card.availableLimit ?? '鏃?}`).join(' ')}锛塦);
      }

      // IDEMPOTENCY 鈥?a SECOND `replace_card` request through the UI must NOT mint a second card. The
      // repeat request may replay the original result, return the existing result, or explicitly refuse
      // the duplicate; a second MFA / tool execution is NOT required (`requireCardAtEnd = false`). The
      // leg is judged solely by the authoritative `GET /api/cards` route state below.
      await gotoAgent(page, ctx.baseUrl);
      const sentIdem = await driveRedTool(
        page,
        ctx.baseUrl,
        [
          CARD_REPLACE_PROMPT,
          '纭锛岃涓烘垜琛ュ姙',
          '璇峰啀鎻愪氦涓€娆¤繖寮犲崱鐨勮ˉ鍔炵敵璇凤紝鎴戣纭涓嶄細閲嶅鍙戝崱',
        ],
        undefined,
        false,
      );
      const afterSecond = await fetchLiveCards(ctx.baseUrl);
      const activeAfter = uniqueActiveCreditCard(afterSecond);
      if (afterSecond.length !== 4) {
        throw new Error(`绗簩娆¤ˉ鍗″悗鍗＄墖鎬绘暟搴斾粛涓?4锛堟湭鏂板绗簩寮犺ˉ鍔炲崱锛夛紝瀹為檯 ${afterSecond.length}锛?{afterSecond.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }
      if (activeAfter?.id !== newId) {
        throw new Error(`绗簩娆¤ˉ鍗″悗 ACTIVE 淇＄敤鍗?id 搴斾粛涓?${newId}锛堟湭鏂板绗簩寮狅級锛屽疄闄?${activeAfter?.id ?? '鏃?}`);
      }

      // 鈥nd the repeat request must not release a SECOND allowance either.
      const totalAvailableAfterIdemMinor = nonLostCreditAvailableTotalMinor(afterSecond);
      if (totalAvailableAfterIdemMinor !== totalAvailableBeforeMinor) {
        throw new Error(`閲嶅琛ュ崱璇锋眰鍚庛€岄潪 LOST 淇＄敤鍗″彲鐢ㄩ搴﹀悎璁°€嶄粛椤讳负 ${centsToMoney(totalAvailableBeforeMinor)}锛堜笉寰楅噸澶嶅彂鍗?鏀鹃搴︼級锛屽疄闄?${centsToMoney(totalAvailableAfterIdemMinor)}锛?{afterSecond.filter((card) => card.type === 'CREDIT').map((card) => `${card.id}:${card.status}:鍙敤=${card.availableLimit ?? '鏃?}`).join(' ')}`);
      }

      return `A1 瀹為檯鍙戦€侊細${sentA1.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?card_credit=LOST锛汚2 瀹為檯鍙戦€侊細${sentA2.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?鏂板崱 ${newId}锛堜俊鐢ㄩ搴?${newRows['淇＄敤棰濆害']}銆佸彲鐢ㄩ搴?${newRows['鍙敤棰濆害']}锛岀姸鎬佸惈銆屾甯搞€嶏級锛?cards 涓?${CREDIT_CARD_ID} 鏄剧ず銆屽凡鎸傚け銆?銆屽凡琛ュ崱銆嶏紱GET /api/cards锛氬叡 ${cards.length} 寮犮€佸敮涓€ ACTIVE 淇＄敤鍗?id=${active.id}銆乧reditLimit=${active.creditLimit}銆乤vailableLimit=${active.availableLimit}銆乧ard_credit.status=${source?.status}銆乺eplacedByCardId=${source?.replacedByCardId}锛涘啀娆¤ˉ鍗″疄闄呭彂閫侊細${sentIdem.map((t) => `銆?{t}銆峘).join(' 鈫?')}锛堥噸澶嶈姹傦紝鍏佽閲嶆斁/杩斿洖鏃㈡湁缁撴灉/鏄惧紡鎷掔粷锛屼笉瑕佹眰浜屾 MFA/宸ュ叿鎵ц锛夊悗浠嶄负 ${afterSecond.length} 寮犮€丄CTIVE id=${activeAfter?.id ?? '鏃?}锛堟湭鏂板绗簩寮狅級锛涘彲鐢ㄤ俊鐢ㄩ搴︼紙闈?LOST 淇＄敤鍗″悎璁★級锛氳ˉ鍔炲墠 ${centsToMoney(totalAvailableBeforeMinor)}锛?{CREDIT_CARD_ID}:ACTIVE:鍙敤=${sourceBefore.availableLimit}锛夆啋 琛ュ姙鍚?${centsToMoney(totalAvailableAfterMinor)}锛堝敮涓€ ACTIVE 琛ュ姙鍗?${newId}:鍙敤=${active.availableLimit}锛?{CREDIT_CARD_ID}:LOST:鍙敤=${source?.availableLimit ?? '鏃?}锛屽凡鎺掗櫎锛夛紱鎶?LOST 婧愬崱涔熻鍏ョ殑鏈寸礌鍚堣 ${centsToMoney(naiveAllCreditBeforeMinor)} 鈫?${centsToMoney(naiveAllCreditAfterMinor)}锛堥噸澶嶈棰濆害锛屽凡琚柇瑷€鎺掗櫎锛夛紱閲嶅琛ュ崱鍚庡悎璁?${centsToMoney(totalAvailableAfterIdemMinor)}锛涙埅鍥?${cardsShot ?? '鏈惤鐩?}`;
    },
    { label: 'lA-credit-report-lost-and-replace' },
  );
}

/** The `holding_wenjiana` row subset the redemption scenario asserts on. */
interface LiveHoldingRow {
  principalAmountMinor: bigint;
  estimatedMarketValue: string | null;
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
          select: { principalAmountMinor: true, estimatedMarketValue: true },
        });
        return row && predicate(row) ? row : false;
      }),
    { timeoutMs, intervalMs: 1_000, description },
  );
}

/** Read one labelled `label 鈫?value` row (two adjacent spans) from a rendered investment tile. */
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

/**
 * SCENARIO lB (LIVE-LLM, REAL BROWSER): subscribe an extra 楼1,000 into 绋冲仴鐞嗚储A (RED) and then
 * PARTIALLY redeem 楼2,000 of principal (RED) through the `/agent` chat + MFA, then verify the EXACT
 * remaining principal / market value / profit on the REAL `/investments` page, the ledger + balance
 * and the full-precision valuation stored in SQLite.
 */
async function scenarioPartialRedeem(ctx: Ctx): Promise<string> {
  return withPage(
    ctx.browser,
    async (page) => {
      attachCollectors(page);
      const beforeBalance = (await fetchDashboardSummary(ctx.baseUrl)).checkingBalance;
      const beforeLedger = (await fetchLedger(ctx.baseUrl)).transactions;
      await gotoAgent(page, ctx.baseUrl);

      // B1 鈥?RED `subscribe_investment` (楼1,000 into 绋冲仴鐞嗚储A 鈫?principal 6,000.00): bounded natural
      // turns; if the model insists on a failing plan/submission path, one mild natural rephrase.
      const sentB1 = await driveRedTool(page, ctx.baseUrl, [
        '杩藉姞鐢宠喘绋冲仴鐞嗚储A 1000鍏?,
        '纭锛岃鍔炵悊',
        '鐣岄潰涓婃柟娌℃湁鍑虹幇纭闈㈡澘锛岃閲嶆柊鍙戣捣杩欑瑪杩藉姞鐢宠喘',
        '鐜板湪灏辩敤鎴戠殑璐︽埛杩藉姞鐢宠喘绋冲仴鐞嗚储A 1000鍏?,
      ]);
      await awaitHolding(
        (row) => row.principalAmountMinor === 600_000n,
        'B1 鍚?holding_wenjiana.principalAmountMinor === 600000锛埪?,000.00锛?,
      );

      // B2 鈥?RED `redeem_investment` (PARTIAL 楼2,000 principal 鈫?principal 4,000.00): bounded natural turns.
      const sentB2 = await driveRedTool(page, ctx.baseUrl, [
        '鎴戞寔鏈夌殑绋冲仴鐞嗚储A閮ㄥ垎璧庡洖2000鍏冩湰閲?,
        '纭锛岃鍔炵悊',
        '鐣岄潰涓婃柟娌℃湁鍑虹幇纭闈㈡澘锛岃閲嶆柊鍙戣捣杩欑瑪閮ㄥ垎璧庡洖',
      ]);
      const holding = await awaitHolding(
        (row) => row.principalAmountMinor === 400_000n && (row.estimatedMarketValue ?? '').startsWith('4118.90666'),
        'B2 鍚?principalAmountMinor === 400000 涓?estimatedMarketValue 浠?4118.90666 寮€澶达紙鍏ㄧ簿搴﹀瓨鍌級',
      );

      // REAL PAGE 鈥?exact remaining principal / market value / profit rendered on `/investments`.
      await page.goto(`${ctx.baseUrl}/investments`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, '[data-investment-holdings]');
      const tiles = page.locator('[data-investment-holdings] div.rounded-2xl').filter({ hasText: '绋冲仴鐞嗚储A' });
      const tileCount = await tiles.count();
      if (tileCount !== 1) throw new Error(`/investments 鎸佷粨鍖恒€岀ǔ鍋ョ悊璐銆嶅崱鐗囧簲鎭?1 寮狅紝瀹為檯 ${tileCount}`);
      const principal = await readTileRow(tiles.first(), '鎸佹湁閲戦');
      const marketValue = await readTileRow(tiles.first(), '甯傚€?);
      const profit = await readTileRow(tiles.first(), '鏀剁泭');
      await captureLive(page, 'lB-investments');
      const shown: Record<string, string> = { 鎸佹湁閲戦: principal, 甯傚€? marketValue, 鏀剁泭: profit };
      for (const [label, value] of Object.entries(shown)) {
        if (value === '') throw new Error(`/investments 鏈覆鏌撱€?{label}銆嶈`);
        if (/\.\d{6,}/.test(value)) throw new Error(`銆?{label}銆嶅睍绀轰簡鏈粨绠楃殑杩囬珮绮惧害锛?{value}`);
        if (!/^[+-]?楼[\d,]+\.\d{2}$/.test(value)) throw new Error(`銆?{label}銆嶆樉绀哄€兼牸寮忎笉姝ｇ‘锛?{value}`);
      }
      if (principal !== '楼4,000.00') throw new Error(`鎸佹湁閲戦搴斾负 楼4,000.00锛屽疄闄?${principal}`);
      if (marketValue !== '楼4,118.91') throw new Error(`甯傚€煎簲涓?楼4,118.91锛屽疄闄?${marketValue}`);
      if (profit !== '+楼118.91') throw new Error(`鏀剁泭搴斾负 +楼118.91锛屽疄闄?${profit}`);

      // LEDGER + BALANCE 鈥?one investment DEBIT (璁よ喘) and one investment CREDIT (璧庡洖).
      const afterBalance = (await fetchDashboardSummary(ctx.baseUrl)).checkingBalance;
      const afterLedger = (await fetchLedger(ctx.baseUrl)).transactions;
      const added = diffLedger(beforeLedger, afterLedger).added;
      const describe = added.map((tx) => `${tx.id}:${tx.amount}:${tx.direction}:${tx.merchant}/${tx.category}`).join(' ');
      const debits = added.filter(
        (tx) => tx.direction === 'DEBIT' && moneyToCents(tx.amount) === -100_000n && tx.merchant === '璁よ喘绋冲仴鐞嗚储A' && tx.category === '鎶曡祫',
      );
      const credits = added.filter(
        (tx) => tx.direction === 'CREDIT' && moneyToCents(tx.amount) === 205_945n && tx.merchant === '璧庡洖' && tx.category === '鎶曡祫',
      );
      if (debits.length !== 1) throw new Error(`璐︽湰搴旀柊澧?1 鏉?-1000.00 鐨勬姇璧?DEBIT锛堣璐ǔ鍋ョ悊璐锛夛紝瀹為檯 ${debits.length}锛?{describe}`);
      if (credits.length !== 1) throw new Error(`璐︽湰搴旀柊澧?1 鏉?+2059.45 鐨勬姇璧?CREDIT锛堣祹鍥烇級锛屽疄闄?${credits.length}锛?{describe}`);
      const expectedBalance = addMoney(subtractMoney(beforeBalance, '1000.00'), '2059.45');
      if (afterBalance !== expectedBalance) throw new Error(`娲绘湡浣欓搴斾负 ${expectedBalance}锛屽疄闄?${afterBalance}`);

      return `B1 瀹為檯鍙戦€侊細${sentB1.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?DB principalAmountMinor=600000锛埪?,000.00锛夛紱B2 瀹為檯鍙戦€侊細${sentB2.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?DB principalAmountMinor=${holding.principalAmountMinor}锛埪?,000.00锛夈€乪stimatedMarketValue=${holding.estimatedMarketValue}锛堝叏绮惧害锛夛紱/investments 鏄剧ず 鎸佹湁閲戦=${principal}銆佸競鍊?${marketValue}銆佹敹鐩?${profit}锛涜处鏈柊澧?DEBIT ${debits[0].amount}锛?{debits[0].id}锛?{debits[0].merchant}/${debits[0].category}锛変笌 CREDIT ${credits[0].amount}锛?{credits[0].id}锛?{credits[0].merchant}/${credits[0].category}锛夛紱娲绘湡浣欓 ${beforeBalance} 鈫?${afterBalance}`;
    },
    { label: 'lB-investment-partial-redemption' },
  );
}

// --- scenario table ------------------------------------------------------------------------------

/** Verify transport completion and exact text preservation using persisted wire events. */
// --- scenario lC: LIVE virtual-card consumption --------------------------------------------------

/** UI-driven consumption for scenario lC (a unique merchant keeps the ledger row unambiguous). */
const VIRTUAL_CONSUME_AMOUNT = '88.00';
const VIRTUAL_CONSUME_CATEGORY = '璐墿';
const VIRTUAL_CONSUME_MERCHANT = '铏氭嫙鍗℃秷璐归獙璇?;
/** Natural (Chinese-only) turns asking the model to CONFIRM the EXISTING virtual card 鈥?never to mint one. */
const VIRTUAL_CONFIRM_PROMPT = '鎴戝彧鏄兂纭涓€涓嬫垜鐜版湁鐨勯偅寮犺櫄鎷熷崱锛堝熬鍙?788锛夌殑鐘舵€侊紝涓嶉渶瑕佹柊鍔炲崱锛屽彲浠ュ悧锛?;
const VIRTUAL_PAYABLE_PROMPT = '閭ｆ垜杩欏紶铏氭嫙鍗″綋鍓嶆渶澶氬彲浠ユ敮浠樺灏戦挶锛?;

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
    if (!account) throw new Error(`缂哄皯璐︽埛 ${DEMO_CHECKING_ID}`);
    return { cardDebits, consumptions, balanceMinor: account.balanceMinor };
  });
}

/**
 * SCENARIO lC (LIVE-LLM, REAL BROWSER): confirm the SEEDED virtual card (`card_virtual` 鈥?a VIRTUAL debit
 * instrument bound to `acct_checking` with monthly limit 楼5,000.00) through a natural `/agent` request,
 * then spend WITHIN limits through the REAL front-end consume dialog (`CardManager` 娑堣垂 button 鈫?
 * `CardConsumeDialog` form 鈫?`POST /api/cards/[id]/consume`).
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
      // Baseline FIRST 鈥?the seeded virtual card must be an ACTIVE VIRTUAL bound to the checking account,
      // and the DB balance / CARD debits / consumptions are the authoritative start state.
      const baselineCards = await awaitLiveCards(
        ctx.baseUrl,
        (cards) => cardById(cards, VIRTUAL_CARD_ID)?.type === 'VIRTUAL' && cardById(cards, VIRTUAL_CARD_ID)?.status === 'ACTIVE',
        `${VIRTUAL_CARD_ID} 搴斾负 ACTIVE 鐨?VIRTUAL 鍗,
      );
      const virtualBefore = cardById(baselineCards, VIRTUAL_CARD_ID);
      if (!virtualBefore) throw new Error(`GET /api/cards 缂哄皯 ${VIRTUAL_CARD_ID}`);
      if (virtualBefore.linkedAccountId !== DEMO_CHECKING_ID) {
        throw new Error(`${VIRTUAL_CARD_ID}.linkedAccountId 搴斾负 ${DEMO_CHECKING_ID}锛屽疄闄?${virtualBefore.linkedAccountId}`);
      }
      const monthlyLimit = virtualBefore.monthlyLimit;
      const availableBefore = virtualBefore.accountAvailableBalance;
      const payableBefore = virtualBefore.payableAmount;
      if (monthlyLimit === undefined || availableBefore === undefined || payableBefore === undefined) {
        throw new Error(`${VIRTUAL_CARD_ID} 搴旀毚闇?monthlyLimit/accountAvailableBalance/payableAmount锛屽疄闄?${JSON.stringify(virtualBefore)}`);
      }
      const before = await readVirtualConsumeSnapshot();
      const limitMinor = moneyToCents(monthlyLimit);
      const amountMinor = moneyToCents(VIRTUAL_CONSUME_AMOUNT);
      if (amountMinor <= 0n) throw new Error(`娑堣垂閲戦蹇呴』涓烘锛?{VIRTUAL_CONSUME_AMOUNT}`);
      const spentBeforeMinor = before.consumptions.reduce((sum, row) => sum + row.amountMinor, 0n);
      const remainingBeforeMinor = limitMinor > spentBeforeMinor ? limitMinor - spentBeforeMinor : 0n;
      const expectedPayableBeforeMinor = before.balanceMinor < remainingBeforeMinor ? before.balanceMinor : remainingBeforeMinor;
      if (moneyToCents(payableBefore) !== expectedPayableBeforeMinor) {
        throw new Error(`${VIRTUAL_CARD_ID}.payableAmount 搴斾负 min(鍙敤浣欓 ${centsToMoney(before.balanceMinor)}, 鍓╀綑鏈堥檺棰?${centsToMoney(remainingBeforeMinor)}) = ${centsToMoney(expectedPayableBeforeMinor)}锛屽疄闄?${payableBefore}`);
      }

      // C1 鈥?natural `/agent` request CONFIRMING the existing virtual card (never a create request). It is
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
        throw new Error(`纭铏氭嫙鍗″悗搴斾粛鎭版湁 1 寮?VIRTUAL 鍗★紙${VIRTUAL_CARD_ID}锛夛紝瀹為檯 ${JSON.stringify(virtuals)}`);
      }
      if (afterConfirm.length !== baselineCards.length) {
        throw new Error(`纭铏氭嫙鍗″悗鍗＄墖鎬绘暟搴斾繚鎸佷笉鍙橈紙鍩虹嚎 ${baselineCards.length} 寮狅級锛屽疄闄?${afterConfirm.length}锛?{afterConfirm.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}`);
      }

      // C2 鈥?spend THROUGH THE REAL FRONT-END (CardManager 娑堣垂 button 鈫?CardConsumeDialog form).
      await page.goto(`${ctx.baseUrl}/cards`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, `[data-card-id="${VIRTUAL_CARD_ID}"] [data-card-consume] button`);
      const consumeButton = page.locator(`[data-card-id="${VIRTUAL_CARD_ID}"] [data-card-consume] button`).first();
      await waitFor(async () => ((await consumeButton.isEnabled()) ? true : false), {
        timeoutMs: 60_000,
        description: `${VIRTUAL_CARD_ID} 鐨勩€屾秷璐广€嶆寜閽彲鐢╜,
      });
      await consumeButton.click();
      await waitForElementHydration(page, '[data-card-consume-form]');
      const dialogCardId = await page.locator('[data-card-consume-dialog]').first().getAttribute('data-card-consume-card-id');
      if (dialogCardId !== VIRTUAL_CARD_ID) {
        throw new Error(`娑堣垂寮圭獥搴旂粦瀹?${VIRTUAL_CARD_ID}锛屽疄闄?data-card-consume-card-id=${dialogCardId}`);
      }
      const summary = await readDialogRows(page, '[data-card-consume-summary]');
      if (summary['鏈堥檺棰?] !== formatCNY(monthlyLimit)) {
        throw new Error(`娑堣垂寮圭獥銆屾湀闄愰銆嶅簲涓?${formatCNY(monthlyLimit)}锛屽疄闄?${summary['鏈堥檺棰?]}锛?{JSON.stringify(summary)}锛塦);
      }
      if (summary['鍏宠仈璐︽埛'] !== '****8821') {
        throw new Error(`娑堣垂寮圭獥銆屽叧鑱旇处鎴枫€嶅簲涓?****8821锛屽疄闄?${summary['鍏宠仈璐︽埛']}锛?{JSON.stringify(summary)}锛塦);
      }
      if (summary['褰撳墠鍙敮浠橀噾棰?] !== formatCNY(payableBefore)) {
        throw new Error(`娑堣垂寮圭獥銆屽綋鍓嶅彲鏀粯閲戦銆嶅簲涓?${formatCNY(payableBefore)}锛屽疄闄?${summary['褰撳墠鍙敮浠橀噾棰?]}锛?{JSON.stringify(summary)}锛塦);
      }
      const form = page.locator('[data-card-consume-form]').first();
      // The dialog must offer NO time control at all: the booking instant is SERVER-owned.
      const formFieldNames = await form.locator('input').evaluateAll((els) => els.map((el) => el.getAttribute('name') ?? ''));
      if (formFieldNames.some((name) => /occurred|date|time/i.test(name))) {
        throw new Error(`娑堣垂琛ㄥ崟涓嶅緱鍖呭惈浠讳綍鏃堕棿瀛楁锛堣璐︽椂闂寸敱鏈嶅姟绔嫢鏈夛級锛屽疄闄?${JSON.stringify(formFieldNames)}`);
      }
      for (const required of ['amount', 'category', 'merchant']) {
        if (!formFieldNames.includes(required)) {
          throw new Error(`娑堣垂琛ㄥ崟缂哄皯 ${required} 瀛楁锛屽疄闄?${JSON.stringify(formFieldNames)}`);
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
      await form.getByRole('button', { name: '鎻愪氦娑堣垂', exact: true }).click();
      const sentBodyText = (await consumeRequest).postData() ?? '';
      if (sentBodyText === '') throw new Error('娑堣垂璇锋眰娌℃湁璇锋眰浣擄紝鏃犳硶鏍稿鏄惁鎻愪氦浜嗚璐︽椂闂?);
      const sentBody = JSON.parse(sentBodyText) as Record<string, unknown>;
      if ('occurredAt' in sentBody) {
        throw new Error(`娑堣垂璇锋眰浣撲笉寰楁惡甯?occurredAt锛堣璐︽椂闂寸敱鏈嶅姟绔嫢鏈夛級锛屽疄闄?${sentBodyText}`);
      }
      // The dialog may also send its retry `executionKey` (an idempotency identity, NOT a time), so the
      // property pinned here is precisely the one that matters: the body carries NO time-shaped key and
      // nothing outside the four accepted fields.
      const sentKeys = Object.keys(sentBody).sort().join(',');
      const allowedKeys = new Set(['amount', 'category', 'merchant', 'executionKey']);
      const unexpectedKeys = Object.keys(sentBody).filter((key) => !allowedKeys.has(key));
      if (unexpectedKeys.length > 0) {
        throw new Error(`娑堣垂璇锋眰浣撳彧鍏佽 amount/category/merchant/executionKey锛屽疄闄呭鍑?${unexpectedKeys.join(',')}锛?{sentBodyText}锛塦);
      }
      const timeShapedKeys = Object.keys(sentBody).filter((key) => /occurred|date|time/i.test(key));
      if (timeShapedKeys.length > 0) {
        throw new Error(`娑堣垂璇锋眰浣撲笉寰楁惡甯︿换浣曟椂闂村瓧娈碉紙璁拌处鏃堕棿鐢辨湇鍔＄鎷ユ湁锛夛紝瀹為檯 ${timeShapedKeys.join(',')}锛?{sentBodyText}锛塦);
      }
      for (const required of ['amount', 'category', 'merchant']) {
        if (!(required in sentBody)) {
          throw new Error(`娑堣垂璇锋眰浣撶己灏?${required}锛屽疄闄?${sentBodyText}`);
        }
      }
      if (sentBody['amount'] !== VIRTUAL_CONSUME_AMOUNT) {
        throw new Error(`娑堣垂璇锋眰浣?amount 搴斾负 ${VIRTUAL_CONSUME_AMOUNT}锛屽疄闄?${String(sentBody['amount'])}`);
      }
      await waitForStatusText(page, '娑堣垂鎴愬姛', 60_000);
      // The dialog reloads this card's consumptions after a successful spend 鈫?exactly ONE new record.
      await waitFor(
        async () => ((await page.locator('[data-card-consumption]').count()) === before.consumptions.length + 1 ? true : false),
        { timeoutMs: 60_000, description: '娑堣垂鎴愬姛鍚庡脊绐椼€屾秷璐硅褰曘€嶆柊澧?1 鏉? },
      );
      const recordText = (await page.locator('[data-card-consumption]').last().innerText()).replace(/\s+/g, ' ');
      if (!recordText.includes(VIRTUAL_CONSUME_MERCHANT) || !recordText.includes(formatCNY(VIRTUAL_CONSUME_AMOUNT))) {
        throw new Error(`寮圭獥娑堣垂璁板綍搴斿寘鍚€?{VIRTUAL_CONSUME_MERCHANT}銆嶄笌 ${formatCNY(VIRTUAL_CONSUME_AMOUNT)}锛屽疄闄呫€?{recordText}銆峘);
      }
      const successShot = await captureLive(page, 'lC-consume-success');

      // AUTHORITATIVE cross-check: exactly ONE new CARD DEBIT, ONE CardConsumption, ONE balance drop.
      const after = await readVirtualConsumeSnapshot();
      const newDebits = after.cardDebits.filter((row) => !before.cardDebits.some((prev) => prev.id === row.id));
      const newConsumptions = after.consumptions.filter((row) => !before.consumptions.some((prev) => prev.id === row.id));
      const describeDebits = newDebits.map((row) => `${row.id}:${row.amountMinor}:${row.direction}:${row.channel}:${row.category}/${row.merchant}`).join(' ');
      const describeConsumptions = newConsumptions.map((row) => `${row.id}:${row.cardId}:${row.accountId}:${row.amountMinor}:${row.category}/${row.merchant}`).join(' ');
      if (after.cardDebits.length !== before.cardDebits.length + 1) {
        throw new Error(`搴旀伆鏂板 1 鏉?channel=CARD 鐨?DEBIT 娴佹按锛屽疄闄呮柊澧?${after.cardDebits.length - before.cardDebits.length}锛?{describeDebits}`);
      }
      const debitRow = newDebits[0];
      if (!debitRow) throw new Error('鏂板 CARD 娴佹按涓虹┖');
      if (debitRow.amountMinor !== -amountMinor || debitRow.direction !== 'DEBIT' || debitRow.channel !== 'CARD'
        || debitRow.category !== VIRTUAL_CONSUME_CATEGORY || debitRow.merchant !== VIRTUAL_CONSUME_MERCHANT) {
        throw new Error(`鏂板 CARD 娴佹按搴斾负 -${amountMinor}锛?{VIRTUAL_CONSUME_CATEGORY}/${VIRTUAL_CONSUME_MERCHANT}锛夛紝瀹為檯 ${describeDebits}`);
      }
      if (after.consumptions.length !== before.consumptions.length + 1) {
        throw new Error(`搴旀伆鏂板 1 鏉?CardConsumption锛屽疄闄呮柊澧?${after.consumptions.length - before.consumptions.length}锛?{describeConsumptions}`);
      }
      const consumptionRow = newConsumptions[0];
      if (!consumptionRow) throw new Error('鏂板 CardConsumption 涓虹┖');
      if (consumptionRow.cardId !== VIRTUAL_CARD_ID || consumptionRow.accountId !== DEMO_CHECKING_ID
        || consumptionRow.amountMinor !== amountMinor || consumptionRow.category !== VIRTUAL_CONSUME_CATEGORY
        || consumptionRow.merchant !== VIRTUAL_CONSUME_MERCHANT) {
        throw new Error(`鏂板 CardConsumption 搴斾负 cardId=${VIRTUAL_CARD_ID}銆乤ccountId=${DEMO_CHECKING_ID}銆乤mountMinor=${amountMinor}锛?{VIRTUAL_CONSUME_CATEGORY}/${VIRTUAL_CONSUME_MERCHANT}锛夛紝瀹為檯 ${describeConsumptions}`);
      }
      // SERVER-OWNED TIME 鈥?both rows carry the SAME server business instant (the pinned demo clock
      // DEMO_NOW), never a client value: the dialog body captured above carried no time field at all.
      const serverInstantMs = DEMO_NOW;
      if (debitRow.occurredAt.getTime() !== serverInstantMs) {
        throw new Error(`CARD 娴佹按鐨?occurredAt 搴斾负鏈嶅姟绔笟鍔℃椂閽?${new Date(serverInstantMs).toISOString()}锛屽疄闄?${debitRow.occurredAt.toISOString()}`);
      }
      if (consumptionRow.occurredAt.getTime() !== serverInstantMs) {
        throw new Error(`CardConsumption 鐨?occurredAt 搴斾负鏈嶅姟绔笟鍔℃椂閽?${new Date(serverInstantMs).toISOString()}锛屽疄闄?${consumptionRow.occurredAt.toISOString()}`);
      }
      if (after.balanceMinor !== before.balanceMinor - amountMinor) {
        throw new Error(`娲绘湡浣欓搴斿噺灏戞伆 ${amountMinor}锛?{centsToMoney(before.balanceMinor)} 鈫?${centsToMoney(before.balanceMinor - amountMinor)}锛夛紝瀹為檯 ${centsToMoney(after.balanceMinor)}`);
      }
      // EXACTLY ONCE 鈥?the ledger must carry no second, equal CARD debit for this spend.
      const duplicates = after.cardDebits.filter((row) => row.amountMinor === -amountMinor && row.merchant === VIRTUAL_CONSUME_MERCHANT);
      if (duplicates.length !== 1) {
        throw new Error(`鏈铏氭嫙鍗℃秷璐瑰簲鎭版湁 1 鏉℃祦姘达紙涓嶅緱閲嶅鎵ｆ锛夛紝瀹為檯 ${duplicates.length}锛?{duplicates.map((row) => row.id).join(',')}`);
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
        throw new Error(`${VIRTUAL_CARD_ID}.accountAvailableBalance 搴斾负 ${centsToMoney(availableAfterMinor)}锛屽疄闄?${virtualAfter?.accountAvailableBalance}`);
      }
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
      await waitForElementHydration(page, `[data-card-id="${VIRTUAL_CARD_ID}"]`);
      const tileRows = await readCardTileRows(page, VIRTUAL_CARD_ID);
      const tileShot = await captureLive(page, 'lC-card-tile');
      if (tileRows['褰撳墠鍙敮浠橀噾棰?] !== formatCNY(centsToMoney(expectedPayableAfterMinor))) {
        throw new Error(`${VIRTUAL_CARD_ID} 鍗＄墖銆屽綋鍓嶅彲鏀粯閲戦銆嶅簲涓?${formatCNY(centsToMoney(expectedPayableAfterMinor))}锛屽疄闄?${tileRows['褰撳墠鍙敮浠橀噾棰?]}锛?{JSON.stringify(tileRows)}锛塦);
      }

      return `C1 瀹為檯鍙戦€侊細${sentC1.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?浠嶆伆 1 寮?VIRTUAL 鍗★紙${VIRTUAL_CARD_ID}锛屾湭琚噸澶嶅紑閫氾級锛汣2 鍓嶇娑堣垂寮圭獥锛堢粦瀹?${dialogCardId}锛屾湀闄愰 ${summary['鏈堥檺棰?]}銆佸叧鑱旇处鎴?${summary['鍏宠仈璐︽埛']}銆佹秷璐瑰墠褰撳墠鍙敮浠橀噾棰?${summary['褰撳墠鍙敮浠橀噾棰?]}锛夋彁浜?${formatCNY(VIRTUAL_CONSUME_AMOUNT)}锛?{VIRTUAL_CONSUME_CATEGORY}/${VIRTUAL_CONSUME_MERCHANT}锛夆啋 娑堣垂鎴愬姛锛汼QLite锛氭柊澧?1 鏉?channel=CARD/DEBIT 娴佹按 ${debitRow.amountMinor}锛?{debitRow.id}锛夈€? 鏉?CardConsumption amountMinor=${consumptionRow.amountMinor}锛?{consumptionRow.id}锛夛紱娲绘湡浣欓 ${centsToMoney(before.balanceMinor)} 鈫?${centsToMoney(after.balanceMinor)}锛堟伆鎵ｄ竴娆★級锛?{VIRTUAL_CARD_ID}.payableAmount ${payableBefore} 鈫?${virtualAfter?.payableAmount} = min(鍙敤浣欓 ${virtualAfter?.accountAvailableBalance}銆佸墿浣欐湀闄愰 ${centsToMoney(remainingAfterMinor)})锛涘崱鐗囥€屽綋鍓嶅彲鏀粯閲戦銆?${tileRows['褰撳墠鍙敮浠橀噾棰?]}锛涜璐︽椂闂寸敱鏈嶅姟绔嫢鏈夛細寮圭獥璇锋眰浣撻€愬瓧 ${sentBodyText}锛堥敭=${sentKeys}锛屾棤 occurredAt锛夛紝钀借处 Transaction.occurredAt 涓?CardConsumption.occurredAt 鍧囦负 ${debitRow.occurredAt.toISOString()}锛? DEMO_NOW 鏈嶅姟绔笟鍔℃椂閽?2026-09-25T12:00:00+08:00锛夛紱鎴浘 ${formShot ?? '鏈惤鐩?} / ${successShot ?? '鏈惤鐩?} / ${tileShot ?? '鏈惤鐩?}`;
    },
    { label: 'lC-virtual-card-consumption' },
  );
}

// --- scenarios lD / lE: LIVE virtual-card apply/limit, and 鎸傚け鈫掕ˉ鍔?continuity ---------------------
//
// Both scenarios are built ON TOP of `./live-virtual-card.e2e-helper`: that module owns the shared
// apply/consume primitives, the raw-SQLite cross-checks and the payable maths. This file only
// SEQUENCES them and owns the bounded RED-tool driver (`driveRedTool`, injected as `RedToolDriver`)
// so the `assertNoFabricatedConfirmationPanel` guard stays in force on every prose-only turn.

/** The mask tail (last 4 digits) the natural-language 鎸傚け/琛ュ姙 turns refer to. */
function vcMaskTail(numberMasked: string): string {
  const digits = numberMasked.replace(/\D+/g, '');
  if (digits.length < 4) throw new Error(`鍗＄墖鎺╃爜銆?{numberMasked}銆嶄笉鍚彲鐢ㄧ殑灏惧彿 4 浣峘);
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
 * The SHARED opening act of lD + lE 鈥?ONE function, so the two scenarios cannot drift apart: open a NEW
 * virtual card with the stated 楼100.00 monthly limit through the REAL `/agent` chat (RED
 * `apply_virtual_card` 鈬?confirmation/MFA, completed by `driveRedTool` with the real code), then verify
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
    `RAW Card ${applied.cardId} 搴斾负 ACTIVE 鐨?VIRTUAL 鍗,
  );
  const limitMinor = moneyToCents(VC_MONTHLY_LIMIT);
  if (raw.monthlyLimitMinor !== limitMinor) {
    throw new Error(`RAW Card ${applied.cardId}.monthlyLimitMinor 搴斾负 ${limitMinor}锛?{VC_MONTHLY_LIMIT}锛夛紝瀹為檯 ${raw.monthlyLimitMinor}`);
  }
  if (raw.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
    throw new Error(`RAW Card ${applied.cardId}.linkedAccountId 搴斾负 ${VC_CHECKING_ACCOUNT_ID}锛屽疄闄?${raw.linkedAccountId}`);
  }
  if (raw.creditLimitMinor !== null || raw.availableLimitMinor !== null) {
    throw new Error(`铏氭嫙鍗℃槸鍊熻宸ュ叿锛孯AW 琛屼笉寰楁湁淇＄敤棰濆害锛歝reditLimitMinor=${raw.creditLimitMinor}銆乤vailableLimitMinor=${raw.availableLimitMinor}`);
  }
  for (const card of existing) {
    if (card.numberMasked !== undefined && card.numberMasked === raw.numberMasked) {
      throw new Error(`鏂拌櫄鎷熷崱鍗″彿 ${raw.numberMasked} 涓庢棦鏈夊崱鐗?${card.id}锛?{card.numberMasked}锛夌浉鍚宍);
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
      description: `${cardId}.payableAmount === ${expected}锛坢in(璐︽埛鍙敤浣欓, 鍓╀綑鏈堥檺棰?锛塦,
    },
  );
}

/**
 * SCENARIO lD (LIVE-LLM, REAL BROWSER): open a NEW virtual card with a stated 楼100.00 monthly limit
 * through natural `/agent` turns + real MFA, prove the MONTHLY LIMIT (never the ~23k of checking cash)
 * is the binding constraint, spend 楼30.00 through the REAL card-page dialog, and prove an 楼80.00
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
        throw new Error(`娲绘湡浣欓 ${cashBefore} 涓嶉珮浜庢湀闄愰 ${VC_MONTHLY_LIMIT}锛屻€岄檺棰濈粦瀹氥€嶆柇瑷€灏嗕负绌篳);
      }

      // PROJECTION + RENDERED TILE of the brand-new card: the 楼100 limit binds, not the checking cash.
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
      if (summary['鏈堥檺棰?] !== formatCNY(VC_MONTHLY_LIMIT)) {
        throw new Error(`娑堣垂寮圭獥銆屾湀闄愰銆嶅簲涓?${formatCNY(VC_MONTHLY_LIMIT)}锛屽疄闄?${summary['鏈堥檺棰?]}锛?{JSON.stringify(summary)}锛塦);
      }
      if (summary['褰撳墠鍙敮浠橀噾棰?] !== formatCNY(VC_MONTHLY_LIMIT)) {
        throw new Error(`娑堣垂寮圭獥銆屽綋鍓嶅彲鏀粯閲戦銆嶅簲涓?${formatCNY(VC_MONTHLY_LIMIT)}锛屽疄闄?${summary['褰撳墠鍙敮浠橀噾棰?]}锛?{JSON.stringify(summary)}锛塦);
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
        label: `lD 闄愰鍐呮秷璐?${VC_FIRST_SPEND}`,
      });
      const payableAfterSpendMinor = expectedPayableMinor(limitMinor, firstSpendMinor, afterSpend.balanceMinor);
      const payableAfterSpend = centsToMoney(payableAfterSpendMinor);
      if (payableAfterSpend !== '70.00') {
        throw new Error(`娑堣垂 ${VC_FIRST_SPEND} 鍚?payableAmount 搴斾负 100.00 鈭?30.00 = 70.00锛屽疄闄?${payableAfterSpend}锛堝彲鐢ㄤ綑棰?${centsToMoney(afterSpend.balanceMinor)}锛塦);
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

      // OVER-LIMIT SPEND 鈥?the dialog must surface the localized refusal and NOTHING may move.
      await openConsumeDialog(page, cardId);
      const refusalText = await attemptConsumeExpectingRefusal(page, {
        amount: VC_OVER_LIMIT_SPEND,
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_REFUSED,
      });
      if (!refusalText.includes(VC_LIMIT_EXCEEDED_TEXT)) {
        throw new Error(`瓒呴檺娑堣垂 ${VC_OVER_LIMIT_SPEND} 搴旀彁绀恒€?{VC_LIMIT_EXCEEDED_TEXT}銆嶏紝瀹為檯銆?{refusalText}銆峘);
      }
      const refusalShot = await captureLive(page, 'lD-over-limit-refusal');
      const afterRefusal = await readCardSpendState();
      assertNoSpend(afterSpend, afterRefusal, `lD 瓒呴檺娑堣垂 ${VC_OVER_LIMIT_SPEND}锛?{VC_MERCHANT_REFUSED}锛夎鎷掔粷`);
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

      return `lD 瀹為檯鍙戦€侊細${leg.sent.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?鏂拌櫄鎷熷崱 ${cardId}锛圧AW锛歵ype=VIRTUAL銆乻tatus=ACTIVE銆乵onthlyLimitMinor=${leg.raw.monthlyLimitMinor}锛?{VC_MONTHLY_LIMIT}锛夈€乴inkedAccountId=${leg.raw.linkedAccountId}銆乧reditLimitMinor=${leg.raw.creditLimitMinor}銆乤vailableLimitMinor=${leg.raw.availableLimitMinor}銆佸崱鍙?${leg.raw.numberMasked} 涓庢棦鏈夊崱鐗囧潎涓嶅悓锛夛紱payableAmount=${VC_MONTHLY_LIMIT}锛堟湀闄愰缁戝畾锛岃处鎴峰彲鐢ㄤ綑棰?${cashBefore}锛夛紱/cards 娓叉煋 ${JSON.stringify(applyTileRows)}锛堟棤銆屼俊鐢ㄩ搴︺€?銆屽彲鐢ㄩ搴︺€嶏級锛涙秷璐?${VC_FIRST_SPEND}锛?{VC_SPEND_CATEGORY}/${VC_MERCHANT_APPLY}锛夆啋 ${spend.notice}锛氭柊澧?CARD/DEBIT 娴佹按 ${delta.debit.amountMinor}锛?{delta.debit.id}锛? 1 鏉?CardConsumption amountMinor=${delta.consumption.amountMinor}锛?{delta.consumption.id}锛夛紝娲绘湡浣欓 ${centsToMoney(delta.balanceBeforeMinor)} 鈫?${centsToMoney(delta.balanceAfterMinor)}锛堟伆鎵ｄ竴娆★級锛沺ayableAmount 鈫?${payableAfterSpend}锛屽埛鏂板悗鍗＄墖銆屽綋鍓嶅彲鏀粯閲戦銆?${spendTileRows['褰撳墠鍙敮浠橀噾棰?]}锛涜秴闄?${VC_OVER_LIMIT_SPEND}锛?{VC_MERCHANT_REFUSED}锛夎鎷掔粷锛氥€?{refusalText}銆嶏紝娴佹按/浣欓/CardConsumption 闆跺彉鍖栵紝payableAmount 浠?${payableAfterRefusal}锛涙埅鍥?${applyShot ?? '鏈惤鐩?} / ${spendShot ?? '鏈惤鐩?} / ${refusalShot ?? '鏈惤鐩?}锛涜瘉鎹?JSON ${evidenceFile ?? '鏈惤鐩?}`;
    },
    { label: 'lD-virtual-card-apply-and-limit' },
  );
}

/**
 * SCENARIO lE (LIVE-LLM, REAL BROWSER): open a virtual card (the SAME shared apply leg as lD), spend
 * 楼30.00, then 鎸傚け (lose) and 琛ュ姙 (replace) it purely through natural `/agent` turns + real MFA, and
 * prove FAMILY-CONTINUOUS allowance: the replacement inherits the monthly limit's already-spent part
 * (`payableAmount` = 70.00, NEVER a reset to 100.00), the linking account and 鈥?until it is exhausted 鈥?
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

      // PRE-LOST SPEND 鈥?楼30 of the 楼100 monthly allowance through the REAL card-page dialog.
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
        label: `lE 鎸傚け鍓嶆秷璐?${VC_FIRST_SPEND}`,
      });

      // 鎸傚け 鈥?natural turns + real MFA. The source becomes terminal LOST and NO funds move.
      await gotoAgent(page, ctx.baseUrl);
      const sentLost = await driveRedTool(page, ctx.baseUrl, vcReportLostTurns(leg.maskTail));
      const lostRaw = await awaitRawCard(sourceId, (row) => row.status === 'LOST', `RAW Card ${sourceId} 鎸傚け鍚?status='LOST'`);
      const afterLost = await readCardSpendState();
      assertNoSpend(afterSpend, afterLost, `lE 鎸傚け ${sourceId}`);
      if (lostRaw.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
        throw new Error(`鎸傚け鍚?RAW Card ${sourceId}.linkedAccountId 搴斾负 ${VC_CHECKING_ACCOUNT_ID}锛屽疄闄?${lostRaw.linkedAccountId}`);
      }

      // 琛ュ姙 鈥?natural turns + real MFA. Exactly ONE new ACTIVE VIRTUAL card, bound to the SAME account.
      const idsBeforeReplace = new Set((await fetchLiveCards(ctx.baseUrl)).map((card) => card.id));
      const sentReplace = await driveRedTool(page, ctx.baseUrl, vcReplaceTurns(leg.maskTail));
      const sourceAfterReplace = await awaitRawCard(
        sourceId,
        (row) => typeof row.replacedByCardId === 'string' && row.replacedByCardId !== '',
        `RAW Card ${sourceId} 琛ュ姙鍚?replacedByCardId 鎸囧悜鏂板崱`,
      );
      const replacementId = sourceAfterReplace.replacedByCardId as string;
      const replacement = await awaitRawCard(
        replacementId,
        (row) => row.type === 'VIRTUAL' && row.status === 'ACTIVE',
        `RAW Card ${replacementId} 搴斾负 ACTIVE 鐨?VIRTUAL 鍗,
      );
      // THE INHERITANCE FIX: the replacement is bound to the SAME checking account as its source.
      if (replacement.linkedAccountId !== sourceAfterReplace.linkedAccountId) {
        throw new Error(`琛ュ姙鍗?${replacementId}.linkedAccountId锛?{replacement.linkedAccountId}锛夊簲缁ф壙鍘熷崱 ${sourceId} 鐨?${sourceAfterReplace.linkedAccountId}`);
      }
      if (replacement.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
        throw new Error(`琛ュ姙鍗?${replacementId}.linkedAccountId 搴斾负 ${VC_CHECKING_ACCOUNT_ID}锛屽疄闄?${replacement.linkedAccountId}`);
      }
      if (replacement.numberMasked === sourceAfterReplace.numberMasked) {
        throw new Error(`琛ュ姙鍗″崱鍙峰簲涓嶅悓浜庡師鍗★紝瀹為檯鍧囦负 ${replacement.numberMasked}`);
      }
      if (replacement.monthlyLimitMinor !== limitMinor) {
        throw new Error(`琛ュ姙鍗?${replacementId}.monthlyLimitMinor 搴斾负 ${limitMinor}锛?{VC_MONTHLY_LIMIT}锛夛紝瀹為檯 ${replacement.monthlyLimitMinor}`);
      }
      if (replacement.creditLimitMinor !== null || replacement.availableLimitMinor !== null) {
        throw new Error(`琛ュ姙铏氭嫙鍗℃槸鍊熻宸ュ叿锛孯AW 琛屼笉寰楁湁淇＄敤棰濆害锛歝reditLimitMinor=${replacement.creditLimitMinor}銆乤vailableLimitMinor=${replacement.availableLimitMinor}`);
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
          description: `琛ュ姙鍚?GET /api/cards 搴旀伆鏂板 1 寮?ACTIVE VIRTUAL 鍗★紙${replacementId}锛塦,
        },
      );

      // FAMILY-CONTINUOUS ALLOWANCE 鈥?100.00 鈭?30.00 = 70.00 left for the card family, never 100.00.
      const familySpentMinor = afterLost.consumptions
        .filter((row) => row.cardId === sourceId || row.cardId === replacementId)
        .reduce((sum, row) => sum + row.amountMinor, 0n);
      const familyPayable = centsToMoney(expectedPayableMinor(limitMinor, familySpentMinor, afterLost.balanceMinor));
      if (familyPayable !== '70.00') {
        throw new Error(`琛ュ姙鍗＄殑瀹跺涵鍓╀綑鏈堥檺棰濆簲涓?${VC_MONTHLY_LIMIT} 鈭?${VC_FIRST_SPEND} = 70.00锛屽疄闄?${familyPayable}锛堝搴凡鐢?${familySpentMinor}銆佽处鎴峰彲鐢ㄤ綑棰?${centsToMoney(afterLost.balanceMinor)}锛塦);
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
        throw new Error(`琛ュ姙鍗?${replacementId}.payableAmount 涓嶅緱閲嶇疆涓烘弧棰?${VC_MONTHLY_LIMIT}锛堟湀闄愰蹇呴』鍦ㄥ崱瀹舵棌鍐呰繛缁級`);
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
        label: `lE 琛ュ姙鍗℃秷璐?${VC_SECOND_SPEND}`,
      });
      const exhaustedPayable = centsToMoney(
        expectedPayableMinor(limitMinor, familySpentMinor + moneyToCents(VC_SECOND_SPEND), afterSecondSpend.balanceMinor),
      );
      if (exhaustedPayable !== '0.00') {
        throw new Error(`瀹跺涵鏈堥檺棰濈敤灏藉悗 payableAmount 搴斾负 0.00锛屽疄闄?${exhaustedPayable}锛堣处鎴峰彲鐢ㄤ綑棰?${centsToMoney(afterSecondSpend.balanceMinor)}锛塦);
      }
      const cardsExhausted = await awaitPayable(ctx.baseUrl, replacementId, exhaustedPayable);
      assertVirtualCardView(cardById(cardsExhausted, replacementId), {
        cardId: replacementId,
        monthlyLimit: VC_MONTHLY_LIMIT,
        accountAvailableBalance: centsToMoney(afterSecondSpend.balanceMinor),
        payableAmount: exhaustedPayable,
      });
      // A 楼1.00 spend against the exhausted family allowance must be refused with NOTHING moved.
      const refusalText = await attemptConsumeExpectingRefusal(page, {
        amount: VC_TINY_SPEND,
        category: VC_SPEND_CATEGORY,
        merchant: VC_MERCHANT_REFUSED,
      });
      if (!refusalText.includes(VC_LIMIT_EXCEEDED_TEXT)) {
        throw new Error(`棰濆害鐢ㄥ敖鍚?${VC_TINY_SPEND} 娑堣垂搴旀彁绀恒€?{VC_LIMIT_EXCEEDED_TEXT}銆嶏紝瀹為檯銆?{refusalText}銆峘);
      }
      const refusalShot = await captureLive(page, 'lE-exhausted-refusal');
      const afterRefusal = await readCardSpendState();
      assertNoSpend(afterSecondSpend, afterRefusal, `lE 棰濆害鐢ㄥ敖鍚庣殑 ${VC_TINY_SPEND} 娑堣垂锛?{VC_MERCHANT_REFUSED}锛夎鎷掔粷`);
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

      return `lE 瀹為檯鍙戦€侊紙寮€鍗★級锛?{leg.sent.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?鏂拌櫄鎷熷崱 ${sourceId}锛坢onthlyLimitMinor=${leg.raw.monthlyLimitMinor}銆乴inkedAccountId=${leg.raw.linkedAccountId}锛夛紱鎸傚け鍓嶆秷璐?${VC_FIRST_SPEND}锛?{VC_SPEND_CATEGORY}/${VC_MERCHANT_PRE_LOST}锛? 鏂板 CARD/DEBIT 娴佹按 ${firstDelta.debit.amountMinor}锛?{firstDelta.debit.id}锛? 1 鏉?CardConsumption锛?{firstDelta.consumption.id}锛夛紝娲绘湡浣欓 ${centsToMoney(firstDelta.balanceBeforeMinor)} 鈫?${centsToMoney(firstDelta.balanceAfterMinor)}锛涙寕澶卞疄闄呭彂閫侊細${sentLost.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?RAW status=${lostRaw.status}銆佽祫閲戦浂鍙樺寲锛涜ˉ鍔炲疄闄呭彂閫侊細${sentReplace.map((t) => `銆?{t}銆峘).join(' 鈫?')} 鈫?MFA 123456 鈫?${sourceId}.replacedByCardId=${replacementId}锛堟伆鏂板 1 寮?VIRTUAL/ACTIVE 鍗★級锛涜ˉ鍔炲崱 RAW锛歭inkedAccountId=${replacement.linkedAccountId}锛? 鍘熷崱 ${sourceAfterReplace.linkedAccountId}锛岀户鎵夸慨澶嶇敓鏁堬級銆乵onthlyLimitMinor=${replacement.monthlyLimitMinor}銆佸崱鍙?${replacement.numberMasked} 鈮?鍘熷崱 ${sourceAfterReplace.numberMasked}銆佹棤淇＄敤棰濆害锛涘搴湀闄愰杩炵画锛氬凡鐢?${familySpentMinor} 鈫?payableAmount=${replacementView?.payableAmount}锛?70.00锛屼笉鏄?100.00锛夛紝鍗＄墖娓叉煋 ${JSON.stringify(replaceTileRows)}锛涜ˉ鍔炲崱娑堣垂 ${VC_SECOND_SPEND}锛?{VC_SPEND_CATEGORY}/${VC_MERCHANT_REPLACE}锛? 鏂板 CARD/DEBIT 娴佹按 ${secondDelta.debit.amountMinor}锛?{secondDelta.debit.id}锛? 1 鏉?CardConsumption锛?{secondDelta.consumption.id}锛夛紝娲绘湡浣欓 ${centsToMoney(secondDelta.balanceBeforeMinor)} 鈫?${centsToMoney(secondDelta.balanceAfterMinor)}锛堟伆鎵ｄ竴娆★級鈫?payableAmount=${exhaustedPayable}锛涢搴︾敤灏藉悗 ${VC_TINY_SPEND}锛?{VC_MERCHANT_REFUSED}锛夎鎷掔粷锛氥€?{refusalText}銆嶏紝娴佹按/浣欓/CardConsumption 闆跺彉鍖栵紝payableAmount 浠?${payableAfterRefusal}锛涙埅鍥?${replaceShot ?? '鏈惤鐩?} / ${refusalShot ?? '鏈惤鐩?}锛涜瘉鎹?JSON ${evidenceFile ?? '鏈惤鐩?}`;
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
  // must always stop the CURRENT one 鈥?stopping only the initially booted `devServer` leaked scenario
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
   * exit while Chrome was still shutting down). Never throws 鈥?a close failure must not flip a PASS run.
   */
  const teardown = async (): Promise<void> => {
    stopActiveServer();
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        console.warn(`路 鍏抽棴娴忚鍣ㄥけ璐ワ紙涓嶅奖鍝嶉獙鏀剁粨璁猴級锛?{errText(error)}`);
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
    console.error(`鏈崟鑾峰紓甯革細${errText(error)}`);
    cleanup();
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    console.error(`鏈鐞嗙殑 rejection锛?{errText(error)}`);
    cleanup();
    process.exit(1);
  });

  console.log('== AI Banking Agent 鐪熷疄娴忚鍣?+ 鐪熷疄 DeepSeek 鍦ㄧ嚎楠屾敹 (tests/e2e/live) ==');
  const forcedModel = process.env['LIVE_FORCE_MODEL']?.trim();
  console.log(
    forcedModel
      ? 'Live run uses an explicitly requested model override.'
      : 'Live run uses the configured model.',
  );

  const executablePath = resolveBrowserExecutable();
  if (executablePath === undefined) {
    for (const scenario of [...chosen, { name: '7-live-committed-continuation-failed' }]) {
      reporter.skip(scenario.name, '鏈壘鍒扮湡瀹炴祻瑙堝櫒锛圕hrome/Edge锛夛紱鍙缃?E2E_BROWSER_PATH 瑕嗙洊');
    }
    console.log(`== 姹囨€伙細PASS ${reporter.passes} 锝?FAIL ${reporter.failures} 锝?SKIP ${reporter.skips} ==`);
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
    console.log(`路 闅旂 LIVE 鏁版嵁搴擄細${LIVE_DB_URL}锛坧risma/dev.db 涓?prisma/test.db 涓嶅彈褰卞搷锛塦);
    console.log('路 閲嶇疆 LIVE 鏁版嵁搴?鈫掞紙缂?Prisma Client 鏃跺厛 prisma generate锛夆啋 db push 闃舵 鈫?probe 鈫?tsx prisma/seed.ts');
    resetLiveDatabase();

    console.log(
      'Live provider configuration is applied; configuration values are not displayed.',
    );
    devServer = await bootDevServer({ timeoutMs: NAV_TIMEOUT_MS, attempts: 2 });
    const baseUrl = devServer.baseUrl;
    console.log(`路 next dev (pid=${devServer.pid}) 鈫?${baseUrl}锛?api/health 涓?/agent 鍧囧凡灏辩华锛塦);

    // LIVE-mode confirmation: read the RESOLVED config the app actually serves (mock vs live) and,
    // when running scenario 1, observe a narration the scripted mock cannot produce.
    const health = (await (await fetch(`${baseUrl}/api/health`)).json()) as { ok?: boolean; data?: Record<string, unknown> };
    console.log(`路 /api/health=${JSON.stringify(health).slice(0, 200)}`);

    console.log(`路 鐪熷疄娴忚鍣細${executablePath}`);
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

    // Post-scenario diagnostics + the TASK-A evidence dump run HERE 鈥?INSIDE the `try`, BEFORE the
    // `finally` tears the dev server down, so the isolated WAL database is still served. They are
    // wrapped in their own try/catch so a diagnostic/evidence read can NEVER reject `main()` (which
    // `void main().catch(...)` would turn into exit 1 AFTER the PASS lines printed). A read failure
    // only warns; it never changes `process.exitCode`.
    try {
      // Scenario 6's global invariant: no provider "tool message must answer tool_calls" 400 anywhere.
      const violation = findToolOrderViolation();
      if (violation) {
        console.error(`路 鍏ㄧ▼鎹曡幏鍒?tool/tool_calls 400锛?{violation.method} ${violation.url} 鈥?${violation.body.slice(0, 400)}`);
      }
      console.log(`路 绱缃戠粶 4xx/5xx锛?{netLog.issues.length}锛宑onsole error锛?{netLog.consoleErrors.length}锛宲ageerror锛?{netLog.pageErrors.length}`);
      for (const issue of netLog.issues.slice(0, 20)) {
        console.log(`路 [4xx/5xx] ${issue.method} ${issue.status} ${issue.url} 鈥?${issue.body.slice(0, 200).replace(/\s+/g, ' ')}`);
      }

      // TASK-A EVIDENCE: the ACTUAL arg shape the LIVE model produced, recovered from the SAME DB the
      // run used (`AgentSession.stateJson` 鈫?`agentState.messages`). Printed verbatim for every run.
      console.log('路 銆愯瘉鎹€戞寔涔呭寲鐨?transfer_money / search_contact 宸ュ叿璋冪敤锛圓gentSession.stateJson锛屽弬鏁板璞￠€愬瓧锛夛細');
      console.log(await persistedRecipientCalls());
      console.log(`路 銆愯瘉鎹€戠瀛愬簱鏀舵浜?${RECIPIENT_NAME} 鎵嬫満鍙?${await readSeedRecipientPhone()}`);
    } catch (error) {
      console.warn(`路 鍦烘櫙鍚庤瘖鏂?璇佹嵁鏀堕泦澶辫触锛堜笉褰卞搷楠屾敹缁撹锛岄€€鍑虹爜涓嶅彉锛夛細${errText(error)}`);
    }
  } catch (error) {
    console.error(`路 鍩虹璁炬柦澶辫触锛?{errText(error)}`);
    reporter.fail('infrastructure', errText(error));
  } finally {
    await teardown();
  }

  // The summary and the exit code are ALWAYS reached on the normal path (teardown never throws).
  console.log(`== 姹囨€伙細PASS ${reporter.passes} 锝?FAIL ${reporter.failures} 锝?SKIP ${reporter.skips} ==`);
  process.exitCode = reporter.failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`鍏ュ彛鑴氭湰澶辫触锛?{errText(error)}`);
  process.exitCode = 1;
});

// Referenced so `captureScreenshot` stays part of the public harness surface used by `withPage`.
void captureScreenshot;
