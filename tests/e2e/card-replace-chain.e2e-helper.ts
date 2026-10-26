/**
 * `tests/e2e/card-replace-chain.e2e-helper.ts` — bodies of the two card-loss/补办 LIVE scenarios:
 *
 * - `scenarioCreditReplaceNewSession` ⇒ id `lF`: a FRESH session, report the demo credit card lost and
 *   replace it, then prove the replacement INHERITS its limit and that available credit is NOT counted
 *   twice (`18000.00`, never the naive `36000.00`).
 * - `scenarioFullCardChain` ⇒ id `lG`: the VERBATIM replay of the single-session chain that used to be
 *   refused with 「补办实体信用卡和借记卡只能在「卡片」页面手动办理」: open a virtual card, spend, 挂失,
 *   补办 (continuity), spend to the limit, then 挂失 + 补办 the credit card in the SAME conversation.
 *
 * WHY A SEPARATE MODULE: the entry script (`live-acceptance.e2e.ts`) keeps only registration lines, and
 * both scenarios share ONE pre-verification primitive — {@link driveReplaceLegAndVerify} — that the
 * generic bounded RED driver cannot express: it must STOP while the `replace_card` `PendingAction` is
 * still parked, assert "no card yet / no status change yet", and only THEN submit the real MFA code.
 *
 * Everything else is REUSED: the read model / DB primitives / payable maths / consume-dialog drivers
 * come from `./live-virtual-card.e2e-helper`, the browser+chat+panel primitives from `./helpers`, and the
 * bounded RED driver (with its fabricated-panel guard) is INJECTED as {@link RedToolDriver} from the
 * entry script, so `assertNoFabricatedConfirmationPanel` keeps a single implementation.
 *
 * This file carries no `.test.`/`.spec.` suffix and is never collected by Vitest.
 */
import { spawnSync } from 'node:child_process';
import type { Page } from 'playwright-core';
import { centsToMoney, formatCNY, moneyToCents } from '../../lib/money';
import { CARD_LABEL, CARD_LABEL_RETIRED } from './card-labels.e2e-helper';
import { assertIssuanceReceipt } from './issuance-receipt.e2e-helper';
import {
  REPO_ROOT,
  SELECTORS,
  assertNoFabricatedConfirmationPanel,
  assistantTexts,
  clickConfirm,
  diffLedger,
  fetchDashboardSummary,
  fetchLedger,
  fetchPendingActions,
  gotoAgent,
  mfaCardPresent,
  sleep,
  submitChat,
  submitMfa,
  waitFor,
  waitForElementHydration,
  waitForMfaCard,
  type LedgerView,
  type PendingActionView,
} from './helpers';
import {
  VC_APPLY_TURNS,
  VC_CHECKING_ACCOUNT_ID,
  VC_FIRST_SPEND,
  VC_LIMIT_EXCEEDED_TEXT,
  VC_MERCHANT_APPLY,
  VC_MERCHANT_REFUSED,
  VC_MERCHANT_REPLACE,
  VC_MONTHLY_LIMIT,
  VC_SECOND_SPEND,
  VC_SPEND_CATEGORY,
  VC_TINY_SPEND,
  applyVirtualCardViaAgent,
  assertNoSpend,
  assertSingleSpend,
  attemptConsumeExpectingRefusal,
  awaitRawCard,
  cardById,
  consumeSuccessfully,
  expectedPayableMinor,
  fetchLiveCards,
  gotoCards,
  liveModelId,
  minorOf,
  openConsumeDialog,
  readCardSpendState,
  readCardTileRows,
  readRawCard,
  vcReplaceTurns,
  vcReportLostTurns,
  withDb,
  writeScenarioEvidence,
  type CardSpendState,
  type LiveCardRecord,
  type RawCardRow,
  type RedToolDriver,
} from './live-virtual-card.e2e-helper';

// --- scenario contract ---------------------------------------------------------------------------

/**
 * Everything a scenario body needs. The entry script owns the browser context, the bounded RED driver
 * and the screenshot sequencer, so it INJECTS them instead of this module reaching into the entry.
 */
export interface CardChainParams {
  page: Page;
  baseUrl: string;
  /** The entry script's bounded RED-tool driver (`driveRedTool`), fabricated-panel guard included. */
  drive: RedToolDriver;
  /** The entry script's screenshot helper (`captureLive`); never throws, may return `undefined`. */
  captureShot: (page: Page, label: string) => Promise<string | undefined>;
}

// --- seed / prompt facts -------------------------------------------------------------------------

/** The demo CREDIT card the user loses and replaces. */
export const LF_CREDIT_CARD_ID = 'card_credit';
export const LF_DEBIT_CARD_ID = 'card_debit';
export const LF_VIRTUAL_CARD_ID = 'card_virtual';
/** The seeded credit-card mask — the 补办 card must carry a DIFFERENT number. */
export const LF_CREDIT_CARD_MASK = '****6688';
/** The seeded credit limit / available limit the 补办 card must INHERIT unchanged. */
export const LF_CREDIT_LIMIT_MINOR = 1_800_000n;
/** `availableLimit` of the seeded credit card (`GET /api/cards` money string). */
export const LF_CREDIT_AVAILABLE = '18000.00';
/** The BUG SIGNATURE: summing ALL `CREDIT` rows (the `LOST` source included) yields double credit. */
export const LF_CREDIT_NAIVE_TOTAL = '36000.00';
/** The only verification code the live scenarios accept. */
export const LF_MFA_CODE = '123456';
/** At most this many natural turns per business leg (a bounded loop, never an open-ended nudge). */
export const MAX_TURNS_PER_LEG = 6;

/**
 * The natural-language nudge the objective pins for "the model only narrated, do it for real".
 * It ASKS for a real pending action — it never claims that a panel already exists.
 */
export const CARD_CHAIN_NUDGE = '确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。';

/** lF: 挂失 the credit card, then 补办 it (the exact prompt of the previously-refused request). */
export const LF_REPORT_LOST_PROMPT = '我的尾号6688信用卡丢失了，请正式挂失，我确认不可撤销。';
export const LF_REPLACE_PROMPT = '请为刚挂失的尾号6688信用卡补办新卡。';

/** lG step 1 — VERBATIM user prompt (recorded per turn in the evidence). */
export const LG_VC_APPLY_PROMPT = '请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。';
/** lG step 3 — VERBATIM user prompt. */
export function lgVcReportLostPrompt(maskTail: string): string {
  return `尾号${maskTail}的虚拟卡信息泄露，请正式挂失，我确认不可撤销。`;
}
/** lG step 4 — VERBATIM user prompt. */
export function lgVcReplacePrompt(maskTail: string): string {
  return `请为刚才正式挂失的尾号${maskTail}虚拟卡再补办一张新卡。`;
}
/** lG step 6 — VERBATIM user prompt. */
export const LG_CREDIT_REPORT_LOST_PROMPT = '尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。';
/** lG step 7 — the prompt that used to be REFUSED with the manual-only sentence. */
export const LG_CREDIT_REPLACE_PROMPT = LF_REPLACE_PROMPT;
/** lG step 8 — VERBATIM final turn of the replay. */
export const LG_FINAL_CONFIRM_PROMPT = '确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。';

/** The masked tail (last 4 digits) the natural-language 挂失/补办 turns refer to. */
export function cardMaskTail(numberMasked: string): string {
  const digits = numberMasked.replace(/\D+/g, '');
  if (digits.length < 4) throw new Error(`卡片掩码「${numberMasked}」不含可用的尾号 4 位`);
  return digits.slice(-4);
}

/** The certified product-tree commit (`git rev-parse --short HEAD`) — never a secret. */
export function certifiedHead(): string {
  const out = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true });
  const text = (out.stdout ?? '').trim();
  return out.status === 0 && text !== '' ? text : '(未知)';
}

// --- rendered `CardTile` label contract ----------------------------------------------------------
//
// `readCardTileRows` keys its `Record<renderedLabel, renderedValue>` by the label the tile ACTUALLY
// renders, so every lookup in this module goes through {@link CARD_LABEL} (`./card-labels.e2e-helper`,
// derived from `lib/i18n/messages/business.zh-CN.json` — the very catalogue
// `components/banking/CardTile.tsx` renders from). A hard-coded literal turns a catalogue rename into a
// silent `undefined` lookup, which then fails for the wrong reason (or passes vacuously on an absence).

/**
 * A superseded label must not be a row any more. `CARD_LABEL_RETIRED` (`账户可用余额` / `当前可支付金额`)
 * stays in the catalogue, so this proves a tile renders the CURRENT rows — `账户余额` / `可用余额` —
 * instead of merely forgetting the old ones: finding a retired row is a rendering defect.
 */
export function assertNoRetiredCardLabels(rows: Record<string, string>, label: string): void {
  if (CARD_LABEL_RETIRED.accountAvailable in rows || CARD_LABEL_RETIRED.payableAmount in rows) {
    throw new Error(
      `${label}：卡片不得再渲染已废弃标签「${CARD_LABEL_RETIRED.accountAvailable}」/「${CARD_LABEL_RETIRED.payableAmount}」，实际渲染行 ${JSON.stringify(rows)}`,
    );
  }
}

/**
 * A `CREDIT` tile renders its credit rows and NO settlement-account amount: a credit card's
 * `CardView.linkedAccountStatus` is always `NOT_APPLICABLE` (`banking-sdk/types.ts`), so it has no
 * account cash — inventing an `账户余额` row for it is exactly the credit/debit confusion to avoid.
 */
export function assertCreditTileLabels(rows: Record<string, string>, label: string): void {
  assertNoRetiredCardLabels(rows, label);
  if (rows[CARD_LABEL.creditLimit] === undefined || rows[CARD_LABEL.availableLimit] === undefined) {
    throw new Error(
      `${label}：CREDIT 卡片必须渲染「${CARD_LABEL.creditLimit}」与「${CARD_LABEL.availableLimit}」两行，实际渲染行 ${JSON.stringify(rows)}`,
    );
  }
  if (rows[CARD_LABEL.accountBalance] !== undefined || rows[CARD_LABEL.usableBalance] !== undefined) {
    throw new Error(
      `${label}：CREDIT 卡片没有结算账户，不得渲染「${CARD_LABEL.accountBalance}」/「${CARD_LABEL.usableBalance}」行，实际渲染行 ${JSON.stringify(rows)}`,
    );
  }
}

/**
 * A card whose settlement ACCOUNT resolved renders the account rows and NO credit row: a `VIRTUAL` /
 * `DEBIT` card is a debit instrument drawing on that account's cash, so `信用额度` / `可用额度` on it
 * would be a credit line invented on top of cash. Those rows carry the REAL amounts even while the card
 * is unusable (`usable === false`, e.g. `LOST`) — unusable is not empty.
 *
 * `MISSING` / `UNTRUSTED` — ONLY the notice (`未关联账户` / `账户暂不可用`) and NO money row at all,
 * never a placeholder `0.00`.
 */
export function assertLinkedAccountTileLabels(
  rows: Record<string, string>,
  label: string,
  status: 'LINKED' | 'MISSING' | 'UNTRUSTED' = 'LINKED',
  tileText?: string,
): void {
  assertNoRetiredCardLabels(rows, label);
  if (status !== 'LINKED') {
    const notice = status === 'MISSING' ? CARD_LABEL.linkedAccountMissing : CARD_LABEL.linkedAccountUntrusted;
    for (const moneyRow of [CARD_LABEL.accountBalance, CARD_LABEL.usableBalance]) {
      if (rows[moneyRow] !== undefined) {
        throw new Error(
          `${label}：linkedAccountStatus=${status} 时不得渲染「${moneyRow}」行（该状态没有金额，绝不以 0.00 冒充），实际渲染行 ${JSON.stringify(rows)}`,
        );
      }
    }
    if (tileText !== undefined && !tileText.includes(notice)) {
      throw new Error(`${label}：linkedAccountStatus=${status} 时应渲染提示「${notice}」：${tileText.slice(0, 240)}`);
    }
    return;
  }
  if (rows[CARD_LABEL.accountBalance] === undefined || rows[CARD_LABEL.usableBalance] === undefined) {
    throw new Error(
      `${label}：绑定账户的非信用卡必须渲染「${CARD_LABEL.accountBalance}」与「${CARD_LABEL.usableBalance}」两行，实际渲染行 ${JSON.stringify(rows)}`,
    );
  }
  if (rows[CARD_LABEL.creditLimit] !== undefined || rows[CARD_LABEL.availableLimit] !== undefined) {
    throw new Error(
      `${label}：非信用卡不得渲染信用额度行「${CARD_LABEL.creditLimit}」/「${CARD_LABEL.availableLimit}」，实际渲染行 ${JSON.stringify(rows)}`,
    );
  }
}

// --- credit-available maths (ONE definition, shared by lF's before/after diff) ---------------------

/**
 * Spendable credit: every `CREDIT` card that is NOT `LOST`. A 补办 card's source stays in the read model
 * as `LOST` and KEEPS its recorded `availableLimit`, so counting both would double the allowance.
 */
export function nonLostCreditAvailableTotalMinor(cards: readonly LiveCardRecord[]): bigint {
  return cards
    .filter((card) => card.type === 'CREDIT' && card.status !== 'LOST' && card.availableLimit !== undefined)
    .reduce((sum, card) => sum + moneyToCents(card.availableLimit as string), 0n);
}

/** The NAIVE total over ALL `CREDIT` cards INCLUDING `LOST` ones — recorded only to expose the trap. */
export function allCreditAvailableTotalMinor(cards: readonly LiveCardRecord[]): bigint {
  return cards
    .filter((card) => card.type === 'CREDIT' && card.availableLimit !== undefined)
    .reduce((sum, card) => sum + moneyToCents(card.availableLimit as string), 0n);
}

/** One-line card listing for failure messages + evidence. */
export function describeCards(cards: readonly LiveCardRecord[]): string {
  return cards
    .map((card) => `${card.id}:${card.type}:${card.status}:可用=${card.availableLimit ?? '无'}:被补=${card.replacedByCardId ?? '无'}`)
    .join(' ');
}

/** The UNIQUE `CREDIT` + `ACTIVE` card, or `undefined` when there is none / more than one. */
export function uniqueActiveCreditCard(cards: readonly LiveCardRecord[]): LiveCardRecord | undefined {
  const matches = cards.filter((card) => card.type === 'CREDIT' && card.status === 'ACTIVE');
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The credit-available figure the `/cards` PAGE actually renders: the `可用额度` `<dd>` of every
 * `CREDIT` tile, summed by card id. `app/cards/page.tsx` renders NO page-level aggregate, so "counted
 * once" can only be proven per tile — `includeLost: false` implements the correct (non-double) reading.
 *
 * The row label is {@link CARD_LABEL.availableLimit}: the string `CardTile` actually renders, never a
 * literal that a catalogue rename would silently turn into an `undefined` row.
 */
export async function renderedCreditAvailableMinor(
  page: Page,
  cards: readonly LiveCardRecord[],
  opts: { includeLost: boolean },
): Promise<bigint> {
  const creditCards = cards.filter(
    (card) => card.type === 'CREDIT' && card.availableLimit !== undefined && (opts.includeLost || card.status !== 'LOST'),
  );
  let total = 0n;
  for (const card of creditCards) {
    await waitForElementHydration(page, `[data-card-id="${card.id}"]`);
    const rows = await readCardTileRows(page, card.id);
    total += minorOf(rows[CARD_LABEL.availableLimit], `${card.id} 卡片渲染的「${CARD_LABEL.availableLimit}」`);
  }
  return total;
}

// --- money / ledger invariance -------------------------------------------------------------------

/** `GET /api/dashboard` + `GET /api/bills` as one comparable snapshot. */
export interface CardChainMoneySnapshot {
  checkingBalance: string;
  ledger: LedgerView;
}

/** Read the two authoritative money views (a 补办 must move NO money). */
export async function readCardChainMoneySnapshot(baseUrl: string): Promise<CardChainMoneySnapshot> {
  const [dashboard, ledger] = await Promise.all([fetchDashboardSummary(baseUrl), fetchLedger(baseUrl)]);
  return { checkingBalance: dashboard.checkingBalance, ledger };
}

/** Assert a step neither moved cash nor changed the transaction list at all. */
export function assertCardChainMoneyUnchanged(
  before: CardChainMoneySnapshot,
  after: CardChainMoneySnapshot,
  label: string,
): void {
  if (before.checkingBalance !== after.checkingBalance) {
    throw new Error(`${label}：活期余额不得变化，实际 ${before.checkingBalance} → ${after.checkingBalance}`);
  }
  const diff = diffLedger(before.ledger.transactions, after.ledger.transactions);
  if (diff.added.length !== 0 || diff.removed.length !== 0) {
    throw new Error(`${label}：GET /api/bills 流水不得变化，实际新增 ${diff.added.length} 条、消失 ${diff.removed.length} 条`);
  }
}

// --- parked `PendingAction` read/assert primitives -----------------------------------------------

/** The statuses `/api/actions` treats as a live decision (`app/api/actions/route.ts`). */
const DECISION_STATUSES: readonly string[] = ['pending', 'awaiting_mfa'];

/** The live decision rows of `/api/actions` (never `executed`/`cancelled`/`locked`). */
export function decisionActions(actions: readonly PendingActionView[]): PendingActionView[] {
  return actions.filter((action) => DECISION_STATUSES.includes(action.status));
}

/** The live `replace_card` decision row (the ONLY accepted form of a 补办 request). */
export function replaceDecisionActions(actions: readonly PendingActionView[]): PendingActionView[] {
  return decisionActions(actions).filter((action) => action.toolName === 'replace_card');
}

/**
 * Poll `/api/actions` for a live decision row of `toolName` until `timeoutMs`, then give up and return
 * `undefined`. Deliberately explicit: the caller (a bounded nudge loop) decides what a miss means.
 */
export async function pollForPendingTool(
  baseUrl: string,
  toolName: string,
  timeoutMs: number,
  ignoreActionIds: ReadonlySet<string> = new Set(),
): Promise<PendingActionView | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const actions = await fetchPendingActions(baseUrl);
    const hit = decisionActions(actions).find((action) => action.toolName === toolName && !ignoreActionIds.has(action.id));
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) return undefined;
    await sleep(1_000);
  }
}

/** The raw `PendingAction` (+ its `MfaChallenge`) row asserted as evidence. */
export interface PendingActionRow {
  id: string;
  toolName: string;
  status: string;
  riskLevel: string;
  requiresMfa: boolean;
  argsJson: string;
  mfa: { id: string; status: string; attempts: number; maxAttempts: number } | null;
}

/** One `PendingAction` row straight from SQLite (the server-side truth behind `/api/actions`). */
export async function readPendingActionRow(actionId: string): Promise<PendingActionRow> {
  return withDb(async (db) => {
    const row = await db.pendingAction.findUnique({
      where: { id: actionId },
      select: {
        id: true,
        toolName: true,
        status: true,
        riskLevel: true,
        requiresMfa: true,
        argsJson: true,
        mfa: { select: { id: true, status: true, attempts: true, maxAttempts: true } },
      },
    });
    if (!row) throw new Error(`SQLite 缺少 PendingAction 行 ${actionId}`);
    return row;
  });
}

/** Every `PendingAction` of the given tools with its MFA challenge — the replay evidence. */
export function readPendingActionRows(toolNames: readonly string[]): Promise<PendingActionRow[]> {
  return withDb(async (db) => {
    const rows = await db.pendingAction.findMany({
      where: { toolName: { in: [...toolNames] } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        toolName: true,
        status: true,
        riskLevel: true,
        requiresMfa: true,
        argsJson: true,
        mfa: { select: { id: true, status: true, attempts: true, maxAttempts: true } },
      },
    });
    return rows;
  });
}

/** The tool-call events the runtime journaled (written by Pi before any effect). */
export interface ToolEventRow {
  sequence: number;
  eventType: string;
  payload: string;
}

/** Recent `tool_execution_*` events (`AgentRunEvent`, channel `raw`) — evidence only, never asserted. */
export function readToolEvents(limit = 80): Promise<ToolEventRow[]> {
  return withDb(async (db) => {
    const rows = await db.agentRunEvent.findMany({
      where: { eventType: { startsWith: 'tool_execution' } },
      orderBy: { sequence: 'desc' },
      take: limit,
      select: { sequence: true, eventType: true, payloadJson: true },
    });
    return rows.map((row) => ({ sequence: row.sequence, eventType: row.eventType, payload: row.payloadJson.slice(0, 400) }));
  });
}

// --- the pre-verification primitive (the reason this module exists) -------------------------------

/** What a `replace_card` leg proved BEFORE the verification code was submitted. */
export interface ReplacePreVerification {
  cardCount: number;
  sourceStatus: string;
  sourceReplacedByCardId: string | null;
  /** Cards created by this leg before verification — must be empty. */
  newlyCreatedCardIds: string[];
}

/** The outcome of one bounded 补办 leg. */
export interface ReplaceLegResult {
  /** The prompts the leg actually sent (≤ {@link MAX_TURNS_PER_LEG}). */
  turns: string[];
  /** The assistant prose of every prose turn, verbatim. */
  prose: string[];
  /** The real `/api/actions` decision row (RED + requiresMfa) that gated the write. */
  action: PendingActionView;
  /** The same row read back from SQLite. */
  actionRow: PendingActionRow;
  preVerification: ReplacePreVerification;
}

/**
 * Complete a REAL confirmation + MFA panel: click 确认 when the gateway parked a `pending` action, then
 * submit the real code on the MFA card. Fails (never silently succeeds) when no card renders.
 */
export async function completeConfirmationPanel(page: Page, label: string, code = LF_MFA_CODE): Promise<void> {
  if (!(await mfaCardPresent(page))) {
    await clickConfirm(page, 90_000);
  }
  await waitForMfaCard(page, 120_000);
  await submitMfa(page, code, 60_000);
  void label;
}

/**
 * Drive a `replace_card` leg through bounded natural turns and STOP at the parked `PendingAction`:
 *
 * 1. every turn's prose is guarded by `assertNoFabricatedConfirmationPanel` (a claimed panel with no
 *    `PendingAction` is a user-visible defect, never model noise);
 * 2. as soon as `/api/actions` exposes a NEW `replace_card` decision row, the PRE-VERIFICATION state is
 *    asserted (RED + requiresMfa, no new card, no status change, card count unchanged);
 * 3. only then is the real MFA code submitted.
 *
 * A bounded loop that never parks a `replace_card` action is a MANDATORY FAILURE — that is exactly the
 * regression this leg exists to catch (a manual-only refusal must never pass as "model variance").
 */
export async function driveReplaceLegAndVerify(
  params: CardChainParams,
  opts: { sourceCardId: string; prompts: readonly string[]; label: string },
): Promise<ReplaceLegResult> {
  const { page, baseUrl } = params;
  const prompts = opts.prompts.slice(0, MAX_TURNS_PER_LEG);
  if (prompts.length === 0) throw new Error(`${opts.label}：未提供任何自然语言轮次`);
  const cardsBefore = await fetchLiveCards(baseUrl);
  const knownIds = new Set(cardsBefore.map((card) => card.id));
  const ignoreActionIds = new Set((await fetchPendingActions(baseUrl)).map((action) => action.id));
  const turns: string[] = [];
  const prose: string[] = [];
  let action: PendingActionView | undefined;

  for (const prompt of prompts) {
    const baseline = (await assistantTexts(page)).length;
    await submitChat(page, prompt);
    turns.push(prompt);
    const hit = await pollForPendingTool(baseUrl, 'replace_card', 120_000, ignoreActionIds);
    const turnProse = (await assistantTexts(page)).slice(baseline).join('\n');
    prose.push(turnProse);
    assertNoFabricatedConfirmationPanel({ page, prose: turnProse, actions: await fetchPendingActions(baseUrl) });
    if (hit !== undefined) {
      action = hit;
      break;
    }
  }
  if (action === undefined) {
    throw new Error(
      `${opts.label}：有界 ${prompts.length} 轮自然语言后 /api/actions 仍无 replace_card 待确认动作（模型未发起受控工具或只称需人工办理）；实际发送：${turns.map((t) => `「${t}」`).join(' → ')}；模型散文：${prose.map((p) => `「${p.replace(/\s+/g, ' ').slice(0, 300)}」`).join(' | ')}`,
    );
  }

  // The parked action must be the RED write the contract promises — checked on BOTH surfaces.
  if (action.tier !== 'RED') throw new Error(`${opts.label}：replace_card 待确认动作应为 RED，实际 tier=${action.tier}`);
  if (action.requiresMfa !== true) throw new Error(`${opts.label}：replace_card 待确认动作必须要求 MFA，实际 requiresMfa=${action.requiresMfa}`);
  const actionRow = await readPendingActionRow(action.id);
  if (actionRow.toolName !== 'replace_card') throw new Error(`${opts.label}：SQLite PendingAction.toolName 应为 replace_card，实际 ${actionRow.toolName}`);
  if (actionRow.requiresMfa !== true) throw new Error(`${opts.label}：SQLite PendingAction.requiresMfa 应为 true，实际 ${actionRow.requiresMfa}`);
  if (!DECISION_STATUSES.includes(actionRow.status)) throw new Error(`${opts.label}：验证前 PendingAction.status 应留在待确认态，实际 ${actionRow.status}`);

  // PRE-VERIFICATION: nothing may have happened yet.
  const cardsAtPark = await fetchLiveCards(baseUrl);
  const createdIds = cardsAtPark.filter((card) => !knownIds.has(card.id)).map((card) => card.id);
  if (createdIds.length !== 0) {
    throw new Error(`${opts.label}：验证前不得创建任何新卡，实际新增 ${createdIds.join(',')}（全部卡片：${describeCards(cardsAtPark)}）`);
  }
  if (cardsAtPark.length !== cardsBefore.length) {
    throw new Error(`${opts.label}：验证前卡片总数应不变（${cardsBefore.length}），实际 ${cardsAtPark.length}：${describeCards(cardsAtPark)}`);
  }
  const sourceAtPark = await readRawCard(opts.sourceCardId);
  if (sourceAtPark.status !== 'LOST') {
    throw new Error(`${opts.label}：验证前源卡 ${opts.sourceCardId} 应已是 LOST（先挂失再补办），实际 ${sourceAtPark.status}`);
  }
  if (sourceAtPark.replacedByCardId !== null) {
    throw new Error(`${opts.label}：验证前源卡不应已关联补办卡，实际 replacedByCardId=${sourceAtPark.replacedByCardId}`);
  }

  await completeConfirmationPanel(page, opts.label);
  return {
    turns,
    prose,
    action,
    actionRow,
    preVerification: {
      cardCount: cardsAtPark.length,
      sourceStatus: sourceAtPark.status,
      sourceReplacedByCardId: sourceAtPark.replacedByCardId,
      newlyCreatedCardIds: createdIds,
    },
  };
}

// --- replacement outcome -------------------------------------------------------------------------

/** The authoritative consequence of one 补办 leg. */
export interface CardReplacementOutcome {
  replacementId: string;
  replacementRaw: RawCardRow;
  sourceRaw: RawCardRow;
  cards: LiveCardRecord[];
  /** Exactly one id, always — more than one new card is a FAILURE inside this helper. */
  createdIds: string[];
}

/**
 * Wait for the REAL post-MFA state: the source points at its 补办 card, that card is ACTIVE and of
 * `expectedType`, and `GET /api/cards` carries EXACTLY ONE new card — the replacement.
 */
export async function awaitCardReplacement(
  params: CardChainParams,
  opts: {
    sourceCardId: string;
    knownIds: ReadonlySet<string>;
    expectedType: 'CREDIT' | 'VIRTUAL' | 'DEBIT';
    label: string;
  },
): Promise<CardReplacementOutcome> {
  const sourceRaw = await awaitRawCard(
    opts.sourceCardId,
    (row) => typeof row.replacedByCardId === 'string' && row.replacedByCardId !== '',
    `${opts.label}：源卡 ${opts.sourceCardId}.replacedByCardId 指向补办卡`,
  );
  const replacementId = sourceRaw.replacedByCardId as string;
  const replacementRaw = await awaitRawCard(
    replacementId,
    (row) => row.type === opts.expectedType && row.status === 'ACTIVE',
    `${opts.label}：补办卡 ${replacementId} 应为 ACTIVE 的 ${opts.expectedType} 卡`,
  );
  if (replacementRaw.numberMasked === sourceRaw.numberMasked) {
    throw new Error(`${opts.label}：补办卡卡号必须不同于源卡，实际均为 ${replacementRaw.numberMasked}`);
  }
  const cards = await waitFor(
    async () => {
      const list = await fetchLiveCards(params.baseUrl);
      const created = list.filter((card) => !opts.knownIds.has(card.id));
      return created.length === 1 && created[0].id === replacementId ? list : false;
    },
    {
      timeoutMs: 180_000,
      intervalMs: 1_000,
      description: `${opts.label}：GET /api/cards 应恰新增 1 张卡（${replacementId}）`,
    },
  );
  const createdIds = cards.filter((card) => !opts.knownIds.has(card.id)).map((card) => card.id);
  if (createdIds.length !== 1 || createdIds[0] !== replacementId) {
    throw new Error(`${opts.label}：应恰新增 1 张补办卡 ${replacementId}，实际新增 ${createdIds.join(',')}：${describeCards(cards)}`);
  }
  return { replacementId, replacementRaw, sourceRaw, cards, createdIds };
}

/** Poll `GET /api/cards` until `cardId.payableAmount === expected` (the documented projection). */
export function awaitPayableAmount(
  baseUrl: string,
  cardId: string,
  expected: string,
  label: string,
): Promise<LiveCardRecord[]> {
  return waitFor(
    async () => {
      const cards = await fetchLiveCards(baseUrl);
      return cardById(cards, cardId)?.payableAmount === expected ? cards : false;
    },
    {
      timeoutMs: 180_000,
      intervalMs: 1_000,
      description: `${label}：${cardId}.payableAmount === ${expected}（min(账户余额, 剩余月限额)）`,
    },
  );
}

/** The bounded turn list of one REPORT-LOST leg: the verbatim first prompt + the shared nudges. */
export function withFirstTurn(first: string, rest: readonly string[]): string[] {
  return [first, ...rest].slice(0, MAX_TURNS_PER_LEG);
}

/** Assert a leg stayed inside the bounded-turn budget. */
export function assertBoundedLeg(sent: readonly string[], label: string): void {
  if (sent.length > MAX_TURNS_PER_LEG) {
    throw new Error(`${label}：有界轮次不得超过 ${MAX_TURNS_PER_LEG}，实际 ${sent.length} 轮：${sent.map((t) => `「${t}」`).join(' → ')}`);
  }
}

/** Truncated prose for the one-line evidence string (full prose goes to the JSON blob). */
function brief(texts: readonly string[], max = 240): string {
  const joined = texts.map((text) => text.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
  return joined === '' ? '(无散文)' : joined.length > max ? `${joined.slice(0, max)}…` : joined;
}

// --- SCENARIO lF ---------------------------------------------------------------------------------

/**
 * SCENARIO lF (LIVE-LLM, REAL BROWSER, FRESH SESSION): report the demo credit card lost, then 补办 it
 * and prove the 补办 is a REAL gated write with inherited limits and NO double-counted credit.
 *
 * Requirements 1–8 of the objective map onto the numbered blocks below.
 */
export async function scenarioCreditReplaceNewSession(params: CardChainParams): Promise<string> {
  const { page, baseUrl, drive, captureShot } = params;
  const head = certifiedHead();
  const model = liveModelId();
  await gotoAgent(page, baseUrl);

  // BASELINE (before 挂失) — the only reference for "credit available must not grow".
  const cardsBeforeLost = await fetchLiveCards(baseUrl);
  const sourceBefore = cardById(cardsBeforeLost, LF_CREDIT_CARD_ID);
  if (sourceBefore?.type !== 'CREDIT' || sourceBefore.status !== 'ACTIVE' || sourceBefore.availableLimit === undefined) {
    throw new Error(`挂失前 ${LF_CREDIT_CARD_ID} 应为带 availableLimit 的 ACTIVE CREDIT 卡，实际 ${JSON.stringify(sourceBefore)}`);
  }
  const availableBeforeLostMinor = nonLostCreditAvailableTotalMinor(cardsBeforeLost);
  const naiveBeforeLostMinor = allCreditAvailableTotalMinor(cardsBeforeLost);
  if (availableBeforeLostMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`挂失前非 LOST 信用卡可用额度合计应为 ${LF_CREDIT_LIMIT_MINOR}（${LF_CREDIT_AVAILABLE}），实际 ${availableBeforeLostMinor}：${describeCards(cardsBeforeLost)}`);
  }
  const moneyBeforeLost = await readCardChainMoneySnapshot(baseUrl);

  // (1) 挂失 — bounded natural turns + the REAL confirmation/MFA panel.
  const proseBeforeLost = (await assistantTexts(page)).length;
  const lostTurns = await drive(withFirstTurn(LF_REPORT_LOST_PROMPT, vcReportLostTurns('6688').slice(1)));
  assertBoundedLeg(lostTurns, 'lF 挂失信用卡');
  const lostProse = (await assistantTexts(page)).slice(proseBeforeLost);
  const lostRaw = await awaitRawCard(
    LF_CREDIT_CARD_ID,
    (row) => row.status === 'LOST',
    `lF：RAW Card ${LF_CREDIT_CARD_ID} 挂失后 status='LOST'`,
  );
  if (lostRaw.status !== 'LOST') throw new Error(`lF：RAW Card ${LF_CREDIT_CARD_ID}.status 应为 LOST，实际 ${lostRaw.status}`);
  const cardsAfterLost = await fetchLiveCards(baseUrl);
  if (cardsAfterLost.length !== cardsBeforeLost.length) {
    throw new Error(`lF：挂失不得增减卡片，实际 ${cardsBeforeLost.length} → ${cardsAfterLost.length}：${describeCards(cardsAfterLost)}`);
  }

  // (2) PRE-REPLACEMENT baseline: the money views, the credit totals and the /cards rendering.
  const moneyBeforeReplace = await readCardChainMoneySnapshot(baseUrl);
  const nonLostAfterLostMinor = nonLostCreditAvailableTotalMinor(cardsAfterLost);
  const naiveAfterLostMinor = allCreditAvailableTotalMinor(cardsAfterLost);
  await gotoCards(page, baseUrl);
  await waitForElementHydration(page, `[data-card-id="${LF_CREDIT_CARD_ID}"]`);
  const sourceTileAfterLost = await readCardTileRows(page, LF_CREDIT_CARD_ID);
  assertCreditTileLabels(sourceTileAfterLost, 'lF 挂失后源信用卡卡片');
  // 「不可用 ≠ 余额为零」: the source is LOST (`usable === false`) and STILL renders its real 可用额度
  // row — what changes is that it is not counted in the credit total, never the amount on the tile.
  const renderedAfterLostMinor = await renderedCreditAvailableMinor(page, cardsAfterLost, { includeLost: false });
  const lostShot = await captureShot(page, 'lF-cards-after-lost');
  if (sourceTileAfterLost[CARD_LABEL.availableLimit] !== formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))) {
    throw new Error(`lF：挂失后源卡仍应渲染原「${CARD_LABEL.availableLimit}」${formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))}（该值不得计入可用合计），实际 ${sourceTileAfterLost[CARD_LABEL.availableLimit]}（${JSON.stringify(sourceTileAfterLost)}）`);
  }
  if (renderedAfterLostMinor !== nonLostAfterLostMinor) {
    throw new Error(`lF：/cards 渲染的非 LOST 信用卡可用合计（${renderedAfterLostMinor}）应等于 GET /api/cards 推导值（${nonLostAfterLostMinor}）`);
  }

  // (3)+(4) 补办 — bounded natural turns, stop at the parked RED action, assert "nothing yet", then MFA.
  await gotoAgent(page, baseUrl);
  const leg = await driveReplaceLegAndVerify(params, {
    sourceCardId: LF_CREDIT_CARD_ID,
    prompts: withFirstTurn(LF_REPLACE_PROMPT, [
      CARD_CHAIN_NUDGE,
      '界面上方没有出现确认面板，请重新发起这张信用卡的补办',
      '请直接为我补办一张新卡，我已确认',
    ]),
    label: 'lF 补办信用卡',
  });

  // (6) The REAL consequence: exactly ONE new CREDIT card with an INHERITED limit.
  const outcome = await awaitCardReplacement(params, {
    sourceCardId: LF_CREDIT_CARD_ID,
    knownIds: new Set(cardsAfterLost.map((card) => card.id)),
    expectedType: 'CREDIT',
    label: 'lF 补办信用卡',
  });
  const newId = outcome.replacementId;
  await assertIssuanceReceipt(page, baseUrl, leg.action.id, newId);
  if (outcome.replacementRaw.numberMasked === LF_CREDIT_CARD_MASK) {
    throw new Error(`lF：补办卡卡号不得沿用源卡 ${LF_CREDIT_CARD_MASK}，实际 ${outcome.replacementRaw.numberMasked}`);
  }
  if (outcome.replacementRaw.creditLimitMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`lF：补办卡 creditLimitMinor 应继承 ${LF_CREDIT_LIMIT_MINOR}，实际 ${outcome.replacementRaw.creditLimitMinor}`);
  }
  if (outcome.replacementRaw.availableLimitMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`lF：补办卡 availableLimitMinor 应继承 ${LF_CREDIT_LIMIT_MINOR}，实际 ${outcome.replacementRaw.availableLimitMinor}`);
  }
  if (outcome.sourceRaw.status !== 'LOST') throw new Error(`lF：源卡应仍为 LOST，实际 ${outcome.sourceRaw.status}`);
  if (outcome.sourceRaw.replacedByCardId !== newId) {
    throw new Error(`lF：源卡 replacedByCardId 应指向 ${newId}，实际 ${outcome.sourceRaw.replacedByCardId}`);
  }
  const cardsAfter = outcome.cards;
  if (cardsAfter.length !== cardsAfterLost.length + 1) {
    throw new Error(`lF：补办后卡片总数应为 ${cardsAfterLost.length + 1}（基线 + 1），实际 ${cardsAfter.length}：${describeCards(cardsAfter)}`);
  }
  const activeCredit = uniqueActiveCreditCard(cardsAfter);
  if (activeCredit?.id !== newId) {
    throw new Error(`lF：应恰有 1 张 ACTIVE 信用卡且为补办卡 ${newId}，实际 ${activeCredit?.id ?? '无'}：${describeCards(cardsAfter)}`);
  }
  const creditRows = cardsAfter.filter((card) => card.type === 'CREDIT');
  if (creditRows.length !== 2) {
    throw new Error(`lF：补办后应恰有 2 张 CREDIT 行（1 LOST 源卡 + 1 补办卡），实际 ${creditRows.length}：${describeCards(cardsAfter)}`);
  }

  // (7) NO DOUBLE COUNTING — the non-LOST sum must equal the PRE-挂失 value, never the naive total.
  const availableAfterMinor = nonLostCreditAvailableTotalMinor(cardsAfter);
  const naiveAfterMinor = allCreditAvailableTotalMinor(cardsAfter);
  if (availableAfterMinor !== availableBeforeLostMinor) {
    throw new Error(`lF：补办前后「非 LOST 信用卡可用额度合计」必须不变，挂失前 ${centsToMoney(availableBeforeLostMinor)} → 补办后 ${centsToMoney(availableAfterMinor)}：${describeCards(cardsAfter)}`);
  }
  if (availableAfterMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`lF：补办后非 LOST 信用卡可用额度合计应为 ${LF_CREDIT_AVAILABLE}，实际 ${centsToMoney(availableAfterMinor)}`);
  }
  if (naiveAfterMinor === availableAfterMinor) {
    throw new Error(`lF：朴素全 CREDIT 合计不得等于可用合计（否则 LOST 源卡被重复计入）：${centsToMoney(naiveAfterMinor)}`);
  }
  if (naiveAfterMinor !== moneyToCents(LF_CREDIT_NAIVE_TOTAL)) {
    throw new Error(`lF：朴素全 CREDIT 合计（bug 签名，显式排除）应为 ${LF_CREDIT_NAIVE_TOTAL}，实际 ${centsToMoney(naiveAfterMinor)}`);
  }
  await gotoCards(page, baseUrl);
  await waitForElementHydration(page, `[data-card-id="${newId}"]`);
  const replacementTileRows = await readCardTileRows(page, newId);
  assertCreditTileLabels(replacementTileRows, 'lF 补办信用卡卡片');
  const renderedAfterReplaceMinor = await renderedCreditAvailableMinor(page, cardsAfter, { includeLost: false });
  const renderedNaiveMinor = await renderedCreditAvailableMinor(page, cardsAfter, { includeLost: true });
  const replaceShot = await captureShot(page, 'lF-cards-after-replace');
  for (const card of cardsAfter.filter(card => card.status === 'ACTIVE')) {
    const expected = card.type === 'CREDIT' ? card.availableLimit : card.type === 'VIRTUAL' ? card.payableAmount : card.accountAvailableBalance;
    if (expected === undefined) continue;
    const hero = page.locator(`[data-card-id="${card.id}"] [data-card-primary-amount]`);
    if ((await hero.locator('dd').textContent())?.trim() !== formatCNY(expected)) throw new Error(`The ${card.type} tile shows the wrong primary amount`);
    const details = page.locator(`[data-card-id="${card.id}"] [data-card-details]`);
    if (await details.getAttribute('open') !== null) throw new Error('Card details must initially be collapsed');
    await details.locator('summary').click();
    if (!(await details.innerText()).trim()) throw new Error('Expanded card facts are unavailable');
    await details.locator('summary').click();
  }
  const desktopViewport = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Mobile cards overflow horizontally');
  await captureShot(page, 'lF-mobile-card-overview');
  if (desktopViewport) await page.setViewportSize(desktopViewport);
  if (replacementTileRows[CARD_LABEL.creditLimit] !== formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))) {
    throw new Error(`lF：补办卡「${CARD_LABEL.creditLimit}」应渲染 ${formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))}，实际 ${replacementTileRows[CARD_LABEL.creditLimit]}（${JSON.stringify(replacementTileRows)}）`);
  }
  if (replacementTileRows[CARD_LABEL.availableLimit] !== formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))) {
    throw new Error(`lF：补办卡「${CARD_LABEL.availableLimit}」应渲染 ${formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))}，实际 ${replacementTileRows[CARD_LABEL.availableLimit]}（${JSON.stringify(replacementTileRows)}）`);
  }
  if (renderedAfterReplaceMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`lF：/cards 上非 LOST 信用卡「可用额度」渲染合计应为 ${LF_CREDIT_AVAILABLE}（只计一次），实际 ${centsToMoney(renderedAfterReplaceMinor)}`);
  }
  if (renderedNaiveMinor !== moneyToCents(LF_CREDIT_NAIVE_TOTAL)) {
    throw new Error(`lF：把 LOST 源卡也算进去的渲染合计（bug 签名，显式排除）应为 ${LF_CREDIT_NAIVE_TOTAL}，实际 ${centsToMoney(renderedNaiveMinor)}`);
  }

  // (8) CASH/LEDGER INVARIANCE — 补办 moves no money: dashboard balance + bills list unchanged.
  const moneyAfter = await readCardChainMoneySnapshot(baseUrl);
  assertCardChainMoneyUnchanged(moneyBeforeReplace, moneyAfter, 'lF 补办信用卡');
  assertCardChainMoneyUnchanged(moneyBeforeLost, moneyAfter, 'lF 挂失 + 补办信用卡（整段）');

  // Evidence: verbatim prose, the real rows, the batch of parked actions.
  const pendingRows = await readPendingActionRows(['report_lost_card', 'replace_card']);
  const toolEvents = await readToolEvents();
  const evidenceFile = writeScenarioEvidence('lF', {
    scenario: 'lF-live-credit-report-lost-and-replace-new-session',
    certifiedHead: head,
    model,
    prompts: { lost: lostTurns, replace: leg.turns },
    prose: { lost: lostProse, replace: leg.prose },
    parkedAction: { http: leg.action, sqlite: leg.actionRow },
    preVerification: leg.preVerification,
    pendingActionRows: pendingRows,
    toolEvents,
    cards: {
      beforeLost: cardsBeforeLost,
      afterLost: cardsAfterLost,
      afterReplace: cardsAfter,
    },
    rawCards: { sourceBefore, sourceAfterReplace: outcome.sourceRaw, replacement: outcome.replacementRaw },
    credit: {
      availableBeforeLostMinor,
      naiveBeforeLostMinor,
      nonLostAfterLostMinor,
      naiveAfterLostMinor,
      availableAfterMinor,
      naiveAfterMinor,
      renderedAfterLostMinor,
      renderedAfterReplaceMinor,
      renderedNaiveMinor,
      naiveBugSignature: LF_CREDIT_NAIVE_TOTAL,
    },
    money: { beforeLost: moneyBeforeLost.checkingBalance, beforeReplace: moneyBeforeReplace.checkingBalance, after: moneyAfter.checkingBalance },
    tileRows: { sourceAfterLost: sourceTileAfterLost, replacementAfterReplace: replacementTileRows },
    screenshots: { lostShot, replaceShot },
  });

  return `lF（认证产品树 ${head}，模型 ${model}）1 挂失实际发送：${lostTurns.map((t) => `「${t}」`).join(' → ')} → MFA ${LF_MFA_CODE} → RAW ${LF_CREDIT_CARD_ID}.status=${lostRaw.status}（模型散文：${brief(lostProse)}）；2 补办前基线：GET /api/cards ${cardsAfterLost.length} 张（${describeCards(cardsAfterLost)}）、非 LOST 可用合计 ${centsToMoney(nonLostAfterLostMinor)}、朴素全 CREDIT 合计 ${centsToMoney(naiveAfterLostMinor)}、/cards 渲染非 LOST 可用 ${centsToMoney(renderedAfterLostMinor)}（源卡「${CARD_LABEL.availableLimit}」=${sourceTileAfterLost[CARD_LABEL.availableLimit]} 不得计入）、dashboard=${moneyBeforeReplace.checkingBalance}；3-4 补办实际发送：${leg.turns.map((t) => `「${t}」`).join(' → ')}（模型散文：${brief(leg.prose)}）→ /api/actions 出现 replace_card 待确认动作 ${leg.action.id}（tier=${leg.action.tier}、requiresMfa=${leg.action.requiresMfa}、status=${leg.action.status}；SQLite 同行 status=${leg.actionRow.status}、mfa=${leg.actionRow.mfa?.status ?? '无'}/${leg.actionRow.mfa?.attempts ?? '-'}），验证前卡片总数仍 ${leg.preVerification.cardCount}、未新增任何卡、源卡 status=${leg.preVerification.sourceStatus}、replacedByCardId=${leg.preVerification.sourceReplacedByCardId ?? 'null'}；5 未出现「只能手动办理」拒绝（replace_card 门控真实存在）；6 MFA ${LF_MFA_CODE} 后：恰 1 张新 CREDIT 卡 ${newId}（RAW status=${outcome.replacementRaw.status}、卡号 ${outcome.replacementRaw.numberMasked} ≠ ${LF_CREDIT_CARD_MASK}、creditLimitMinor=${outcome.replacementRaw.creditLimitMinor}、availableLimitMinor=${outcome.replacementRaw.availableLimitMinor}），源卡 status=${outcome.sourceRaw.status}、replacedByCardId=${outcome.sourceRaw.replacedByCardId}，卡片总数 ${cardsAfterLost.length} → ${cardsAfter.length}（基线 + 1）；7 额度不重复：非 LOST 可用合计 ${centsToMoney(availableAfterMinor)}（= 挂失前 ${centsToMoney(availableBeforeLostMinor)}），/cards 渲染非 LOST 可用合计 ${centsToMoney(renderedAfterReplaceMinor)}、补办卡「${CARD_LABEL.creditLimit}」=${replacementTileRows[CARD_LABEL.creditLimit]}、「${CARD_LABEL.availableLimit}」=${replacementTileRows[CARD_LABEL.availableLimit]}；把 LOST 源卡计入的朴素合计 ${centsToMoney(naiveAfterMinor)}（渲染 ${centsToMoney(renderedNaiveMinor)}）作为 bug 签名显式排除；8 资金不变：dashboard ${moneyBeforeReplace.checkingBalance} → ${moneyAfter.checkingBalance}、GET /api/bills 新增 0 条/消失 0 条；截图 ${lostShot ?? '未落盘'} / ${replaceShot ?? '未落盘'}；证据 JSON ${evidenceFile ?? '未落盘'}`;
}

// --- SCENARIO lG ---------------------------------------------------------------------------------

/** One chat turn of the replay, kept for the evidence blob. */
export interface ChainTurnEvidence {
  step: string;
  prompt: string;
  prose: string;
  actionId?: string;
  toolName?: string;
  actionStatus?: string;
}

/**
 * Send the VERBATIM step-8 turn and record what the model does. If the gateway parks a NEW
 * `replace_card` action and the UI offers verification, complete it; either way the caller re-asserts
 * "still exactly one replacement card".
 */
async function sendFinalConfirmTurn(
  params: CardChainParams,
): Promise<{ prose: string; action?: PendingActionView; mfaCompleted: boolean; panelRendered: boolean }> {
  // Re-enter /agent first: the previous front-end leg may have left the browser on /cards, where no
  // chat composer exists, so `submitChat` would wait for `textarea[data-chat-composer="true"]` and time out.
  await gotoAgent(params.page, params.baseUrl);
  const { page, baseUrl } = params;
  const ignoreActionIds = new Set((await fetchPendingActions(baseUrl)).map((action) => action.id));
  const baseline = (await assistantTexts(page)).length;
  await submitChat(page, LG_FINAL_CONFIRM_PROMPT);
  const action = await pollForPendingTool(baseUrl, 'replace_card', 120_000, ignoreActionIds);
  const prose = (await assistantTexts(page)).slice(baseline).join('\n');
  assertNoFabricatedConfirmationPanel({ page, prose, actions: await fetchPendingActions(baseUrl) });
  if (action === undefined) return { prose, mfaCompleted: false, panelRendered: false };
  const panelRendered = (await page.locator(SELECTORS.approvalRequest).count()) > 0;
  if (!panelRendered) return { prose, action, mfaCompleted: false, panelRendered };
  await completeConfirmationPanel(page, 'lG 第 8 轮');
  return { prose, action, mfaCompleted: true, panelRendered };
}

/**
 * SCENARIO lG (LIVE-LLM, REAL BROWSER, ONE SESSION): the VERBATIM replay of the chain that reproduced
 * the bug. Every business leg is bounded (≤ {@link MAX_TURNS_PER_LEG} natural turns) and every prose
 * turn is guarded against a fabricated confirmation/MFA panel claim.
 */
export async function scenarioFullCardChain(params: CardChainParams): Promise<string> {
  const { page, baseUrl, drive, captureShot } = params;
  const head = certifiedHead();
  const model = liveModelId();
  const chain: ChainTurnEvidence[] = [];
  await gotoAgent(page, baseUrl);

  // Scenario-start BASELINE — never a hardcoded card count (the seed is not the invariant).
  const cardsAtStart = await fetchLiveCards(baseUrl);
  const baselineCount = cardsAtStart.length;
  const seedIds = cardsAtStart.map((card) => card.id);
  const seedMasks = new Set(cardsAtStart.map((card) => card.numberMasked).filter((mask): mask is string => mask !== undefined));
  const spendAtStart = await readCardSpendState();
  const moneyAtStart = await readCardChainMoneySnapshot(baseUrl);
  const limitMinor = moneyToCents(VC_MONTHLY_LIMIT);
  const firstSpendMinor = moneyToCents(VC_FIRST_SPEND);
  const secondSpendMinor = moneyToCents(VC_SECOND_SPEND);

  // ---- STEP 1: 新开一张月限额 100 元的虚拟卡（绑定活期账户），真实确认 + MFA --------------------------
  const proseBeforeApply = (await assistantTexts(page)).length;
  const applied = await applyVirtualCardViaAgent(page, baseUrl, drive, {
    excludeCardIds: seedIds,
    // The pinned verbatim step-1 sentence (NOT the generic `VC_APPLY_TURNS` opener): lG replays an exact
    // transcript, so the first turn must be the user's real wording; only the nudges are generic.
    turns: withFirstTurn(LG_VC_APPLY_PROMPT, VC_APPLY_TURNS.slice(1)),
    monthlyLimit: VC_MONTHLY_LIMIT,
  });
  const applyProse = (await assistantTexts(page)).slice(proseBeforeApply);
  assertBoundedLeg(applied.sent, 'lG 开卡');
  chain.push({ step: '1-虚拟卡开卡', prompt: applied.sent.join(' → '), prose: applyProse.join('\n') });
  const vcRaw = await awaitRawCard(
    applied.cardId,
    (row) => row.type === 'VIRTUAL' && row.status === 'ACTIVE',
    `lG：RAW Card ${applied.cardId} 应为 ACTIVE 的 VIRTUAL 卡`,
  );
  if (vcRaw.monthlyLimitMinor !== limitMinor) {
    throw new Error(`lG：新虚拟卡 monthlyLimitMinor 应为 ${limitMinor}（${VC_MONTHLY_LIMIT}），实际 ${vcRaw.monthlyLimitMinor}`);
  }
  if (vcRaw.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
    throw new Error(`lG：新虚拟卡 linkedAccountId 应为 ${VC_CHECKING_ACCOUNT_ID}，实际 ${vcRaw.linkedAccountId}`);
  }
  if (vcRaw.creditLimitMinor !== null || vcRaw.availableLimitMinor !== null) {
    throw new Error(`lG：虚拟卡不得有信用额度，实际 creditLimitMinor=${vcRaw.creditLimitMinor}、availableLimitMinor=${vcRaw.availableLimitMinor}`);
  }
  if (seedMasks.has(vcRaw.numberMasked)) {
    throw new Error(`lG：新虚拟卡卡号 ${vcRaw.numberMasked} 与既有卡片重复`);
  }
  const vcTail = cardMaskTail(vcRaw.numberMasked);
  const cardsAfterApply = await fetchLiveCards(baseUrl);
  if (cardsAfterApply.length !== baselineCount + 1) {
    throw new Error(`lG：开卡后卡片总数应为 ${baselineCount + 1}（基线 + 1），实际 ${cardsAfterApply.length}：${describeCards(cardsAfterApply)}`);
  }

  // ---- STEP 2: 前端在 NEW 虚拟卡上消费 30.00 -------------------------------------------------------
  const beforeFirstSpend = await readCardSpendState();
  await gotoCards(page, baseUrl);
  await waitForElementHydration(page, `[data-card-id="${applied.cardId}"]`);
  await openConsumeDialog(page, applied.cardId);
  await consumeSuccessfully(
    page,
    { amount: VC_FIRST_SPEND, category: VC_SPEND_CATEGORY, merchant: VC_MERCHANT_APPLY },
    beforeFirstSpend.consumptions.filter((row) => row.cardId === applied.cardId).length + 1,
  );
  const afterFirstSpend = await readCardSpendState();
  const firstDelta = assertSingleSpend(beforeFirstSpend, afterFirstSpend, {
    cardId: applied.cardId,
    amountMinor: firstSpendMinor,
    category: VC_SPEND_CATEGORY,
    merchant: VC_MERCHANT_APPLY,
    label: `lG 虚拟卡消费 ${VC_FIRST_SPEND}`,
  });
  const payableAfterFirst = centsToMoney(expectedPayableMinor(limitMinor, firstSpendMinor, afterFirstSpend.balanceMinor));
  if (payableAfterFirst !== '70.00') {
    throw new Error(`lG：消费 ${VC_FIRST_SPEND} 后 payableAmount 应为 70.00，实际 ${payableAfterFirst}（可用余额 ${centsToMoney(afterFirstSpend.balanceMinor)}）`);
  }
  await awaitPayableAmount(baseUrl, applied.cardId, payableAfterFirst, 'lG 首次消费后');

  // ---- STEP 3: 正式挂失该虚拟卡（真实确认 + MFA） ----------------------------------------------------
  await gotoAgent(page, baseUrl);
  const proseBeforeVcLost = (await assistantTexts(page)).length;
  const vcLostTurns = await drive(withFirstTurn(lgVcReportLostPrompt(vcTail), vcReportLostTurns(vcTail).slice(1)));
  assertBoundedLeg(vcLostTurns, 'lG 虚拟卡挂失');
  const vcLostProse = (await assistantTexts(page)).slice(proseBeforeVcLost);
  chain.push({ step: '3-虚拟卡挂失', prompt: vcLostTurns.join(' → '), prose: vcLostProse.join('\n') });
  const vcLostRaw = await awaitRawCard(applied.cardId, (row) => row.status === 'LOST', `lG：RAW Card ${applied.cardId} 挂失后 status='LOST'`);
  if (vcLostRaw.status !== 'LOST') throw new Error(`lG：虚拟卡 ${applied.cardId}.status 应为 LOST，实际 ${vcLostRaw.status}`);
  const afterVcLost = await readCardSpendState();
  assertNoSpend(afterFirstSpend, afterVcLost, 'lG 虚拟卡挂失');
  const cardsAfterVcLost = await fetchLiveCards(baseUrl);
  if (cardsAfterVcLost.length !== cardsAfterApply.length) {
    throw new Error(`lG：挂失不得增减卡片，实际 ${cardsAfterApply.length} → ${cardsAfterVcLost.length}：${describeCards(cardsAfterVcLost)}`);
  }

  // ---- STEP 4: 补办该虚拟卡：验证前必须停在 replace_card 待确认动作上 ----------------------------------
  const vcReplaceLeg = await driveReplaceLegAndVerify(params, {
    sourceCardId: applied.cardId,
    prompts: withFirstTurn(lgVcReplacePrompt(vcTail), vcReplaceTurns(vcTail).slice(1)),
    label: 'lG 补办虚拟卡',
  });
  chain.push({
    step: '4-虚拟卡补办',
    prompt: vcReplaceLeg.turns.join(' → '),
    prose: vcReplaceLeg.prose.join('\n'),
    actionId: vcReplaceLeg.action.id,
    toolName: vcReplaceLeg.action.toolName,
    actionStatus: vcReplaceLeg.actionRow.status,
  });
  const vcOutcome = await awaitCardReplacement(params, {
    sourceCardId: applied.cardId,
    knownIds: new Set(cardsAfterVcLost.map((card) => card.id)),
    expectedType: 'VIRTUAL',
    label: 'lG 补办虚拟卡',
  });
  if (vcOutcome.replacementRaw.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
    throw new Error(`lG：补办虚拟卡 linkedAccountId 应继承 ${VC_CHECKING_ACCOUNT_ID}，实际 ${vcOutcome.replacementRaw.linkedAccountId}`);
  }
  if (vcOutcome.replacementRaw.monthlyLimitMinor !== limitMinor) {
    throw new Error(`lG：补办虚拟卡 monthlyLimitMinor 应继承 ${limitMinor}，实际 ${vcOutcome.replacementRaw.monthlyLimitMinor}`);
  }
  if (vcOutcome.replacementRaw.creditLimitMinor !== null || vcOutcome.replacementRaw.availableLimitMinor !== null) {
    throw new Error(`lG：补办虚拟卡不得有信用额度，实际 creditLimitMinor=${vcOutcome.replacementRaw.creditLimitMinor}、availableLimitMinor=${vcOutcome.replacementRaw.availableLimitMinor}`);
  }
  if (vcOutcome.sourceRaw.status !== 'LOST') throw new Error(`lG：源虚拟卡应仍为 LOST，实际 ${vcOutcome.sourceRaw.status}`);
  if (vcOutcome.sourceRaw.replacedByCardId !== vcOutcome.replacementId) {
    throw new Error(`lG：源虚拟卡 replacedByCardId 应指向 ${vcOutcome.replacementId}，实际 ${vcOutcome.sourceRaw.replacedByCardId}`);
  }
  const vcReplacementId = vcOutcome.replacementId;
  // CONTINUITY — the family's remaining allowance never resets: 70.00 before AND after 补办.
  const familyPayable = centsToMoney(expectedPayableMinor(limitMinor, firstSpendMinor, afterVcLost.balanceMinor));
  if (familyPayable !== '70.00') {
    throw new Error(`lG：补办后家庭剩余月限额应为 70.00，实际 ${familyPayable}（账户余额 ${centsToMoney(afterVcLost.balanceMinor)}）`);
  }
  const cardsAfterVcReplace = await awaitPayableAmount(baseUrl, vcReplacementId, familyPayable, 'lG 虚拟卡补办后');
  if (cardById(cardsAfterVcReplace, vcReplacementId)?.payableAmount === VC_MONTHLY_LIMIT) {
    throw new Error(`lG：补办虚拟卡 payableAmount 不得重置为满额 ${VC_MONTHLY_LIMIT}`);
  }
  await gotoCards(page, baseUrl);
  await waitForElementHydration(page, `[data-card-id="${vcReplacementId}"]`);
  const vcReplaceTileRows = await readCardTileRows(page, vcReplacementId);
  assertLinkedAccountTileLabels(vcReplaceTileRows, 'lG 补办虚拟卡卡片');
  const vcReplaceShot = await captureShot(page, 'lG-virtual-replacement');

  // ---- STEP 5: 补办卡上消费 70.00（成功，payable→0.00），再 1.00 必须被 422 LIMIT_EXCEEDED 拒绝 --------
  const beforeSecondSpend = await readCardSpendState();
  await openConsumeDialog(page, vcReplacementId);
  await consumeSuccessfully(
    page,
    { amount: VC_SECOND_SPEND, category: VC_SPEND_CATEGORY, merchant: VC_MERCHANT_REPLACE },
    beforeSecondSpend.consumptions.filter((row) => row.cardId === vcReplacementId).length + 1,
  );
  const afterSecondSpend = await readCardSpendState();
  const secondDelta = assertSingleSpend(beforeSecondSpend, afterSecondSpend, {
    cardId: vcReplacementId,
    amountMinor: secondSpendMinor,
    category: VC_SPEND_CATEGORY,
    merchant: VC_MERCHANT_REPLACE,
    label: `lG 补办虚拟卡消费 ${VC_SECOND_SPEND}`,
  });
  const exhaustedPayable = centsToMoney(
    expectedPayableMinor(limitMinor, firstSpendMinor + secondSpendMinor, afterSecondSpend.balanceMinor),
  );
  if (exhaustedPayable !== '0.00') {
    throw new Error(`lG：家庭月限额用尽后 payableAmount 应为 0.00，实际 ${exhaustedPayable}`);
  }
  await awaitPayableAmount(baseUrl, vcReplacementId, exhaustedPayable, 'lG 额度用尽后');
  const refusalText = await attemptConsumeExpectingRefusal(page, {
    amount: VC_TINY_SPEND,
    category: VC_SPEND_CATEGORY,
    merchant: VC_MERCHANT_REFUSED,
  });
  if (!refusalText.includes(VC_LIMIT_EXCEEDED_TEXT)) {
    throw new Error(`lG：额度用尽后 ${VC_TINY_SPEND} 消费应提示「${VC_LIMIT_EXCEEDED_TEXT}」（HTTP 422 LIMIT_EXCEEDED），实际「${refusalText}」`);
  }
  const refusalShot = await captureShot(page, 'lG-virtual-refusal');
  const afterRefusal = await readCardSpendState();
  assertNoSpend(afterSecondSpend, afterRefusal, `lG 额度用尽后的 ${VC_TINY_SPEND} 消费（${VC_MERCHANT_REFUSED}）被拒绝`);

  // ---- STEP 6: 挂失信用卡（真实确认 + MFA） ---------------------------------------------------------
  await gotoAgent(page, baseUrl);
  const cardsBeforeCreditLost = await fetchLiveCards(baseUrl);
  const moneyBeforeCreditLost = await readCardChainMoneySnapshot(baseUrl);
  const proseBeforeCreditLost = (await assistantTexts(page)).length;
  const creditLostTurns = await drive(withFirstTurn(LG_CREDIT_REPORT_LOST_PROMPT, vcReportLostTurns('6688').slice(1)));
  assertBoundedLeg(creditLostTurns, 'lG 信用卡挂失');
  const creditLostProse = (await assistantTexts(page)).slice(proseBeforeCreditLost);
  chain.push({ step: '6-信用卡挂失', prompt: creditLostTurns.join(' → '), prose: creditLostProse.join('\n') });
  const creditLostRaw = await awaitRawCard(LF_CREDIT_CARD_ID, (row) => row.status === 'LOST', `lG：RAW Card ${LF_CREDIT_CARD_ID} 挂失后 status='LOST'`);
  if (creditLostRaw.status !== 'LOST') throw new Error(`lG：信用卡 ${LF_CREDIT_CARD_ID}.status 应为 LOST，实际 ${creditLostRaw.status}`);
  const afterCreditLost = await readCardSpendState();
  assertNoSpend(afterRefusal, afterCreditLost, 'lG 信用卡挂失');
  const cardsAfterCreditLost = await fetchLiveCards(baseUrl);
  if (cardsAfterCreditLost.length !== cardsBeforeCreditLost.length) {
    throw new Error(`lG：挂失不得增减卡片，实际 ${cardsBeforeCreditLost.length} → ${cardsAfterCreditLost.length}：${describeCards(cardsAfterCreditLost)}`);
  }

  // ---- STEP 7: 补办信用卡 —— 曾经被「只能手动办理」拒绝的那一句 --------------------------------------
  const moneyBeforeCreditReplace = await readCardChainMoneySnapshot(baseUrl);
  const creditReplaceLeg = await driveReplaceLegAndVerify(params, {
    sourceCardId: LF_CREDIT_CARD_ID,
    prompts: withFirstTurn(LG_CREDIT_REPLACE_PROMPT, [
      CARD_CHAIN_NUDGE,
      '界面上方没有出现确认面板，请重新发起这张信用卡的补办',
      '请直接为我补办一张新卡，我已确认',
    ]),
    label: 'lG 补办信用卡',
  });
  chain.push({
    step: '7-信用卡补办',
    prompt: creditReplaceLeg.turns.join(' → '),
    prose: creditReplaceLeg.prose.join('\n'),
    actionId: creditReplaceLeg.action.id,
    toolName: creditReplaceLeg.action.toolName,
    actionStatus: creditReplaceLeg.actionRow.status,
  });
  const creditOutcome = await awaitCardReplacement(params, {
    sourceCardId: LF_CREDIT_CARD_ID,
    knownIds: new Set(cardsAfterCreditLost.map((card) => card.id)),
    expectedType: 'CREDIT',
    label: 'lG 补办信用卡',
  });
  const creditReplacementId = creditOutcome.replacementId;
  if (creditOutcome.replacementRaw.numberMasked === LF_CREDIT_CARD_MASK) {
    throw new Error(`lG：补办信用卡卡号不得沿用源卡 ${LF_CREDIT_CARD_MASK}，实际 ${creditOutcome.replacementRaw.numberMasked}`);
  }
  if (creditOutcome.replacementRaw.creditLimitMinor !== LF_CREDIT_LIMIT_MINOR
    || creditOutcome.replacementRaw.availableLimitMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`lG：补办信用卡额度应继承 ${LF_CREDIT_LIMIT_MINOR}，实际 creditLimitMinor=${creditOutcome.replacementRaw.creditLimitMinor}、availableLimitMinor=${creditOutcome.replacementRaw.availableLimitMinor}`);
  }
  if (creditOutcome.sourceRaw.status !== 'LOST') throw new Error(`lG：源信用卡应仍为 LOST，实际 ${creditOutcome.sourceRaw.status}`);
  if (creditOutcome.sourceRaw.replacedByCardId !== creditReplacementId) {
    throw new Error(`lG：源信用卡 replacedByCardId 应指向 ${creditReplacementId}，实际 ${creditOutcome.sourceRaw.replacedByCardId}`);
  }
  const cardsAfterCreditReplace = creditOutcome.cards;
  if (cardsAfterCreditReplace.length !== cardsAfterCreditLost.length + 1) {
    throw new Error(`lG：补办信用卡后卡片总数应为 ${cardsAfterCreditLost.length + 1}（基线 + 1），实际 ${cardsAfterCreditReplace.length}：${describeCards(cardsAfterCreditReplace)}`);
  }
  const activeCredit = uniqueActiveCreditCard(cardsAfterCreditReplace);
  if (activeCredit?.id !== creditReplacementId) {
    throw new Error(`lG：应恰有 1 张 ACTIVE 信用卡且为补办卡 ${creditReplacementId}，实际 ${activeCredit?.id ?? '无'}：${describeCards(cardsAfterCreditReplace)}`);
  }
  assertCardChainMoneyUnchanged(moneyBeforeCreditReplace, await readCardChainMoneySnapshot(baseUrl), 'lG 补办信用卡');
  await gotoCards(page, baseUrl);
  await waitForElementHydration(page, `[data-card-id="${creditReplacementId}"]`);
  const creditReplaceTileRows = await readCardTileRows(page, creditReplacementId);
  assertCreditTileLabels(creditReplaceTileRows, 'lG 补办信用卡卡片');
  const creditReplaceShot = await captureShot(page, 'lG-credit-replacement');
  if (creditReplaceTileRows[CARD_LABEL.availableLimit] !== formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))) {
    throw new Error(`lG：补办信用卡「${CARD_LABEL.availableLimit}」应渲染 ${formatCNY(centsToMoney(LF_CREDIT_LIMIT_MINOR))}，实际 ${creditReplaceTileRows[CARD_LABEL.availableLimit]}`);
  }
  const availableAfterCreditReplaceMinor = nonLostCreditAvailableTotalMinor(cardsAfterCreditReplace);
  const naiveAfterCreditReplaceMinor = allCreditAvailableTotalMinor(cardsAfterCreditReplace);
  if (availableAfterCreditReplaceMinor !== LF_CREDIT_LIMIT_MINOR) {
    throw new Error(`lG：补办信用卡后非 LOST 可用合计应为 ${LF_CREDIT_AVAILABLE}，实际 ${centsToMoney(availableAfterCreditReplaceMinor)}：${describeCards(cardsAfterCreditReplace)}`);
  }
  if (naiveAfterCreditReplaceMinor === availableAfterCreditReplaceMinor) {
    throw new Error(`lG：朴素全 CREDIT 合计不得等于可用合计（LOST 源卡被重复计入）`);
  }

  // ---- STEP 8: 逐字「确认，请继续办理…」 —— 不得再生成第二张补办卡 -------------------------------------
  const cardsBeforeFinal = await fetchLiveCards(baseUrl);
  const finalTurn = await sendFinalConfirmTurn(params);
  chain.push({
    step: '8-逐字催促确认',
    prompt: LG_FINAL_CONFIRM_PROMPT,
    prose: finalTurn.prose,
    actionId: finalTurn.action?.id,
    toolName: finalTurn.action?.toolName,
    actionStatus: finalTurn.action === undefined ? '无待确认动作' : undefined,
  });
  const cardsAfterFinal = await fetchLiveCards(baseUrl);
  if (cardsAfterFinal.length !== cardsBeforeFinal.length) {
    throw new Error(`lG 第 8 轮：不得再生成补办卡，卡片总数应仍为 ${cardsBeforeFinal.length}，实际 ${cardsAfterFinal.length}：${describeCards(cardsAfterFinal)}`);
  }
  if (cardsAfterFinal.length !== cardsAfterCreditReplace.length) {
    throw new Error(`lG 第 8 轮：卡片总数应保持补办后的 ${cardsAfterCreditReplace.length}，实际 ${cardsAfterFinal.length}：${describeCards(cardsAfterFinal)}`);
  }
  const activeAfterFinal = uniqueActiveCreditCard(cardsAfterFinal);
  if (activeAfterFinal?.id !== creditReplacementId) {
    throw new Error(`lG 第 8 轮：唯一 ACTIVE 信用卡 id 应仍为 ${creditReplacementId}，实际 ${activeAfterFinal?.id ?? '无'}：${describeCards(cardsAfterFinal)}`);
  }
  // 虚拟卡家系按基线推导，不硬编码总数：演示种子本就含 VIRTUAL 卡（`card_virtual`），
  // 本链路只在基线上新增「1 张 LOST 源卡 + 1 张补办卡」两行。
  const vcBaselineIds = new Set(cardsAtStart.filter((card) => card.type === 'VIRTUAL').map((card) => card.id));
  const vcAfterFinal = cardsAfterFinal.filter((card) => card.type === 'VIRTUAL');
  const vcChainRows = vcAfterFinal.filter((card) => !vcBaselineIds.has(card.id));
  const expectedVcCount = vcBaselineIds.size + 2;
  if (vcAfterFinal.length !== expectedVcCount) {
    throw new Error(`lG 第 8 轮：VIRTUAL 行应为基线 ${vcBaselineIds.size} 张 + 本链路新增 2 张（1 LOST 源卡 + 1 补办卡）= ${expectedVcCount}，实际 ${vcAfterFinal.length}：${describeCards(cardsAfterFinal)}`);
  }
  const vcSourceAfterFinal = vcChainRows.find((card) => card.id === applied.cardId);
  if (vcSourceAfterFinal?.status !== 'LOST') {
    throw new Error(`lG 第 8 轮：本链路源虚拟卡 ${applied.cardId} 应仍为 LOST，实际 ${vcSourceAfterFinal?.status ?? '缺失'}：${describeCards(cardsAfterFinal)}`);
  }
  const vcReplacementAfterFinal = vcChainRows.find((card) => card.id === vcReplacementId);
  if (vcReplacementAfterFinal?.status !== 'ACTIVE') {
    throw new Error(`lG 第 8 轮：本链路补办虚拟卡 ${vcReplacementId} 应仍为 ACTIVE，实际 ${vcReplacementAfterFinal?.status ?? '缺失'}：${describeCards(cardsAfterFinal)}`);
  }

  // ---- WHOLE-CHAIN INVARIANCE: only the TWO consumptions moved money --------------------------------
  const spendFinal = await readCardSpendState();
  const expectedFinalBalanceMinor = spendAtStart.balanceMinor - firstSpendMinor - secondSpendMinor;
  if (spendFinal.balanceMinor !== expectedFinalBalanceMinor) {
    throw new Error(`lG：整段链路只有两笔刷卡消费应影响活期余额（${centsToMoney(spendAtStart.balanceMinor)} − ${VC_FIRST_SPEND} − ${VC_SECOND_SPEND} = ${centsToMoney(expectedFinalBalanceMinor)}），实际 ${centsToMoney(spendFinal.balanceMinor)}`);
  }
  const moneyFinal = await readCardChainMoneySnapshot(baseUrl);
  const ledgerDiff = diffLedger(moneyAtStart.ledger.transactions, moneyFinal.ledger.transactions);
  if (ledgerDiff.removed.length !== 0) {
    throw new Error(`lG：GET /api/bills 不得丢失原有流水，实际消失 ${ledgerDiff.removed.length} 条`);
  }
  if (ledgerDiff.added.length !== 2) {
    throw new Error(`lG：GET /api/bills 应只新增两笔刷卡消费流水（${VC_FIRST_SPEND} + ${VC_SECOND_SPEND}），实际新增 ${ledgerDiff.added.length} 条`);
  }
  const addedMerchants = ledgerDiff.added.map((row) => row.merchant).sort();
  const expectedMerchants = [VC_MERCHANT_APPLY, VC_MERCHANT_REPLACE].sort();
  if (addedMerchants.length !== expectedMerchants.length || addedMerchants.some((merchant, index) => merchant !== expectedMerchants[index])) {
    throw new Error(`lG：新增流水商户应为 ${expectedMerchants.join('/')}（补办/挂失不得产生流水），实际 ${addedMerchants.join('/')}`);
  }
  if (!ledgerDiff.added.every((row) => row.direction === 'DEBIT')) {
    throw new Error(`lG：新增的两条流水都应为 DEBIT，实际 ${ledgerDiff.added.map((row) => row.direction).join('/')}`);
  }
  if (moneyFinal.checkingBalance !== centsToMoney(expectedFinalBalanceMinor)) {
    throw new Error(`lG：GET /api/dashboard 活期余额应为 ${centsToMoney(expectedFinalBalanceMinor)}，实际 ${moneyFinal.checkingBalance}`);
  }

  const pendingRows = await readPendingActionRows(['apply_virtual_card', 'report_lost_card', 'replace_card']);
  const toolEvents = await readToolEvents();
  const evidenceFile = writeScenarioEvidence('lG', {
    scenario: 'lG-live-full-card-loss-replace-chain-single-session',
    certifiedHead: head,
    model,
    baselineCount,
    seedIds,
    chain,
    pendingActionRows: pendingRows,
    toolEvents,
    virtualCard: {
      sourceId: applied.cardId,
      sourceRaw: vcRaw,
      sourceRawAfterLost: vcLostRaw,
      maskTail: vcTail,
      replacementId: vcReplacementId,
      replacementRaw: vcOutcome.replacementRaw,
      payableAfterFirstSpend: payableAfterFirst,
      payableAfterReplace: familyPayable,
      payableAfterExhaustion: exhaustedPayable,
      tileRows: vcReplaceTileRows,
    },
    spends: {
      first: { amount: VC_FIRST_SPEND, merchant: VC_MERCHANT_APPLY, debitId: firstDelta.debit.id, consumptionId: firstDelta.consumption.id },
      second: { amount: VC_SECOND_SPEND, merchant: VC_MERCHANT_REPLACE, debitId: secondDelta.debit.id, consumptionId: secondDelta.consumption.id },
      refused: { amount: VC_TINY_SPEND, merchant: VC_MERCHANT_REFUSED, text: refusalText },
    },
    creditCard: {
      sourceId: LF_CREDIT_CARD_ID,
      sourceRawAfterLost: creditLostRaw,
      replacementId: creditReplacementId,
      replacementRaw: creditOutcome.replacementRaw,
      tileRows: creditReplaceTileRows,
      availableMinor: availableAfterCreditReplaceMinor,
      naiveMinor: naiveAfterCreditReplaceMinor,
    },
    finalTurn: {
      prompt: LG_FINAL_CONFIRM_PROMPT,
      prose: finalTurn.prose,
      action: finalTurn.action,
      mfaCompleted: finalTurn.mfaCompleted,
      panelRendered: finalTurn.panelRendered,
      cardCountBefore: cardsBeforeFinal.length,
      cardCountAfter: cardsAfterFinal.length,
      activeCreditIdAfter: activeAfterFinal?.id,
    },
    cards: { start: cardsAtStart, afterApply: cardsAfterApply, afterCreditReplace: cardsAfterCreditReplace, afterFinal: cardsAfterFinal },
    money: {
      dashboardStart: moneyAtStart.checkingBalance,
      dashboardBeforeCreditLost: moneyBeforeCreditLost.checkingBalance,
      dashboardBeforeCreditReplace: moneyBeforeCreditReplace.checkingBalance,
      dashboardFinal: moneyFinal.checkingBalance,
      spendStartMinor: spendAtStart.balanceMinor,
      spendFinalMinor: spendFinal.balanceMinor,
      ledgerAddedMerchants: addedMerchants,
    },
    screenshots: { vcReplaceShot, refusalShot, creditReplaceShot },
  });

  return `lG（认证产品树 ${head}，模型 ${model}，单会话；基线 ${baselineCount} 张卡）1 开卡实际发送：${applied.sent.map((t) => `「${t}」`).join(' → ')} → MFA ${LF_MFA_CODE} → ${applied.cardId}（RAW VIRTUAL/ACTIVE、monthlyLimitMinor=${vcRaw.monthlyLimitMinor}（${VC_MONTHLY_LIMIT}）、linkedAccountId=${vcRaw.linkedAccountId}、卡号 ${vcRaw.numberMasked}）；2 前端消费 ${VC_FIRST_SPEND}（${VC_SPEND_CATEGORY}/${VC_MERCHANT_APPLY}）→ 流水 ${firstDelta.debit.amountMinor}（${firstDelta.debit.id}）+ CardConsumption（${firstDelta.consumption.id}），活期 ${centsToMoney(firstDelta.balanceBeforeMinor)} → ${centsToMoney(firstDelta.balanceAfterMinor)}，payable=${payableAfterFirst}；3 虚拟卡挂失实际发送：${vcLostTurns.map((t) => `「${t}」`).join(' → ')} → MFA ${LF_MFA_CODE} → RAW status=${vcLostRaw.status}、资金零变化（散文：${brief(vcLostProse)}）；4 虚拟卡补办实际发送：${vcReplaceLeg.turns.map((t) => `「${t}」`).join(' → ')}（散文：${brief(vcReplaceLeg.prose)}）→ /api/actions replace_card 待确认动作 ${vcReplaceLeg.action.id}（tier=${vcReplaceLeg.action.tier}、requiresMfa=${vcReplaceLeg.action.requiresMfa}），验证前卡片总数仍 ${vcReplaceLeg.preVerification.cardCount}、未新增卡、源卡 ${vcReplaceLeg.preVerification.sourceStatus} → MFA ${LF_MFA_CODE} → 恰新增 1 张 ${vcReplacementId}（VIRTUAL/ACTIVE、linkedAccountId=${vcOutcome.replacementRaw.linkedAccountId}、monthlyLimitMinor=${vcOutcome.replacementRaw.monthlyLimitMinor}、无信用额度），源卡 replacedByCardId=${vcOutcome.sourceRaw.replacedByCardId}，payable 补办前后均 ${familyPayable}（未重置为 ${VC_MONTHLY_LIMIT}），卡片渲染 ${JSON.stringify(vcReplaceTileRows)}；5 补办卡消费 ${VC_SECOND_SPEND}（${VC_MERCHANT_REPLACE}）→ 流水 ${secondDelta.debit.amountMinor}（${secondDelta.debit.id}）+ CardConsumption（${secondDelta.consumption.id}），活期 ${centsToMoney(secondDelta.balanceBeforeMinor)} → ${centsToMoney(secondDelta.balanceAfterMinor)}，payable=${exhaustedPayable}；随后 ${VC_TINY_SPEND} 被拒绝「${refusalText}」（HTTP 422 LIMIT_EXCEEDED），流水/余额/CardConsumption 零变化；6 信用卡挂失实际发送：${creditLostTurns.map((t) => `「${t}」`).join(' → ')} → MFA ${LF_MFA_CODE} → ${LF_CREDIT_CARD_ID}=${creditLostRaw.status}（散文：${brief(creditLostProse)}）；7 信用卡补办（曾被「只能手动办理」拒绝的那一句）实际发送：${creditReplaceLeg.turns.map((t) => `「${t}」`).join(' → ')}（散文：${brief(creditReplaceLeg.prose)}）→ /api/actions replace_card 待确认动作 ${creditReplaceLeg.action.id}（tier=${creditReplaceLeg.action.tier}、requiresMfa=${creditReplaceLeg.action.requiresMfa}、status=${creditReplaceLeg.actionRow.status}），验证前无任何新卡、源卡仍 ${creditReplaceLeg.preVerification.sourceStatus} → MFA ${LF_MFA_CODE} → 恰新增 1 张 CREDIT ${creditReplacementId}（RAW ACTIVE、卡号 ${creditOutcome.replacementRaw.numberMasked} ≠ ${LF_CREDIT_CARD_MASK}、creditLimitMinor=${creditOutcome.replacementRaw.creditLimitMinor}、availableLimitMinor=${creditOutcome.replacementRaw.availableLimitMinor}），源卡 replacedByCardId=${creditOutcome.sourceRaw.replacedByCardId}，卡片总数 ${cardsAfterCreditLost.length} → ${cardsAfterCreditReplace.length}，非 LOST 可用合计 ${centsToMoney(availableAfterCreditReplaceMinor)}（朴素合计 ${centsToMoney(naiveAfterCreditReplaceMinor)} 显式排除）；8 逐字催促「${LG_FINAL_CONFIRM_PROMPT}」→ ${finalTurn.action === undefined ? '无新的待确认动作' : `出现待确认动作 ${finalTurn.action.id}（mfaCompleted=${finalTurn.mfaCompleted}）`}，卡片总数 ${cardsBeforeFinal.length} → ${cardsAfterFinal.length}、唯一 ACTIVE 信用卡仍为 ${activeAfterFinal?.id ?? '无'}（未生成第二张补办卡）；整段资金：活期 ${centsToMoney(spendAtStart.balanceMinor)} → ${centsToMoney(spendFinal.balanceMinor)}（仅两笔刷卡消费），GET /api/bills 新增 ${ledgerDiff.added.length} 条（${addedMerchants.join('/')}）、消失 ${ledgerDiff.removed.length} 条，dashboard=${moneyFinal.checkingBalance}；截图 ${vcReplaceShot ?? '未落盘'} / ${refusalShot ?? '未落盘'} / ${creditReplaceShot ?? '未落盘'}；证据 JSON ${evidenceFile ?? '未落盘'}`;
}

/** The spend state after a leg (kept exported for callers that want the same authoritatives). */
export type { CardSpendState };
