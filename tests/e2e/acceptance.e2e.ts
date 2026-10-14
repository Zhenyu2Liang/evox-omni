/**
 * `tests/e2e/acceptance.e2e.ts` — the SINGLE real-browser end-to-end acceptance entry point.
 *
 * It provisions + seeds an ISOLATED E2E SQLite DB (`prisma/e2e.db`, never the shared `prisma/dev.db`),
 * boots the REAL Next.js dev server on a free port against that DB (project-local Next CLI, readiness
 * gated on BOTH `/api/health` AND `/agent`, one retry on a fresh port), launches the machine's real
 * headless Chrome (via `playwright-core`, no browser download), drives the REAL `/agent` UI and
 * asserts on RENDERED DOM. Only the model is scripted (`LLM_MODE=mock`).
 *
 * Run:  npx tsx tests/e2e/acceptance.e2e.ts
 *
 * Output contract: EXACTLY one line per journey — `PASS|FAIL|SKIP <journey> — <evidence|reason>`.
 * The process exits non-zero iff ANY journey FAILED (a SKIP does not fail the run). The dev server's
 * whole process tree and the browser are always torn down (success, failure and unexpected errors).
 *
 * Every money-moving journey keeps its PRIMARY evidence on RENDERED DOM (assistant text / plan badges)
 * and adds a SECONDARY DB/ledger cross-check via the app's real read routes (`/api/dashboard`,
 * `/api/bills`, `/api/cards`, `/api/actions`).
 *
 * NOTE: the filename deliberately ends in `.e2e.ts` (NOT `.test.`/`.spec.`), so it does NOT match
 * vitest's include glob `tests/**\/*.{test,spec}.ts` and never runs under `npm run test`.
 */
import type { Browser, Page } from 'playwright-core';
import { moneyToCents, subtractMoney } from '../../lib/money';
import { journeyManualReview } from './manual-review.e2e-helper';
import { journeyAssistantWorkspace } from './ui-shell.e2e-helper';
import { journeyI18n } from './i18n.e2e-helper';
import { journeyHydration } from './hydration.e2e-helper';
import { journeySharedDemo } from './shared-demo.e2e-helper';
import { journeyToolLifecycle } from './tool-lifecycle.e2e-helper';
import { journeyDeveloperMode } from './developer-mode.e2e-helper';
import { journeyMultiCardFreeze } from './card-freeze.e2e-helper';
import { journeyBankingPages } from './banking-pages.e2e-helper';
import { journeyCardManagement } from './card-management.e2e-helper';
import { journeyNaturalConversation, journeyDialogueRegressions } from './conversation.e2e-helper';
import { journeyOperationHistory } from './activity.e2e-helper';
import { journeyChatHistory } from './chat-history.e2e-helper';
import { createTranslator } from '../../lib/i18n/shared';
import {
  NAV_TIMEOUT_MS,
  SELECTORS,
  assistantTexts,
  bootDevServer,
  cardCategoryLimit,
  clickConfirm,
  clickPlanControl,
  createReporter,
  diffLedger,
  errText,
  fetchCards,
  fetchDashboardSummary,
  fetchLedger,
  fetchPendingActions,
  getJson,
  gotoAgent,
  hasAssistantText,
  launchBrowser,
  mfaCardPresent,
  nodeStatus,
  planControlPresent,
  readDemoSessionId,
  resetDemoDatabase,
  reseedDemoDatabase,
  resolveBrowserExecutable,
  runJourney,
  setActiveBrowser,
  submitChat,
  submitMfa,
  useIsolatedDatabase,
  waitFor,
  waitForAssistantText,
  waitForComposerHydration,
  waitForConfirmCard,
  waitForElementHydration,
  waitForMfaCard,
  waitForNodeStatus,
  waitForPlanStatus,
  waitForStatusText,
  queryExecutionAudit,
  queryPendingActionStatus,
  querySecurityEvents,
  seedStandaloneWedge,
  WEDGE_ACTION_ID,
  WEDGE_AMOUNT,
  WEDGE_AUDIT_DEDUPE_KEY,
  withPage,
  type DevServer,
  type LedgerView,
} from './helpers';

/** Exact mock-mode trigger phrases, verified against `agent/providers/mock-responder.ts`. */
const MSG = {
  /** GREEN read (`get_balance`) → mints the COOKIE-ONLY session without moving any money. */
  balance: '查一下我的余额',
  /** YELLOW transfer (≤ ¥1000) → confirmation card. */
  transferYellow: '给张伟转200元',
  /**
   * YELLOW, NON-transfer action → confirmation card. Its tier is STATIC (`set_card_limit` = YELLOW,
   * `security/permission-engine.ts`), so — unlike a transfer — it stays YELLOW regardless of the
   * demo day's accumulated transfer total, keeping journey e's confirmation-card recovery
   * deterministic across runs and journey ordering.
   */
  cardLimit: '\u628a\u4fe1\u7528\u5361\u5a31\u4e50\u9650\u989d\u8c03\u6574\u52301500\u5143',
  /** RED transfer (> ¥1000) → MFA card (mock code `123456`). */
  transferRed: '给张伟转2000元',
  /**
   * GATED conditional plan: `analyze`(GREEN `analyze_spending`) → `check`(condition) →
   * `setlimit`(GATED `set_card_limit`) — the LAST node PARKS at 等待确认 (a NON-terminal state), so
   * the PlanCard renders a REAL `暂停`/`取消` control. Used by journeys c (pause/resume) and d (cancel).
   */
  gatedPlan: '如果我这个月消费超过2000，就把信用卡娱乐限额调整到1500元',
  /** RED `subscribe_investment` (稳健理财A, ≥ ¥1,000) → MFA card; writes a 投资-category DEBIT ledger row. */
  subscribe: '申购稳健理财A 1000元',
  /** RED `redeem_investment` (one-shot holding) → MFA card; writes a 投资-category CREDIT ledger row. */
  redeem: '赎回稳健理财A',
  /** GREEN `detect_anomaly` → an `anomaly` chat card (the seeded Apple Store ¥6,999 anomaly). */
  anomaly: '帮我看有没有异常消费',
} as const;

/** Assistant narration lead emitted on a completed transfer (`NARRATION_LEAD.transfer_money`). */
const TRANSFER_OK_NARRATION = '转账处理结果：';

/** Demo seed constants the money assertions are anchored to. */
const DEMO_CREDIT_CARD_ID = 'card_credit';
const ENTERTAINMENT_CATEGORY = '娱乐';
const RECIPIENT_NAME = '张伟';
const TRANSFER_YELLOW_AMOUNT = '200.00';
const TRANSFER_RED_AMOUNT = '2000.00';

/** The gated plan's node names (its timeline rows), matched by distinctive substring. */
const PLAN_NODE_ANALYZE = '查询消费情况'; // analyze (GREEN analyze_spending) — completes immediately.
const PLAN_NODE_SETLIMIT = '调整'; // setlimit (GATED set_card_limit) — parks at 待确认.

/**
 * Wait for the chat page to be interactive again after a client-side `page.reload()`: first the
 * (server-rendered) composer becomes visible, then React has HYDRATED it. Interacting before
 * hydration drops the click and resets a `fill()` — see `waitForComposerHydration` in `helpers.ts`.
 */
async function waitForComposer(page: Page): Promise<void> {
  await page.locator(SELECTORS.composer).first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
  await waitForComposerHydration(page);
}

/** The demo user's money-relevant read state, from the app's real read routes. */
interface MoneySnapshot {
  /** Primary CHECKING balance (CNY). */
  balance: string;
  /** The transaction ledger (`GET /api/bills`). */
  ledger: LedgerView;
  /** The credit card's 娱乐 category limit (CNY), or `undefined`. */
  entLimit: string | undefined;
}

/** Snapshot the demo user's balance + ledger + 娱乐 card limit via the real read routes. */
async function snapshotMoneyState(baseUrl: string): Promise<MoneySnapshot> {
  const [dashboard, ledger, cards] = await Promise.all([
    fetchDashboardSummary(baseUrl),
    fetchLedger(baseUrl),
    fetchCards(baseUrl),
  ]);
  return {
    balance: dashboard.checkingBalance,
    ledger,
    entLimit: cardCategoryLimit(cards, DEMO_CREDIT_CARD_ID, ENTERTAINMENT_CATEGORY),
  };
}

// --- journeys (each asserts on RENDERED DOM; money journeys add a DB/ledger cross-check) ---------

/**
 * (a) YELLOW transfer: confirmation card → 确认 → the completed-transfer narration appears.
 * SECONDARY: the money actually moved — the CHECKING balance drops by the amount AND a matching
 * DEBIT ledger row to 张伟 appears (`GET /api/dashboard` + `GET /api/bills`).
 */
async function journeyTransferConfirm(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      const before = await snapshotMoneyState(baseUrl);
      await submitChat(page, MSG.transferYellow);
      await waitForConfirmCard(page);
      await clickConfirm(page);
      await waitForAssistantText(page, TRANSFER_OK_NARRATION);

      const settled = await waitFor(
        async () => {
          const [dashboard, ledger] = await Promise.all([fetchDashboardSummary(baseUrl), fetchLedger(baseUrl)]);
          if (dashboard.checkingBalance !== subtractMoney(before.balance, TRANSFER_YELLOW_AMOUNT)) return false;
          const match = diffLedger(before.ledger.transactions, ledger.transactions).added.find(
            (tx) => moneyToCents(tx.amount) === -moneyToCents(TRANSFER_YELLOW_AMOUNT) && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
          );
          return match ? { balance: dashboard.checkingBalance, merchant: match.merchant } : false;
        },
        {
          description: `Balance ${subtractMoney(before.balance, TRANSFER_YELLOW_AMOUNT)} and one debit for ${RECIPIENT_NAME}.`,
          timeoutMs: 30_000,
        },
      );
      return `「${MSG.transferYellow}」→ 确认卡(确认/取消) → 确认 → 助手「${TRANSFER_OK_NARRATION}」；余额 ${before.balance} → ${settled.balance}（−${TRANSFER_YELLOW_AMOUNT}），账本新增 -${TRANSFER_YELLOW_AMOUNT} DEBIT（${settled.merchant}）`;
    },
    { label: 'a-transfer-confirm' },
  );
}

/**
 * (b) RED transfer MFA, both legs — each in a FRESH context:
 *   leg 1: correct code `123456` → transfer executes (success narration) + balance −2000 + new DEBIT row.
 *   leg 2: wrong code `000000` → `验证失败，已尝试 1 次` shows, MFA card STAYS, NO success narration,
 *          and the balance + ledger are UNCHANGED (no transfer occurred).
 */
async function journeyTransferMfa(browser: Browser, baseUrl: string): Promise<string> {
  const ok = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      const before = await snapshotMoneyState(baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await submitMfa(page, '123456');
      await waitForAssistantText(page, TRANSFER_OK_NARRATION);

      const settled = await waitFor(
        async () => {
          const [dashboard, ledger] = await Promise.all([fetchDashboardSummary(baseUrl), fetchLedger(baseUrl)]);
          if (dashboard.checkingBalance !== subtractMoney(before.balance, TRANSFER_RED_AMOUNT)) return false;
          const match = diffLedger(before.ledger.transactions, ledger.transactions).added.find(
            (tx) => moneyToCents(tx.amount) === -moneyToCents(TRANSFER_RED_AMOUNT) && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
          );
          return match ? { balance: dashboard.checkingBalance } : false;
        },
        {
          description: `Balance ${subtractMoney(before.balance, TRANSFER_RED_AMOUNT)} and one debit for ${RECIPIENT_NAME}.`,
          timeoutMs: 30_000,
        },
      );
      return `正确验证码 123456 → 助手「${TRANSFER_OK_NARRATION}」；余额 ${before.balance} → ${settled.balance}（−${TRANSFER_RED_AMOUNT}），账本新增 -${TRANSFER_RED_AMOUNT} DEBIT（${RECIPIENT_NAME}）`;
    },
    { label: 'b1-transfer-mfa-ok' },
  );

  const wrong = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      const before = await snapshotMoneyState(baseUrl);
      const previousReplies = (await assistantTexts(page)).length;
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await submitMfa(page, '000000');
      await waitForStatusText(page, '验证失败，已尝试1次');
      if (!(await mfaCardPresent(page))) {
        throw new Error('错误验证码后 MFA 卡片消失（应保留以允许重试）');
      }
      if ((await assistantTexts(page)).slice(previousReplies).some(text => text.includes(TRANSFER_OK_NARRATION))) {
        throw new Error('错误验证码后出现转账成功叙述 —— 转账不应发生');
      }
      // SECONDARY: nothing moved — balance + ledger are IDENTICAL to the pre-attempt snapshot.
      const after = await snapshotMoneyState(baseUrl);
      if (after.balance !== before.balance) {
        throw new Error(`错误验证码后余额变化：${before.balance} → ${after.balance}（转账不应发生）`);
      }
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) {
        throw new Error(`错误验证码后账本新增交易：${added.map((tx) => tx.id).join('、')}（转账不应发生）`);
      }
      return '错误验证码 000000 → role=status「验证失败，已尝试 1 次」，MFA 卡片保留，无成功叙述；余额/账本均未变';
    },
    { label: 'b2-transfer-mfa-wrong' },
  );

  return `正确码：${ok} ｜ 错误码：${wrong}`;
}

/**
 * (c) GENUINE pause → resume on a GATED plan.
 *
 * The gated plan PARKS at 等待确认 — a NON-terminal state — so the PlanCard renders a REAL `暂停`
 * control (`controlActionsFor('waiting_confirmation') = ['pause','cancel']`). This journey actually
 * CLICKS `暂停` (plan badge → 已暂停, `继续` control appears) and then `继续`, asserting NODE-LEVEL
 * status badges from the per-node timeline to prove: the parked node does NOT advance while paused,
 * no later node runs while paused, and completed nodes are NOT re-run after resume.
 *
 * NOTE ON THE DAG: the gated mock plan's `setlimit` node is its LAST node, so after resume the only
 * remaining node `setlimit` re-executes and RE-PARKS (awaiting confirmation again) — that re-entry to
 * 等待确认 is the observable proof that the remaining node ran. A directly observable "downstream node
 * ran after resume" would require a GREEN node AFTER `setlimit` in
 * `agent/providers/mock-responder.ts#handlePlan` (a sibling outside `tests/e2e/`) — reported upward.
 */
async function journeyPlanPauseResume(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.gatedPlan);

      // The gated plan parks at 等待确认; the GREEN analyze node already succeeded, setlimit is parked.
      await waitForPlanStatus(page, '等待确认');
      await waitForNodeStatus(page, PLAN_NODE_ANALYZE, '成功');
      await waitForNodeStatus(page, PLAN_NODE_SETLIMIT, '待确认');

      if (!(await planControlPresent(page, '暂停'))) {
        throw new Error('门控计划停在「等待确认」，但未渲染「暂停」控件（状态与控件不一致）');
      }

      // --- genuine PAUSE ----------------------------------------------------------------------
      const beforePause = await snapshotMoneyState(baseUrl);
      await clickPlanControl(page, '暂停');
      await waitForPlanStatus(page, '已暂停');
      if (!(await planControlPresent(page, '继续'))) throw new Error('已暂停，但未渲染「继续」控件');
      if (await planControlPresent(page, '暂停')) throw new Error('已暂停，但仍渲染「暂停」控件');

      // While paused: the parked node did NOT advance and no later node ran; nothing was executed.
      const parkedDuringPause = await nodeStatus(page, PLAN_NODE_SETLIMIT);
      if (parkedDuringPause !== '待确认') {
        throw new Error(`暂停期间节点「${PLAN_NODE_SETLIMIT}」应保持「待确认」，实际「${parkedDuringPause}」`);
      }
      const duringPause = await snapshotMoneyState(baseUrl);
      if (duringPause.entLimit !== beforePause.entLimit) {
        throw new Error(`暂停期间「${ENTERTAINMENT_CATEGORY}」限额不应变化：${beforePause.entLimit} → ${duringPause.entLimit}`);
      }

      // --- genuine RESUME ---------------------------------------------------------------------
      await clickPlanControl(page, '继续');
      const resumed = await waitForPlanStatus(page, ['等待确认', '已完成'], 90_000);

      // Completed nodes are NOT re-run: the analyze node must still read 成功 (never reset).
      const analyzeAfter = await nodeStatus(page, PLAN_NODE_ANALYZE);
      if (analyzeAfter !== '成功') {
        throw new Error(`继续后已完成节点「${PLAN_NODE_ANALYZE}」被重置为「${analyzeAfter}」（已完成节点不应重跑）`);
      }
      // The remaining node ran again and stopped at its gate (awaiting confirmation).
      const setlimitAfter = await nodeStatus(page, PLAN_NODE_SETLIMIT);
      if (resumed === '等待确认' && setlimitAfter !== '待确认') {
        throw new Error(`继续后剩余节点「${PLAN_NODE_SETLIMIT}」应重新等待确认，实际「${setlimitAfter}」`);
      }

      return `门控计划 → 等待确认 → 点击「暂停」→ 已暂停（节点「${PLAN_NODE_SETLIMIT}」保持「待确认」、${ENTERTAINMENT_CATEGORY}限额 ${beforePause.entLimit} 未变、无后续节点执行）→ 点击「继续」→ ${resumed}（已完成节点「${PLAN_NODE_ANALYZE}」仍「成功」、未重跑；剩余节点重新停在「${setlimitAfter}」）`;
    },
    { label: 'c-plan-pause-resume' },
  );
}

/**
 * (d) GATED plan → 等待确认 → click the plan card's 取消 → 已取消, THEN attempt the OLD confirmation
 * entry: if the parked ConfirmationCard is still rendered, click its `确认` and assert the server
 * REJECTS it; if it is gone, prove that via RENDERED DOM + the `GET /api/actions` read model. Either
 * way the balance / ledger / 娱乐 limit must be UNCHANGED (a plan cancel revokes the parked action).
 */
async function journeyPlanCancel(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      const before = await snapshotMoneyState(baseUrl);
      const previousActions = new Set((await fetchPendingActions(baseUrl)).map(action => action.id));
      await submitChat(page, MSG.gatedPlan);
      await waitForPlanStatus(page, '等待确认');

      const parkedIds = (await fetchPendingActions(baseUrl)).filter(action => !previousActions.has(action.id)).map(action => action.id);

      await clickPlanControl(page, '取消');
      await waitForPlanStatus(page, '已取消');
      if (await planControlPresent(page, '取消')) throw new Error('已取消，但仍渲染「取消」控件');

      // OLD confirmation entry must NOT move money after the plan was cancelled.
      let confirmOutcome: string;
      const confirmButton = page.getByRole('button', { name: '确认', exact: true });
      if ((await confirmButton.count()) > 0) {
        const [response] = await Promise.all([
          page.waitForResponse(
            (res) => res.request().method() === 'POST' && res.url().includes('/confirm'),
            { timeout: 30_000 },
          ),
          confirmButton.first().click(),
        ]);
        const status = response.status();
        const body = (await response.json().catch(() => undefined)) as
          | { ok?: boolean; data?: { ok?: boolean; status?: string }; error?: { code?: string } }
          | undefined;
        const rejected = (status >= 400 && body?.ok === false) || (status === 200 && body?.data?.ok === false);
        if (!rejected) {
          throw new Error(`计划取消后「确认」未被拒绝（HTTP ${status}）：${JSON.stringify(body).slice(0, 160)}`);
        }
        const detail =
          status === 200
            ? `HTTP 200 data.ok=false, status=${body?.data?.status ?? '?'}`
            : `HTTP ${status} error.code=${body?.error?.code ?? '?'}`;
        confirmOutcome = `旧确认入口仍在 → 点击被拒绝（${detail}）`;
      } else {
        const still = await fetchPendingActions(baseUrl);
        const leaked = still.filter((action) => parkedIds.includes(action.id));
        if (leaked.length > 0) {
          throw new Error(`确认卡片已移除，但挂起动作仍处于非终态：${leaked.map((action) => action.id).join('、')}`);
        }
        confirmOutcome = '确认卡片已由 DOM 移除（「确认」按钮计数 0）且挂起动作已不在非终态集合';
      }

      // SECONDARY: the cancelled plan moved NO money.
      const after = await snapshotMoneyState(baseUrl);
      if (after.balance !== before.balance) {
        throw new Error(`计划取消后余额变化：${before.balance} → ${after.balance}`);
      }
      const added = diffLedger(before.ledger.transactions, after.ledger.transactions).added;
      if (added.length > 0) {
        throw new Error(`计划取消后账本新增交易：${added.map((tx) => tx.id).join('、')}`);
      }
      if (after.entLimit !== before.entLimit) {
        throw new Error(`计划取消后「${ENTERTAINMENT_CATEGORY}」限额变化：${before.entLimit} → ${after.entLimit}`);
      }

      return `门控计划 → 等待确认 → 计划卡「取消」→ 已取消 ｜ ${confirmOutcome} ｜ 余额(${before.balance})/账本/${ENTERTAINMENT_CATEGORY}限额(${before.entLimit}) 均未变`;
    },
    { label: 'd-plan-cancel' },
  );
}

/**
 * (e) REFRESH → action-entry recovery, in the SAME context across reload (the HttpOnly
 * `banking_session` cookie persists, so the server state is reachable):
 *   leg 1: park a YELLOW action → reload → the ConfirmationCard(确认/取消) is RESTORED.
 *          Uses `set_card_limit` (STATIC YELLOW), independent of the day's transfer total.
 *   leg 2 (fresh context): park a RED transfer → reload → the MfaCard(身份验证) is RESTORED.
 */
async function journeyRefreshRecovery(browser: Browser, baseUrl: string): Promise<string> {
  const yellow = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.cardLimit);
      await waitForConfirmCard(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposer(page);
      await waitForConfirmCard(page);
      return `YELLOW ${MSG.cardLimit}: reload restores the inline confirmation from persisted actions`;
    },
    { label: 'e1-refresh-confirm' },
  );

  const red = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposer(page);
      await waitForMfaCard(page);
      return 'RED 转账挂起 → 同一 context reload → MfaCard(身份验证) 恢复';
    },
    { label: 'e2-refresh-mfa' },
  );

  return `YELLOW：${yellow} ｜ RED：${red}`;
}

/**
 * (f) WEDGE recovery reached ONLY via a PLAIN refresh/navigation — the refresh-reachable recovery
 * surface. A committed-but-unrecorded standalone transfer (`status='confirmed'`, `resultJson=null`,
 * with a committed `ExecutionReceipt`) is seeded straight into the isolated E2E DB; then a plain
 * `page.goto('/agent')` (the actionId is NEVER passed) must surface the row with a recovery
 * button. Clicking it settles the wedge FROM the committed receipt — one debit total, `executed`
 * status, a durable success audit — never a second debit.
 */
async function journeyWedgeRefreshRecover(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      // (a) Open the shared demo conversation and submit a read-only turn.
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.balance);
      const sessionId = await readDemoSessionId(page);

      // (b) pre-state via the app's real read routes.
      const before = await snapshotMoneyState(baseUrl);

      // (c) SEED the wedge (committed debit + committed receipt + confirmed/null PendingAction).
      await seedStandaloneWedge({ sessionId });
      await waitFor(
        async () => {
          const dashboard = await fetchDashboardSummary(baseUrl);
          return dashboard.checkingBalance === subtractMoney(before.balance, WEDGE_AMOUNT);
        },
        { description: `Balance after the committed wedge: ${subtractMoney(before.balance, WEDGE_AMOUNT)}`, timeoutMs: 30_000 },
      );

      // Plain conversation reload restores the recovery card without a separate approvals page.
      await gotoAgent(page, baseUrl);
      const recoverButton = page.getByRole('button', { name: '恢复执行', exact: true });
      await recoverButton.first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

      // (e) click the recovery control, then wait for the outcome to settle.
      await recoverButton.first().click();
      const settled = await waitFor(
        async () => {
          const [actions, dashboard, ledger] = await Promise.all([
            fetchPendingActions(baseUrl),
            fetchDashboardSummary(baseUrl),
            fetchLedger(baseUrl),
          ]);
          const row = actions.find((candidate) => candidate.id === WEDGE_ACTION_ID);
          if (row !== undefined && row.attention === 'recoverable') return false;
          if (dashboard.checkingBalance !== subtractMoney(before.balance, WEDGE_AMOUNT)) return false;
          const added = diffLedger(before.ledger.transactions, ledger.transactions).added.filter(
            (tx) => moneyToCents(tx.amount) === -moneyToCents(WEDGE_AMOUNT) && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
          );
          if (added.length !== 1) return false;
          return { balance: dashboard.checkingBalance, addedDebits: added.length };
        },
        {
          description: '恢复后：/api/actions 不再“可恢复”、余额恰为一次扣款、账本恰新增一条 -200 DEBIT',
          timeoutMs: 30_000,
        },
      );

      // (f) TRUE facts: persisted action status + durable audit.
      const persisted = await queryPendingActionStatus(WEDGE_ACTION_ID);
      if (persisted === null) throw new Error(`恢复后未找到 PendingAction ${WEDGE_ACTION_ID}`);
      if (persisted.status !== 'executed') {
        throw new Error(`恢复后 PendingAction.status 应为 executed，实际 ${persisted.status}`);
      }
      const audit = await queryExecutionAudit(WEDGE_AUDIT_DEDUPE_KEY);
      if (audit === null) {
        throw new Error(`恢复后未写入恢复成功的 AuditLog（dedupeKey=${WEDGE_AUDIT_DEDUPE_KEY}）`);
      }
      if (audit.status !== 'success' || audit.toolName !== 'transfer_money') {
        throw new Error(`恢复 AuditLog 应为 success/transfer_money，实际 ${audit.status}/${audit.toolName}`);
      }
      if (audit.sessionId !== sessionId) {
        throw new Error(`恢复 AuditLog.sessionId 应为 ${sessionId}，实际 ${audit.sessionId}`);
      }

      return `Conversation reload restores recovery; committed receipt settles once, balance ${before.balance} -> ${settled.balance}, new debit count ${settled.addedDebits}, action ${persisted.status}, audit ${audit.status}`;
    },
    { label: 'f-wedge-refresh-recover' },
  );
}

/**
 * (h) INVESTMENT flow: 申购 (RED `subscribe_investment`, ≥ ¥1,000) then 赎回 (RED `redeem_investment`).
 * Both are RED, so each parks an MFA challenge (mock code `123456`). PRIMARY evidence is RENDERED DOM:
 * the assistant narration leads `理财申购结果：` / `理财赎回结果：`. SECONDARY: the SDK writes
 * 投资-category ledger rows (`认购稳健理财A` DEBIT + `赎回` CREDIT) — cross-checked via `GET /api/bills`.
 * The 稳健理财A holding is ONE-SHOT (a second redeem is a `CONFLICT`), so redeem is typed once per run.
 */
async function journeyInvestmentFlow(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);

      await submitChat(page, MSG.subscribe);
      await waitForMfaCard(page);
      await submitMfa(page, '123456');
      // The narration lead IS the success evidence (the SAME pattern journey b uses for a RED verify):
      // a successful verify clears the MFA card and the model then emits `理财申购结果：`. Await THAT,
      // with a generous budget for the dev server's FIRST hit on the investment execution path.
      await waitForAssistantText(page, '理财申购结果：', 90_000);

      // The SETTLED subscribe MFA card re-renders inline in its assistant message once the subscribe
      // action settles (its duplicate-suppression ends), so a naive `count > 0` wait would return
      // immediately on that stale card, and `.first()` would submit the code against the WRONG
      // (already-executed) action. Count the code inputs before the redeem turn, then wait for one
      // MORE — the LIVE redeem decision card, which `ChatWindow` always renders LAST — and let
      // `submitMfa` drive that LAST card.
      const beforeMfaCount = await page.locator(SELECTORS.mfaInput).count();
      await submitChat(page, MSG.redeem);
      await waitForMfaCard(page, 90_000, beforeMfaCount + 1);
      await submitMfa(page, '123456');
      await waitForAssistantText(page, '理财赎回结果：', 90_000);

      const settled = await waitFor(
        async () => {
          const bills = await getJson<LedgerView>(`${baseUrl}/api/bills`);
          const debit = bills.transactions.find(
            (tx) => tx.direction === 'DEBIT' && tx.category === '投资' && tx.merchant === '认购稳健理财A' && tx.amount === '-1000.00',
          );
          const credit = bills.transactions.find(
            (tx) => tx.direction === 'CREDIT' && tx.category === '投资' && tx.merchant === '赎回',
          );
          return debit && credit ? { debit: debit.amount, credit: credit.amount } : false;
        },
        {
          description: '账本出现「投资」类：认购稳健理财A（DEBIT）与赎回（CREDIT）流水',
          timeoutMs: 30_000,
        },
      );

      return `「${MSG.subscribe}」→ MFA 123456 → 助手「理财申购结果：」；「${MSG.redeem}」→ MFA 123456 → 助手「理财赎回结果：」；账本 category=投资 认购稳健理财A ${settled.debit}（DEBIT）/ 赎回 +${settled.credit}（CREDIT）`;
    },
    { label: 'h-investment-flow' },
  );
}

/**
 * (i) ANOMALY detection (GREEN `detect_anomaly`): the rendered `AnomalyCard` must show the seeded
 * Apple Store ¥6,999 anomaly (title `异常交易提醒`, merchant `Apple Store`, `-¥6,999.00`,
 * badge `风险 低`) and the assistant must NOT claim `未发现可疑交易`. SECONDARY: `GET /api/bills`
 * `anomalies` is exactly that one DEBIT row (no CREDIT anomaly — detection is DEBIT-only).
 */
async function journeyAnomalyDetection(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  interface AnomalyPayload {
    anomalies: Array<{
      transaction: { id: string; merchant: string; amount: string; direction: 'DEBIT' | 'CREDIT' };
    }>;
  }

  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.anomaly);

      await page
        .getByText(t('cards.anomaly.title'), { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      if ((await page.getByText('Apple Store', { exact: true }).count()) === 0) {
        throw new Error('AnomalyCard 未渲染商户「Apple Store」');
      }
      if ((await page.getByText('-¥6,999.00', { exact: true }).count()) === 0) {
        throw new Error('AnomalyCard 未渲染金额「-¥6,999.00」');
      }
      if ((await page.getByText(t('cards.anomaly.risk.low'), { exact: false }).count()) === 0) {
        throw new Error('The anomaly card did not render the low-risk badge');
      }
      if ((await hasAssistantText(page, '未发现可疑交易')) !== false) {
        throw new Error('已检测到异常，但助手文本出现了「未发现可疑交易」');
      }

      const settled = await waitFor(
        async () => {
          const bills = await getJson<AnomalyPayload>(`${baseUrl}/api/bills`);
          if (bills.anomalies.some((a) => a.transaction.direction === 'CREDIT')) {
            throw new Error('anomalies 中出现了 CREDIT 方向的可疑交易（异常检测应仅针对 DEBIT）');
          }
          if (bills.anomalies.length !== 1) return false;
          const only = bills.anomalies[0];
          if (
            only.transaction.id !== 'tx_anomaly_apple' ||
            only.transaction.merchant !== 'Apple Store' ||
            only.transaction.amount !== '-6999.00'
          ) {
            return false;
          }
          return { count: bills.anomalies.length, amount: only.transaction.amount };
        },
        {
          description: 'GET /api/bills anomalies 恰为 1 条 Apple Store -6999 DEBIT（tx_anomaly_apple），无 CREDIT',
          timeoutMs: 30_000,
        },
      );

      return `${MSG.anomaly}: ${t('cards.anomaly.title')} / Apple Store / -¥6,999.00 / ${t('cards.anomaly.risk.low')}; ${settled.count} matching debit anomaly; no false clean result`;
    },
    { label: 'i-anomaly-detection' },
  );
}

/** The mock strong-verification code (`lib/constants.MFA_CODE`), typed by hand into the breaker input. */
const MOCK_MFA_CODE = '123456';

/**
 * Enable the explicit developer preference after the sidebar control has hydrated.
 */
async function enableDeveloperReset(page: Page): Promise<void> {
  const toggle = page.locator('[data-developer-toggle]:visible');
  await waitForElementHydration(page, '[data-developer-toggle]');
  if (await toggle.getAttribute('aria-checked') !== 'true') await toggle.click();
  await page.locator('[data-developer-breaker-reset]').waitFor({ state: 'visible' });
}

/**
 * Click the single developer maintenance button after hydration; no banking code is submitted.
 */
async function clickBreakerReset(page: Page): Promise<void> {
  const button = page.locator('[data-developer-breaker-reset]');
  await waitForElementHydration(page, '[data-developer-breaker-reset]');
  await button.click();
}

/**
 * (j) CIRCUIT-BREAKER lock (DURABLE, per-OWNER `user:user_liming`): reset the account breaker to a
 * known zero state, then submit THREE consecutive wrong MFA codes (`000000`) on a RED transfer — after
 * the first two show the failed attempt count. The third closes the verification input and shows
 * the terminal locked status. It trips the breaker: the security
 * center shows `已熔断` + `失败 3 / 3 次` + a `CIRCUIT_BREAKER_TRIPPED` row (severity `high`, DB-cross-
 * checked), and the lock PERSISTS across a plain reload.
 *
 * Normal mode hides and denies maintenance. Developer mode exposes a code-free reset button,
 * which records SECURITY_RESET without executing the still-pending banking operation.
 */
async function journeyCircuitBreakerLock(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(
    browser,
    async (page) => {
      // (1) Open the shared demo conversation and submit a read-only turn.
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.balance);
      const sessionId = await readDemoSessionId(page);

      // Reset the owner counter through the explicit developer maintenance surface.
      await page.goto(`${baseUrl}/security`, { waitUntil: 'domcontentloaded' });
      if (await page.locator('[data-developer-breaker-reset]').count()) throw new Error('Normal mode exposes breaker maintenance');
      const denied = await page.request.post(`${baseUrl}/api/developer/security/reset`);
      if (denied.status() !== 403) throw new Error('Normal mode can invoke developer maintenance');
      await enableDeveloperReset(page);
      await clickBreakerReset(page);
      await waitForStatusText(page, t('security.reset.success', { count: 0, max: 3 }));

      // (3) three consecutive WRONG MFA codes on a RED transfer → trip the per-owner breaker.
      await gotoAgent(page, baseUrl);
      const beforeLock = await fetchDashboardSummary(baseUrl);
      const beforeLedger = await fetchLedger(baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      for (const attempt of [1, 2, 3]) {
        await submitMfa(page, '000000');
        await waitForStatusText(page, attempt === 3 ? t('cards.terminal.locked') : t('cards.mfa.failedAttempts', { attempts: attempt }));
      }
      if (await page.locator(SELECTORS.mfaInput).count()) throw new Error('Locked verification still exposes a code input');
      if ((await fetchDashboardSummary(baseUrl)).checkingBalance !== beforeLock.checkingBalance ||
          diffLedger(beforeLedger.transactions, (await fetchLedger(baseUrl)).transactions).added.length) {
        throw new Error('Failed verification or a locked operation changed the financial ledger');
      }

      // (4) the lock is shown on the security center AND persisted.
      await page.goto(`${baseUrl}/security`, { waitUntil: 'domcontentloaded' });
      await page
        .getByText('已熔断', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const body = (await page.locator('main').innerText()).replace(/\s+/g, '');
      if (!body.includes('失败3/3次')) throw new Error('安全中心未显示「失败 3 / 3 次」');
      const trippedRow = page.locator('[data-security-event-kind="CIRCUIT_BREAKER_TRIPPED"]');
      if (!(await trippedRow.count()) || !(await trippedRow.first().innerText()).includes(t('security.events.kind.CIRCUIT_BREAKER_TRIPPED'))) {
        throw new Error('The security center did not render the localized circuit-breaker event');
      }
      const tripped = (await querySecurityEvents({ sessionId })).find(
        (event) => event.kind === 'CIRCUIT_BREAKER_TRIPPED',
      );
      if (tripped === undefined) {
        throw new Error(`SecurityEvent(CIRCUIT_BREAKER_TRIPPED) 未持久化（sessionId=${sessionId}）`);
      }
      if (tripped.severity !== 'high') {
        throw new Error(`CIRCUIT_BREAKER_TRIPPED severity 应为 high，实际 ${tripped.severity}`);
      }

      // (5) the lock PERSISTS across a plain reload.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page
        .getByText('已熔断', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

      // Developer maintenance is a single button; it must not require a banking credential.
      if (await page.locator(SELECTORS.breakerCodeInput).count()) throw new Error('Developer reset still requests a verification code');
      await clickBreakerReset(page);
      await waitForStatusText(page, t('security.reset.success', { count: 0, max: 3 }));
      await page
        .locator('[data-security-event-kind="SECURITY_RESET"]')
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const resets = await querySecurityEvents({});
      if (!resets.some((event) => event.kind === 'SECURITY_RESET')) {
        throw new Error('SecurityEvent(SECURITY_RESET) 未持久化');
      }

      return `Session ${sessionId}: normal mode hides and denies developer reset; three wrong payment codes lock the owner across reload; one developer button resets without credentials and records SECURITY_RESET`;
    },
    { label: 'j-circuit-breaker-lock' },
  );
}

interface Journey {
  name: string;
  run: (browser: Browser, baseUrl: string) => Promise<string>;
}

const JOURNEYS: readonly Journey[] = [
  { name: 'chat-history-pagination-and-scroll', run: journeyChatHistory },
  { name: 'signed-amount-memory-and-subscription-analysis', run: journeyDialogueRegressions },
  { name: 'operation-history-and-developer-audit', run: journeyOperationHistory },
  { name: 'natural-conversation-and-financial-boundary', run: journeyNaturalConversation },
  { name: 'manual-card-management-and-agent-boundary', run: journeyCardManagement },
  { name: 'contacts-and-investment-pages', run: journeyBankingPages },
  { name: 'multi-card-freeze-audit-history', run: journeyMultiCardFreeze },
  { name: 'developer-mode-conversation-controls', run: journeyDeveloperMode },
  { name: 'subscription-tool-lifecycle', run: journeyToolLifecycle },
  { name: 'shared-demo-dialogue-and-browsers', run: journeySharedDemo },
  { name: 'hydration-external-root-attribute', run: journeyHydration },
  { name: 'i18n-chinese-default-and-switching', run: journeyI18n },
  { name: 'workspace-http-and-mobile', run: journeyAssistantWorkspace },
  { name: 'a-transfer-confirm', run: journeyTransferConfirm },
  { name: 'b-transfer-mfa', run: journeyTransferMfa },
  { name: 'c-plan-pause-resume', run: journeyPlanPauseResume },
  { name: 'd-plan-cancel', run: journeyPlanCancel },
  { name: 'e-refresh-action-recovery', run: journeyRefreshRecovery },
  { name: 'f-wedge-refresh-recover', run: journeyWedgeRefreshRecover },
  { name: 'g-manual-handoff', run: journeyManualReview },
  { name: 'h-investment-flow', run: journeyInvestmentFlow },
  { name: 'i-anomaly-detection', run: journeyAnomalyDetection },
  { name: 'j-circuit-breaker-lock', run: journeyCircuitBreakerLock },
];

// --- entry point --------------------------------------------------------------------------------

async function main(): Promise<void> {
  // This harness is always offline; the separate live harness owns real provider testing.
  process.env.LLM_MODE = 'mock';
  process.env.LLM_PROVIDER = 'faux';
  process.env.LLM_MODEL = 'faux';
  const reporter = createReporter();
  const selected = process.env.E2E_JOURNEYS?.split(',').map(value => value.trim()).filter(Boolean);
  const journeys = selected ? JOURNEYS.filter(journey => selected.includes(journey.name)) : JOURNEYS;
  if (journeys.length === 0) throw new Error('No browser journeys match E2E_JOURNEYS');
  let browser: Browser | undefined;
  let devServer: DevServer | undefined;
  let cleanedUp = false;

  // Idempotent, synchronous teardown — safe from a `process.on('exit')` handler. Kills the dev
  // server's WHOLE process tree (so no `next dev` is ever left listening) and closes the browser.
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (devServer) {
      try {
        devServer.stop();
      } catch {
        /* best-effort */
      }
    }
    setActiveBrowser(undefined);
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

  console.log('== AI Banking Agent 真实浏览器端到端验收 (tests/e2e) ==');

  let started = 0;
  try {
    const executablePath = resolveBrowserExecutable();
    if (executablePath === undefined) {
      // No real browser on this machine — SKIP honestly (never fake a pass, never fail the run).
      for (const journey of journeys) {
        reporter.skip(journey.name, '未找到真实浏览器（Chrome/Edge）；可设置 E2E_BROWSER_PATH 覆盖');
      }
    } else {
      // Isolate the run: point the provisioning CLIs AND the dev server at the dedicated E2E DB
      // (`prisma/e2e.db`) — the shared `prisma/dev.db` is NEVER touched.
      const dbUrl = useIsolatedDatabase();
      console.log(`· 隔离 E2E 数据库：${dbUrl}（prisma/dev.db 不受影响）`);

      // Deterministic fixture state: reset the E2E DB to the canonical seeded state BEFORE booting.
      // The money journeys are tiered from the FROZEN demo day's accumulated outgoing transfers
      // (`demoNow()` = 2026-09-25 12:00), so without a reset a second run would start with the prior
      // run's executed transfers already in the day and the YELLOW-transfer journey would go RED.
      console.log('Reset isolated E2E database: generate the client if needed, remove the file and sidecars, push the schema, probe, then seed.');
      resetDemoDatabase();

      // Robust boot: prefers the project-local Next CLI (no npx/shell shim), waits for BOTH
      // `/api/health` AND `/agent`, and retries once on a fresh port — see `bootDevServer`.
      devServer = await bootDevServer();
      const baseUrl = devServer.baseUrl;
      const health = await getJson<{ llmMode: string }>(`${baseUrl}/api/health`);
      if (health.llmMode !== 'mock') throw new Error('The offline acceptance server did not start in mock mode.');
      console.log(`· next dev (pid=${devServer.pid}) → ${baseUrl}（/api/health 与 /agent 均已就绪，LLM_MODE=mock）`);

      console.log(`· 真实浏览器：${executablePath}`);
      browser = await launchBrowser(executablePath);
      setActiveBrowser(browser);

      for (const journey of journeys) {
        // Fresh browser cookies no longer imply a fresh conversation in the shared demo.
        // Reseed only this isolated fixture between independent scenarios, never a live workspace.
        if (started > 0) await reseedDemoDatabase();
        await runJourney(reporter, journey.name, (active) => journey.run(active, baseUrl));
        started += 1;
      }
    }
  } catch (error) {
    // Infrastructure failure (boot / health / browser launch / provisioning): every journey not yet
    // reported is honestly FAILED with the concrete reason — no silent pass.
    const reason = `基础设施失败：${errText(error)}`;
    console.error(`· ${reason}`);
    for (const journey of journeys.slice(started)) {
      reporter.fail(journey.name, reason);
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* best-effort */
      }
      browser = undefined;
    }
    cleanup();
  }

  console.log(`== 汇总：PASS ${reporter.passes} ｜ FAIL ${reporter.failures} ｜ SKIP ${reporter.skips} ==`);
  process.exitCode = reporter.failures > 0 ? 1 : 0;
}

void main().catch((error) => {
  console.error(`入口脚本失败：${errText(error)}`);
  process.exitCode = 1;
});
