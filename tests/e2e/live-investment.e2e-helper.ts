/**
 * `tests/e2e/live-investment.e2e-helper.ts` — body of LIVE scenario `lB`:
 * 稳健理财A 的「申购 → 按金额部分赎回 → 按份额部分赎回 → 裸数字澄清」, end to end through the REAL
 * `/agent` UI, the REAL `/investments` page, the REAL model and the REAL SQLite bank.
 *
 * WHY A SEPARATE MODULE: the entry script keeps only the registration line (the `lF`/`lG`/`lH`/`lI`
 * precedent). Everything reusable is REUSED, never re-implemented: the chat/panel primitives and the
 * read routes come from `./helpers`, `withDb` / `writeScenarioEvidence` / `liveModelId` from
 * `./live-virtual-card.e2e-helper`, and the money/decimal/「净值 + 份额」 arithmetic from
 * `lib/money`, `lib/decimal` and `banking-sdk/net-value`.
 *
 * WHAT IT PROVES (B0–B5):
 *
 *  - B0 持仓展示 — asking 「我的持仓」 renders an investments card whose 持仓份额 / 最新净值 / 市值 /
 *    持仓收益 / 持仓收益率 rows agree with `holding_wenjiana` (shares × latest net value) and whose
 *    持仓收益率 row EXISTS and carries a signed percent (a losing holding must not blank the page),
 *    plus the same「净值 + 份额」facts on `/investments`. No new `pageerror` in this step.
 *  - B1 申购 — RED `subscribe_investment` (+¥1,000): cost basis + shares grow, the NEWEST chat card
 *    shows the POST-WRITE shares and differs from the card that came before it.
 *  - B2 按金额赎回 — RED `redeem_investment` (¥2,000 by amount): shares × net value settlement, cost
 *    deduction proportional to shares, realized profit = 到账 − 扣减成本, ledger + balance, and the
 *    NEWEST chat card mirrors the post-write shares / remaining cost / market value.
 *  - B3 按份额赎回 — 100 shares by 份额: the confirmation panel's `dt`/`dd` rows state the口径, the
 *    canonical share text, the 4-dp execution net value, the HALF_UP settlement and `SIMULATED_NONE`;
 *    after 确认 + MFA the DB moves by exactly 100 shares with the same accounting identities.
 *  - B4 裸数字澄清 — a bare `赎回2000` parks NO action: five DB surfaces are unchanged and the prose
 *    mentions BOTH「份额」and「金额」.
 *  - B5 模型真实性 — `/api/health` reports `live`, persisted `provider_*` evidence carries an upstream
 *    provider response id, and the latest model request ends with `[DONE]`.
 *
 * NO product code is written by this file: it asserts existing behaviour. Nothing here is collected by
 * Vitest (no `.test.`/`.spec.` suffix).
 */
import type { Locator, Page } from 'playwright-core';
import {
  NAV_TIMEOUT_MS,
  SELECTORS,
  assistantTexts,
  clickConfirm,
  diffLedger,
  errText,
  fetchDashboardSummary,
  fetchLedger,
  getJson,
  gotoAgent,
  mfaCardPresent,
  submitChat,
  submitMfa,
  waitFor,
  waitForElementHydration,
  waitForMfaCard,
} from './helpers';
import { liveModelId, withDb, writeScenarioEvidence } from './live-virtual-card.e2e-helper';
import { addDecimal, compareDecimal, formatDecimalCNY, formatDecimalFixed, subtractDecimal } from '../../lib/decimal';
import { addMoney, centsToMoney, formatCNY, moneyToCents, subtractMoney } from '../../lib/money';
import { marketValueFromShares, redeemedCostMinor, settlementFromShares } from '../../banking-sdk/net-value';

/** The seeded position every assertion is derived from (never a hard-coded principal + fixed yield). */
const HOLDING_WENJIANA_ID = 'holding_wenjiana';
/** The product's display name — the one substring that identifies ITS holding card. */
const PRODUCT_NAME = '稳健理财A';
/** The demo user's single CHECKING account (B4 proves its balance does not move). */
const CHECKING_ACCOUNT_ID = 'acct_checking';
/** `MFA_CODE` convention of the whole suite. */
const MFA_CODE = '123456';
/** The one extra purchase of B1: ¥1,000.00 = 100_000 minor units. */
const SUBSCRIBE_AMOUNT_MINOR = 100_000n;
/** B3 redeems exactly this many SHARES (canonical decimal text, as the panel states it). */
const SHARES_BY_QUANTITY = '100';
/** B4's bare number — no口径, so it may only earn a clarification. */
const BARE_NUMBER_TURN = '赎回2000';

/**
 * Investment-row labels, verbatim from the ONE catalogue the components render from
 * (`business.investments.*` in `lib/i18n/messages/business.zh-CN.json`).
 */
const LABEL = {
  /** `business.investments.principal` — the booked remaining cost. */
  principal: '持有金额',
  /** `business.investments.remainingCost` */
  remainingCost: '剩余持仓成本',
  /** `business.investments.shares` */
  shares: '持仓份额',
  /** `business.investments.netValue` */
  netValue: '最新净值',
  /** `business.investments.marketValue` */
  marketValue: '市值',
  /** `business.investments.holdingProfit` */
  holdingProfit: '持仓收益',
  /** `business.investments.holdingProfitRate` */
  holdingProfitRate: '持仓收益率',
  /** `business.investments.cumulativeProfit` */
  cumulativeProfit: '累计收益',
  /** `business.investments.realizedProfit` */
  realizedProfit: '已实现收益',
  /** `business.investments.units.shares` / `.units.netValue` */
  unitsShares: '份',
  unitsNetValue: '元/份',
} as const;

/**
 * Redemption-confirmation labels, verbatim from `chat.field.*` (the server mints the field LABELS and
 * `lib/i18n/display.ts` maps them through `display-sources.json` back to the SAME Chinese text).
 */
const PANEL = {
  holding: '持仓',
  redemptionMode: '赎回口径',
  redemptionShares: '赎回份额',
  netValue: '成交净值',
  netValueDate: '净值日期',
  settlementAmount: '预计到账金额',
  feeRule: '费用口径',
  amountChange: '金额变化',
  receivingAccount: '入账账户',
} as const;

/** `chat.value.redemptionByShares` — the口径 text of a SHARES redemption. */
const REDEMPTION_MODE_SHARES = '按份额赎回';

/** Everything `lB` needs from the entry script; nothing here is re-implemented side-band. */
export interface InvestmentScenarioParams {
  page: Page;
  baseUrl: string;
  /** The entry's `driveRedTool`-backed driver: sends bounded natural turns and SETTLES the parked card. */
  drive: (turns: readonly string[]) => Promise<string[]>;
  /** The entry's module-private `captureLive` — injected so the screenshot pipeline stays single-source. */
  captureShot: (page: Page, label: string) => Promise<string | undefined>;
  /** The entry's cross-scenario `pageerror` collector (append-only, so B0 compares a SLICE). */
  pageErrors: readonly string[];
}

// --- SQLite reads (the ONLY source of every expected figure) --------------------------------------

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
    if (netValue === null) throw new Error(`${PRODUCT_NAME} 未发布净值，无法按「净值 + 份额」核对赎回`);
    if (holding.shares === null || holding.estimatedMarketValue === null) {
      throw new Error(`${PRODUCT_NAME} 持仓缺少份额或市值，无法按「净值 + 份额」核对`);
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

// --- presentation → comparable figure ------------------------------------------------------------

/** Collapse whitespace in a rendered VALUE (`4,999.864825 份` keeps its single space). */
function normalizeValue(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Collapse whitespace in a rendered LABEL (labels never contain spaces). */
function normalizeLabel(text: string): string {
  return text.replace(/\s+/g, '');
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

// --- chat investment cards -----------------------------------------------------------------------

/**
 * Root of the READ-ONLY investments card: `components/chat/MessageBubble.tsx` renders tool cards inside
 * `[data-message-role="tool"]` and `components/chat/cards/CardRenderer.tsx` stamps the card type.
 */
const INVESTMENTS_CARD_ROOT = '[data-message-role="tool"] [data-chat-card-type="investments"]';
/**
 * ONE holding tile inside that card (`components/chat/cards/InvestmentsCard.tsx`): the `data-*` hooks
 * added for this scenario. A product without a position (e.g. a `list_investments` payload) carries no
 * `data-investment-holding-id`, so filtering on it keeps only real positions.
 */
const HOLDING_CARD_ROOT = '[data-investment-card="true"][data-investment-holding-id]';

/** Every rendered 稳健理财A holding card in the transcript, oldest → newest (`.last()` = newest). */
function holdingCards(page: Page): Locator {
  return page.locator(`${INVESTMENTS_CARD_ROOT} ${HOLDING_CARD_ROOT}`).filter({ hasText: PRODUCT_NAME });
}

/** Read one `dt`/`dd` row of a chat card (the `card` layout of `HoldingFacts` pairs them). */
async function readCardRow(card: Locator, label: string): Promise<string> {
  const raw = await card.evaluate((el, wanted) => {
    for (const dt of Array.from(el.querySelectorAll('dt'))) {
      if ((dt.textContent ?? '').replace(/\s+/g, '') !== wanted) continue;
      const dd = dt.parentElement ? dt.parentElement.querySelector('dd') : null;
      if (dd) return dd.textContent ?? '';
    }
    return '';
  }, normalizeLabel(label));
  return normalizeValue(raw);
}

/** Read the required facts of ONE chat card; a missing row is a failure, never an empty default. */
async function readCardFacts(card: Locator, labels: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const label of labels) {
    const value = await readCardRow(card, label);
    if (value === '') throw new Error(`聊天投资卡未渲染「${label}」行（净值 + 份额口径的持仓卡应展示该行）`);
    out[label] = value;
  }
  return out;
}

/**
 * Poll the NEWEST holding card until every requested fact equals its expected text.
 *
 * WHY A BOUNDED WAIT: the write projects its own post-write position card from the tool result, and
 * that projection is RENDERED after the DB commit is already visible. Reading the card the instant
 * `awaitHolding` returns can therefore still hit the PREVIOUS card (the stale snapshot), so this waits
 * for the BUSINESS condition — the newest card carries the expected facts — instead of guessing a
 * delay. A transiently missing card/row is NOT an error: it just fails this poll and is retried. A
 * card that never updates still FAILS the step, and the timeout error carries the LAST facts actually
 * read (plus the card count and the expected text) so the diagnosis is immediate.
 */
async function awaitCardFacts(
  page: Page,
  labels: readonly string[],
  expected: Record<string, string>,
  description: string,
  timeoutMs = 90_000,
): Promise<Record<string, string>> {
  let lastFacts: Record<string, string> = {};
  let lastCardCount = 0;
  let lastProblem = '尚未读取';
  try {
    return await waitFor(
      async () => {
        const cards = holdingCards(page);
        try {
          lastCardCount = await cards.count();
          if (lastCardCount === 0) {
            lastFacts = {};
            lastProblem = `聊天里还没有任何「${PRODUCT_NAME}」投资持仓卡`;
            return false;
          }
          const facts: Record<string, string> = {};
          for (const label of labels) facts[label] = await readCardRow(cards.last(), label);
          lastFacts = facts;
          const missing = labels.filter((label) => facts[label] === '');
          lastProblem = missing.length > 0
            ? `最新投资卡未渲染「${missing.join('、')}」行`
            : '最新投资卡的事实与该轮期望不符';
          return labels.every((label) => facts[label] === expected[label]) ? facts : false;
        } catch (e) {
          // A re-render can detach the node mid-read: keep polling — the CONDITION decides, not the read.
          lastProblem = `读取最新投资卡失败：${errText(e)}`;
          return false;
        }
      },
      { timeoutMs, intervalMs: 500, description },
    );
  } catch {
    const actual = labels.map((label) => `${label}=${lastFacts[label] ?? '（读不到该行）'}`).join('、');
    const wanted = labels.map((label) => `${label}=${expected[label]}`).join('、');
    throw new Error(
      `等待超时（${timeoutMs}ms）：${description}；最新投资卡实际 ${actual}；期望 ${wanted}；`
        + `当前「${PRODUCT_NAME}」投资持仓卡共 ${lastCardCount} 张；最后一次轮询状态：${lastProblem}`,
    );
  }
}

/** `formatDecimalFixed(shares, 6) + ' 份'` — the ONE rendering of a share count in cards and pages. */
function sharesText(shares: string): string {
  return `${formatDecimalFixed(shares, 6)} ${LABEL.unitsShares}`;
}

/** `formatDecimalFixed(netValue, 4) + ' 元/份'` — the ONE rendering of a net value. */
function netValueText(netValue: string): string {
  return `${formatDecimalFixed(netValue, 4)} ${LABEL.unitsNetValue}`;
}

// --- approval / MFA panel ------------------------------------------------------------------------

/** Composer is enabled only when the previous turn finished streaming. */
async function composerEnabled(page: Page): Promise<boolean> {
  const composer = page.locator(SELECTORS.composer).first();
  return (await composer.count()) > 0 && (await composer.isEnabled());
}

/** Is there an ACTIONABLE decision control (the dock), i.e. not merely a historical receipt? */
async function actionablePanelPresent(page: Page): Promise<boolean> {
  const confirm = page
    .locator(SELECTORS.approvalRequest)
    .getByRole('button', { name: '确认', exact: true });
  if ((await confirm.count()) > 0) return true;
  return mfaCardPresent(page);
}

/** The number of rendered `确认` buttons (0 once a card is settled / gone). */
async function confirmButtonCount(page: Page): Promise<number> {
  return page.locator(SELECTORS.approvalRequest).getByRole('button', { name: '确认', exact: true }).count();
}

/**
 * Read the fields of the NEWEST redemption panel as a `label → value` map.
 *
 * `components/chat/cards/ActionDetails.tsx` renders exactly one `dt`/`dd` pair per field (no nested
 * `dl`), so pairing by index is exact. The scan runs BACKWARDS because settled authorization records
 * stay in the transcript; only the live dock carries「赎回份额」AND its value.
 */
async function readRedemptionPanel(page: Page): Promise<Record<string, string>> {
  const dls = page.locator(`${SELECTORS.approvalRequest} dl`);
  const count = await dls.count();
  for (let i = count - 1; i >= 0; i -= 1) {
    const dl = dls.nth(i);
    const labels = (await dl.locator('dt').allInnerTexts()).map(normalizeLabel);
    if (!labels.includes(normalizeLabel(PANEL.redemptionShares))) continue;
    const values = (await dl.locator('dd').allInnerTexts()).map(normalizeValue);
    const out: Record<string, string> = {};
    labels.forEach((label, index) => {
      out[label] = values[index] ?? '';
    });
    return out;
  }
  return {};
}

/** Wait until the redemption dock (a panel carrying a non-empty「赎回份额」) is rendered. */
async function waitForRedemptionPanel(page: Page, timeoutMs = 90_000): Promise<Record<string, string>> {
  await waitFor(
    async () => {
      const fields = await readRedemptionPanel(page);
      return (fields[PANEL.redemptionShares] ?? '') === '' ? false : fields;
    },
    { timeoutMs, intervalMs: 1_000, description: '赎回确认面板（含「赎回份额」字段）' },
  );
  return readRedemptionPanel(page);
}

// --- `/investments` page -------------------------------------------------------------------------

/**
 * Assert the REAL `/investments` page against one SQLite snapshot and return what it rendered.
 *
 * The rows are read through `readTileRow` (sibling-span pairing, the `tile` layout of `HoldingFacts`),
 * so every figure is compared as RENDERED text — the assertion states the presentation contract
 * (settled to cents, 份额 6 dp, 净值 4 dp), never a re-computation of the stored valuation.
 */
async function assertInvestmentsPage(params: {
  page: Page;
  baseUrl: string;
  snapshot: LiveHoldingSnapshot;
  label: string;
  captureShot: (page: Page, label: string) => Promise<string | undefined>;
}): Promise<{ shown: Record<string, string>; shot: string | undefined }> {
  const { page, baseUrl, snapshot, label, captureShot } = params;
  await page.goto(`${baseUrl}/investments`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await waitForElementHydration(page, '[data-investment-holdings]');
  const tiles = page.locator('[data-investment-holdings] div.rounded-2xl').filter({ hasText: PRODUCT_NAME });
  const tileCount = await tiles.count();
  if (tileCount !== 1) throw new Error(`/investments 持仓区「${PRODUCT_NAME}」卡片应恰 1 张，实际 ${tileCount}`);
  const labels = [
    LABEL.principal,
    LABEL.remainingCost,
    LABEL.shares,
    LABEL.netValue,
    LABEL.marketValue,
    LABEL.holdingProfit,
    LABEL.cumulativeProfit,
    LABEL.realizedProfit,
  ];
  const shown: Record<string, string> = {};
  for (const rowLabel of labels) {
    const value = await readTileRow(tiles.first(), rowLabel);
    if (value === '') throw new Error(`/investments 未渲染「${rowLabel}」行（净值 + 份额口径的持仓卡应展示该行）`);
    shown[rowLabel] = value;
  }
  const shot = await captureShot(page, label);
  for (const rowLabel of [LABEL.principal, LABEL.remainingCost, LABEL.marketValue, LABEL.holdingProfit, LABEL.cumulativeProfit, LABEL.realizedProfit]) {
    if (/\.\d{3,}/.test(shown[rowLabel])) throw new Error(`「${rowLabel}」展示了未结算的过高精度：${shown[rowLabel]}`);
    if (!/^[+-]?¥[\d,]+\.\d{2}$/.test(shown[rowLabel])) throw new Error(`「${rowLabel}」显示值格式不正确：${shown[rowLabel]}`);
  }
  // 剩余持仓成本 (and the booked 持有金额 that mirrors it) is money, not a share of the old principal.
  const expectedCost = formatCNY(centsToMoney(snapshot.costMinor));
  if (shown[LABEL.principal] !== expectedCost) throw new Error(`持有金额应为 ${expectedCost}（剩余持仓成本），实际 ${shown[LABEL.principal]}`);
  if (shown[LABEL.remainingCost] !== expectedCost) throw new Error(`剩余持仓成本应为 ${expectedCost}，实际 ${shown[LABEL.remainingCost]}`);
  const expectedShares = sharesText(snapshot.shares);
  if (shown[LABEL.shares] !== expectedShares) throw new Error(`持仓份额应为 ${expectedShares}，实际 ${shown[LABEL.shares]}`);
  const expectedNetValue = netValueText(snapshot.netValue);
  if (shown[LABEL.netValue] !== expectedNetValue) throw new Error(`最新净值应为 ${expectedNetValue}，实际 ${shown[LABEL.netValue]}`);
  const expectedMarketValue = formatDecimalCNY(snapshot.marketValue);
  if (shown[LABEL.marketValue] !== expectedMarketValue) throw new Error(`市值应为 ${expectedMarketValue}（剩余份额 × 最新净值），实际 ${shown[LABEL.marketValue]}`);
  const unrealized = subtractDecimal(snapshot.marketValue, centsToMoney(snapshot.costMinor));
  if (shown[LABEL.holdingProfit] !== signedDecimalCNY(unrealized)) {
    throw new Error(`持仓收益应为 ${signedDecimalCNY(unrealized)}（市值 − 剩余持仓成本），实际 ${shown[LABEL.holdingProfit]}`);
  }
  const realizedShown = centsToMoney(snapshot.realizedProfitMinor);
  if (shown[LABEL.realizedProfit] !== formatDecimalCNY(realizedShown)) {
    throw new Error(`已实现收益应为 ${formatDecimalCNY(realizedShown)}，实际 ${shown[LABEL.realizedProfit]}`);
  }
  const cumulative = addDecimal(realizedShown, unrealized);
  if (shown[LABEL.cumulativeProfit] !== signedDecimalCNY(cumulative)) {
    throw new Error(`累计收益应为 ${signedDecimalCNY(cumulative)}（已实现收益 + 持仓收益），实际 ${shown[LABEL.cumulativeProfit]}`);
  }
  // Cross-field consistency: 持仓收益 = 市值 − 持有金额 and 累计收益 = 已实现收益 + 持仓收益.
  if (renderedMinor(shown[LABEL.holdingProfit]) !== renderedMinor(shown[LABEL.marketValue]) - renderedMinor(shown[LABEL.principal])) {
    throw new Error(`持仓收益与「市值 − 持有金额」不自洽：${shown[LABEL.holdingProfit]} vs ${shown[LABEL.marketValue]} − ${shown[LABEL.principal]}`);
  }
  if (renderedMinor(shown[LABEL.cumulativeProfit]) !== renderedMinor(shown[LABEL.realizedProfit]) + renderedMinor(shown[LABEL.holdingProfit])) {
    throw new Error(`累计收益与「已实现收益 + 持仓收益」不自洽：${shown[LABEL.cumulativeProfit]} vs ${shown[LABEL.realizedProfit]} + ${shown[LABEL.holdingProfit]}`);
  }
  return { shown, shot };
}

// --- B4: the five zero-change surfaces -----------------------------------------------------------

/** Every surface a bare number must leave untouched. */
interface ZeroChangeSurfaces {
  shares: string | null;
  principalAmountMinor: bigint;
  realizedProfitMinor: bigint;
  status: string;
  balanceMinor: bigint;
  transactionCount: number;
  pendingActionCount: number;
  pendingActionStatuses: string;
  auditLogCount: number;
}

/** One read of all five surfaces (holding, checking balance, ledger, pending actions, audit). */
async function readZeroChangeSurfaces(): Promise<ZeroChangeSurfaces> {
  return withDb(async (db) => {
    const holding = await db.investmentHolding.findUniqueOrThrow({
      where: { id: HOLDING_WENJIANA_ID },
      select: { shares: true, principalAmountMinor: true, realizedProfitMinor: true, status: true },
    });
    const account = await db.account.findUniqueOrThrow({
      where: { id: CHECKING_ACCOUNT_ID },
      select: { balanceMinor: true },
    });
    const pendingActions = await db.pendingAction.findMany({ select: { status: true }, orderBy: { id: 'asc' } });
    return {
      shares: holding.shares,
      principalAmountMinor: holding.principalAmountMinor,
      realizedProfitMinor: holding.realizedProfitMinor,
      status: holding.status,
      balanceMinor: account.balanceMinor,
      transactionCount: await db.transaction.count(),
      pendingActionCount: pendingActions.length,
      pendingActionStatuses: pendingActions.map((row) => row.status).join(','),
      auditLogCount: await db.auditLog.count(),
    };
  });
}

/** Human-readable one-line rendering of the five surfaces (used in evidence AND error text). */
function describeSurfaces(s: ZeroChangeSurfaces): string {
  return `holding(shares=${s.shares},cost=${centsToMoney(s.principalAmountMinor)},realized=${centsToMoney(s.realizedProfitMinor)},status=${s.status}) 活期=${centsToMoney(s.balanceMinor)} Transaction=${s.transactionCount} PendingAction=${s.pendingActionCount}[${s.pendingActionStatuses}] AuditLog=${s.auditLogCount}`;
}

/** Fail with BOTH states printed when a bare number moved anything. */
function assertNoSurfaceChange(before: ZeroChangeSurfaces, after: ZeroChangeSurfaces): void {
  if (after.shares !== before.shares) throw new Error(`裸数字澄清后持仓份额不应变化：${before.shares} → ${after.shares}`);
  if (after.principalAmountMinor !== before.principalAmountMinor) {
    throw new Error(`裸数字澄清后剩余持仓成本不应变化：${centsToMoney(before.principalAmountMinor)} → ${centsToMoney(after.principalAmountMinor)}`);
  }
  if (after.realizedProfitMinor !== before.realizedProfitMinor) {
    throw new Error(`裸数字澄清后已实现收益不应变化：${centsToMoney(before.realizedProfitMinor)} → ${centsToMoney(after.realizedProfitMinor)}`);
  }
  if (after.status !== before.status) throw new Error(`裸数字澄清后持仓状态不应变化：${before.status} → ${after.status}`);
  if (after.balanceMinor !== before.balanceMinor) {
    throw new Error(`裸数字澄清后活期余额不应变化：${centsToMoney(before.balanceMinor)} → ${centsToMoney(after.balanceMinor)}`);
  }
  if (after.transactionCount !== before.transactionCount) {
    throw new Error(`裸数字澄清后 Transaction 行数不应变化：${before.transactionCount} → ${after.transactionCount}`);
  }
  if (after.pendingActionCount !== before.pendingActionCount || after.pendingActionStatuses !== before.pendingActionStatuses) {
    throw new Error(`裸数字澄清后 PendingAction 行数与状态集合不应变化：${describeSurfaces(before)} → ${describeSurfaces(after)}`);
  }
  if (after.auditLogCount !== before.auditLogCount) {
    throw new Error(`裸数字澄清后 AuditLog 行数不应变化：${before.auditLogCount} → ${after.auditLogCount}`);
  }
}

// --- B5: provider authenticity -------------------------------------------------------------------

/** Persisted `provider_*` evidence for the latest completed model request. */
interface ProviderEvidence {
  summary: string;
  /** Upstream provider response id (header `x-request-id`/`request-id` or a stream chunk `id`). */
  providerIds: string[];
  /** The `terminator` of the last `transport_end` event of the LATEST model request. */
  latestTerminator: string;
  latestRequestId: string;
  completedRequests: number;
}

/**
 * Verify transport completion from the PERSISTED wire events (same query shape the entry uses for
 * scenario 15): each completed request must have a streamed request payload, a 2xx response-header
 * record, and a `transport_end` event whose terminator is `[DONE]`.
 */
async function verifyProviderCompletionEvidence(): Promise<ProviderEvidence> {
  return withDb(async (db) => {
    const requests = await db.modelRequest.findMany({ where: { status: 'completed' } });
    if (!requests.length) throw new Error('B5 未记录任何已完成的模型请求');
    const records = await db.agentRunEvent.findMany({
      where: { eventType: { startsWith: 'provider_' } },
      orderBy: { sequence: 'asc' },
    });
    const providerIds = new Set<string>();
    for (const request of requests) {
      const evidence = records
        .map((record): Record<string, unknown> => ({ type: record.eventType, ...JSON.parse(record.payloadJson) as Record<string, unknown> }))
        .filter((record) => record['modelRequestId'] === request.id);
      const payloadOf = (type: string): Record<string, unknown>[] => evidence
        .filter((record) => record.type === type)
        .map((record) => (record['payload'] ?? {}) as Record<string, unknown>);
      const streamed = payloadOf('provider_request_payload').some((payload) => payload['stream'] === true);
      const headers = payloadOf('provider_response_headers');
      const completed = payloadOf('provider_response_event').some(
        (payload) => payload['kind'] === 'transport_end' && payload['completed'] === true && payload['terminator'] === '[DONE]',
      );
      if (!streamed || !headers.some((payload) => payload['status'] === 200) || !completed) {
        throw new Error(`B5 模型请求 ${request.id} 缺少完整的 wire 证据（streamed=${streamed} headers=${headers.length} [DONE]=${completed}）`);
      }
      for (const header of headers) {
        const map = header['headers'];
        if (!map || typeof map !== 'object') continue;
        for (const name of ['x-request-id', 'request-id']) {
          const value = (map as Record<string, unknown>)[name];
          if (typeof value === 'string' && value !== '') providerIds.add(value);
        }
      }
      for (const payload of payloadOf('provider_response_event')) {
        const id = payload['id'];
        if (typeof id === 'string' && id !== '') providerIds.add(id);
      }
    }
    const latest = await db.modelRequest.findFirst({
      where: { status: 'completed' },
      orderBy: { startedAt: 'desc' },
    });
    if (!latest) throw new Error('B5 未找到最近一次已完成的模型请求');
    const latestEvidence = records
      .map((record): Record<string, unknown> => ({ type: record.eventType, ...JSON.parse(record.payloadJson) as Record<string, unknown> }))
      .filter((record) => record['modelRequestId'] === latest.id);
    const terminators = latestEvidence
      .filter((record) => record.type === 'provider_response_event')
      .map((record) => (record['payload'] ?? {}) as Record<string, unknown>)
      .filter((payload) => payload['kind'] === 'transport_end')
      .map((payload) => String(payload['terminator'] ?? ''));
    const latestTerminator = terminators[terminators.length - 1] ?? '';
    if (latestTerminator !== '[DONE]') {
      throw new Error(`B5 最近一次模型请求 ${latest.id} 未以 [DONE] 收尾（terminator=${latestTerminator || '缺失'}）`);
    }
    if (providerIds.size === 0) throw new Error('B5 持久化的 provider 证据中没有任何上游 provider 响应 id');
    const ids = Array.from(providerIds);
    return {
      summary: `B5：/api/health llmMode=live；完成请求 ${requests.length} 个，每个都有 stream payload + 200 响应头 + transport_end([DONE])；最近一次 ${latest.id} 收尾 ${latestTerminator}；上游 provider 响应 id ${ids.length} 个（如 ${ids[0]}）`,
      providerIds: ids,
      latestTerminator,
      latestRequestId: latest.id,
      completedRequests: requests.length,
    };
  });
}

// --- the scenario --------------------------------------------------------------------------------

/** Bounded natural turns for the GREEN read (`get_investment_holdings` parks no card). */
const B0_TURNS: readonly string[] = [
  '我的持仓',
  '我现在持有哪些理财产品？',
  '请帮我查询一下我名下的理财持仓',
];

/** Ask for the holdings until a NEW investments holding card renders; returns the turns actually sent. */
async function askForHoldings(page: Page, baselineCards: number): Promise<string[]> {
  const sent: string[] = [];
  for (const turn of B0_TURNS) {
    await submitChat(page, turn);
    sent.push(turn);
    const appeared = await waitFor(
      async () => ((await holdingCards(page).count()) > baselineCards ? true : false),
      { timeoutMs: 45_000, intervalMs: 1_000, description: `LIVE 模型返回「${PRODUCT_NAME}」投资持仓卡：${turn}` },
    ).then(() => true).catch(() => false);
    if (appeared) return sent;
  }
  throw new Error(`B0 连发 ${sent.length} 轮自然语言后仍未出现投资持仓卡（实际发送：${sent.map((t) => `「${t}」`).join(' → ')}）`);
}

/**
 * SCENARIO lB (LIVE-LLM, REAL BROWSER): 持仓展示 → 追加申购 ¥1,000 → 按金额部分赎回 ¥2,000 →
 * 按份额赎回 100 份 → 裸数字澄清（零变更）, verifying the resulting 「净值 + 份额」 position on the REAL
 * `/investments` page, the ledger + balance, the chat cards the write itself projects and the
 * full-precision valuation stored in SQLite.
 */
export async function scenarioInvestmentPartialRedemption(params: InvestmentScenarioParams): Promise<string> {
  const { page, baseUrl, drive, captureShot, pageErrors } = params;
  const pageErrorsBefore = pageErrors.length;

  const beforeHolding = await readHoldingSnapshot();
  const beforeBalance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
  const beforeLedger = (await fetchLedger(baseUrl)).transactions;
  await gotoAgent(page, baseUrl);

  // ---------------------------------------------------------------------------------------------
  // B0 — 持仓展示: the read-only investments card agrees with SQLite, and 持仓收益率 renders a SIGNED
  // percent (the negative-rate blank page can never come back unnoticed).
  // ---------------------------------------------------------------------------------------------
  const cardsBeforeB0 = await holdingCards(page).count();
  const sentB0 = await askForHoldings(page, cardsBeforeB0);
  const factsB0 = await readCardFacts(holdingCards(page).last(), [
    LABEL.shares,
    LABEL.netValue,
    LABEL.marketValue,
    LABEL.holdingProfit,
    LABEL.holdingProfitRate,
  ]);
  const b0Shares = sharesText(beforeHolding.shares);
  if (factsB0[LABEL.shares] !== b0Shares) {
    throw new Error(`B0 聊天卡持仓份额应为 ${b0Shares}（DB holding.shares=${beforeHolding.shares}），实际 ${factsB0[LABEL.shares]}`);
  }
  const b0NetValue = netValueText(beforeHolding.netValue);
  if (factsB0[LABEL.netValue] !== b0NetValue) {
    throw new Error(`B0 聊天卡最新净值应为 ${b0NetValue}，实际 ${factsB0[LABEL.netValue]}`);
  }
  const b0MarketValue = marketValueFromShares(beforeHolding.shares, beforeHolding.netValue);
  if (factsB0[LABEL.marketValue] !== formatDecimalCNY(b0MarketValue)) {
    throw new Error(`B0 聊天卡市值应为 ${formatDecimalCNY(b0MarketValue)}（份额 × 最新净值），实际 ${factsB0[LABEL.marketValue]}`);
  }
  const b0HoldingProfit = subtractDecimal(b0MarketValue, centsToMoney(beforeHolding.costMinor));
  if (factsB0[LABEL.holdingProfit] !== signedDecimalCNY(b0HoldingProfit)) {
    throw new Error(`B0 聊天卡持仓收益应为 ${signedDecimalCNY(b0HoldingProfit)}（市值 − 剩余持仓成本），实际 ${factsB0[LABEL.holdingProfit]}`);
  }
  if (!/^[+-]?\d+(\.\d+)?%$/.test(factsB0[LABEL.holdingProfitRate])) {
    throw new Error(`B0 持仓收益率应渲染为带符号百分比（负收益率必须正常显示），实际「${factsB0[LABEL.holdingProfitRate]}」`);
  }
  const pageB0 = await assertInvestmentsPage({ page, baseUrl, snapshot: beforeHolding, label: 'lB-investments-B0', captureShot });
  const pageErrorsB0 = pageErrors.slice(pageErrorsBefore);
  if (pageErrorsB0.length > 0) {
    throw new Error(`B0 持仓展示产生了页面错误（负收益率不应崩页）：${pageErrorsB0.join(' ;; ')}`);
  }
  await gotoAgent(page, baseUrl);

  // ---------------------------------------------------------------------------------------------
  // B1 — RED `subscribe_investment` (¥1,000 into 稳健理财A): the cost basis grows by exactly
  // ¥1,000.00 AND the share count grows. Bounded natural turns; if the model insists on a failing
  // plan/submission path, one mild natural rephrase.
  // ---------------------------------------------------------------------------------------------
  const sentB1 = await drive([
    '追加申购稳健理财A 1000元',
    '确认，请办理',
    '界面上方没有出现确认面板，请重新发起这笔追加申购',
    '现在就用我的账户追加申购稳健理财A 1000元',
  ]);
  const costAfterSubscribeMinor = beforeHolding.costMinor + SUBSCRIBE_AMOUNT_MINOR;
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
  // The write projects its own post-write position card: the NEWEST card must show the CURRENT shares
  // and must differ from the card that was newest BEFORE the write (a stale card would equal it).
  const cardB1 = await awaitCardFacts(
    page,
    [LABEL.shares],
    { [LABEL.shares]: sharesText(subscribed.shares) },
    `B1 写后最新投资卡的持仓份额应为 ${sharesText(subscribed.shares)}（写前为 ${factsB0[LABEL.shares]}）`,
    90_000,
  );
  if (cardB1[LABEL.shares] !== sharesText(subscribed.shares)) {
    throw new Error(`B1 之后聊天里最新投资卡的持仓份额应为 ${sharesText(subscribed.shares)}（写后重读的 DB 值），实际 ${cardB1[LABEL.shares]}`);
  }
  if (cardB1[LABEL.shares] === factsB0[LABEL.shares]) {
    throw new Error(`B1 之后聊天里最新投资卡的持仓份额仍是写前数值 ${factsB0[LABEL.shares]}，说明卡片是旧快照而不是写后重读`);
  }

  // ---------------------------------------------------------------------------------------------
  // B2 — RED `redeem_investment` BY AMOUNT (¥2,000, explicit 口径 in the prompt): bounded natural turns.
  // ---------------------------------------------------------------------------------------------
  const sentB2 = await drive([
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
  // The write's own position card must mirror the CURRENT position (剩余成本 = `Money`, 市值 = `DecimalMoney`).
  const cardB2 = await awaitCardFacts(
    page,
    [LABEL.shares, LABEL.remainingCost, LABEL.marketValue],
    {
      [LABEL.shares]: sharesText(redeemed.shares),
      [LABEL.remainingCost]: formatCNY(centsToMoney(redeemed.costMinor)),
      [LABEL.marketValue]: formatDecimalCNY(redeemed.marketValue),
    },
    `B2 写后最新投资卡的持仓份额应为 ${sharesText(redeemed.shares)}、剩余持仓成本应为 ${formatCNY(centsToMoney(redeemed.costMinor))}、市值应为 ${formatDecimalCNY(redeemed.marketValue)}`,
    90_000,
  );
  if (cardB2[LABEL.shares] !== sharesText(redeemed.shares)) {
    throw new Error(`B2 之后聊天里最新投资卡的持仓份额应为 ${sharesText(redeemed.shares)}，实际 ${cardB2[LABEL.shares]}`);
  }
  if (cardB2[LABEL.remainingCost] !== formatCNY(centsToMoney(redeemed.costMinor))) {
    throw new Error(`B2 之后聊天里最新投资卡的剩余持仓成本应为 ${formatCNY(centsToMoney(redeemed.costMinor))}，实际 ${cardB2[LABEL.remainingCost]}`);
  }
  if (cardB2[LABEL.marketValue] !== formatDecimalCNY(redeemed.marketValue)) {
    throw new Error(`B2 之后聊天里最新投资卡的市值应为 ${formatDecimalCNY(redeemed.marketValue)}，实际 ${cardB2[LABEL.marketValue]}`);
  }

  // REAL PAGE — the 净值 + 份额 facts rendered on `/investments` agree with SQLite.
  const pageB2 = await assertInvestmentsPage({ page, baseUrl, snapshot: redeemed, label: 'lB-investments', captureShot });

  // LEDGER + BALANCE — one investment DEBIT (认购) and one investment CREDIT (赎回到账).
  const afterBalance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
  const afterLedger = (await fetchLedger(baseUrl)).transactions;
  const added = diffLedger(beforeLedger, afterLedger).added;
  const describe = added.map((tx) => `${tx.id}:${tx.amount}:${tx.direction}:${tx.merchant}/${tx.category}`).join(' ');
  const debits = added.filter(
    (tx) => tx.direction === 'DEBIT' && moneyToCents(tx.amount) === -SUBSCRIBE_AMOUNT_MINOR && tx.merchant === '认购稳健理财A' && tx.category === '投资',
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

  // ---------------------------------------------------------------------------------------------
  // B3 — 按份额赎回 100 份. `drive` would settle the card itself, so this leg drives the dock BY HAND:
  // read the `dt`/`dd` snapshot FIRST, then confirm + MFA, then assert the DB moved by exactly 100.
  // ---------------------------------------------------------------------------------------------
  await gotoAgent(page, baseUrl);
  const balanceBeforeB3 = (await fetchDashboardSummary(baseUrl)).checkingBalance;
  const ledgerBeforeB3 = (await fetchLedger(baseUrl)).transactions;
  const sentB3 = [`我持有的${PRODUCT_NAME}按份额赎回 ${SHARES_BY_QUANTITY} 份`];
  await submitChat(page, sentB3[0] as string);
  const panelB3 = await waitForRedemptionPanel(page);
  const panelShot = await captureShot(page, 'lB-redeem-by-shares-panel');
  const expectedNetValuePanel = formatDecimalFixed(redeemed.netValue, 4);
  const expectedSettlementB3 = settlementFromShares(SHARES_BY_QUANTITY, redeemed.netValue);
  const expectedSettlementB3Minor = moneyToCents(expectedSettlementB3);
  // 赎回份额 is the CANONICAL decimal the server minted (no 6-dp padding), so compare by VALUE.
  const panelSharesText = panelB3[PANEL.redemptionShares] ?? '';
  if (!/^\d+(\.\d{1,6})?$/.test(panelSharesText) || compareDecimal(panelSharesText, SHARES_BY_QUANTITY) !== 0) {
    throw new Error(`赎回确认面板「${PANEL.redemptionShares}」应为规范十进制 ${SHARES_BY_QUANTITY}，实际「${panelSharesText}」`);
  }
  if (panelB3[PANEL.redemptionMode] !== REDEMPTION_MODE_SHARES) {
    throw new Error(`赎回确认面板「${PANEL.redemptionMode}」应为 ${REDEMPTION_MODE_SHARES}，实际「${panelB3[PANEL.redemptionMode] ?? '缺失'}」`);
  }
  if (panelB3[PANEL.netValue] !== expectedNetValuePanel) {
    throw new Error(`赎回确认面板「${PANEL.netValue}」应为 ${expectedNetValuePanel}，实际「${panelB3[PANEL.netValue] ?? '缺失'}」`);
  }
  if (panelB3[PANEL.settlementAmount] !== formatCNY(expectedSettlementB3)) {
    throw new Error(`赎回确认面板「${PANEL.settlementAmount}」应为 ${formatCNY(expectedSettlementB3)}（赎回份额 ${SHARES_BY_QUANTITY} × 成交净值 ${expectedNetValuePanel}，HALF_UP 到分），实际「${panelB3[PANEL.settlementAmount] ?? '缺失'}」`);
  }
  if (!(panelB3[PANEL.feeRule] ?? '').includes('SIMULATED_NONE')) {
    throw new Error(`赎回确认面板「${PANEL.feeRule}」应含 SIMULATED_NONE，实际「${panelB3[PANEL.feeRule] ?? '缺失'}」`);
  }
  for (const required of [PANEL.holding, PANEL.netValueDate, PANEL.amountChange, PANEL.receivingAccount]) {
    if (!(required in panelB3)) throw new Error(`赎回确认面板缺少「${required}」字段（实际字段：${Object.keys(panelB3).join('、')}）`);
  }
  if ((await confirmButtonCount(page)) > 0) await clickConfirm(page);
  await waitForMfaCard(page, 90_000);
  await submitMfa(page, MFA_CODE);
  await waitFor(
    async () => ((await confirmButtonCount(page)) > 0 || (await mfaCardPresent(page))
      ? false
      : (await composerEnabled(page)) ? true : false),
    { timeoutMs: 90_000, intervalMs: 1_000, description: 'B3 按份额赎回（确认 + MFA）回合结算' },
  );

  const expectedSharesB3 = subtractDecimal(redeemed.shares, SHARES_BY_QUANTITY);
  await awaitHolding(
    (row) => row.shares !== null && compareDecimal(row.shares, expectedSharesB3) === 0,
    `B3 后持仓份额应为 ${expectedSharesB3}（赎回前 ${redeemed.shares} − ${SHARES_BY_QUANTITY} 份）`,
  );
  const afterB3 = await readHoldingSnapshot();
  const consumedCostMinorB3 = redeemedCostMinor(redeemed.costMinor, SHARES_BY_QUANTITY, redeemed.shares);
  if (consumedCostMinorB3 <= 0n || afterB3.costMinor <= 0n) {
    throw new Error(`B3 后扣减成本与剩余成本都应大于零：扣减 ${centsToMoney(consumedCostMinorB3)}、剩余 ${centsToMoney(afterB3.costMinor)}`);
  }
  if (consumedCostMinorB3 + afterB3.costMinor !== redeemed.costMinor) {
    throw new Error(`B3 扣减成本 ${centsToMoney(consumedCostMinorB3)} + 剩余成本 ${centsToMoney(afterB3.costMinor)} 应等于赎回前成本 ${centsToMoney(redeemed.costMinor)}`);
  }
  const realizedDeltaB3 = afterB3.realizedProfitMinor - redeemed.realizedProfitMinor;
  if (realizedDeltaB3 !== expectedSettlementB3Minor - consumedCostMinorB3) {
    throw new Error(`B3 本次已实现收益应为 到账 ${expectedSettlementB3} − 扣减成本 ${centsToMoney(consumedCostMinorB3)} = ${centsToMoney(expectedSettlementB3Minor - consumedCostMinorB3)}，实际 ${centsToMoney(realizedDeltaB3)}`);
  }
  const ledgerAfterB3 = (await fetchLedger(baseUrl)).transactions;
  const balanceAfterB3 = (await fetchDashboardSummary(baseUrl)).checkingBalance;
  const addedB3 = diffLedger(ledgerBeforeB3, ledgerAfterB3).added;
  const describeB3 = addedB3.map((tx) => `${tx.id}:${tx.amount}:${tx.direction}:${tx.merchant}/${tx.category}`).join(' ');
  const creditsB3 = addedB3.filter(
    (tx) => tx.direction === 'CREDIT' && moneyToCents(tx.amount) === expectedSettlementB3Minor && tx.merchant === '赎回' && tx.category === '投资',
  );
  if (creditsB3.length !== 1) {
    throw new Error(`B3 账本应新增 1 条 ${expectedSettlementB3} 的投资 CREDIT（赎回 ${SHARES_BY_QUANTITY} 份 × 成交净值 ${expectedNetValuePanel}），实际 ${creditsB3.length}：${describeB3}`);
  }
  const expectedBalanceB3 = addMoney(balanceBeforeB3, expectedSettlementB3);
  if (balanceAfterB3 !== expectedBalanceB3) {
    throw new Error(`B3 后活期余额应为 ${expectedBalanceB3}（${balanceBeforeB3} + ${expectedSettlementB3}），实际 ${balanceAfterB3}`);
  }

  // ---------------------------------------------------------------------------------------------
  // B4 — 裸数字澄清: `赎回2000` states NO口径, so it may only earn a clarification. `drive` is NOT
  // used here (it could confirm and execute); five DB surfaces must be byte-identical afterwards.
  // ---------------------------------------------------------------------------------------------
  const surfacesBefore = await readZeroChangeSurfaces();
  const assistantBaseline = (await assistantTexts(page)).length;
  await submitChat(page, BARE_NUMBER_TURN);
  await waitFor(
    async () => {
      if (await actionablePanelPresent(page)) return true;
      return (await assistantTexts(page)).length > assistantBaseline && (await composerEnabled(page)) ? true : false;
    },
    { timeoutMs: 90_000, intervalMs: 1_000, description: `裸数字「${BARE_NUMBER_TURN}」回合结算（澄清或面板）` },
  );
  if (await actionablePanelPresent(page)) {
    throw new Error(`裸数字「${BARE_NUMBER_TURN}」不应停放确认/MFA 面板（口径必须由用户显式给出），实际面板字段：${Object.keys(await readRedemptionPanel(page)).join('、')}`);
  }
  const clarification = (await assistantTexts(page)).slice(assistantBaseline).join('\n').trim();
  const surfacesAfter = await readZeroChangeSurfaces();
  assertNoSurfaceChange(surfacesBefore, surfacesAfter);
  if (!clarification.includes('份额') || !clarification.includes('金额')) {
    throw new Error(`B4 澄清文本应同时提到「份额」与「金额」，实际：「${clarification || '（无新增助手文本）'}」｜${describeSurfaces(surfacesAfter)}`);
  }
  const surfacesShot = await captureShot(page, 'lB-bare-number-clarification');

  // ---------------------------------------------------------------------------------------------
  // B5 — 模型真实性: the live provider really produced these turns.
  // ---------------------------------------------------------------------------------------------
  const health = await getJson<{ llmMode?: string }>(`${baseUrl}/api/health`);
  if (health.llmMode !== 'live') throw new Error(`B5 /api/health 的 llmMode 应为 live，实际 ${health.llmMode ?? '缺失'}`);
  const provider = await verifyProviderCompletionEvidence();

  const evidenceFile = writeScenarioEvidence('lB-investment-partial-redemption', {
    model: liveModelId(),
    b0: { sent: sentB0, cardFacts: factsB0, pageRows: pageB0.shown, pageShot: pageB0.shot, pageErrors: pageErrorsB0 },
    b1: { sent: sentB1, shares: subscribed.shares, cardShares: cardB1[LABEL.shares] },
    b2: { sent: sentB2, pageRows: pageB2.shown, pageShot: pageB2.shot, cardFacts: cardB2 },
    b3: { sent: sentB3, panel: panelB3, panelShot, shares: afterB3.shares, costMinor: afterB3.costMinor.toString() },
    b4: { sent: [BARE_NUMBER_TURN], clarification, surfacesBefore, surfacesAfter, shot: surfacesShot },
    b5: { llmMode: health.llmMode, completedRequests: provider.completedRequests, latestTerminator: provider.latestTerminator, providerIds: provider.providerIds.slice(0, 5) },
  });

  return `B0 持仓展示：实际发送「${sentB0.map((t) => t).join('」→「')}」→ 聊天投资卡 ${Object.entries(factsB0).map(([label, value]) => `${label}=${value}`).join('、')}（DB holding.shares=${beforeHolding.shares}、最新净值 ${beforeHolding.netValue}、市值 ${beforeHolding.marketValue}，持仓收益率行存在且为带符号百分比）；/investments 显示 ${Object.entries(pageB0.shown).map(([label, value]) => `${label}=${value}`).join('、')}；本步新增 pageerror ${pageErrorsB0.length} 条；B1 实际发送：${sentB1.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 剩余持仓成本 ${centsToMoney(subscribed.costMinor)}、持仓份额 ${subscribed.shares}（最新净值 ${subscribed.netValue}）、市值 ${subscribed.marketValue}（全精度），写后聊天卡持仓份额 ${cardB1[LABEL.shares]}（≠ 写前 ${factsB0[LABEL.shares]}）；B2 实际发送：${sentB2.map((t) => `「${t}」`).join(' → ')} → MFA 123456 → 赎回份额 ${redeemedShares} × 成交净值 ${redeemed.netValue} = 预计到账 ${expectedSettlement}；剩余份额 ${redeemed.shares}、剩余成本 ${centsToMoney(redeemed.costMinor)}（本次扣减 ${centsToMoney(consumedCostMinor)}）、市值 ${redeemed.marketValue}（全精度）、本次已实现收益 ${centsToMoney(realizedDelta)}；写后聊天卡 持仓份额=${cardB2[LABEL.shares]}、剩余持仓成本=${cardB2[LABEL.remainingCost]}、市值=${cardB2[LABEL.marketValue]}；/investments 显示 ${Object.entries(pageB2.shown).map(([label, value]) => `${label}=${value}`).join('、')}；账本新增 DEBIT ${debits[0].amount}（${debits[0].id}，${debits[0].merchant}/${debits[0].category}）与 CREDIT ${credits[0].amount}（${credits[0].id}，${credits[0].merchant}/${credits[0].category}）；活期余额 ${beforeBalance} → ${afterBalance}；B3 实际发送：${sentB3.map((t) => `「${t}」`).join(' → ')} → 确认面板 ${Object.entries(panelB3).map(([label, value]) => `${label}=${value}`).join('、')} → 确认 + MFA 123456 → 份额 ${redeemed.shares} → ${afterB3.shares}（恰 −100）、剩余成本 ${centsToMoney(afterB3.costMinor)}（扣减 ${centsToMoney(consumedCostMinorB3)}）、本次已实现收益 ${centsToMoney(realizedDeltaB3)}、账本新增 CREDIT ${creditsB3[0].amount}（${creditsB3[0].id}）、活期余额 ${balanceBeforeB3} → ${balanceAfterB3}；B4 实际发送：「${BARE_NUMBER_TURN}」→ 无确认/MFA 面板、五处零变更（${describeSurfaces(surfacesAfter)}）、澄清文本逐字：「${clarification}」；${provider.summary}；截图 ${[pageB0.shot, pageB2.shot, panelShot, surfacesShot].filter(Boolean).join(' / ') || '未落盘'}；证据 JSON ${evidenceFile ?? '未落盘'}`;
}
