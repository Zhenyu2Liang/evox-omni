/**
 * `tests/e2e/live-virtual-card.e2e-helper.ts` — SHARED LIVE virtual-card steps for scenarios `lD`
 * (apply a virtual card + enforce its monthly limit) and `lE` (挂失 → 补办 → family-continuous
 * allowance) of `live-acceptance.e2e.ts`.
 *
 * WHY THIS MODULE EXISTS: both scenarios start with the SAME act — open a NEW virtual card with a small
 * monthly limit through the real `/agent` chat (RED tool ⇒ confirmation/MFA) and then spend part of it
 * through the REAL `CardConsumeDialog` — and both verify the same projection (`GET /api/cards` plus the
 * raw `Card` / `CardConsumption` / CARD-channel `Transaction` rows). Keeping that act in ONE place is
 * what stops the two scenarios from drifting apart, and it keeps the LIVE entry script within its size
 * budget.
 *
 * The bounded natural-turn RED-tool driver (with its fabricated-panel guard) stays in the entry script,
 * so {@link applyVirtualCardViaAgent} takes it as a callback. The read-model/DB primitives that the
 * entry script shares (`withDb`, `LiveCardRecord`, `fetchLiveCards`, `readCardTileRows`,
 * `readDialogRows`) live here as well and are re-used by the entry script, so nothing is duplicated.
 *
 * This file carries no `.test.`/`.spec.` suffix and is never collected by Vitest. Imports are relative
 * (`./helpers`, `../../lib/*`) — never the `@/` alias — like the other `*.e2e-helper.ts` modules.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import type { PrismaClient } from '../../lib/db/prisma';
import { centsToMoney, formatCNY, moneyToCents } from '../../lib/money';
import {
  NAV_TIMEOUT_MS,
  REPO_ROOT,
  getJson,
  gotoAgent,
  waitFor,
  waitForElementHydration,
  waitForStatusText,
} from './helpers';

// --- shared configuration -----------------------------------------------------------------------

/** The demo user's CHECKING account — the settlement account of every VIRTUAL card asserted here. */
export const VC_CHECKING_ACCOUNT_ID = 'acct_checking';
/**
 * A SMALL monthly limit so the MONTHLY LIMIT — never the ~23k of checking cash — is the binding
 * constraint of every `payableAmount` assertion (otherwise those assertions are vacuous).
 */
export const VC_MONTHLY_LIMIT = '100.00';
/** The within-limit spend of both scenarios (30 of 100 ⇒ 70 left in the billing month). */
export const VC_FIRST_SPEND = '30.00';
/** The spend that exactly exhausts the remaining family allowance (70 = 100 − 30). */
export const VC_SECOND_SPEND = '70.00';
/** A spend that EXCEEDS the remaining 70 monthly allowance (must be refused, no funds move). */
export const VC_OVER_LIMIT_SPEND = '80.00';
/** A spend attempted against an already exhausted family allowance (must be refused). */
export const VC_TINY_SPEND = '1.00';
/** `SPENDING_CATEGORIES` member (see `banking-sdk/card.ts`) — anything else is a VALIDATION refusal. */
export const VC_SPEND_CATEGORY = '购物';
/** Unique merchants keep the CARD-channel ledger rows of each leg unambiguous. */
export const VC_MERCHANT_APPLY = '虚拟卡开卡消费验证';
export const VC_MERCHANT_PRE_LOST = '虚拟卡挂失前消费验证';
export const VC_MERCHANT_REPLACE = '虚拟卡补办续限验证';
/**
 * The merchant of a spend that MUST be refused. A distinct label makes "nothing moved" unambiguous:
 * a stale or partially-written row could never be mistaken for one of the accepted spends.
 */
export const VC_MERCHANT_REFUSED = '虚拟卡超限拒绝验证';
/**
 * The text the consume dialog actually renders for an over-limit refusal: `LIMIT_EXCEEDED` maps to
 * `pages.cards.consumeLimitExceeded` in `app/cards/CardConsumeDialog.tsx#failureKey`, and that key is
 * exactly "超出本月消费限额" in `lib/i18n/messages/pages.zh-CN.json`. The server's own detail string is
 * only surfaced for `VALIDATION`, so this localized sentence IS the whole refusal surface.
 */
export const VC_LIMIT_EXCEEDED_TEXT = '超出本月消费限额';

/**
 * Natural Chinese turns asking the LIVE model to OPEN a virtual card with a stated monthly limit.
 * The first turn states the limit (the model must reach the RED `apply_virtual_card` tool); the rest
 * are confirmation nudges in the same spirit as the other live card scenarios. No internal tool or
 * parameter name is ever typed.
 */
export const VC_APPLY_TURNS: readonly string[] = [
  '请帮我新开一张虚拟卡，月消费限额设为100元',
  '确认，请办理开卡',
  '界面上方没有出现确认面板，请重新发起开卡申请',
  '请直接为我开通这张月限额100元的虚拟卡，我已确认',
];

/** Natural Chinese turns asking the LIVE model to report ONE identified virtual card lost (RED). */
export function vcReportLostTurns(maskTail: string): readonly string[] {
  return [
    `我刚才新办的那张虚拟卡（尾号${maskTail}，月限额100元）丢失了，请帮我正式挂失这张卡`,
    '确认，请办理挂失',
    '界面上方没有出现确认面板，请重新发起这张卡的挂失',
    `请直接帮我挂失那张尾号${maskTail}的虚拟卡，我已经确认`,
  ];
}

/** Natural Chinese turns asking the LIVE model to REPLACE the just-lost virtual card (RED). */
export function vcReplaceTurns(maskTail: string): readonly string[] {
  return [
    `请为我刚才挂失的虚拟卡（原卡尾号${maskTail}）补办一张新卡`,
    '确认，请为我补办',
    '界面上方没有出现确认面板，请重新发起补办',
    `请直接为我补办那张尾号${maskTail}的虚拟卡，我已确认`,
  ];
}

// --- read-model + DB primitives shared with the entry script --------------------------------------

/** `GET /api/cards` row — the FULL `CardView` subset these scenarios assert on. */
export interface LiveCardRecord {
  id: string;
  type: string;
  status: string;
  numberMasked?: string;
  creditLimit?: string;
  availableLimit?: string;
  monthlyLimit?: string;
  linkedAccountId?: string;
  linkedAccountNumber?: string;
  accountAvailableBalance?: string;
  payableAmount?: string;
  replacedByCardId?: string;
}

/** One card by id, or `undefined` when the demo user does not hold it. */
export function cardById(cards: readonly LiveCardRecord[], cardId: string): LiveCardRecord | undefined {
  return cards.find((card) => card.id === cardId);
}

/** The demo user's cards straight from the REAL read route (never the narrow `fetchCards` helper). */
export async function fetchLiveCards(baseUrl: string): Promise<LiveCardRecord[]> {
  const data = await getJson<{ cards: LiveCardRecord[] }>(`${baseUrl}/api/cards`);
  return data.cards;
}

/** Run `fn` on a throwaway PrismaClient bound to the isolated live DB (authoritative cross-checks). */
export async function withDb<T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const { createDatabaseClient } = await import('../../lib/db/database');
  const db = createDatabaseClient();
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}

/** Read a rendered `CardTile`'s `<dt>/<dd>` rows (`账户可用余额` / `当前可支付金额` / credit rows). */
export async function readCardTileRows(page: Page, cardId: string): Promise<Record<string, string>> {
  return page.locator(`[data-card-id="${cardId}"]`).first().evaluate((tile) => {
    const rows: Record<string, string> = {};
    for (const dt of Array.from(tile.querySelectorAll('dl dt'))) {
      const label = (dt.textContent ?? '').replace(/\s+/g, '');
      const dd = dt.nextElementSibling;
      if (label && dd) rows[label] = (dd.textContent ?? '').trim();
    }
    return rows;
  });
}

/** The whole rendered text of one `CardTile` (labels rendered as `<span>`, e.g. 关联账户 / 月限额). */
export async function readCardTileText(page: Page, cardId: string): Promise<string> {
  return (await page.locator(`[data-card-id="${cardId}"]`).first().innerText()).replace(/\s+/g, ' ');
}

/** Read a rendered `<dl>`'s `dt → dd` label/value map (the consume dialog's summary rows). */
export async function readDialogRows(page: Page, selector: string): Promise<Record<string, string>> {
  const list = page.locator(selector).first();
  if ((await list.count()) === 0) return {};
  return list.evaluate((el) => {
    const rows: Record<string, string> = {};
    for (const dt of Array.from(el.querySelectorAll('dt'))) {
      const label = (dt.textContent ?? '').replace(/\s+/g, '');
      const dd = dt.nextElementSibling;
      if (label && dd) rows[label] = (dd.textContent ?? '').trim();
    }
    return rows;
  });
}

// --- RAW SQLite card state ------------------------------------------------------------------------

/** The raw `Card` row subset asserted on (the just-landed inheritance fix is a SQLite fact). */
export interface RawCardRow {
  id: string;
  type: string;
  status: string;
  network: string;
  numberMasked: string;
  creditLimitMinor: bigint | null;
  availableLimitMinor: bigint | null;
  monthlyLimitMinor: bigint | null;
  linkedAccountId: string | null;
  replacedByCardId: string | null;
}

const RAW_CARD_FIELDS = {
  id: true,
  type: true,
  status: true,
  network: true,
  numberMasked: true,
  creditLimitMinor: true,
  availableLimitMinor: true,
  monthlyLimitMinor: true,
  linkedAccountId: true,
  replacedByCardId: true,
} as const;

/** One raw `Card` row straight from SQLite (throws when the row does not exist). */
export function readRawCard(cardId: string): Promise<RawCardRow> {
  return withDb(async (db) => {
    const row = await db.card.findUnique({ where: { id: cardId }, select: RAW_CARD_FIELDS });
    if (!row) throw new Error(`SQLite 缺少 Card 行 ${cardId}`);
    return row;
  });
}

/** Poll the RAW `Card` row until `predicate` holds (a business condition, never a fixed sleep). */
export function awaitRawCard(
  cardId: string,
  predicate: (row: RawCardRow) => boolean,
  description: string,
  timeoutMs = 180_000,
): Promise<RawCardRow> {
  return waitFor(
    async () => {
      const row = await readRawCard(cardId);
      return predicate(row) ? row : false;
    },
    { timeoutMs, intervalMs: 1_000, description },
  );
}

/** One `channel='CARD'` DEBIT ledger row of the checking account. */
export interface CardDebitRow {
  id: string;
  amountMinor: bigint;
  channel: string | null;
  direction: string;
  category: string;
  merchant: string;
}

/** One `CardConsumption` row (`amountMinor` is the positive magnitude of the spend). */
export interface CardConsumptionRow {
  id: string;
  cardId: string;
  accountId: string;
  amountMinor: bigint;
  category: string;
  merchant: string;
}

/** The authoritative spend state: checking cash + every CARD-channel debit + every card consumption. */
export interface CardSpendState {
  balanceMinor: bigint;
  cardDebits: CardDebitRow[];
  consumptions: CardConsumptionRow[];
}

/** Read the checking balance, the CARD-channel debits and all `CardConsumption` rows from SQLite. */
export function readCardSpendState(): Promise<CardSpendState> {
  return withDb(async (db) => {
    const [cardDebits, consumptions, account] = await Promise.all([
      db.transaction.findMany({
        where: { accountId: VC_CHECKING_ACCOUNT_ID, channel: 'CARD', direction: 'DEBIT' },
        select: { id: true, amountMinor: true, channel: true, direction: true, category: true, merchant: true },
      }),
      db.cardConsumption.findMany({
        select: { id: true, cardId: true, accountId: true, amountMinor: true, category: true, merchant: true },
      }),
      db.account.findUnique({ where: { id: VC_CHECKING_ACCOUNT_ID }, select: { balanceMinor: true } }),
    ]);
    if (!account) throw new Error(`缺少账户 ${VC_CHECKING_ACCOUNT_ID}`);
    return { balanceMinor: account.balanceMinor, cardDebits, consumptions };
  });
}

/** The rows of `after` that did not exist in `before` (matched by id). */
export function newRowsById<T extends { id: string }>(before: readonly T[], after: readonly T[]): T[] {
  const known = new Set(before.map((row) => row.id));
  return after.filter((row) => !known.has(row.id));
}

/** One-line rendering of a debit/consumption diff for failure + evidence strings. */
export function describeCardDebits(rows: readonly CardDebitRow[]): string {
  return rows.map((row) => `${row.id}:${row.amountMinor}:${row.channel}/${row.direction}:${row.category}/${row.merchant}`).join(' ') || '(无)';
}

export function describeConsumptions(rows: readonly CardConsumptionRow[]): string {
  return rows.map((row) => `${row.id}:${row.cardId}:${row.amountMinor}:${row.category}/${row.merchant}`).join(' ') || '(无)';
}

/** The exact rows one accepted spend produced (evidence + later assertions). */
export interface SpendDelta {
  debit: CardDebitRow;
  consumption: CardConsumptionRow;
  balanceBeforeMinor: bigint;
  balanceAfterMinor: bigint;
}

/**
 * Assert that ONE spend landed EXACTLY ONCE between `before` and `after`: exactly one new
 * `channel='CARD'`/`direction='DEBIT'` transaction of `-amountMinor` with the leg's unique merchant,
 * exactly one new `CardConsumption` bound to `cardId` on the checking account, and a checking balance
 * debited exactly once. Every scenario uses ONE merchant per accepted spend, so the table-wide
 * duplicate check below is a real "charged twice?" guard, not a coincidence.
 */
export function assertSingleSpend(
  before: CardSpendState,
  after: CardSpendState,
  expected: { cardId: string; amountMinor: bigint; category: string; merchant: string; label: string },
): SpendDelta {
  const newDebits = newRowsById(before.cardDebits, after.cardDebits);
  const newConsumptions = newRowsById(before.consumptions, after.consumptions);
  if (newDebits.length !== 1) {
    throw new Error(`${expected.label}：应恰新增 1 条 channel=CARD/DEBIT 流水，实际 ${newDebits.length}：${describeCardDebits(newDebits)}`);
  }
  const debit = newDebits[0];
  if (debit.amountMinor !== -expected.amountMinor || debit.channel !== 'CARD' || debit.direction !== 'DEBIT'
    || debit.category !== expected.category || debit.merchant !== expected.merchant) {
    throw new Error(`${expected.label}：新增流水应为 -${expected.amountMinor}、CARD/DEBIT、${expected.category}/${expected.merchant}，实际 ${describeCardDebits([debit])}`);
  }
  if (newConsumptions.length !== 1) {
    throw new Error(`${expected.label}：应恰新增 1 条 CardConsumption，实际 ${newConsumptions.length}：${describeConsumptions(newConsumptions)}`);
  }
  const consumption = newConsumptions[0];
  if (consumption.cardId !== expected.cardId || consumption.accountId !== VC_CHECKING_ACCOUNT_ID
    || consumption.amountMinor !== expected.amountMinor || consumption.category !== expected.category
    || consumption.merchant !== expected.merchant) {
    throw new Error(`${expected.label}：新增 CardConsumption 应为 cardId=${expected.cardId}、accountId=${VC_CHECKING_ACCOUNT_ID}、amountMinor=${expected.amountMinor}（${expected.category}/${expected.merchant}），实际 ${describeConsumptions([consumption])}`);
  }
  if (after.balanceMinor !== before.balanceMinor - expected.amountMinor) {
    throw new Error(`${expected.label}：活期余额应减少恰 ${expected.amountMinor}，实际 ${centsToMoney(before.balanceMinor)} → ${centsToMoney(after.balanceMinor)}`);
  }
  const duplicates = after.cardDebits.filter((row) => row.amountMinor === -expected.amountMinor && row.merchant === expected.merchant);
  if (duplicates.length !== 1) {
    throw new Error(`${expected.label}：本次消费应恰有 1 条流水（不得重复扣款），实际 ${duplicates.length}：${duplicates.map((row) => row.id).join(',')}`);
  }
  return { debit, consumption, balanceBeforeMinor: before.balanceMinor, balanceAfterMinor: after.balanceMinor };
}

/** Assert that NOTHING moved between two spend states (a refusal must be a complete no-op). */
export function assertNoSpend(before: CardSpendState, after: CardSpendState, label: string): void {
  const newDebits = newRowsById(before.cardDebits, after.cardDebits);
  const newConsumptions = newRowsById(before.consumptions, after.consumptions);
  if (newDebits.length !== 0) throw new Error(`${label}：被拒绝的消费不得写入流水，实际新增 ${describeCardDebits(newDebits)}`);
  if (newConsumptions.length !== 0) throw new Error(`${label}：被拒绝的消费不得写入 CardConsumption，实际新增 ${describeConsumptions(newConsumptions)}`);
  if (after.balanceMinor !== before.balanceMinor) {
    throw new Error(`${label}：被拒绝的消费不得移动资金，实际 ${centsToMoney(before.balanceMinor)} → ${centsToMoney(after.balanceMinor)}`);
  }
}

// --- payable maths + projection assertions --------------------------------------------------------

/** `min(account available cash, remaining monthly limit)` — the documented spendable amount. */
export function expectedPayableMinor(
  monthlyLimitMinor: bigint,
  familySpentMinor: bigint,
  accountBalanceMinor: bigint,
): bigint {
  const remainingMinor = monthlyLimitMinor > familySpentMinor ? monthlyLimitMinor - familySpentMinor : 0n;
  return accountBalanceMinor < remainingMinor ? accountBalanceMinor : remainingMinor;
}

/** The projection values a render + a `GET /api/cards` row must both expose. */
export interface VirtualCardProjection {
  monthlyLimit: string;
  accountAvailableBalance: string;
  payableAmount: string;
  /** Rendered account reference (the masked linked-account number). */
  linkedAccountText?: string;
}

/**
 * Assert the AUTHORITATIVE `GET /api/cards` row of a virtual card: a DEBIT instrument bound to the
 * checking account with a monthly limit — and NEVER an invented credit line.
 */
export function assertVirtualCardView(
  card: LiveCardRecord | undefined,
  expected: VirtualCardProjection & { cardId: string; numberMasked?: string },
): void {
  if (card === undefined) throw new Error(`GET /api/cards 缺少卡片 ${expected.cardId}`);
  if (card.type !== 'VIRTUAL') throw new Error(`${expected.cardId}.type 应为 VIRTUAL，实际 ${card.type}`);
  if (card.status !== 'ACTIVE') throw new Error(`${expected.cardId}.status 应为 ACTIVE，实际 ${card.status}`);
  if (card.creditLimit !== undefined || card.availableLimit !== undefined) {
    throw new Error(`${expected.cardId} 是借记类虚拟卡，不得暴露信用额度字段，实际 ${JSON.stringify(card)}`);
  }
  if (card.linkedAccountId !== VC_CHECKING_ACCOUNT_ID) {
    throw new Error(`${expected.cardId}.linkedAccountId 应为 ${VC_CHECKING_ACCOUNT_ID}，实际 ${card.linkedAccountId}`);
  }
  if (card.monthlyLimit !== expected.monthlyLimit) {
    throw new Error(`${expected.cardId}.monthlyLimit 应为 ${expected.monthlyLimit}，实际 ${card.monthlyLimit}`);
  }
  if (card.accountAvailableBalance !== expected.accountAvailableBalance) {
    throw new Error(`${expected.cardId}.accountAvailableBalance 应为 ${expected.accountAvailableBalance}，实际 ${card.accountAvailableBalance}`);
  }
  if (card.payableAmount !== expected.payableAmount) {
    throw new Error(`${expected.cardId}.payableAmount 应为 ${expected.payableAmount}（= min(账户可用余额, 剩余月限额)），实际 ${card.payableAmount}`);
  }
  if (expected.numberMasked !== undefined && card.numberMasked !== expected.numberMasked) {
    throw new Error(`${expected.cardId}.numberMasked 应为 ${expected.numberMasked}，实际 ${card.numberMasked}`);
  }
}

/**
 * Assert the RENDERED `CardTile` of a virtual card: server-projected 关联账户 / 账户可用余额 / 月限额 /
 * 当前可支付金额, and NO 信用额度 / 可用额度 (those two rows are CREDIT-only in `CardTile`).
 */
export function assertVirtualCardTile(
  cardId: string,
  rows: Record<string, string>,
  tileText: string,
  expected: VirtualCardProjection,
): void {
  for (const creditLabel of ['信用额度', '可用额度']) {
    if (rows[creditLabel] !== undefined) {
      throw new Error(`虚拟卡 ${cardId} 不应渲染「${creditLabel}」行，实际 ${JSON.stringify(rows)}`);
    }
    if (tileText.includes(creditLabel)) {
      throw new Error(`虚拟卡 ${cardId} 的卡片文本出现「${creditLabel}」（虚拟卡不是信用工具）：${tileText.slice(0, 240)}`);
    }
  }
  if (!tileText.includes('关联账户')) throw new Error(`虚拟卡 ${cardId} 未渲染「关联账户」：${tileText.slice(0, 240)}`);
  if (expected.linkedAccountText !== undefined && !tileText.includes(expected.linkedAccountText)) {
    throw new Error(`虚拟卡 ${cardId} 的「关联账户」应显示 ${expected.linkedAccountText}：${tileText.slice(0, 240)}`);
  }
  if (!tileText.includes('月限额')) throw new Error(`虚拟卡 ${cardId} 未渲染「月限额」：${tileText.slice(0, 240)}`);
  if (!tileText.includes(formatCNY(expected.monthlyLimit))) {
    throw new Error(`虚拟卡 ${cardId} 的「月限额」应显示 ${formatCNY(expected.monthlyLimit)}：${tileText.slice(0, 240)}`);
  }
  if (rows['账户可用余额'] !== formatCNY(expected.accountAvailableBalance)) {
    throw new Error(`虚拟卡 ${cardId} 的「账户可用余额」应为 ${formatCNY(expected.accountAvailableBalance)}，实际 ${rows['账户可用余额']}（${JSON.stringify(rows)}）`);
  }
  if (rows['当前可支付金额'] !== formatCNY(expected.payableAmount)) {
    throw new Error(`虚拟卡 ${cardId} 的「当前可支付金额」应为 ${formatCNY(expected.payableAmount)}，实际 ${rows['当前可支付金额']}（${JSON.stringify(rows)}）`);
  }
}

// --- RED apply step (shared by lD + lE) ------------------------------------------------------------

/** The bounded natural-turn RED driver owned by the entry script (keeps its fabricated-panel guard). */
export type RedToolDriver = (turns: readonly string[]) => Promise<string[]>;

export interface AppliedVirtualCard {
  cardId: string;
  /** The prompts actually sent by the driver. */
  sent: string[];
  /** The card as read back from `GET /api/cards`. */
  card: LiveCardRecord;
}

/**
 * Open a NEW virtual card with `monthlyLimit` through the REAL `/agent` chat: drive the RED
 * `apply_virtual_card` tool in bounded natural turns (the driver completes the confirmation/MFA panel
 * with the real code), then wait for the authoritative `GET /api/cards` route to expose exactly ONE
 * new card and verify it is the ACTIVE VIRTUAL card the request asked for.
 * `opts.turns` OVERRIDES the default `VC_APPLY_TURNS` list for scenarios whose first user prompt is a
 * pinned verbatim sentence (lG replays an exact transcript); the caller owns the bounded turn list.
 */
export async function applyVirtualCardViaAgent(
  page: Page,
  baseUrl: string,
  drive: RedToolDriver,
  opts: { excludeCardIds: readonly string[]; monthlyLimit?: string; turns?: readonly string[] },
): Promise<AppliedVirtualCard> {
  const limit = opts.monthlyLimit ?? VC_MONTHLY_LIMIT;
  const before = await fetchLiveCards(baseUrl);
  const known = new Set<string>([...opts.excludeCardIds, ...before.map((card) => card.id)]);
  await gotoAgent(page, baseUrl);
  const sent = await drive(opts.turns ?? VC_APPLY_TURNS);
  const cards = await waitFor(
    async () => {
      const list = await fetchLiveCards(baseUrl);
      return list.some((card) => !known.has(card.id)) ? list : false;
    },
    { timeoutMs: 180_000, intervalMs: 1_000, description: `RED 开卡后 GET /api/cards 出现新虚拟卡（月限额 ${limit}）` },
  );
  const created = cards.filter((card) => !known.has(card.id));
  if (created.length !== 1) {
    throw new Error(
      `开卡后应恰新增 1 张卡，实际 ${created.length}：${created.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}（全部卡片：${cards.map((card) => `${card.id}:${card.type}:${card.status}`).join(',')}）`,
    );
  }
  const card = created[0];
  if (card.type !== 'VIRTUAL' || card.status !== 'ACTIVE') {
    throw new Error(`新卡应为 ACTIVE 的 VIRTUAL 卡，实际 ${JSON.stringify(card)}`);
  }
  if (card.monthlyLimit !== limit) {
    throw new Error(`新虚拟卡月限额应为 ${limit}（自然语言中已明确给出），实际 ${card.monthlyLimit}：${JSON.stringify(card)}`);
  }
  return { cardId: card.id, sent, card };
}

// --- real front-end consumption --------------------------------------------------------------------

/** Open `/cards` (hydration-complete) so a `[data-card-id]` tile can be driven. */
export async function gotoCards(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/cards`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  await waitForElementHydration(page, '[data-card-add] button');
}

/**
 * Click a card tile's 消费 button and wait for the REAL `CardConsumeDialog` form bound to `cardId`.
 * Returns the dialog's server-projected summary rows (关联账户 / 账户可用余额 / 月限额 / 当前可支付金额).
 */
export async function openConsumeDialog(page: Page, cardId: string): Promise<Record<string, string>> {
  await waitForElementHydration(page, `[data-card-id="${cardId}"] [data-card-consume] button`);
  const button = page.locator(`[data-card-id="${cardId}"] [data-card-consume] button`).first();
  await waitFor(async () => ((await button.isEnabled()) ? true : false), {
    timeoutMs: 60_000,
    description: `${cardId} 的「消费」按钮可用`,
  });
  await button.click();
  await waitForElementHydration(page, '[data-card-consume-form]');
  const dialogCardId = await page.locator('[data-card-consume-dialog]').first().getAttribute('data-card-consume-card-id');
  if (dialogCardId !== cardId) {
    throw new Error(`消费弹窗应绑定 ${cardId}，实际 data-card-consume-card-id=${dialogCardId}`);
  }
  return readDialogRows(page, '[data-card-consume-summary]');
}

export interface ConsumeInput {
  amount: string;
  category: string;
  merchant: string;
}

/** Fill + submit the consume form (only `amount`/`category`/`merchant` — booking time is server-owned). */
async function submitConsume(page: Page, input: ConsumeInput): Promise<void> {
  const form = page.locator('[data-card-consume-form]').first();
  await form.locator('input[name="amount"]').fill(input.amount);
  await form.locator('input[name="category"]').fill(input.category);
  await form.locator('input[name="merchant"]').fill(input.merchant);
  await form.getByRole('button', { name: '提交消费', exact: true }).click();
}

/** Render the dialog's consume records as `merchant · category · amount` lines. */
export async function readConsumeRecords(page: Page): Promise<string[]> {
  const texts = await page.locator('[data-card-consumption]').allInnerTexts();
  return texts.map((text) => text.replace(/\s+/g, ' ').trim());
}

export interface ConsumeSuccess {
  notice: string;
  recordCount: number;
  lastRecordText: string;
}

/**
 * Submit a spend that MUST be accepted and wait for the dialog's success notice plus its reloaded
 * record list (`expectedRecordCount` = rows this card already had + 1).
 */
export async function consumeSuccessfully(
  page: Page,
  input: ConsumeInput,
  expectedRecordCount: number,
): Promise<ConsumeSuccess> {
  await submitConsume(page, input);
  await waitForStatusText(page, '消费成功', 60_000);
  await waitFor(
    async () => ((await page.locator('[data-card-consumption]').count()) === expectedRecordCount ? true : false),
    { timeoutMs: 60_000, description: `消费成功后弹窗「消费记录」应为 ${expectedRecordCount} 条` },
  );
  const records = await readConsumeRecords(page);
  return {
    notice: '消费成功',
    recordCount: records.length,
    lastRecordText: records[records.length - 1] ?? '',
  };
}

/**
 * Submit a spend that MUST be REFUSED and return the refusal text the dialog actually renders
 * (`<p role="alert">` inside the consume dialog — never an invented string).
 */
export async function attemptConsumeExpectingRefusal(page: Page, input: ConsumeInput): Promise<string> {
  await submitConsume(page, input);
  return waitFor(
    async () => {
      const alerts = await page.locator('[data-card-consume-dialog] p[role="alert"]').allInnerTexts();
      const text = alerts.join(' ').replace(/\s+/g, ' ').trim();
      return text === '' ? false : text;
    },
    { timeoutMs: 60_000, intervalMs: 500, description: '消费被拒绝时弹窗内的 role=alert 提示' },
  );
}

// --- machine-readable per-run evidence --------------------------------------------------------------

/**
 * Persist a machine-readable evidence JSON for one LIVE smoke run under `logs/` (file logs belong in
 * `logs/` per the repository contract). Auxiliary only: a write failure is reported and never flips an
 * acceptance result.
 */
export function writeScenarioEvidence(label: string, payload: Record<string, unknown>): string | undefined {
  try {
    const dir = path.join(REPO_ROOT, 'logs');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${label}-evidence.json`);
    const json = JSON.stringify(payload, (_key, value) => (typeof value === 'bigint' ? value.toString() : value), 2);
    writeFileSync(file, `${json}\n`, 'utf8');
    return file;
  } catch (error) {
    console.warn(`· 证据 JSON 写入失败（不影响验收结论）：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** The LIVE model id this process is configured with (never a secret; `undefined` when unset). */
export function liveModelId(): string {
  return process.env['LLM_MODEL']?.trim() || '(未设置 LLM_MODEL)';
}

/** `min(...)` formatting convenience: minor units → the `formatCNY` rendering used by the UI. */
export function cny(minor: bigint): string {
  return formatCNY(centsToMoney(minor));
}

/** Parse a `CardView` money string into minor units (throws on a missing/invalid value). */
export function minorOf(value: string | undefined, label: string): bigint {
  if (value === undefined) throw new Error(`${label} 缺失`);
  return moneyToCents(value);
}
