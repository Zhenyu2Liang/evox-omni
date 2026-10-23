/**
 * `tests/e2e/live-debit-card.e2e-helper.ts` — LIVE scenario `lJ`: a DEBIT/VIRTUAL card on `/cards`
 * shows its LINKED SETTLEMENT ACCOUNT's cash (never a second balance owned by the card).
 *
 * WHY THIS MODULE EXISTS: the web demo must prove — against a REAL browser and the REAL model — that
 * a debit instrument's displayed money is the bound CHECKING account's cash, that the same cash is
 * reported identically by `GET /api/cards`, `GET /api/dashboard` and SQLite, that several cards on one
 * account share that single amount and it is counted ONCE in the asset total, and that freezing or
 * reporting a card lost keeps the real balance visible while making the card explicitly unusable.
 *
 * The scenario runs on the SAME isolated `prisma/live-acceptance.db` as the rest of the live harness and
 * drives ONLY real user-facing surfaces: `/cards` (DOM), `GET /api/cards`, `GET /api/dashboard`,
 * `GET /api/health`, the real `/agent` chat (real model, real confirmation/MFA panels) and read-only
 * SQLite cross-checks. No SDK business call is made directly and nothing is mocked.
 *
 * Reused primitives (never re-implemented): `./live-virtual-card.e2e-helper` (read models, `withDb`,
 * tile readers, evidence writer, RED apply leg, payable maths), `./card-labels.e2e-helper` (`CARD_LABEL`
 * / `CARD_LABEL_RETIRED`) and `./helpers` (chat/confirm/MFA drivers, `getJson`, `waitFor`).
 * Carries no `*.test.`/`*.spec.` suffix and is never collected by Vitest.
 */
import type { Page } from 'playwright-core';
import {
  NAV_TIMEOUT_MS,
  SELECTORS,
  assertNoFabricatedConfirmationPanel,
  assistantTexts,
  clickConfirm,
  errText,
  fetchPendingActions,
  getJson,
  submitChat,
  waitFor,
  waitForConfirmCard,
} from './helpers';
import { CARD_LABEL, CARD_LABEL_RETIRED } from './card-labels.e2e-helper';
import {
  applyVirtualCardViaAgent,
  cardById,
  expectedPayableMinor,
  fetchLiveCards,
  gotoCards,
  liveModelId,
  readCardTileRows,
  readCardTileText,
  withDb,
  writeScenarioEvidence,
  type LiveCardRecord,
  type RedToolDriver,
} from './live-virtual-card.e2e-helper';
import { centsToMoney, formatCNY, moneyToCents } from '../../lib/money';
import { compareDecimal, subtractDecimal } from '../../lib/decimal';
import { createTranslator } from '../../lib/i18n/shared';

const t = createTranslator('zh-CN');

// --- fixtures (ids only; every AMOUNT is read from SQLite at run time) ------------------------------

const CHECKING_ACCOUNT_ID = 'acct_checking';
const DEBIT_CARD_ID = 'card_debit';
const VIRTUAL_CARD_ID = 'card_virtual';
const CREDIT_CARD_ID = 'card_credit';
const RECIPIENT_NAME = '张伟';

/** The one real business of this scenario: a small (YELLOW tier) transfer out of the checking account. */
const TRANSFER_AMOUNT = '12.34';
const TRANSFER_AMOUNT_MINOR = 1234n;
const TRANSFER_PROMPT = `给${RECIPIENT_NAME}转${TRANSFER_AMOUNT}元`;
const TRANSFER_NUDGES = ['确认，请发起这笔转账', '请直接调用转账工具发起这笔转账'] as const;

/** Second virtual card opened on the SAME account — proves the shared cash is counted only once. */
const SECOND_VIRTUAL_LIMIT = '100.00';

const FREEZE_TURNS = [
  '请把我的借记卡冻结（我确认，可随时解冻）。',
  '确认，请冻结那张借记卡',
  '请直接冻结我的借记卡，我已确认',
] as const;

/** `attachCollectors`-free injected surface: the entry script owns the driver, screenshot and page. */
export interface DebitCardParams {
  page: Page;
  baseUrl: string;
  /** The entry script's bounded RED-tool driver (`driveRedTool`), fabricated-panel guard included. */
  drive: RedToolDriver;
  /** The entry script's screenshot helper (`captureLive`); never throws, may return `undefined`. */
  captureShot: (page: Page, label: string) => Promise<string | undefined>;
}

// --- read models -----------------------------------------------------------------------------------

/** `GET /api/health` payload (`llmMode` is read from the server config, never hard-coded). */
interface HealthJson {
  status: 'ok';
  time: number;
  llmMode: 'live' | 'mock';
}

/**
 * `GET /api/dashboard` payload. `helpers.ts#DashboardView` only declares `checkingBalance`; the fields
 * asserted here (`totalAssets`, `creditAvailable`) are declared on `banking-sdk/types.ts#DashboardSummary`.
 */
interface DashboardJson {
  totalAssets: string;
  checkingBalance: string;
  creditAvailable: string;
  monthSpend: string;
  month: string;
  asOf: number;
}

/** The demo user's settlement CHECKING account (authoritative cash, straight from SQLite). */
interface AccountRow {
  id: string;
  name: string;
  number: string;
  type: string;
  balanceMinor: bigint;
}

/** One raw `Card` row (the card-to-account binding is a SQLite fact, not a rendered one). */
interface RawCardRow {
  id: string;
  type: string;
  status: string;
  numberMasked: string;
  creditLimitMinor: bigint | null;
  availableLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  linkedAccountId: string | null;
  replacedByCardId: string | null;
}

interface ConsumptionRow {
  cardId: string;
  accountId: string;
  amountMinor: bigint;
}

interface DebitRow {
  id: string;
  amountMinor: bigint;
  merchant: string;
  channel: string | null;
  category: string;
  direction: string;
}

const RAW_CARD_FIELDS = {
  id: true,
  type: true,
  status: true,
  numberMasked: true,
  creditLimitMinor: true,
  availableLimitMinor: true,
  monthlyLimitMinor: true,
  linkedAccountId: true,
  replacedByCardId: true,
} as const;

function readAccount(): Promise<AccountRow> {
  return withDb(async (db) => {
    const account = await db.account.findUnique({
      where: { id: CHECKING_ACCOUNT_ID },
      select: { id: true, name: true, number: true, type: true, balanceMinor: true },
    });
    if (!account) throw new Error(`SQLite 缺少结算账户 ${CHECKING_ACCOUNT_ID}`);
    return account;
  });
}

function readRawCards(): Promise<RawCardRow[]> {
  return withDb((db) => db.card.findMany({ orderBy: { id: 'asc' }, select: RAW_CARD_FIELDS }));
}

function readConsumptions(): Promise<ConsumptionRow[]> {
  return withDb((db) =>
    db.cardConsumption.findMany({ select: { cardId: true, accountId: true, amountMinor: true } }),
  );
}

function readAccountDebits(): Promise<DebitRow[]> {
  return withDb((db) =>
    db.transaction.findMany({
      where: { accountId: CHECKING_ACCOUNT_ID, direction: 'DEBIT' },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      select: { id: true, amountMinor: true, merchant: true, channel: true, category: true, direction: true },
    }),
  );
}

function rawCardById(rows: readonly RawCardRow[], cardId: string): RawCardRow {
  const row = rows.find((card) => card.id === cardId);
  if (!row) throw new Error(`SQLite 缺少 Card 行 ${cardId}（实际：${rows.map((card) => card.id).join('、')}）`);
  return row;
}

/**
 * The card FAMILY of `cardId`: the card itself plus every replacement issued FOR it and every ancestor
 * that points at it (`Card.replacedByCardId`). A family shares one monthly allowance, so the family's
 * spent amount — not one card's — is what `CardView.payableAmount` is derived from.
 */
function familyCardIds(cards: readonly RawCardRow[], cardId: string): Set<string> {
  const ids = new Set<string>([cardId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const card of cards) {
      if (ids.has(card.id)) continue;
      const parentInFamily = card.replacedByCardId !== null && ids.has(card.replacedByCardId);
      const childInFamily = cards.some((other) => other.id === card.id && other.replacedByCardId !== null && ids.has(other.id));
      const ancestor = cards.some((other) => ids.has(other.id) && other.replacedByCardId === card.id);
      if (parentInFamily || childInFamily || ancestor) {
        ids.add(card.id);
        grew = true;
      }
    }
  }
  return ids;
}

/** Σ consumption amounts of one card family (positive magnitudes) — the projection's `spentMinor`. */
function familySpentMinor(
  cards: readonly RawCardRow[],
  consumptions: readonly ConsumptionRow[],
  cardId: string,
): bigint {
  const ids = familyCardIds(cards, cardId);
  return consumptions.filter((row) => ids.has(row.cardId)).reduce((total, row) => total + row.amountMinor, 0n);
}

function readDashboard(baseUrl: string): Promise<DashboardJson> {
  return getJson<DashboardJson>(`${baseUrl}/api/dashboard`);
}

function readHealth(baseUrl: string): Promise<HealthJson> {
  return getJson<HealthJson>(`${baseUrl}/api/health`);
}

/** `GET /api/dashboard.creditAvailable` re-derived from `GET /api/cards`: non-`LOST` CREDIT cards only. */
function creditAvailableFromCards(cards: readonly LiveCardRecord[]): string {
  const total = cards
    .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST')
    .reduce((sum, card) => sum + (card.availableLimit === undefined ? 0n : moneyToCents(card.availableLimit)), 0n);
  return centsToMoney(total);
}

/** Cards bound to the settlement account (the only cards whose tile may carry account money rows). */
function cardsBoundToAccount(cards: readonly LiveCardRecord[]): LiveCardRecord[] {
  return cards.filter((card) => card.linkedAccountStatus === 'LINKED');
}

// --- assertion vocabulary --------------------------------------------------------------------------

function fail(message: string): never {
  throw new Error(message);
}

/** Short, quoted DOM/JSON excerpt so a FAILED live run is self-diagnosing. */
function excerpt(value: string, max = 240): string {
  return value.replace(/\s+/g, ' ').slice(0, max);
}

interface LinkedAccountExpectation {
  cardId: string;
  type: 'DEBIT' | 'VIRTUAL';
  status: string;
  usable: boolean;
  account: AccountRow;
  accountBalance: string;
  payableAmount: string;
  monthlyLimit?: string;
}

/**
 * Assert one `GET /api/cards` row of a DEBIT/VIRTUAL card: it is bound to the settlement account, its
 * money fields are the ACCOUNT's cash (identical for every card on that account), and it carries NO
 * credit-limit field and NO card-owned balance.
 */
function assertLinkedAccountView(card: LiveCardRecord | undefined, expected: LinkedAccountExpectation): void {
  if (card === undefined) fail(`GET /api/cards 缺少卡片 ${expected.cardId}`);
  const label = `${expected.cardId}`;
  if (card.type !== expected.type) fail(`${label}.type 应为 ${expected.type}，实际 ${card.type}`);
  if (card.status !== expected.status) fail(`${label}.status 应为 ${expected.status}，实际 ${card.status}`);
  if (card.usable !== expected.usable) {
    fail(`${label}.usable 应为 ${expected.usable}（usable 只由 status 决定），实际 ${String(card.usable)}`);
  }
  if (card.linkedAccountStatus !== 'LINKED') {
    fail(`${label}.linkedAccountStatus 应为 LINKED（绑定 ${CHECKING_ACCOUNT_ID} 的借记工具），实际 ${card.linkedAccountStatus}`);
  }
  if (card.linkedAccountId !== expected.account.id) {
    fail(`${label}.linkedAccountId 应为 ${expected.account.id}，实际 ${card.linkedAccountId}`);
  }
  if (card.linkedAccountName !== expected.account.name) {
    fail(`${label}.linkedAccountName 应为 ${expected.account.name}，实际 ${card.linkedAccountName}`);
  }
  if (card.linkedAccountNumber !== expected.account.number) {
    fail(`${label}.linkedAccountNumber 应为 ${expected.account.number}，实际 ${card.linkedAccountNumber}`);
  }
  if (card.accountAvailableBalance !== expected.accountBalance) {
    fail(`${label}.accountAvailableBalance 应为结算账户余额 ${expected.accountBalance}，实际 ${card.accountAvailableBalance}`);
  }
  if (card.payableAmount !== expected.payableAmount) {
    fail(`${label}.payableAmount 应为 ${expected.payableAmount}（= min(账户余额, 剩余月限额)），实际 ${card.payableAmount}`);
  }
  if (expected.monthlyLimit === undefined) {
    if (card.monthlyLimit !== undefined) fail(`${label} 无月限额，不得暴露 monthlyLimit，实际 ${card.monthlyLimit}`);
  } else if (card.monthlyLimit !== expected.monthlyLimit) {
    fail(`${label}.monthlyLimit 应为 ${expected.monthlyLimit}，实际 ${card.monthlyLimit}`);
  }
  if (card.creditLimit !== undefined || card.availableLimit !== undefined) {
    fail(`${label} 是借记类卡片，不得暴露信用额度字段，实际 ${excerpt(JSON.stringify(card))}`);
  }
  // A card-own balance would be a SECOND money source. `CardView` has none: prove it at runtime.
  const asRecord = card as unknown as Record<string, unknown>;
  for (const ownBalanceField of ['balance', 'availableBalance', 'accountBalance']) {
    if (ownBalanceField in asRecord) {
      fail(`${label} 出现了卡片自有余额字段 ${ownBalanceField}（金额必须来自绑定账户）：${excerpt(JSON.stringify(card))}`);
    }
  }
  if (!('accountAvailableBalance' in asRecord)) fail(`${label} 缺少 accountAvailableBalance 字段`);
}

/** Assert a RENDERED DEBIT/VIRTUAL tile: account rows present, credit rows and retired labels absent. */
function assertAccountTile(
  cardId: string,
  rows: Record<string, string>,
  tileText: string,
  expected: { accountBalance: string; payableAmount: string; statusText: string; unusableNotice?: string },
): void {
  for (const creditLabel of [CARD_LABEL.creditLimit, CARD_LABEL.availableLimit]) {
    if (rows[creditLabel] !== undefined) fail(`${cardId} 不应渲染「${creditLabel}」行（那是 CREDIT 卡专用），实际 ${excerpt(JSON.stringify(rows))}`);
    if (tileText.includes(creditLabel)) fail(`${cardId} 的卡片文本出现「${creditLabel}」：${excerpt(tileText)}`);
  }
  for (const retiredLabel of [CARD_LABEL_RETIRED.accountAvailable, CARD_LABEL_RETIRED.payableAmount]) {
    if (rows[retiredLabel] !== undefined) fail(`${cardId} 仍渲染废弃标签「${retiredLabel}」行：${excerpt(JSON.stringify(rows))}`);
    if (tileText.includes(retiredLabel)) fail(`${cardId} 的卡片文本仍出现废弃标签「${retiredLabel}」：${excerpt(tileText)}`);
  }
  if (!tileText.includes(CARD_LABEL.linkedAccount)) fail(`${cardId} 未渲染「${CARD_LABEL.linkedAccount}」：${excerpt(tileText)}`);
  // Guard against a renamed catalogue label turning BOTH sides of a comparison into `undefined`.
  if (rows[CARD_LABEL.accountBalance] === undefined) {
    fail(`${cardId} 未渲染「${CARD_LABEL.accountBalance}」行（标签缺失会让金额断言失去意义）：${excerpt(JSON.stringify(rows))}`);
  }
  if (rows[CARD_LABEL.accountBalance] !== formatCNY(expected.accountBalance)) {
    fail(`${cardId} 的「${CARD_LABEL.accountBalance}」应为 ${formatCNY(expected.accountBalance)}，实际 ${rows[CARD_LABEL.accountBalance]}（${excerpt(JSON.stringify(rows))}）`);
  }
  if (rows[CARD_LABEL.usableBalance] === undefined) {
    fail(`${cardId} 未渲染「${CARD_LABEL.usableBalance}」行（标签缺失会让金额断言失去意义）：${excerpt(JSON.stringify(rows))}`);
  }
  if (rows[CARD_LABEL.usableBalance] !== formatCNY(expected.payableAmount)) {
    fail(`${cardId} 的「${CARD_LABEL.usableBalance}」应为 ${formatCNY(expected.payableAmount)}，实际 ${rows[CARD_LABEL.usableBalance]}（${excerpt(JSON.stringify(rows))}）`);
  }
  if (!tileText.includes(expected.statusText)) fail(`${cardId} 未渲染状态「${expected.statusText}」：${excerpt(tileText)}`);
  if (expected.unusableNotice === undefined) {
    for (const notice of [t('business.cards.cardFrozenNotice'), t('business.cards.cardLostNotice')]) {
      if (tileText.includes(notice)) fail(`${cardId} 是可用卡片，却渲染了不可用提示「${notice}」：${excerpt(tileText)}`);
    }
  } else if (!tileText.includes(expected.unusableNotice)) {
    fail(`${cardId} 应逐字渲染不可用提示「${expected.unusableNotice}」：${excerpt(tileText)}`);
  }
}

/** Assert the CREDIT card renders ONLY credit rows (it has no settlement account by design). */
function assertCreditTile(cardId: string, rows: Record<string, string>, tileText: string, available: string): void {
  for (const accountRow of [CARD_LABEL.accountBalance, CARD_LABEL.usableBalance]) {
    if (rows[accountRow] !== undefined) fail(`${cardId}（CREDIT）不应渲染账户行「${accountRow}」：${excerpt(JSON.stringify(rows))}`);
    if (tileText.includes(accountRow)) fail(`${cardId}（CREDIT）卡片文本出现账户行「${accountRow}」：${excerpt(tileText)}`);
  }
  if (tileText.includes(CARD_LABEL.linkedAccount)) fail(`${cardId}（CREDIT）不应有「${CARD_LABEL.linkedAccount}」：${excerpt(tileText)}`);
  if (rows[CARD_LABEL.availableLimit] === undefined) fail(`${cardId}（CREDIT）未渲染「${CARD_LABEL.availableLimit}」行：${excerpt(JSON.stringify(rows))}`);
  if (rows[CARD_LABEL.availableLimit] !== formatCNY(available)) {
    fail(`${cardId} 的「${CARD_LABEL.availableLimit}」应为 ${formatCNY(available)}，实际 ${rows[CARD_LABEL.availableLimit]}`);
  }
}

/**
 * Wait until `/cards` finished its first CLIENT refresh.
 *
 * `CardManager` starts at `refreshing = true` / `loaded = false` and disables EVERY footer button
 * while `disabled = busy || refreshing || !loaded` (`app/cards/CardManager.tsx:181`, applied verbatim
 * to the `data-card-add` button and to each tile's `data-card-consume` / `data-card-delete`). The
 * tile ROWS are already correct in that frame (server-rendered `CardTile`s), so a button state read
 * straight after `gotoCards` — which only waits for HYDRATION — describes the refresh, not the card.
 * `[data-card-add]` is enabled exactly when all three flags are false, so waiting on it is the honest
 * "page settled" condition and it is INDEPENDENT of the card whose consume entry is being judged.
 */
async function waitForCardsSettled(page: Page): Promise<void> {
  const addButton = page.locator('[data-card-add] button').first();
  try {
    await waitFor(async () => ((await addButton.isEnabled()) ? true : false), {
      timeoutMs: 60_000,
      intervalMs: 500,
      description: '`/cards` 首帧刷新完成（`data-card-add` 解除 disabled：busy/refreshing/!loaded 三者皆假）',
    });
  } catch (error) {
    const alert = page.locator('main > p[role="alert"]').first();
    const alertText = (await alert.count()) > 0 ? excerpt(await alert.innerText()) : '（无页面通知）';
    fail(`/cards 首屏刷新始终未完成（页脚按钮保持全局 disabled），无法判定单卡消费入口：${errText(error)}；页面通知=「${alertText}」`);
  }
}

/**
 * Assert ONE card's rendered 消费 entry state, read only AFTER `/cards` settled.
 *
 * The product's rule is type-agnostic: the entry is enabled iff the page is settled AND `card.usable`
 * (`usable = status === 'ACTIVE'`), so the SAME card must flip enabled → disabled when it stops being
 * ACTIVE. Reading the state before the refresh settles would make the assertion vacuous (everything
 * is disabled then), which is why the settle wait is part of this helper rather than the call site.
 */
async function assertConsumeEntry(
  page: Page,
  cardId: string,
  expected: 'enabled' | 'disabled',
  why: string,
): Promise<void> {
  await waitForCardsSettled(page);
  const enabled = await consumeButtonEnabled(page, cardId);
  if (enabled === (expected === 'enabled')) return;
  fail(`${cardId} 的「消费」按钮应为${expected === 'enabled' ? '可用' : '不可用'}（${why}），实际${enabled ? '可用' : '不可用'}`);
}

/** `[data-card-id]`-scoped consume button state (a frozen/lost card must not be spendable from the page). */
async function consumeButtonEnabled(page: Page, cardId: string): Promise<boolean> {
  const button = page.locator(`[data-card-id="${cardId}"] [data-card-consume] button`).first();
  if ((await button.count()) === 0) fail(`${cardId} 未渲染「消费」按钮`);
  return button.isEnabled();
}

/** The whole rendered `/cards` card list text (page-level copy assertions, e.g. 授信额度 must not appear). */
async function cardListText(page: Page): Promise<string> {
  const list = page.locator('[data-card-list]').first();
  if ((await list.count()) === 0) fail('`/cards` 未渲染 [data-card-list]');
  return (await list.innerText()).replace(/\s+/g, ' ');
}

// --- YELLOW (confirm-only) transfer leg -------------------------------------------------------------

/** The number of rendered actionable `确认` buttons (a YELLOW tool parks a confirm card, no MFA). */
function confirmButtonCount(page: Page): Promise<number> {
  return page.locator(SELECTORS.approvalRequest).getByRole('button', { name: '确认', exact: true }).count();
}

/** Is the chat composer (`textarea[data-chat-composer]`) enabled? It is disabled while a turn streams. */
async function composerEnabled(page: Page): Promise<boolean> {
  const composer = page.locator(SELECTORS.composer).first();
  return (await composer.count()) > 0 && (await composer.isEnabled());
}

/**
 * Drive a YELLOW (confirmation-only) write through natural Chinese turns and confirm its card.
 *
 * `params.drive` (the RED driver) is deliberately NOT used here: it waits for an MFA card after the
 * confirmation, and a small transfer never parks one. A prose-only turn is checked for a fabricated
 * panel claim before the next nudge; the leg is bounded and FAILS if no confirm card ever appears.
 */
async function driveYellowTransfer(
  page: Page,
  baseUrl: string,
  prompt: string,
  nudges: readonly string[],
): Promise<string[]> {
  const sent: string[] = [];
  /** Why the LAST wait ended early: `waitFor` reports both the timeout and the last predicate error. */
  let lastWaitError: unknown;
  for (const turn of [prompt, ...nudges]) {
    const baseline = (await assistantTexts(page)).length;
    await submitChat(page, turn);
    sent.push(turn);
    const outcome = await waitFor(
      async () => {
        if ((await confirmButtonCount(page)) > 0) return 'confirm' as const;
        return (await assistantTexts(page)).length > baseline && (await composerEnabled(page)) ? 'reply' as const : false;
      },
      { timeoutMs: 90_000, intervalMs: 1_000, description: `等待 LIVE 模型为 YELLOW 转账停车确认卡：${turn}` },
    ).catch((error: unknown) => {
      // Keep the REASON: the final failure below must distinguish "the model never parked a card"
      // (plain `等待超时…`) from "the predicate itself threw" (`（最后错误：…）` inside it).
      lastWaitError = error;
      return 'timeout' as const;
    });
    if (outcome === 'confirm') {
      await waitForConfirmCard(page, 60_000);
      await clickConfirm(page);
      return sent;
    }
    if (outcome === 'reply') {
      const prose = (await assistantTexts(page)).slice(baseline).join('\n');
      await assertNoFabricatedConfirmationPanel({ page, prose, actions: await fetchPendingActions(baseUrl) });
    }
  }
  const last = (await assistantTexts(page)).slice(-1)[0] ?? '';
  fail(`有界 ${sent.length} 轮自然语言后未出现转账确认卡（模型未调用 transfer_money）：最后一条=「${excerpt(last)}」；最后一次等待=${errText(lastWaitError ?? '（无等待错误：每轮都等到了确认卡或回复）')}`);
}

// --- real-model proof ------------------------------------------------------------------------------

interface ModelEvidence {
  completedRequests: number;
  requestIds: string[];
  model: string;
}

/**
 * Server-side proof that the REAL model served this scenario: completed `ModelRequest` rows plus the
 * upstream `x-request-id` headers recorded on the SAME run's `provider_response_headers` wire events.
 */
async function readModelEvidence(model: string): Promise<ModelEvidence> {
  return withDb(async (db) => {
    const requests = await db.modelRequest.findMany({ where: { status: 'completed' }, select: { id: true } });
    const headers = await db.agentRunEvent.findMany({
      where: { eventType: 'provider_response_headers' },
      orderBy: { sequence: 'asc' },
      select: { payloadJson: true },
    });
    const requestIds: string[] = [];
    for (const row of headers) {
      const match = /x-request-id"?\s*:\s*"?([^",}\s]+)/i.exec(row.payloadJson);
      if (match && match[1] && !requestIds.includes(match[1])) requestIds.push(match[1]);
    }
    return { completedRequests: requests.length, requestIds, model };
  });
}

// --- the scenario ----------------------------------------------------------------------------------

/**
 * SCENARIO lJ (LIVE-LLM, REAL BROWSER): `/cards` shows a DEBIT/VIRTUAL card's LINKED SETTLEMENT ACCOUNT
 * cash — the binding is `Card.linkedAccountId → Account`, the amount is that account's balance, several
 * cards on one account share it and it is counted ONCE; a real transfer moves all three views together;
 * freezing the debit card and reporting the virtual card lost keep the real balance VISIBLE while making
 * the card explicitly unusable.
 */
export async function scenarioDebitCardLinkedAccount(params: DebitCardParams): Promise<string> {
  const { page, baseUrl, drive, captureShot } = params;

  // ---- P0: the server really runs the live model ------------------------------------------------
  const health = await readHealth(baseUrl);
  if (health.llmMode !== 'live') {
    fail(`GET /api/health 的 data.llmMode 应为 live，实际 ${health.llmMode}（本次必须跑真模型）`);
  }
  const model = liveModelId();

  // ---- P1: baseline — the binding, the money and the render all agree ---------------------------
  const account = await readAccount();
  const rawCards = await readRawCards();
  const consumptions = await readConsumptions();
  const debitRaw = rawCardById(rawCards, DEBIT_CARD_ID);
  const virtualRaw = rawCardById(rawCards, VIRTUAL_CARD_ID);
  const creditRaw = rawCardById(rawCards, CREDIT_CARD_ID);
  if (debitRaw.type !== 'DEBIT' || debitRaw.linkedAccountId !== account.id) {
    fail(`SQLite ${DEBIT_CARD_ID} 应为绑定 ${account.id} 的 DEBIT 卡，实际 ${JSON.stringify(debitRaw)}`);
  }
  if (virtualRaw.type !== 'VIRTUAL' || virtualRaw.linkedAccountId !== account.id) {
    fail(`SQLite ${VIRTUAL_CARD_ID} 应为绑定 ${account.id} 的 VIRTUAL 卡，实际 ${JSON.stringify(virtualRaw)}`);
  }
  if (creditRaw.type !== 'CREDIT' || creditRaw.linkedAccountId !== null) {
    fail(`SQLite ${CREDIT_CARD_ID} 应为无结算账户的 CREDIT 卡，实际 ${JSON.stringify(creditRaw)}`);
  }
  const cash = centsToMoney(account.balanceMinor);
  const virtualPayable = centsToMoney(
    expectedPayableMinor(virtualRaw.monthlyLimitMinor ?? 0n, familySpentMinor(rawCards, consumptions, VIRTUAL_CARD_ID), account.balanceMinor),
  );

  const cards0 = await fetchLiveCards(baseUrl);
  assertLinkedAccountView(cardById(cards0, DEBIT_CARD_ID), {
    cardId: DEBIT_CARD_ID,
    type: 'DEBIT',
    status: 'ACTIVE',
    usable: true,
    account,
    accountBalance: cash,
    payableAmount: cash,
  });
  assertLinkedAccountView(cardById(cards0, VIRTUAL_CARD_ID), {
    cardId: VIRTUAL_CARD_ID,
    type: 'VIRTUAL',
    status: 'ACTIVE',
    usable: true,
    account,
    accountBalance: cash,
    payableAmount: virtualPayable,
    monthlyLimit: centsToMoney(virtualRaw.monthlyLimitMinor ?? 0n),
  });
  // `NOT_APPLICABLE` (CREDIT) must omit EVERY account field — the closed-field-set half of the contract.
  const creditView0 = cardById(cards0, CREDIT_CARD_ID);
  if (creditView0 === undefined) fail(`GET /api/cards 缺少 ${CREDIT_CARD_ID}`);
  if (creditView0.linkedAccountStatus !== 'NOT_APPLICABLE') {
    fail(`${CREDIT_CARD_ID}.linkedAccountStatus 应为 NOT_APPLICABLE（信用卡不绑定结算账户），实际 ${creditView0.linkedAccountStatus}`);
  }
  for (const field of ['linkedAccountName', 'linkedAccountNumber', 'accountAvailableBalance', 'payableAmount'] as const) {
    if (creditView0[field] !== undefined) {
      fail(`${CREDIT_CARD_ID}（NOT_APPLICABLE）不得携带 ${field}，实际 ${excerpt(JSON.stringify(creditView0))}`);
    }
  }
  // Live-response invariant: ONLY `LINKED` carries account money — never a fabricated 0.00.
  for (const card of cards0) {
    const carriesMoney = card.accountAvailableBalance !== undefined;
    if ((card.linkedAccountStatus === 'LINKED') !== carriesMoney) {
      fail(`${card.id}: linkedAccountStatus=${card.linkedAccountStatus} 与 accountAvailableBalance=${card.accountAvailableBalance} 不一致（只有 LINKED 才带金额）`);
    }
  }

  await gotoCards(page, baseUrl);
  const debitRows0 = await readCardTileRows(page, DEBIT_CARD_ID);
  const debitText0 = await readCardTileText(page, DEBIT_CARD_ID);
  assertAccountTile(DEBIT_CARD_ID, debitRows0, debitText0, {
    accountBalance: cash,
    payableAmount: cash,
    statusText: t('business.cards.active'),
  });
  if (!debitText0.includes(t('business.cards.debit'))) fail(`${DEBIT_CARD_ID} 未渲染卡类型「${t('business.cards.debit')}」：${excerpt(debitText0)}`);
  if (!debitText0.includes(`${account.name} · ${account.number}`)) {
    fail(`${DEBIT_CARD_ID} 的「${CARD_LABEL.linkedAccount}」应显示「${account.name} · ${account.number}」：${excerpt(debitText0)}`);
  }
  // The 消费 entry belongs to the card the product actually lets spend from the page: an ACTIVE
  // (`usable`) VIRTUAL card. Like every footer button it is disabled until `/cards` settles, so the
  // state is read through `assertConsumeEntry`, never from the pre-refresh frame.
  await assertConsumeEntry(page, VIRTUAL_CARD_ID, 'enabled', 'ACTIVE（usable=true）的虚拟卡必须能打开消费表单，消费入口在此卡上真实存在');

  const virtualRows0 = await readCardTileRows(page, VIRTUAL_CARD_ID);
  const virtualText0 = await readCardTileText(page, VIRTUAL_CARD_ID);
  assertAccountTile(VIRTUAL_CARD_ID, virtualRows0, virtualText0, {
    accountBalance: cash,
    payableAmount: virtualPayable,
    statusText: t('business.cards.active'),
  });
  if (!virtualText0.includes(CARD_LABEL.monthlyLimit)) fail(`${VIRTUAL_CARD_ID} 未渲染「${CARD_LABEL.monthlyLimit}」：${excerpt(virtualText0)}`);

  const creditRows0 = await readCardTileRows(page, CREDIT_CARD_ID);
  const creditText0 = await readCardTileText(page, CREDIT_CARD_ID);
  assertCreditTile(CREDIT_CARD_ID, creditRows0, creditText0, creditView0.availableLimit ?? '0.00');

  const listText0 = await cardListText(page);
  // Credit wording belongs to CREDIT cards only; a debit instrument naming it would misrepresent cash.
  if (listText0.includes('授信额度')) fail(`/cards 卡片区出现「授信额度」（借记类卡片不得使用授信措辞）：${excerpt(listText0)}`);

  const dashboard0 = await readDashboard(baseUrl);
  if (dashboard0.checkingBalance !== cash) {
    fail(`GET /api/dashboard.checkingBalance 应为 ${cash}，实际 ${dashboard0.checkingBalance}`);
  }
  const creditFromCards0 = creditAvailableFromCards(cards0);
  if (dashboard0.creditAvailable !== creditFromCards0) {
    fail(`GET /api/dashboard.creditAvailable 应为非 LOST CREDIT 合计 ${creditFromCards0}，实际 ${dashboard0.creditAvailable}`);
  }
  const holdingsComponent = subtractDecimal(dashboard0.totalAssets, dashboard0.checkingBalance);
  const shotBaseline = await captureShot(page, 'lJ-baseline-cards');

  // ---- P2: a SECOND virtual card on the same account shares ONE balance, counted once -----------
  const cardsAtStart = new Set(cards0.map((card) => card.id));
  const applied = await applyVirtualCardViaAgent(page, baseUrl, drive, {
    excludeCardIds: [...cardsAtStart],
    monthlyLimit: SECOND_VIRTUAL_LIMIT,
  });
  const secondLimitMinor = moneyToCents(SECOND_VIRTUAL_LIMIT);
  const secondPayable = centsToMoney(expectedPayableMinor(secondLimitMinor, 0n, account.balanceMinor));
  const cards1 = await fetchLiveCards(baseUrl);
  const secondView = cardById(cards1, applied.cardId);
  assertLinkedAccountView(secondView, {
    cardId: applied.cardId,
    type: 'VIRTUAL',
    status: 'ACTIVE',
    usable: true,
    account,
    accountBalance: cash,
    payableAmount: secondPayable,
    monthlyLimit: SECOND_VIRTUAL_LIMIT,
  });
  const boundCards = cardsBoundToAccount(cards1);
  if (boundCards.length < 3) fail(`账户 ${account.id} 上应至少绑定 3 张卡（借记 + 2 张虚拟），实际 ${boundCards.map((card) => card.id).join('、')}`);
  for (const card of boundCards) {
    if (card.accountAvailableBalance !== cash) {
      fail(`${card.id}.accountAvailableBalance 应为同一账户余额 ${cash}（多卡共享，不是各卡副本），实际 ${card.accountAvailableBalance}`);
    }
  }
  await gotoCards(page, baseUrl);
  const secondRows1 = await readCardTileRows(page, applied.cardId);
  const secondText1 = await readCardTileText(page, applied.cardId);
  assertAccountTile(applied.cardId, secondRows1, secondText1, {
    accountBalance: cash,
    payableAmount: secondPayable,
    statusText: t('business.cards.active'),
  });
  const debitRows1 = await readCardTileRows(page, DEBIT_CARD_ID);
  const virtualRows1 = await readCardTileRows(page, VIRTUAL_CARD_ID);
  if (debitRows1[CARD_LABEL.accountBalance] !== secondRows1[CARD_LABEL.accountBalance]
    || virtualRows1[CARD_LABEL.accountBalance] !== secondRows1[CARD_LABEL.accountBalance]) {
    fail(`同一账户三张卡的「${CARD_LABEL.accountBalance}」应完全一致，实际 借记=${debitRows1[CARD_LABEL.accountBalance]} 虚拟=${virtualRows1[CARD_LABEL.accountBalance]} 新虚拟=${secondRows1[CARD_LABEL.accountBalance]}`);
  }
  const dashboard1 = await readDashboard(baseUrl);
  if (dashboard1.checkingBalance !== cash) {
    fail(`新开一张虚拟卡后 /api/dashboard.checkingBalance 不应变化，实际 ${dashboard1.checkingBalance}（开卡凭空造钱？）`);
  }
  if (compareDecimal(dashboard1.totalAssets, dashboard0.totalAssets) !== 0) {
    fail(`新开一张虚拟卡后 totalAssets 不应变化（卡片投影余额绝不进入资产合计）：${dashboard0.totalAssets} → ${dashboard1.totalAssets}`);
  }
  if (compareDecimal(subtractDecimal(dashboard1.totalAssets, dashboard1.checkingBalance), holdingsComponent) !== 0) {
    fail(`开卡后 (totalAssets - checkingBalance) 应保持持仓部分 ${holdingsComponent}，实际 ${subtractDecimal(dashboard1.totalAssets, dashboard1.checkingBalance)}`);
  }
  const shotSecondCard = await captureShot(page, 'lJ-second-virtual-card');

  // ---- P3: one REAL business (YELLOW transfer) — three views move together, cash counted once ---
  const beforeTransfer = await readAccount();
  const debitsBefore = await readAccountDebits();
  const knownDebitIds = new Set(debitsBefore.map((row) => row.id));
  const sentTransfer = await driveYellowTransfer(page, baseUrl, TRANSFER_PROMPT, TRANSFER_NUDGES);
  const afterTransferMinor = beforeTransfer.balanceMinor - TRANSFER_AMOUNT_MINOR;
  const settled = await waitFor(
    async () => {
      const [row, debits] = await Promise.all([readAccount(), readAccountDebits()]);
      const added = debits.filter((debit) => !knownDebitIds.has(debit.id) && debit.amountMinor === -TRANSFER_AMOUNT_MINOR);
      if (row.balanceMinor !== afterTransferMinor || added.length !== 1) return false;
      return { balanceMinor: row.balanceMinor, debit: added[0]! };
    },
    {
      timeoutMs: 180_000,
      intervalMs: 1_000,
      description: `转账 ${TRANSFER_AMOUNT}：SQLite 余额 ${cash} → ${centsToMoney(afterTransferMinor)} 且恰新增 1 条 DEBIT 流水`,
    },
  );
  if (!settled.debit.merchant.includes(RECIPIENT_NAME)) {
    fail(`新增 DEBIT 流水收款方应含「${RECIPIENT_NAME}」，实际 ${settled.debit.merchant}`);
  }
  const cash2 = centsToMoney(settled.balanceMinor);
  await gotoCards(page, baseUrl);
  const debitRows2 = await readCardTileRows(page, DEBIT_CARD_ID);
  const virtualRows2 = await readCardTileRows(page, VIRTUAL_CARD_ID);
  const secondRows2 = await readCardTileRows(page, applied.cardId);
  const cards2 = await fetchLiveCards(baseUrl);
  const dashboard2 = await readDashboard(baseUrl);
  // (a) DOM — every card bound to the account shows the SAME, NEW account cash.
  for (const [cardId, rows] of [
    [DEBIT_CARD_ID, debitRows2],
    [VIRTUAL_CARD_ID, virtualRows2],
    [applied.cardId, secondRows2],
  ] as const) {
    if (rows[CARD_LABEL.accountBalance] !== formatCNY(cash2)) {
      fail(`业务后 ${cardId} 的「${CARD_LABEL.accountBalance}」应为 ${formatCNY(cash2)}（绑定账户余额），实际 ${rows[CARD_LABEL.accountBalance]}`);
    }
  }
  // (b) GET /api/cards — every bound card projects the new cash.
  for (const card of cardsBoundToAccount(cards2)) {
    if (card.accountAvailableBalance !== cash2) {
      fail(`业务后 ${card.id}.accountAvailableBalance 应为 ${cash2}，实际 ${card.accountAvailableBalance}`);
    }
  }
  const virtualPayableAfter = centsToMoney(
    expectedPayableMinor(virtualRaw.monthlyLimitMinor ?? 0n, familySpentMinor(rawCards, consumptions, VIRTUAL_CARD_ID), settled.balanceMinor),
  );
  if (cardById(cards2, VIRTUAL_CARD_ID)?.payableAmount !== virtualPayableAfter) {
    fail(`${VIRTUAL_CARD_ID}.payableAmount 业务后应为 ${virtualPayableAfter}，实际 ${cardById(cards2, VIRTUAL_CARD_ID)?.payableAmount}`);
  }
  if (cardById(cards2, applied.cardId)?.payableAmount !== secondPayable) {
    fail(`${applied.cardId}.payableAmount 业务后应仍为 ${secondPayable}（月限额低于余额时由限额绑定），实际 ${cardById(cards2, applied.cardId)?.payableAmount}`);
  }
  // (c) GET /api/dashboard — the same new cash, credit untouched, assets down by EXACTLY one transfer.
  if (dashboard2.checkingBalance !== cash2) {
    fail(`业务后 /api/dashboard.checkingBalance 应为 ${cash2}，实际 ${dashboard2.checkingBalance}`);
  }
  if (dashboard2.creditAvailable !== creditAvailableFromCards(cards2)) {
    fail(`业务后 creditAvailable 应为非 LOST CREDIT 合计 ${creditAvailableFromCards(cards2)}，实际 ${dashboard2.creditAvailable}`);
  }
  const assetsDrop = subtractDecimal(dashboard1.totalAssets, dashboard2.totalAssets);
  if (compareDecimal(assetsDrop, TRANSFER_AMOUNT) !== 0) {
    fail(`totalAssets 应只下降 1 笔 ${TRANSFER_AMOUNT}（现金按账户计一次，不按卡重复计），实际下降 ${assetsDrop}`);
  }
  const shotTransferCards = await captureShot(page, 'lJ-transfer-cards');
  await page.goto(`${baseUrl}/overview`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  const overviewText = (await page.locator('main').first().innerText()).replace(/\s+/g, ' ');
  if (!overviewText.includes(formatCNY(cash2))) {
    fail(`/overview 未渲染业务后活期余额 ${formatCNY(cash2)}：${excerpt(overviewText)}`);
  }
  const shotOverview = await captureShot(page, 'lJ-transfer-overview');

  // ---- P4: freeze the DEBIT card — real balance stays visible, card explicitly unusable --------
  const sentFreeze = await drive(FREEZE_TURNS);
  const cards3 = await waitFor(
    async () => {
      const cards = await fetchLiveCards(baseUrl);
      return cardById(cards, DEBIT_CARD_ID)?.status === 'FROZEN' ? cards : false;
    },
    { timeoutMs: 180_000, intervalMs: 1_000, description: `${DEBIT_CARD_ID}.status === FROZEN（/agent 冻结链路）` },
  );
  const frozenRaw = rawCardById(await readRawCards(), DEBIT_CARD_ID);
  if (frozenRaw.status !== 'FROZEN') fail(`SQLite ${DEBIT_CARD_ID}.status 应为 FROZEN，实际 ${frozenRaw.status}`);
  if (frozenRaw.linkedAccountId !== account.id) fail(`冻结后 ${DEBIT_CARD_ID}.linkedAccountId 应仍为 ${account.id}，实际 ${frozenRaw.linkedAccountId}`);
  const afterFreeze = await readAccount();
  if (afterFreeze.balanceMinor !== settled.balanceMinor) {
    fail(`冻结卡不应移动任何资金：余额 ${cash2} → ${centsToMoney(afterFreeze.balanceMinor)}`);
  }
  assertLinkedAccountView(cardById(cards3, DEBIT_CARD_ID), {
    cardId: DEBIT_CARD_ID,
    type: 'DEBIT',
    status: 'FROZEN',
    usable: false,
    account,
    accountBalance: cash2,
    payableAmount: cash2,
  });
  await gotoCards(page, baseUrl);
  const frozenRows = await readCardTileRows(page, DEBIT_CARD_ID);
  const frozenText = await readCardTileText(page, DEBIT_CARD_ID);
  assertAccountTile(DEBIT_CARD_ID, frozenRows, frozenText, {
    accountBalance: cash2,
    payableAmount: cash2,
    statusText: t('business.cards.frozen'),
    unusableNotice: t('business.cards.cardFrozenNotice'),
  });
  // A FROZEN card keeps its real balance visible but is `usable = false`, so the page must withhold
  // the spend entry — asserted only after `/cards` settled, otherwise "disabled" would just be the
  // pre-refresh frame and the assertion would pass without proving anything.
  await assertConsumeEntry(page, DEBIT_CARD_ID, 'disabled', 'FROZEN 卡 usable=false：真实余额仍可见，但页面不得提供消费入口');
  const virtualRows3 = await readCardTileRows(page, VIRTUAL_CARD_ID);
  const virtualText3 = await readCardTileText(page, VIRTUAL_CARD_ID);
  assertAccountTile(VIRTUAL_CARD_ID, virtualRows3, virtualText3, {
    accountBalance: cash2,
    payableAmount: virtualPayableAfter,
    statusText: t('business.cards.active'),
  });
  // Freezing one card must not touch any other: this is the SAME VIRTUAL card that was enabled in P1,
  // so it must still be enabled here (the frozen DEBIT card above is the only one that lost its entry).
  await assertConsumeEntry(page, VIRTUAL_CARD_ID, 'enabled', '未被冻结的 ACTIVE 虚拟卡仍须可消费：冻结只影响那一张卡');
  const shotFrozen = await captureShot(page, 'lJ-frozen-card');

  // ---- P5: report the seed VIRTUAL card lost — balance visible, card explicitly unusable --------
  const lostTail = (cardById(cards3, VIRTUAL_CARD_ID)?.numberMasked ?? '').replace(/\D/g, '').slice(-4);
  if (lostTail.length !== 4) fail(`无法从 ${VIRTUAL_CARD_ID}.numberMasked 取到 4 位尾号：${cardById(cards3, VIRTUAL_CARD_ID)?.numberMasked}`);
  const sentLost = await drive([
    `尾号${lostTail}的虚拟卡丢失了，请正式挂失，我确认不可撤销。`,
    '确认，请正式挂失',
    `请直接为尾号${lostTail}的虚拟卡办理挂失`,
  ]);
  const cards4 = await waitFor(
    async () => {
      const cards = await fetchLiveCards(baseUrl);
      return cardById(cards, VIRTUAL_CARD_ID)?.status === 'LOST' ? cards : false;
    },
    { timeoutMs: 180_000, intervalMs: 1_000, description: `${VIRTUAL_CARD_ID}.status === LOST（/agent 挂失链路）` },
  );
  const lostRaw = rawCardById(await readRawCards(), VIRTUAL_CARD_ID);
  if (lostRaw.linkedAccountId !== account.id) fail(`挂失后 ${VIRTUAL_CARD_ID}.linkedAccountId 应仍为 ${account.id}，实际 ${lostRaw.linkedAccountId}`);
  const afterLost = await readAccount();
  if (afterLost.balanceMinor !== settled.balanceMinor) {
    fail(`挂失卡不应移动任何资金：余额 ${cash2} → ${centsToMoney(afterLost.balanceMinor)}`);
  }
  assertLinkedAccountView(cardById(cards4, VIRTUAL_CARD_ID), {
    cardId: VIRTUAL_CARD_ID,
    type: 'VIRTUAL',
    status: 'LOST',
    usable: false,
    account,
    accountBalance: cash2,
    payableAmount: virtualPayableAfter,
    monthlyLimit: centsToMoney(virtualRaw.monthlyLimitMinor ?? 0n),
  });
  await gotoCards(page, baseUrl);
  const lostRows = await readCardTileRows(page, VIRTUAL_CARD_ID);
  const lostText = await readCardTileText(page, VIRTUAL_CARD_ID);
  assertAccountTile(VIRTUAL_CARD_ID, lostRows, lostText, {
    accountBalance: cash2,
    payableAmount: virtualPayableAfter,
    statusText: t('business.cards.lost'),
    unusableNotice: t('business.cards.cardLostNotice'),
  });
  // The non-vacuous FLIP: this exact card was asserted `enabled` in P1 and P4; reporting it LOST makes
  // `usable` false, so the very same rendered control must now be disabled (balance still visible).
  await assertConsumeEntry(page, VIRTUAL_CARD_ID, 'disabled', 'LOST 卡 usable=false：此前 P1/P4 可用的消费入口在挂失后必须关闭');
  const dashboard4 = await readDashboard(baseUrl);
  if (dashboard4.checkingBalance !== cash2) fail(`挂失后 /api/dashboard.checkingBalance 应为 ${cash2}，实际 ${dashboard4.checkingBalance}`);
  const creditFromCards4 = creditAvailableFromCards(cards4);
  if (dashboard4.creditAvailable !== creditFromCards4) {
    fail(`挂失后 creditAvailable 应仍为非 LOST CREDIT 合计 ${creditFromCards4}（LOST 卡不参与信贷合计），实际 ${dashboard4.creditAvailable}`);
  }
  if (compareDecimal(dashboard4.totalAssets, dashboard2.totalAssets) !== 0) {
    fail(`挂失卡不应改变资产合计（卡片投影余额不进合计）：${dashboard2.totalAssets} → ${dashboard4.totalAssets}`);
  }
  const shotLost = await captureShot(page, 'lJ-lost-virtual-card');

  // ---- P6: evidence -----------------------------------------------------------------------------
  const modelEvidence = await readModelEvidence(model);
  if (modelEvidence.completedRequests === 0) fail('没有任何 completed 的 ModelRequest（模型并未真正参与本次运行）');
  if (modelEvidence.requestIds.length === 0) fail('没有任何带 x-request-id 的 provider_response_headers 证据（无法证明真模型调用）');
  const evidenceFile = writeScenarioEvidence('lJ', {
    scenario: 'lJ-live-debit-card-linked-account-balance',
    model,
    llmMode: health.llmMode,
    modelEvidence,
    sqlite: {
      account: { id: account.id, name: account.name, number: account.number, type: account.type, balanceMinorAtStart: account.balanceMinor, balanceMinorAfterTransfer: settled.balanceMinor },
      cardDebit: debitRaw,
      cardVirtual: virtualRaw,
      cardCredit: creditRaw,
      cardDebitAfterFreeze: frozenRaw,
      cardVirtualAfterLost: lostRaw,
      transferDebitRow: { id: settled.debit.id, amountMinor: settled.debit.amountMinor, merchant: settled.debit.merchant, category: settled.debit.category },
    },
    threeWay: {
      baseline: { dom: debitRows0[CARD_LABEL.accountBalance], apiCards: cash, accountBalance: cash, dashboardChecking: dashboard0.checkingBalance },
      afterTransfer: {
        domDebit: debitRows2[CARD_LABEL.accountBalance],
        domVirtual: virtualRows2[CARD_LABEL.accountBalance],
        domSecondVirtual: secondRows2[CARD_LABEL.accountBalance],
        apiCards: cash2,
        sqlite: centsToMoney(settled.balanceMinor),
        dashboardChecking: dashboard2.checkingBalance,
        assetsDrop,
      },
      afterFreeze: { domDebit: frozenRows[CARD_LABEL.accountBalance], domUsable: frozenRows[CARD_LABEL.usableBalance], sqlite: centsToMoney(afterFreeze.balanceMinor) },
      afterLost: { domVirtual: lostRows[CARD_LABEL.accountBalance], domUsable: lostRows[CARD_LABEL.usableBalance], sqlite: centsToMoney(afterLost.balanceMinor) },
    },
    renderedCopy: {
      debitTile: excerpt(debitText0, 400),
      debitTileFrozen: excerpt(frozenText, 400),
      virtualTileLost: excerpt(lostText, 400),
      creditTile: excerpt(creditText0, 400),
    },
    sentTurns: { transfer: sentTransfer, freeze: sentFreeze, lost: sentLost, secondVirtualCard: applied.sent },
    screenshots: { shotBaseline, shotSecondCard, shotTransferCards, shotOverview, shotFrozen, shotLost },
  });

  return `lJ 模型 ${model}（/api/health llmMode=${health.llmMode}，completed ModelRequest ${modelEvidence.completedRequests} 条，x-request-id 示例 ${modelEvidence.requestIds[0]}）｜`
    + `基线：SQLite Card.linkedAccountId(${DEBIT_CARD_ID})=${debitRaw.linkedAccountId} → Account ${account.name}/${account.number} ${cash}；`
    + `GET /api/cards ${DEBIT_CARD_ID} linkedAccountStatus=LINKED name=${account.name} number=${account.number} accountAvailableBalance=${cash} payableAmount=${cash} usable=true（无信用额度字段、无卡片自有余额）；`
    + `/cards DOM 行「${CARD_LABEL.linkedAccount}」=「${account.name} · ${account.number}」「${CARD_LABEL.accountBalance}」=${debitRows0[CARD_LABEL.accountBalance]}「${CARD_LABEL.usableBalance}」=${debitRows0[CARD_LABEL.usableBalance]} 状态=「${t('business.cards.active')}」；`
    + `虚拟卡 ${VIRTUAL_CARD_ID} 同一余额 ${virtualRows0[CARD_LABEL.accountBalance]}、可用 ${virtualRows0[CARD_LABEL.usableBalance]}（月限额 ${centsToMoney(virtualRaw.monthlyLimitMinor ?? 0n)}）；信用卡 ${CREDIT_CARD_ID} 只有「${CARD_LABEL.availableLimit}」=${creditRows0[CARD_LABEL.availableLimit]}、无账户行、无「${CARD_LABEL.linkedAccount}」；页面无「授信额度」；`
    + `第 2 张虚拟卡（自然语言「${applied.sent.join('」→「')}」）：${applied.cardId} 同余额 ${secondRows1[CARD_LABEL.accountBalance]}、可用 ${secondRows1[CARD_LABEL.usableBalance]}，三张卡账户余额全等，checkingBalance 与 totalAssets 未变；`
    + `真实业务「${sentTransfer.join('」→「')}」：SQLite 余额 ${cash} → ${centsToMoney(settled.balanceMinor)}（流水 ${settled.debit.id} ${settled.debit.amountMinor}），/cards DOM 借记=${debitRows2[CARD_LABEL.accountBalance]} 虚拟=${virtualRows2[CARD_LABEL.accountBalance]} 新虚拟=${secondRows2[CARD_LABEL.accountBalance]}，/api/cards=${cash2}，/api/dashboard.checkingBalance=${dashboard2.checkingBalance}，/overview 含 ${formatCNY(cash2)}，totalAssets 仅下降 ${assetsDrop}；`
    + `冻结（「${sentFreeze.join('」→「')}」）：SQLite status=FROZEN、usable=false、余额仍 ${frozenRows[CARD_LABEL.accountBalance]}、可用 ${frozenRows[CARD_LABEL.usableBalance]}，tile 逐字「${t('business.cards.frozen')}」+「${t('business.cards.cardFrozenNotice')}」，消费按钮 disabled，同时 ${VIRTUAL_CARD_ID} 仍可用；`
    + `挂失（「${sentLost.join('」→「')}」）：SQLite status=LOST、usable=false、余额仍 ${lostRows[CARD_LABEL.accountBalance]}、可用 ${lostRows[CARD_LABEL.usableBalance]}，tile 逐字「${t('business.cards.lost')}」+「${t('business.cards.cardLostNotice')}」，消费按钮 disabled，creditAvailable=${dashboard4.creditAvailable}（=非 LOST CREDIT 合计）、totalAssets 未变；`
    + `截图 ${[shotBaseline, shotSecondCard, shotTransferCards, shotOverview, shotFrozen, shotLost].map((shot) => shot ?? '未落盘').join(' / ')}；证据 JSON ${evidenceFile ?? '未落盘'}`;
}