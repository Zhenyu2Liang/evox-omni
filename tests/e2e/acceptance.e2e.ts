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
import { journeyManualReview } from './manual-review.e2e-helper';
import {
  NAV_TIMEOUT_MS,
  SELECTORS,
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
  readSessionCookie,
  resetDemoDatabase,
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
  waitForMfaCard,
  waitForMfaSettled,
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
   * YELLOW, NON-transfer action → confirmation card. Its tier is STATIC (`freeze_card` = YELLOW,
   * `security/permission-engine.ts`), so — unlike a transfer — it stays YELLOW regardless of the
   * demo day's accumulated transfer total, keeping journey e's confirmation-card recovery
   * deterministic across runs and journey ordering.
   */
  freezeCard: '冻结我的信用卡',
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
const TRANSFER_YELLOW_AMOUNT = 200;
const TRANSFER_RED_AMOUNT = 2000;

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
  balance: number;
  /** The transaction ledger (`GET /api/bills`). */
  ledger: LedgerView;
  /** The credit card's 娱乐 category limit (CNY), or `undefined`. */
  entLimit: number | undefined;
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
          if (dashboard.checkingBalance !== before.balance - TRANSFER_YELLOW_AMOUNT) return false;
          const match = diffLedger(before.ledger.transactions, ledger.transactions).added.find(
            (tx) => tx.amount === -TRANSFER_YELLOW_AMOUNT && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
          );
          return match ? { balance: dashboard.checkingBalance, merchant: match.merchant } : false;
        },
        {
          description: `余额应为 ${before.balance - TRANSFER_YELLOW_AMOUNT}（−${TRANSFER_YELLOW_AMOUNT}）且账本新增 -${TRANSFER_YELLOW_AMOUNT} DEBIT（${RECIPIENT_NAME}）`,
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
          if (dashboard.checkingBalance !== before.balance - TRANSFER_RED_AMOUNT) return false;
          const match = diffLedger(before.ledger.transactions, ledger.transactions).added.find(
            (tx) => tx.amount === -TRANSFER_RED_AMOUNT && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
          );
          return match ? { balance: dashboard.checkingBalance } : false;
        },
        {
          description: `余额应为 ${before.balance - TRANSFER_RED_AMOUNT}（−${TRANSFER_RED_AMOUNT}）且账本新增 -${TRANSFER_RED_AMOUNT} DEBIT（${RECIPIENT_NAME}）`,
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
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      await submitMfa(page, '000000');
      await waitForStatusText(page, '验证失败，已尝试1次');
      if (!(await mfaCardPresent(page))) {
        throw new Error('错误验证码后 MFA 卡片消失（应保留以允许重试）');
      }
      if (await hasAssistantText(page, TRANSFER_OK_NARRATION)) {
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
      await submitChat(page, MSG.gatedPlan);
      await waitForPlanStatus(page, '等待确认');

      // The parked action id(s), read through the caller's own session cookie (for the "card gone" proof).
      const cookie = await readSessionCookie(page);
      const parkedIds = cookie ? (await fetchPendingActions(baseUrl, cookie)).map((action) => action.id) : [];

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
        const still = cookie ? await fetchPendingActions(baseUrl, cookie) : [];
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
 *          Uses `freeze_card` (STATIC YELLOW) rather than a transfer, so the tier does not depend on
 *          the demo day's accumulated transfer total (see MSG.freezeCard).
 *   leg 2 (fresh context): park a RED transfer → reload → the MfaCard(身份验证) is RESTORED.
 */
async function journeyRefreshRecovery(browser: Browser, baseUrl: string): Promise<string> {
  const yellow = await withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.freezeCard);
      await waitForConfirmCard(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForComposer(page);
      await waitForConfirmCard(page);
      return `YELLOW「${MSG.freezeCard}」挂起 → 同一 context reload → ConfirmationCard(确认/取消) 由 GET /api/actions 恢复`;
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
 * `page.goto('/actions')` (the actionId is NEVER passed) must surface the row with a `恢复执行`
 * button. Clicking it settles the wedge FROM the committed receipt — one debit total, `executed`
 * status, a durable success audit — never a second debit.
 */
async function journeyWedgeRefreshRecover(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      // (a) mint the identity cookie via the FIRST chat turn (identity is COOKIE-ONLY).
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.balance);
      const cookie = await waitFor(
        async () => {
          const value = await readSessionCookie(page);
          return value === undefined ? false : value;
        },
        { description: '银行会话 cookie（banking_session）', timeoutMs: NAV_TIMEOUT_MS },
      );
      const sessionId = cookie.slice(cookie.indexOf('=') + 1);

      // (b) pre-state via the app's real read routes.
      const before = await snapshotMoneyState(baseUrl);

      // (c) SEED the wedge (committed debit + committed receipt + confirmed/null PendingAction).
      await seedStandaloneWedge({ sessionId });
      await waitFor(
        async () => {
          const dashboard = await fetchDashboardSummary(baseUrl);
          return dashboard.checkingBalance === before.balance - WEDGE_AMOUNT;
        },
        { description: `wedge 注入后余额应为 ${before.balance - WEDGE_AMOUNT}`, timeoutMs: 30_000 },
      );

      // (d) PLAIN navigation to /actions — the actionId is NEVER passed to the browser.
      await page.goto(`${baseUrl}/actions`, { waitUntil: 'domcontentloaded' });
      const recoverButton = page.getByRole('button', { name: '恢复执行', exact: true });
      await recoverButton.first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });

      // (e) click the recovery control, then wait for the outcome to settle.
      await recoverButton.first().click();
      const settled = await waitFor(
        async () => {
          const [actions, dashboard, ledger] = await Promise.all([
            fetchPendingActions(baseUrl, cookie),
            fetchDashboardSummary(baseUrl),
            fetchLedger(baseUrl),
          ]);
          const row = actions.find((candidate) => candidate.id === WEDGE_ACTION_ID);
          if (row !== undefined && row.attention === 'recoverable') return false;
          if (dashboard.checkingBalance !== before.balance - WEDGE_AMOUNT) return false;
          const added = diffLedger(before.ledger.transactions, ledger.transactions).added.filter(
            (tx) => tx.amount === -WEDGE_AMOUNT && tx.direction === 'DEBIT' && tx.merchant.includes(RECIPIENT_NAME),
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

      return `仅经“纯刷新/导航”可达的恢复面：种子 wedge(status=confirmed,resultJson=null,已提交凭证) → page.goto('/actions')（不传 actionId）→ 渲染「恢复执行」→ 点击 → 由已提交凭证结算（未再次扣款）；余额 ${before.balance} → ${settled.balance}（恰一次 −${WEDGE_AMOUNT}，账本恰新增 ${settled.addedDebits} 条 −${WEDGE_AMOUNT} DEBIT/${RECIPIENT_NAME}）；PendingAction.status=${persisted.status}；AuditLog(dedupeKey=${WEDGE_AUDIT_DEDUPE_KEY}) status=${audit.status}`;
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
      await waitForMfaSettled(page);
      await waitForAssistantText(page, '理财申购结果：');

      await submitChat(page, MSG.redeem);
      await waitForMfaCard(page);
      await submitMfa(page, '123456');
      await waitForMfaSettled(page);
      await waitForAssistantText(page, '理财赎回结果：');

      const settled = await waitFor(
        async () => {
          const bills = await getJson<LedgerView>(`${baseUrl}/api/bills`);
          const debit = bills.transactions.find(
            (tx) => tx.direction === 'DEBIT' && tx.category === '投资' && tx.merchant === '认购稳健理财A',
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
  interface AnomalyPayload {
    anomalies: Array<{
      transaction: { id: string; merchant: string; amount: number; direction: 'DEBIT' | 'CREDIT' };
    }>;
  }

  return withPage(
    browser,
    async (page) => {
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.anomaly);

      await page
        .getByText('异常交易提醒', { exact: false })
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      if ((await page.getByText('Apple Store', { exact: true }).count()) === 0) {
        throw new Error('AnomalyCard 未渲染商户「Apple Store」');
      }
      if ((await page.getByText('-¥6,999.00', { exact: true }).count()) === 0) {
        throw new Error('AnomalyCard 未渲染金额「-¥6,999.00」');
      }
      if ((await page.getByText('风险 低', { exact: false }).count()) === 0) {
        throw new Error('AnomalyCard 未渲染「风险 低」徽标');
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
            only.transaction.amount !== -6999
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

      return `「${MSG.anomaly}」→ AnomalyCard 标题「异常交易提醒」/ 商户 Apple Store / -¥6,999.00 / 徽标「风险 低」；助手未出现「未发现可疑交易」；GET /api/bills anomalies=${settled.count} 条（Apple Store ${settled.amount}），无 CREDIT`;
    },
    { label: 'i-anomaly-detection' },
  );
}

/**
 * (j) CIRCUIT-BREAKER lock (DURABLE, per-OWNER `user:user_liming`): reset the account breaker to a
 * known zero state, then submit THREE consecutive wrong MFA codes (`000000`) on a RED transfer — after
 * each, RENDERED `role=status` shows `验证失败，已尝试 N 次`. The third trips the breaker: the security
 * center shows `已熔断` + `失败 3 / 3 次` + a `CIRCUIT_BREAKER_TRIPPED` row (severity `high`, DB-cross-
 * checked), and the lock PERSISTS across a plain reload. Finally the GATED `解除熔断限制` (prefilled
 * `123456`) unlocks it and records a `SECURITY_RESET` event (DOM + DB).
 */
async function journeyCircuitBreakerLock(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(
    browser,
    async (page) => {
      // (1) mint the identity cookie via the FIRST chat turn (identity is COOKIE-ONLY).
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.balance);
      const cookie = await waitFor(
        async () => {
          const value = await readSessionCookie(page);
          return value === undefined ? false : value;
        },
        { description: '银行会话 cookie（banking_session）', timeoutMs: NAV_TIMEOUT_MS },
      );
      const sessionId = cookie.slice(cookie.indexOf('=') + 1);

      // (2) reset the ACCOUNT breaker so the three failures below start from a known zero state.
      await page.goto(`${baseUrl}/security`, { waitUntil: 'domcontentloaded' });
      const resetButton = page.getByRole('button', { name: /重置熔断计数|解除熔断限制/ });
      await resetButton.first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await resetButton.first().click();
      await waitForStatusText(page, '已解除，当前失败0/3次');

      // (3) three consecutive WRONG MFA codes on a RED transfer → trip the per-owner breaker.
      await gotoAgent(page, baseUrl);
      await submitChat(page, MSG.transferRed);
      await waitForMfaCard(page);
      for (const attempt of [1, 2, 3]) {
        await submitMfa(page, '000000');
        await waitForStatusText(page, `验证失败，已尝试${attempt}次`);
      }

      // (4) the lock is shown on the security center AND persisted.
      await page.goto(`${baseUrl}/security`, { waitUntil: 'domcontentloaded' });
      await page
        .getByText('已熔断', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const body = (await page.locator('main').innerText()).replace(/\s+/g, '');
      if (!body.includes('失败3/3次')) throw new Error('安全中心未显示「失败 3 / 3 次」');
      if (!body.includes('CIRCUIT_BREAKER_TRIPPED')) {
        throw new Error('安全中心未渲染 CIRCUIT_BREAKER_TRIPPED 安全事件行');
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

      // (6) GATED unlock with the mock code → breaker cleared + audited.
      const unlockButton = page.getByRole('button', { name: '解除熔断限制', exact: true });
      await unlockButton.first().waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      await unlockButton.first().click();
      await waitForStatusText(page, '已解除，当前失败0/3次');
      await page
        .getByText('SECURITY_RESET', { exact: true })
        .first()
        .waitFor({ state: 'visible', timeout: NAV_TIMEOUT_MS });
      const resets = await querySecurityEvents({});
      if (!resets.some((event) => event.kind === 'SECURITY_RESET')) {
        throw new Error('SecurityEvent(SECURITY_RESET) 未持久化');
      }

      return `会话 ${sessionId}：重置熔断计数 → 3 次错误验证码(000000) 逐次「验证失败，已尝试 1/2/3 次」→ 安全中心「已熔断」+「失败 3 / 3 次」+ CIRCUIT_BREAKER_TRIPPED(high) → reload 仍锁定 → 「解除熔断限制」(123456) → 已解除(0/3) 且 SECURITY_RESET 已审计`;
    },
    { label: 'j-circuit-breaker-lock' },
  );
}

interface Journey {
  name: string;
  run: (browser: Browser, baseUrl: string) => Promise<string>;
}

const JOURNEYS: readonly Journey[] = [
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
  const reporter = createReporter();
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
      for (const journey of JOURNEYS) {
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
      console.log('· 重置隔离 E2E 数据库 →（缺 Prisma Client 时先 prisma generate）→ 删除 e2e.db + 副本 → 按顺序尝试 db push 阶梯（主：--skip-generate；回退：generate + --force-reset；兜底：无参数）→ probe → tsx prisma/seed.ts（保证每次运行起始状态一致）');
      resetDemoDatabase();

      // Robust boot: prefers the project-local Next CLI (no npx/shell shim), waits for BOTH
      // `/api/health` AND `/agent`, and retries once on a fresh port — see `bootDevServer`.
      devServer = await bootDevServer();
      const baseUrl = devServer.baseUrl;
      console.log(`· next dev (pid=${devServer.pid}) → ${baseUrl}（/api/health 与 /agent 均已就绪，LLM_MODE=mock）`);

      console.log(`· 真实浏览器：${executablePath}`);
      browser = await launchBrowser(executablePath);
      setActiveBrowser(browser);

      for (const journey of JOURNEYS) {
        await runJourney(reporter, journey.name, (active) => journey.run(active, baseUrl));
        started += 1;
      }
    }
  } catch (error) {
    // Infrastructure failure (boot / health / browser launch / provisioning): every journey not yet
    // reported is honestly FAILED with the concrete reason — no silent pass.
    const reason = `基础设施失败：${errText(error)}`;
    console.error(`· ${reason}`);
    for (const journey of JOURNEYS.slice(started)) {
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
