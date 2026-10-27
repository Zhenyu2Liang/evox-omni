/**
 * tests/integration/card-linked-account-projection.test.ts — SQLITE-BACKED regression for the
 * "借记卡展示绑定账户余额" half of the card projection (`banking-sdk/card.ts#loadCardView` /
 * `#toCardView`), through the REAL SDK against the REAL (isolated SQLite) database: no model, no
 * browser, no HTTP.
 *
 * INVARIANT UNDER TEST (root CONTEXT.md): a DEBIT/VIRTUAL card is a debit instrument bound to ONE
 * owned CHECKING account. Its displayed balance IS that account's cash — never a second balance owned
 * by the card, never a credit line, and never somebody else's money. Consequences covered here:
 *
 *  (1) OWNERSHIP (security). `Card.linkedAccountId` is a real FK, so storage CAN hold a card whose
 *      settlement account belongs to another user (or is a SAVINGS account). The projection must not
 *      leak that account: `linkedAccountStatus` is `UNTRUSTED` and the view carries NO balance field
 *      at all — not the other owner's balance, not a fabricated `0.00`, not the masked number, not
 *      the account name. Spending from such a card is refused (`CONFLICT`) and moves no money. A
 *      `MISSING` binding likewise reports no balance field.
 *
 *  (2) ONE ACCOUNT, MANY CARDS. Two cards bound to the same CHECKING account share that single
 *      balance: both report the SAME `accountAvailableBalance`, a spend through ONE card lowers BOTH
 *      by the same amount, and the account's cash is still counted ONCE in the dashboard summary and
 *      total assets (`tests/integration/card-dashboard-assets.test.ts` owns the credit/asset
 *      aggregation baseline; this file adds the two-cards-one-account case explicitly).
 *
 *  (3) ONE YARDSTICK FOR EVERY BALANCE. After a TRANSFER, a CARD SPEND and an INVESTMENT PURCHASE the
 *      card view's `accountAvailableBalance` must equal the ACCOUNT's balance — compared as canonical
 *      CNY money text against `centsToMoney(account.balanceMinor)` AND against the account page
 *      (`banking.account.getBalance`). All three paths share ONE assertion helper, so no path can
 *      invent its own arithmetic.
 *
 * Fixtures (`tests/helpers/fixtures.ts`): demo user 李明, CHECKING `acct_checking` ¥23,580.00 (mask
 * `****8821`, name 活期账户), SAVINGS `acct_savings` ¥50,000.00, `card_credit` (CREDIT, ¥18,000.00
 * available), `card_debit` (DEBIT, bound to `acct_checking`, no monthly limit), holding 稳健理财A with
 * market value ¥5,050. Total assets therefore start at 5,050 + 73,580.00 = '78630'.
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { CardView } from '@/banking-sdk/types';
import { addDecimal, subtractDecimal } from '@/lib/decimal';
import { AppError } from '@/lib/errors';
import { addMoney, centsToMoney, moneyToCents, subtractMoney } from '@/lib/money';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';

const db = () => getTestPrisma();

/** The seeded CHECKING account — the settlement account of every DEBIT/VIRTUAL card below. */
const CHECKING = 'acct_checking';
/** The seeded SAVINGS account — never a valid settlement account (a card spends from 活期 only). */
const SAVINGS = 'acct_savings';
/** The seeded DEBIT card, bound to `acct_checking` with NO monthly limit. */
const DEBIT = 'card_debit';
/** A user that exists only to own a card whose settlement account is somebody else's. */
const FOREIGN_USER_ID = 'user_foreign_owner';
/** That user's card (id chosen so no assertion can collide with a generated id). */
const FOREIGN_CARD = 'card_foreign_bound';

/** `acct_checking` cash as seeded: '23580.00'. */
const SEEDED_CHECKING = '23580.00';
/** `acct_savings` cash as seeded: '50000.00'. */
const SEEDED_SAVINGS = '50000.00';
/** Both seeded accounts: '73580.00'. */
const SEEDED_CASH = '73580.00';
/** The seeded CREDIT card's available limit: '18000.00'. */
const SEEDED_CREDIT_AVAILABLE = '18000.00';
/** holdings ¥5,050 + cash ¥73,580.00, as the summary's unrounded decimal text. */
const SEEDED_TOTAL_ASSETS = '78630';
/** The one amount every path below moves, so each balance delta is the same exact number. */
const SPEND = '100.00';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** The raw CHECKING row — the ledger of record every card view must agree with. */
const accountRow = (accountId: string = CHECKING) =>
  db().account.findUniqueOrThrow({ where: { id: accountId } });

/** One card of `userId` as `getCards` projects it (the exact DTO the UI renders). */
async function viewOf(userId: string, cardId: string): Promise<CardView> {
  const view = (await banking.card.getCards(userId)).find((card) => card.id === cardId);
  if (!view) throw new Error(`card ${cardId} was not projected for ${userId}`);
  return view;
}

/**
 * THE one yardstick shared by every balance path in this file: a card's displayed balance must be the
 * bound account's balance, compared as canonical CNY money text on BOTH sides —
 * `card.accountAvailableBalance === centsToMoney(account.balanceMinor)` — and cross-checked against
 * the account page (`banking.account.getBalance`) so "card view" and "account page" can never show two
 * different numbers for one account. Returns the agreed money text for delta assertions.
 */
async function expectCardBalanceMatchesAccount(
  card: CardView,
  accountId: string = CHECKING,
): Promise<string> {
  const row = await accountRow(accountId);
  const accountMoney = centsToMoney(row.balanceMinor);
  const pageAccount = (await banking.account.getBalance(DEMO_USER_ID)).accounts
    .find((account) => account.id === accountId);
  expect(pageAccount?.balance).toBe(accountMoney);

  expect(card.linkedAccountStatus).toBe('LINKED');
  expect(card.linkedAccountId).toBe(accountId);
  expect(card.accountAvailableBalance).toBe(accountMoney);
  return accountMoney;
}

describe('a card view never leaks a settlement account the card does not own', () => {
  it('projects UNTRUSTED with no balance, number or name when the account belongs to another user', async () => {
    // ── Arrange: user B owns a card whose RECORDED settlement account is user A's `acct_checking`.
    // The FK allows the row (the account exists); only the projection can refuse to resolve it. ────
    await db().user.create({ data: { id: FOREIGN_USER_ID, name: '王五', phone: '139****0008' } });
    await db().card.create({ data: {
      id: FOREIGN_CARD,
      userId: FOREIGN_USER_ID,
      type: 'DEBIT',
      network: 'UnionPay',
      numberMasked: '****7777',
      status: 'ACTIVE',
      linkedAccountId: CHECKING,
    } });
    // ── Act: the projection of user B's own cards. ────────────────────────────────────────────────
    const foreign = await viewOf(FOREIGN_USER_ID, FOREIGN_CARD);
    expect(foreign.linkedAccountStatus).toBe('UNTRUSTED');
    // The stored reference is echoed (a historical id), but nothing that RESOLVES to account A is.
    expect(foreign.linkedAccountId).toBe(CHECKING);
    expect(foreign.accountAvailableBalance).toBeUndefined();
    expect(foreign.payableAmount).toBeUndefined();
    expect(foreign.linkedAccountNumber).toBeUndefined();
    expect(foreign.linkedAccountName).toBeUndefined();
    // Not `0.00` either: a missing balance is absent, never fabricated.
    expect(foreign.accountAvailableBalance).not.toBe(centsToMoney(0n));
    expect(foreign.accountAvailableBalance).not.toBe('0.00');
    // An ACTIVE but untrusted card is "usable": unusable is a card status, not a binding state.
    expect(foreign.usable).toBe(true);

    // ── Assert: NOT ONE BYTE of account A's money, mask or name in the serialized projection. ─────
    const serialized = JSON.stringify(await banking.card.getCards(FOREIGN_USER_ID));
    expect(serialized).not.toContain('23580');
    expect(serialized).not.toContain('8821');
    expect(serialized).not.toContain('活期账户');
    expect(serialized).not.toContain(SAVINGS);
    // The projection still names the card itself (a masked number it owns, its own id).
    expect(serialized).toContain('****7777');
    expect(serialized).toContain(FOREIGN_CARD);

    // ── User A's own card is unaffected: still LINKED, still showing A's own cash. ────────────────
    const owner = await viewOf(DEMO_USER_ID, DEBIT);
    expect(owner.linkedAccountNumber).toBe('****8821');
    expect(owner.linkedAccountName).toBe('活期账户');
    expect(await expectCardBalanceMatchesAccount(owner)).toBe(SEEDED_CHECKING);
  });

  it('refuses to spend from it, so another owner’s cash cannot be debited', async () => {
    await db().user.create({ data: { id: FOREIGN_USER_ID, name: '王五', phone: '139****0008' } });
    await db().card.create({ data: {
      id: FOREIGN_CARD,
      userId: FOREIGN_USER_ID,
      type: 'DEBIT',
      network: 'UnionPay',
      numberMasked: '****7777',
      status: 'ACTIVE',
      linkedAccountId: CHECKING,
    } });
    const before = await accountRow();

    // ONE call, one rejection: the settlement re-validation inside `consumeCard` refuses UNTRUSTED.
    const rejected = banking.card.consumeCard({
      userId: FOREIGN_USER_ID,
      cardId: FOREIGN_CARD,
      amount: '10.00',
      merchant: '越权消费',
    });
    await expect(rejected).rejects.toBeInstanceOf(AppError);
    await expect(rejected).rejects.toMatchObject({
      code: 'CONFLICT',
      detail: { cardId: FOREIGN_CARD, linkedAccountId: CHECKING, linkedAccountStatus: 'UNTRUSTED' },
    });

    // User A's money did not move and nothing was booked anywhere.
    expect((await accountRow()).balanceMinor).toBe(before.balanceMinor);
    expect(await db().transaction.count({ where: { merchant: '越权消费' } })).toBe(0);
    expect(await db().cardConsumption.count()).toBe(0);
  });

  it('projects an unbound card as MISSING with no balance field at all', async () => {
    await db().card.update({ where: { id: DEBIT }, data: { linkedAccountId: null } });

    const missing = await viewOf(DEMO_USER_ID, DEBIT);
    expect(missing.linkedAccountStatus).toBe('MISSING');
    expect(missing.linkedAccountId).toBeUndefined();
    expect(missing.accountAvailableBalance).toBeUndefined();
    expect(missing.payableAmount).toBeUndefined();
    expect(missing.linkedAccountNumber).toBeUndefined();
    expect(missing.linkedAccountName).toBeUndefined();
    // A missing binding reports NO balance — '0.00' would claim the card is empty, which is a lie.
    expect(missing.accountAvailableBalance).not.toBe('0.00');
    // …while the account's real cash is untouched by the broken binding.
    expect(centsToMoney((await accountRow()).balanceMinor)).toBe(SEEDED_CHECKING);
  });

  it('projects UNTRUSTED when the recorded account is not a CHECKING account', async () => {
    // `Card.linkedAccountId` may point at the owner's SAVINGS account (the FK does not encode the
    // type); a card never spends from savings, so the projection must refuse to resolve it.
    await db().card.update({ where: { id: DEBIT }, data: { linkedAccountId: SAVINGS } });

    const wrongType = await viewOf(DEMO_USER_ID, DEBIT);
    expect(wrongType.linkedAccountStatus).toBe('UNTRUSTED');
    expect(wrongType.accountAvailableBalance).toBeUndefined();
    expect(wrongType.payableAmount).toBeUndefined();
    // Not one digit of the savings balance and not its name.
    const serialized = JSON.stringify(wrongType);
    expect(serialized).not.toContain('50000');
    expect(serialized).not.toContain('储蓄账户');
  });
});

describe('several cards on one CHECKING account share that ONE balance', () => {
  it('shows the same balance — and the same decrement — on both cards, counted once in assets', async () => {
    // ── Arrange: the seeded DEBIT card plus a VIRTUAL card, BOTH bound to `acct_checking`. ────────
    const virtual = await banking.card.applyVirtualCard({
      userId: DEMO_USER_ID,
      linkedAccountId: CHECKING,
      monthlyLimit: '2000.00',
    });
    expect(virtual).toMatchObject({ type: 'VIRTUAL', status: 'ACTIVE', linkedAccountId: CHECKING });

    // STORAGE TRUTH: ONE account row, TWO cards — the real FK (`Account.cards`) holds both, so the
    // relation cannot drift from the projection that reads it.
    const bound = await db().account.findUniqueOrThrow({
      where: { id: CHECKING },
      select: { cards: { select: { id: true } } },
    });
    expect(bound.cards.map((card) => card.id).sort()).toEqual([DEBIT, virtual.id].sort());
    expect(await db().card.count({ where: { userId: DEMO_USER_ID, linkedAccountId: CHECKING } })).toBe(2);

    const summaryBefore = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(summaryBefore.checkingBalance).toBe(SEEDED_CHECKING);
    expect(summaryBefore.totalAssets).toBe(SEEDED_TOTAL_ASSETS);

    const debitBefore = await viewOf(DEMO_USER_ID, DEBIT);
    const virtualBefore = await viewOf(DEMO_USER_ID, virtual.id);
    // ONE balance, reported identically by both cards and equal to the account's own cash.
    expect(debitBefore.accountAvailableBalance).toBe(SEEDED_CHECKING);
    expect(virtualBefore.accountAvailableBalance).toBe(debitBefore.accountAvailableBalance);
    expect(await expectCardBalanceMatchesAccount(debitBefore)).toBe(SEEDED_CHECKING);
    expect(await expectCardBalanceMatchesAccount(virtualBefore)).toBe(SEEDED_CHECKING);
    // `payableAmount` stays CARD-SPECIFIC even though the balance is shared: the DEBIT card has no
    // monthly limit (the account governs), the VIRTUAL card is capped by its own ¥2,000 limit.
    expect(debitBefore.payableAmount).toBe(SEEDED_CHECKING);
    expect(virtualBefore.payableAmount).toBe('2000.00');

    // ── Act: spend ¥100.00 through ONE of the two cards. ──────────────────────────────────────────
    const consumed = await banking.card.consumeCard({
      userId: DEMO_USER_ID,
      cardId: virtual.id,
      amount: SPEND,
      category: '购物',
      merchant: '共享账户回归商户',
    });
    expect(consumed.consumption).toMatchObject({ cardId: virtual.id, accountId: CHECKING, amount: SPEND });

    // ── Assert: BOTH cards drop by the same ¥100.00, and both equal the account's new balance. ────
    const debitAfter = await viewOf(DEMO_USER_ID, DEBIT);
    const virtualAfter = await viewOf(DEMO_USER_ID, virtual.id);
    expect(await expectCardBalanceMatchesAccount(debitAfter)).toBe('23480.00');
    expect(await expectCardBalanceMatchesAccount(virtualAfter)).toBe('23480.00');
    expect(debitAfter.accountAvailableBalance).toBe(virtualAfter.accountAvailableBalance);
    expect(subtractMoney(debitBefore.accountAvailableBalance ?? '', debitAfter.accountAvailableBalance ?? '')).toBe(SPEND);
    expect(subtractMoney(virtualBefore.accountAvailableBalance ?? '', virtualAfter.accountAvailableBalance ?? '')).toBe(SPEND);
    // The card that did NOT spend moved by exactly the same amount (one account, one balance).
    expect(consumed.accountAvailableBalance).toBe(debitAfter.accountAvailableBalance);
    expect(consumed.card.accountAvailableBalance).toBe(virtualAfter.accountAvailableBalance);
    // The unspent card's own allowance is untouched by a spend it did not make.
    expect(debitAfter.payableAmount).toBe('23480.00');
    expect(virtualAfter.payableAmount).toBe(subtractMoney('2000.00', SPEND));

    // ── The account's cash is counted ONCE, however many cards are bound to it. ───────────────────
    // (`card-dashboard-assets.test.ts` owns the seeded aggregation baseline; this is the explicit
    // two-cards-one-account case.)
    const summary = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    const page = await banking.account.getBalance(DEMO_USER_ID);
    expect(summary.checkingBalance).toBe('23480.00');
    expect(summary.checkingBalance).toBe(centsToMoney((await accountRow()).balanceMinor));
    expect(page.totalAvailable).toBe(addMoney('23480.00', SEEDED_SAVINGS));
    expect(page.totalAvailable).toBe(subtractMoney(SEEDED_CASH, SPEND));
    expect(summary.totalAssets).toBe(subtractDecimal(SEEDED_TOTAL_ASSETS, SPEND));
    // 78,530 + 23,480 would mean each card contributed its own copy of the shared cash.
    expect(summary.totalAssets).not.toBe(addDecimal(subtractDecimal(SEEDED_TOTAL_ASSETS, SPEND), '23480.00'));
    // A debit instrument is never credit.
    expect(summary.creditAvailable).toBe(SEEDED_CREDIT_AVAILABLE);
  });
});

describe('a card shows the account balance at the same instant on every money path', () => {
  it('(1) after a transfer: the card view equals the account balance, reduced by the transfer', async () => {
    const before = await expectCardBalanceMatchesAccount(await viewOf(DEMO_USER_ID, DEBIT));
    expect(before).toBe(SEEDED_CHECKING);

    const transfer = await banking.transfer.createTransfer({
      userId: DEMO_USER_ID,
      contactId: 'contact_zhangwei',
      amount: SPEND,
      remark: '绑定余额一致性转账',
    });
    expect(transfer.success).toBe(true);
    expect(transfer.sourceAccountId).toBe(CHECKING);
    expect(transfer.newBalance).toBe(subtractMoney(SEEDED_CHECKING, SPEND));

    // The card the UI renders and the account it spends from agree, to the cent.
    const after = await expectCardBalanceMatchesAccount(await viewOf(DEMO_USER_ID, DEBIT));
    expect(after).toBe(transfer.newBalance);
    expect(after).toBe('23480.00');
    expect(subtractMoney(before, after)).toBe(SPEND);

    // Exactly ONE debit of exactly SPEND on the settlement account.
    const ledger = await db().transaction.findMany({ where: { accountId: CHECKING, remark: '绑定余额一致性转账' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ channel: 'TRANSFER', direction: 'DEBIT', currency: 'CNY' });
    expect(ledger[0].amountMinor).toBe(-moneyToCents(SPEND));
    // A transfer is not a card spend: no consumption row is invented for it.
    expect(await db().cardConsumption.count()).toBe(0);
  });

  it('(2) after a card spend: the card view equals the account balance it just debited', async () => {
    const before = await expectCardBalanceMatchesAccount(await viewOf(DEMO_USER_ID, DEBIT));

    const consumed = await banking.card.consumeCard({
      userId: DEMO_USER_ID,
      cardId: DEBIT,
      amount: SPEND,
      category: '购物',
      merchant: '绑定余额一致性消费',
    });
    expect(consumed.consumption).toMatchObject({ cardId: DEBIT, accountId: CHECKING, amount: SPEND });
    expect(consumed.accountAvailableBalance).toBe(subtractMoney(SEEDED_CHECKING, SPEND));

    const after = await expectCardBalanceMatchesAccount(await viewOf(DEMO_USER_ID, DEBIT));
    // The projection returned by the WRITE and the projection returned by the READ are one number.
    expect(after).toBe(consumed.accountAvailableBalance);
    expect(consumed.card.accountAvailableBalance).toBe(after);
    expect(after).toBe('23480.00');
    expect(subtractMoney(before, after)).toBe(SPEND);

    const ledger = await db().transaction.findMany({ where: { accountId: CHECKING, merchant: '绑定余额一致性消费' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ channel: 'CARD', direction: 'DEBIT', currency: 'CNY' });
    expect(ledger[0].amountMinor).toBe(-moneyToCents(SPEND));
    expect(await db().cardConsumption.count({ where: { cardId: DEBIT } })).toBe(1);
  });

  it('(3) after an investment purchase: the card view equals the account balance it funded', async () => {
    const before = await expectCardBalanceMatchesAccount(await viewOf(DEMO_USER_ID, DEBIT));

    // `prod_huobi` (货币基金) has a ¥100.00 minimum, i.e. exactly SPEND.
    const purchased = await banking.investment.subscribeInvestment({
      userId: DEMO_USER_ID,
      productId: 'prod_huobi',
      amount: SPEND,
    });
    expect(purchased.success).toBe(true);
    expect(purchased.sourceAccountId).toBe(CHECKING);
    expect(purchased.newBalance).toBe(subtractMoney(SEEDED_CHECKING, SPEND));

    const after = await expectCardBalanceMatchesAccount(await viewOf(DEMO_USER_ID, DEBIT));
    expect(after).toBe(purchased.newBalance);
    expect(after).toBe('23480.00');
    expect(subtractMoney(before, after)).toBe(SPEND);

    // The investment flow debited the settlement account ONCE, on the APP channel.
    const ledger = await db().transaction.findMany({ where: { accountId: CHECKING, merchant: '认购货币基金' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ direction: 'DEBIT', category: '投资', currency: 'CNY' });
    expect(ledger[0].amountMinor).toBe(-moneyToCents(SPEND));
  });
});
