/**
 * banking-sdk · the settlement-account block of a card projection (展示绑定账户余额).
 *
 * Pure SDK-level acceptance for the read path that renders a card's settlement account in the UI:
 *   - `CardView.linkedAccountStatus` is TOTAL and honest — `LINKED` (a recorded account that resolves
 *     to one of the owner's CHECKING accounts), `MISSING` (nothing recorded), `UNTRUSTED` (an account
 *     is recorded but no longer resolves to an owned CHECKING account) and `NOT_APPLICABLE` (CREDIT);
 *   - a `LINKED` card exposes the account's masked number, its display NAME, the ACCOUNT's balance
 *     (`accountAvailableBalance`) and `payableAmount` = `min(account balance, remaining family monthly
 *     limit)`; the full account number is never surfaced and a `null` monthly limit means the whole
 *     balance is payable;
 *   - `MISSING` / `UNTRUSTED` cards expose NO balance field at all — never another owner's cash and
 *     never a fabricated `0.00`;
 *   - `usable` is derived from the CARD STATUS alone: a `FROZEN` / `LOST` card is unusable but still
 *     reports its real (non-zero) balance — unusable is not the same as empty;
 *   - a CREDIT card draws on its credit line: `NOT_APPLICABLE`, no settlement account is looked up, and
 *     its `creditLimit` / `availableLimit` stay intact;
 *   - `addDemoCard` binds DEBIT/VIRTUAL cards at creation: the user's ONLY CHECKING account when the
 *     id is omitted, an explicit id when supplied (ownership + CHECKING type are re-validated), and a
 *     `VALIDATION` error — with no card row written — when the implicit choice is ambiguous.
 *
 * The FK SHAPE MATTERS HERE: `Card.linkedAccountId` is a REAL foreign key onto `Account` with Prisma's
 * default `SetNull`, so (a) a card can never record an id that does not exist and (b) deleting the
 * account NULLS the reference — a deleted account therefore surfaces as `MISSING`, while `UNTRUSTED`
 * is reached with an account that still EXISTS but is foreign or non-CHECKING.
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats.
 *
 * Fixtures: demo user 李明 (`acct_checking` CHECKING ¥23,580, mask `****8821`, name 活期账户 ·
 * `acct_savings` SAVINGS ¥50,000), `card_credit` (CREDIT, ¥18,000 credit limit) and `card_debit`
 * (DEBIT, bound to `acct_checking`, no monthly limit).
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { ApplyVirtualCardInput, CardView } from '@/banking-sdk/types';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

useFreshDatabase();

const db = () => getTestPrisma();

/** The user's only seeded CHECKING account (¥23,580) — the settlement account of `card_debit`. */
const CHECKING = 'acct_checking';
/** A SAVINGS account of the SAME owner — existing, but never a valid settlement account. */
const SAVINGS = 'acct_savings';
/** Seeded CREDIT card: draws on its credit line, never on a settlement account. */
const CREDIT = 'card_credit';
/** Seeded DEBIT card, bound to `acct_checking` by the fixture. */
const DEBIT = 'card_debit';
/** A user that owns none of the demo data. */
const FOREIGN_USER = 'user_intruder';
/** The FOREIGN user's own CHECKING account — exists and is CHECKING, but is not 李明's. */
const FOREIGN_CHECKING = 'acct_foreign';
/** A second CHECKING account for 李明, created on demand (makes the implicit binding ambiguous). */
const SECOND_CHECKING = 'acct_checking2';

/** A full (unmasked) account number shape — the projection must never expose one. */
const FULL_ACCOUNT_NUMBER = '6222021234568821';
/** Digits-only values of length ≥ 6 look like a real (unmasked) account/card number. */
const UNMASKED_NUMBER_SHAPE = /^\d{6,}$/;

/** Await `fn`, returning whatever it rejected with; fail loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/** Assert the rejection is an `AppError` carrying the expected domain code. */
function expectCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
}

/** Issue a VIRTUAL card for the demo user (optionally overriding the binding / monthly limit). */
function issueVirtual(input: Omit<Partial<ApplyVirtualCardInput>, 'userId'> = {}): Promise<CardView> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, ...input });
}

/** The exact balance of an account as canonical CNY text. */
async function balanceOf(accountId = CHECKING): Promise<string> {
  const row = await db().account.findUniqueOrThrow({ where: { id: accountId } });
  return centsToMoney(row.balanceMinor);
}

/** The enriched `CardView` for one of the user's cards (the exact projection `getCards` returns). */
async function viewOf(cardId: string): Promise<CardView> {
  const view = (await banking.card.getCards(DEMO_USER_ID)).find((candidate) => candidate.id === cardId);
  if (!view) throw new Error(`card ${cardId} not found`);
  return view;
}

/**
 * Insert a card row DIRECTLY (bypassing the SDK) so a binding state the SDK itself can no longer mint
 * can be projected: `null` (no settlement account at all), a FOREIGN account or a SAVINGS account.
 * A nonexistent account id is NOT expressible here — `linkedAccountId` is a real FK.
 */
async function insertCard(data: {
  id: string;
  type: 'VIRTUAL' | 'DEBIT';
  numberMasked: string;
  linkedAccountId: string | null;
  status?: 'ACTIVE' | 'FROZEN';
  monthlyLimit?: string;
}): Promise<void> {
  await db().card.create({ data: {
    id: data.id,
    userId: DEMO_USER_ID,
    type: data.type,
    network: 'UnionPay',
    numberMasked: data.numberMasked,
    status: data.status ?? 'ACTIVE',
    creditLimitMinor: null,
    availableLimitMinor: null,
    monthlyLimitMinor: data.monthlyLimit === undefined ? null : moneyToCents(data.monthlyLimit),
    replacedByCardId: null,
    linkedAccountId: data.linkedAccountId,
  } });
}

/** Create a second user owning a CHECKING account with its own cash (never 李明's settlement account). */
async function addForeignUser(): Promise<string> {
  await db().user.create({ data: { id: FOREIGN_USER, name: '外部用户', phone: '137****9999' } });
  await db().account.create({ data: {
    id: FOREIGN_CHECKING,
    userId: FOREIGN_USER,
    type: 'CHECKING',
    name: '外部活期',
    number: '****0003',
    balanceMinor: moneyToCents('5000.00'),
  } });
  return FOREIGN_CHECKING;
}

/** Assert EVERY settlement-account field is absent (undefined) — never `0.00`, never another owner's cash. */
function expectNoSettlementFields(view: CardView): void {
  expect(view.linkedAccountId).toBeUndefined();
  expect(view.linkedAccountNumber).toBeUndefined();
  expect(view.linkedAccountName).toBeUndefined();
  expect(view.accountAvailableBalance).toBeUndefined();
  expect(view.payableAmount).toBeUndefined();
  // The projection omits the fields entirely: an "empty" balance must never be serialized as 0.00.
  expect(view.accountAvailableBalance).not.toBe('0.00');
  expect(view.payableAmount).not.toBe('0.00');
}

describe('banking-sdk · a LINKED settlement account is projected with its real balance', () => {
  it('projects the seeded DEBIT card with its account name, masked number and exact balance', async () => {
    const account = await db().account.findUniqueOrThrow({ where: { id: CHECKING } });
    const accountBalance = centsToMoney(account.balanceMinor);

    const debit = await viewOf(DEBIT);

    // The binding resolved to the card's OWN CHECKING account.
    expect(debit.type).toBe('DEBIT');
    expect(debit.status).toBe('ACTIVE');
    expect(debit.linkedAccountStatus).toBe('LINKED');
    expect(debit.linkedAccountId).toBe(CHECKING);
    expect(debit.usable).toBe(true);

    // A human-readable account name, never empty and never an id standing in for a label.
    expect(debit.linkedAccountName).toBe('活期账户');
    expect(debit.linkedAccountName).toBe(account.name);
    expect(debit.linkedAccountName!.trim()).not.toBe('');
    expect(debit.linkedAccountName).toMatch(/[\u4e00-\u9fa5]/);
    expect(debit.linkedAccountName).not.toBe(CHECKING);

    // The MASKED account number is echoed — the full number is never exposed.
    expect(debit.linkedAccountNumber).toBe('****8821');
    expect(debit.linkedAccountNumber).toBe(account.number);
    expect(debit.linkedAccountNumber).toContain('****');
    expect(debit.linkedAccountNumber).not.toBe(FULL_ACCOUNT_NUMBER);
    expect(debit.linkedAccountNumber).not.toMatch(UNMASKED_NUMBER_SHAPE);

    // `accountAvailableBalance` is the ACCOUNT's cash, and the fixture's ¥23,580 is asserted once here.
    expect(debit.accountAvailableBalance).toBe(accountBalance);
    expect(accountBalance).toBe('23580.00');

    // `card_debit` carries NO monthly limit → the whole account balance is payable.
    expect(debit.monthlyLimit).toBeUndefined();
    expect(debit.payableAmount).toBe(debit.accountAvailableBalance);
    expect(debit.payableAmount).toBe('23580.00');
  });

  it('caps payableAmount by the remaining monthly limit while accountAvailableBalance stays whole', async () => {
    const accountBalance = await balanceOf();
    const card = await issueVirtual({ monthlyLimit: '500.00' });

    // min(¥23,580 account balance, ¥500 remaining limit) — the lower one wins.
    expect(card.linkedAccountStatus).toBe('LINKED');
    expect(card.accountAvailableBalance).toBe(accountBalance);
    expect(card.payableAmount).toBe('500.00');

    // Spend part of the allowance: BOTH the account balance and the remaining limit drop.
    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '120.00' });
    expect(result.accountAvailableBalance).toBe('23460.00');
    expect(await balanceOf()).toBe('23460.00'); // the account and the projection agree
    expect(result.card.payableAmount).toBe('380.00'); // min(23,460, 500 − 120)

    const afterSpend = await viewOf(card.id);
    expect(afterSpend.accountAvailableBalance).toBe(await balanceOf());
    expect(afterSpend.accountAvailableBalance).toBe('23460.00');
    expect(afterSpend.payableAmount).toBe('380.00');

    // When the account runs below the remaining limit, the BALANCE becomes the binding constraint.
    await db().account.update({ where: { id: CHECKING }, data: { balanceMinor: moneyToCents('90.00') } });
    const lowered = await viewOf(card.id);
    expect(lowered.accountAvailableBalance).toBe('90.00');
    expect(lowered.payableAmount).toBe('90.00'); // min(90, 380)
  });

  it('spends from the seeded DEBIT card exactly like a bound VIRTUAL card', async () => {
    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: DEBIT, amount: '80.00', merchant: '借记卡消费' });

    expect(result.consumption.accountId).toBe(CHECKING);
    expect(result.consumption.amount).toBe('80.00');
    expect(result.accountAvailableBalance).toBe('23500.00');
    expect(await balanceOf()).toBe('23500.00');

    // No monthly limit → payable follows the balance.
    expect(result.card.linkedAccountStatus).toBe('LINKED');
    expect(result.card.payableAmount).toBe('23500.00');
    expect(await db().cardConsumption.count({ where: { cardId: DEBIT } })).toBe(1);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '借记卡消费' } })).toBe(1);
  });
});

describe('banking-sdk · a MISSING settlement binding exposes no balance', () => {
  it('projects an unbound card as MISSING with no number, name, balance or payable amount', async () => {
    await insertCard({ id: 'card_unbound', type: 'VIRTUAL', linkedAccountId: null, numberMasked: '****7001' });

    const view = await viewOf('card_unbound');

    expect(view.linkedAccountStatus).toBe('MISSING');
    expectNoSettlementFields(view);
    // Nothing was guessed from the user's single CHECKING account either.
    expect(view.linkedAccountId).not.toBe(CHECKING);
  });

  it('keeps usable tied to the card STATUS, not to the binding', async () => {
    await insertCard({ id: 'card_unbound_active', type: 'VIRTUAL', linkedAccountId: null, numberMasked: '****7002' });
    await insertCard({ id: 'card_unbound_frozen', type: 'VIRTUAL', linkedAccountId: null, status: 'FROZEN', numberMasked: '****7003' });

    const active = await viewOf('card_unbound_active');
    expect(active.status).toBe('ACTIVE');
    expect(active.linkedAccountStatus).toBe('MISSING');
    expect(active.usable).toBe(true);
    expectNoSettlementFields(active);

    const frozen = await viewOf('card_unbound_frozen');
    expect(frozen.status).toBe('FROZEN');
    expect(frozen.linkedAccountStatus).toBe('MISSING');
    expect(frozen.usable).toBe(false);
    expectNoSettlementFields(frozen);
  });
});

describe('banking-sdk · an UNTRUSTED settlement binding exposes no balance', () => {
  it("never leaks another user's CHECKING account through a recorded binding", async () => {
    const foreign = await addForeignUser();
    await insertCard({ id: 'card_foreign', type: 'VIRTUAL', linkedAccountId: foreign, numberMasked: '****7101' });

    const view = await viewOf('card_foreign');

    expect(view.linkedAccountStatus).toBe('UNTRUSTED');
    // The stored reference is echoed as an id (it is what the row records)...
    expect(view.linkedAccountId).toBe(foreign);
    // ...but NO cash, mask or name of the foreign account crosses the boundary.
    expect(view.linkedAccountNumber).toBeUndefined();
    expect(view.linkedAccountName).toBeUndefined();
    expect(view.accountAvailableBalance).toBeUndefined();
    expect(view.payableAmount).toBeUndefined();
    expect(view.accountAvailableBalance).not.toBe('5000.00'); // the foreign balance
    expect(view.linkedAccountNumber).not.toBe('****0003'); // the foreign mask
    expect(view.linkedAccountName).not.toBe('外部活期');
    // An ACTIVE card is usable by status; the untrusted binding is a separate, honest axis.
    expect(view.usable).toBe(true);
  });

  it("reports the owner's own SAVINGS account as UNTRUSTED", async () => {
    await insertCard({ id: 'card_savings', type: 'DEBIT', linkedAccountId: SAVINGS, numberMasked: '****7201' });

    const view = await viewOf('card_savings');

    expect(view.linkedAccountStatus).toBe('UNTRUSTED');
    expect(view.linkedAccountId).toBe(SAVINGS);
    expect(view.linkedAccountNumber).toBeUndefined();
    expect(view.linkedAccountName).toBeUndefined();
    expect(view.accountAvailableBalance).toBeUndefined();
    expect(view.payableAmount).toBeUndefined();
    expect(view.accountAvailableBalance).not.toBe('50000.00'); // the SAVINGS balance
  });

  it('turns a DELETED settlement account into MISSING (the FK is SetNull) instead of a zero balance', async () => {
    // `linkedAccountId` is a REAL FK with SetNull: a recorded-but-deleted account cannot linger as an
    // UNTRUSTED id — deleting the account NULLS the reference, so the card reads as MISSING.
    await db().account.create({ data: {
      id: SECOND_CHECKING,
      userId: DEMO_USER_ID,
      type: 'CHECKING',
      name: '活期账户二',
      number: '****0002',
      balanceMinor: moneyToCents('1000.00'),
    } });
    await insertCard({ id: 'card_doomed', type: 'VIRTUAL', linkedAccountId: SECOND_CHECKING, numberMasked: '****7301', monthlyLimit: '100.00' });

    const beforeDelete = await viewOf('card_doomed');
    expect(beforeDelete.linkedAccountStatus).toBe('LINKED');
    expect(beforeDelete.linkedAccountNumber).toBe('****0002');
    expect(beforeDelete.accountAvailableBalance).toBe('1000.00');
    expect(beforeDelete.payableAmount).toBe('100.00');

    await db().account.delete({ where: { id: SECOND_CHECKING } });

    // The FK nulled the stored reference: the binding is GONE, not "untrusted-but-recorded".
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_doomed' } })).linkedAccountId).toBeNull();

    const afterDelete = await viewOf('card_doomed');
    expect(afterDelete.linkedAccountStatus).toBe('MISSING');
    expectNoSettlementFields(afterDelete);
    // The pre-delete balance is never echoed as a stale copy.
    expect(afterDelete.accountAvailableBalance).not.toBe('1000.00');
    expect(afterDelete.linkedAccountNumber).not.toBe('****0002');
  });
});

describe('banking-sdk · an unusable card still reports its real balance', () => {
  it('keeps the bound balance on a FROZEN card', async () => {
    const accountBalance = await balanceOf();
    const card = await issueVirtual({ monthlyLimit: '500.00' });
    expect(card.usable).toBe(true);

    const frozen = await banking.card.freezeCard(card.id, DEMO_USER_ID);

    expect(frozen.status).toBe('FROZEN');
    expect(frozen.usable).toBe(false);
    expect(frozen.linkedAccountStatus).toBe('LINKED');
    // Unusable is NOT empty: the balance block is intact and non-zero.
    expect(frozen.accountAvailableBalance).toBe(accountBalance);
    expect(frozen.accountAvailableBalance).toBe('23580.00');
    expect(frozen.accountAvailableBalance).not.toBe('0.00');
    expect(frozen.payableAmount).toBe('500.00');
    expect(frozen.linkedAccountNumber).toBe('****8821');
    expect(frozen.linkedAccountName).toBe('活期账户');

    // A fresh projection read (what the UI renders after a refresh) agrees.
    const reloaded = await viewOf(card.id);
    expect(reloaded.usable).toBe(false);
    expect(reloaded.accountAvailableBalance).toBe('23580.00');
  });

  it('keeps the bound balance on a LOST card', async () => {
    const accountBalance = await balanceOf();
    const card = await issueVirtual();
    expect(card.payableAmount).toBe('23580.00');

    const lost = await banking.card.reportLostCard(card.id, DEMO_USER_ID, { reason: '遗失' });

    expect(lost.status).toBe('LOST');
    expect(lost.usable).toBe(false);
    expect(lost.linkedAccountStatus).toBe('LINKED');
    expect(lost.accountAvailableBalance).toBe(accountBalance);
    expect(lost.accountAvailableBalance).toBe('23580.00');
    expect(lost.accountAvailableBalance).not.toBe('0.00');
    expect(lost.payableAmount).toBe('23580.00'); // no monthly limit → the whole balance
    expect(lost.payableAmount).not.toBe('0.00');
    expect(lost.linkedAccountNumber).toBe('****8821');

    const reloaded = await viewOf(card.id);
    expect(reloaded.usable).toBe(false);
    expect(reloaded.accountAvailableBalance).toBe('23580.00');
    expect(reloaded.payableAmount).toBe('23580.00');
  });
});

describe('banking-sdk · a CREDIT card has no settlement account', () => {
  it('projects the seeded CREDIT card as NOT_APPLICABLE and keeps its credit limits', async () => {
    const view = await viewOf(CREDIT);

    expect(view.type).toBe('CREDIT');
    expect(view.status).toBe('ACTIVE');
    expect(view.linkedAccountStatus).toBe('NOT_APPLICABLE');
    expect(view.usable).toBe(true);
    expectNoSettlementFields(view);

    // The credit line is untouched by the settlement projection.
    expect(view.creditLimit).toBe('18000.00');
    expect(view.availableLimit).toBe('18000.00');
    expect(view.monthlyLimit).toBe('18000.00');
  });
});

describe('banking-sdk · binding a settlement account at card creation', () => {
  it("auto-binds the user's only CHECKING account and refuses to guess once there are two", async () => {
    const debit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });

    expect(debit.linkedAccountStatus).toBe('LINKED');
    expect(debit.linkedAccountId).toBe(CHECKING);
    expect(debit.accountAvailableBalance).toBe('23580.00');
    expect(debit.payableAmount).toBe('23580.00');
    // The binding is PERSISTED, not a projection-only detail.
    expect((await db().card.findUniqueOrThrow({ where: { id: debit.id } })).linkedAccountId).toBe(CHECKING);

    // A SECOND CHECKING account makes the implicit choice ambiguous → VALIDATION and no card row.
    await db().account.create({ data: {
      id: SECOND_CHECKING,
      userId: DEMO_USER_ID,
      type: 'CHECKING',
      name: '活期账户二',
      number: '****0002',
      balanceMinor: moneyToCents('1000.00'),
    } });
    const before = await db().card.count({ where: { userId: DEMO_USER_ID } });

    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' })), 'VALIDATION');
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(before);

    // The fence is shared with `applyVirtualCard`: no implicit pick for a VIRTUAL card either.
    expectCode(await capture(() => issueVirtual()), 'VALIDATION');
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(before);

    // An EXPLICIT account resolves the ambiguity again — and it is the one that was named.
    const explicit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT', linkedAccountId: CHECKING });
    expect(explicit.linkedAccountId).toBe(CHECKING);
    expect(explicit.linkedAccountStatus).toBe('LINKED');
    expect(explicit.accountAvailableBalance).toBe('23580.00');
    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(before + 1);
  });

  it('rejects a SAVINGS / foreign / nonexistent explicit account and mints no card', async () => {
    const foreign = await addForeignUser();
    const before = await db().card.count({ where: { userId: DEMO_USER_ID } });

    // Existing but the wrong type.
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT', linkedAccountId: SAVINGS })), 'VALIDATION');
    // Existing CHECKING, but somebody else's cash.
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', linkedAccountId: foreign })), 'SECURITY_DENIED');
    // Not existing at all.
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT', linkedAccountId: 'acct_nowhere' })), 'SECURITY_DENIED');

    expect(await db().card.count({ where: { userId: DEMO_USER_ID } })).toBe(before);
  });
});
