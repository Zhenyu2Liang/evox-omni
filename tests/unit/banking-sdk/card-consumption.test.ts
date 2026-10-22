/**
 * banking-sdk · account-bound virtual cards + card consumption.
 *
 * Pure SDK-level acceptance for the account-bound virtual-card feature:
 *   - `applyVirtualCard`/`addDemoCard` BIND a settlement CHECKING account (`Card.linkedAccountId`):
 *     an explicit id must be one of the caller's CHECKING accounts (a missing/foreign id is
 *     `SECURITY_DENIED`, a non-CHECKING one `VALIDATION`); an omitted id falls back to the caller's
 *     default CHECKING account and fails with `VALIDATION` when there is none;
 *   - the enriched `CardView` exposes `linkedAccountId`/`linkedAccountNumber`/`accountAvailableBalance`
 *     and a derived `payableAmount` = min(balance, remaining monthly limit) for a BOUND card, and
 *     NOTHING for an unbound one (no fabricated values);
 *   - `consumeCard` debits the bound account with an atomic sufficient-funds write and writes a
 *     `channel='CARD'` ledger row plus a positive `CardConsumption` row in ONE transaction, guarded by
 *     the card's monthly limit and its `ACTIVE` + bound state;
 *   - the booking instant is SERVER-owned: it comes from the project business clock (`demoNow()`,
 *     UTC+08:00 semantics) and the billing month the limit is counted against is derived from that
 *     SAME instant. `ConsumeCardInput` therefore carries no `occurredAt`, and a runtime object that
 *     still supplies a DEFINED one is rejected with `VALIDATION` before any read/write; the only seam
 *     is the test-only `ConsumeCardOptions` second argument (`{ now }`);
 *   - an `executionKey` replays the PERSISTED original result (never a second charge) and is rejected
 *     when it is reused for another card/user or when the snapshot is missing;
 *   - `listCardConsumptions` is owner-scoped, newest-first, card-filterable and limit-capped;
 *   - the debit + ledger + consumption unit is ATOMIC (the real transaction rolls back).
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats.
 *
 * Fixtures: demo user 李明 (`acct_checking` CHECKING ¥23,580 · `acct_savings` SAVINGS ¥50,000),
 * `card_credit` (CREDIT, ¥18,000 monthly limit, never account-bound) and `card_debit` (DEBIT, bound to
 * `acct_checking`, no monthly limit). These specs still issue VIRTUAL cards through the SDK itself
 * where a fresh settlement binding is needed; an UNBOUND card is inserted directly, because the SDK
 * no longer mints one (both DEBIT and VIRTUAL cards are bound at creation).
 *
 * NOTE: `useFreshDatabase()` resets through the shared `truncateAll()`, which clears EVERY model of
 * the schema — including the relation-free `CardConsumption` ledger — so every test starts from
 * a genuinely empty spend history without an extra hook.
 */
import { describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { ApplyVirtualCardInput, CardView, ConsumeCardInput, ConsumeCardResult } from '@/banking-sdk/types';
import { demoMonthRange, demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { withInjectedWriteFailure } from '../../helpers/write-failure';

useFreshDatabase();

const db = () => getTestPrisma();

/** The user's default CHECKING account (¥23,580) — the fallback settlement account. */
const CHECKING = 'acct_checking';
/** A SAVINGS account — never a valid virtual-card settlement account. */
const SAVINGS = 'acct_savings';
const CREDIT = 'card_credit';
/** The seeded DEBIT card — bound to `acct_checking` by the fixture (an UNBOUND card only exists when inserted directly). */
const DEBIT = 'card_debit';
/** A user that owns none of the demo data — proves the ownership fence. */
const FOREIGN_USER = 'user_intruder';
/** A user whose only account is a SAVINGS account — proves the "no CHECKING account" rejection. */
const NO_CHECKING_USER = 'user_nochecking';

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

/**
 * A request that still claims its own booking instant. `ConsumeCardInput` deliberately has no
 * `occurredAt` (the instant is SERVER-owned), so a cast is the only way to express the stale shape an
 * older caller / resumed plan node / HTTP body can still carry at RUNTIME — which is rejected.
 */
function claimingInstant(input: { userId: string; cardId: string; amount: string; occurredAt: unknown }): ConsumeCardInput {
  return input as ConsumeCardInput;
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

/** Every one of the user's card views, keyed by id. */
async function cardMap(): Promise<Map<string, CardView>> {
  return new Map((await banking.card.getCards(DEMO_USER_ID)).map((view) => [view.id, view]));
}

/** Create a second CHECKING account for the demo user (a distinct valid settlement target). */
async function addSecondChecking(): Promise<string> {
  await db().account.create({ data: { id: 'acct_checking2', userId: DEMO_USER_ID, type: 'CHECKING', name: '活期账户二', number: '****0002', balanceMinor: moneyToCents('1000.00') } });
  return 'acct_checking2';
}

/** Create a foreign user owning a CHECKING account (never a valid settlement target for 李明). */
async function addForeignUser(): Promise<string> {
  await db().user.create({ data: { id: FOREIGN_USER, name: '外部用户', phone: '137****9999' } });
  await db().account.create({ data: { id: 'acct_foreign', userId: FOREIGN_USER, type: 'CHECKING', name: '外部活期', number: '****0003', balanceMinor: moneyToCents('5000.00') } });
  return 'acct_foreign';
}

/**
 * Insert a card row DIRECTLY (bypassing the SDK) to reproduce the one state the SDK no longer mints:
 * an `ACTIVE` DEBIT/VIRTUAL card with NO settlement account. `Card.linkedAccountId` is a REAL foreign
 * key, so `null` is the only way to express "unbound" — a nonexistent account id is rejected by SQLite.
 */
async function insertUnboundCard(data: {
  id: string;
  type: 'VIRTUAL' | 'DEBIT';
  numberMasked: string;
  monthlyLimitMinor?: bigint | null;
}): Promise<void> {
  await db().card.create({ data: {
    id: data.id,
    userId: DEMO_USER_ID,
    type: data.type,
    network: 'UnionPay',
    numberMasked: data.numberMasked,
    status: 'ACTIVE',
    creditLimitMinor: null,
    availableLimitMinor: null,
    monthlyLimitMinor: data.monthlyLimitMinor ?? null,
    replacedByCardId: null,
    linkedAccountId: null,
  } });
}

/** Create a user whose only account is a SAVINGS account. */
async function addUserWithoutChecking(): Promise<void> {
  await db().user.create({ data: { id: NO_CHECKING_USER, name: '无活期用户', phone: '136****9998' } });
  await db().account.create({ data: { id: 'acct_only_savings', userId: NO_CHECKING_USER, type: 'SAVINGS', name: '只有储蓄', number: '****0004', balanceMinor: moneyToCents('100.00') } });
}

describe('banking-sdk · virtual card settlement-account binding', () => {
  it('binds the default CHECKING account when none is requested and exposes its exact balance', async () => {
    const card = await issueVirtual();

    expect(card.type).toBe('VIRTUAL');
    expect(card.status).toBe('ACTIVE');
    expect(card.linkedAccountId).toBe(CHECKING);
    expect(card.linkedAccountNumber).toBe('****8821');
    expect(card.accountAvailableBalance).toBe('23580.00');
    // No monthly limit configured → the payable amount is the whole account balance.
    expect(card.monthlyLimit).toBeUndefined();
    expect(card.payableAmount).toBe('23580.00');

    // The binding is persisted in `Card.linkedAccountId` (a real FK column), not just projected.
    expect((await db().card.findUniqueOrThrow({ where: { id: card.id } })).linkedAccountId).toBe(CHECKING);
  });

  it('binds an explicitly requested CHECKING account', async () => {
    const second = await addSecondChecking();
    const card = await issueVirtual({ linkedAccountId: second });

    expect(card.linkedAccountId).toBe(second);
    expect(card.linkedAccountNumber).toBe('****0002');
    expect(card.accountAvailableBalance).toBe('1000.00');
    expect(card.payableAmount).toBe('1000.00');
  });

  it('rejects a non-CHECKING account with VALIDATION and mints no card', async () => {
    const before = await db().card.count();
    expectCode(await capture(() => issueVirtual({ linkedAccountId: SAVINGS })), 'VALIDATION');
    expect(await db().card.count()).toBe(before);
  });

  it('rejects an account that belongs to another user with SECURITY_DENIED', async () => {
    const foreign = await addForeignUser();
    const before = await db().card.count();

    expectCode(await capture(() => issueVirtual({ linkedAccountId: foreign })), 'SECURITY_DENIED');
    expect(await db().card.count()).toBe(before);
  });

  it('rejects an unknown account id with SECURITY_DENIED', async () => {
    expectCode(await capture(() => issueVirtual({ linkedAccountId: 'acct_missing' })), 'SECURITY_DENIED');
  });

  it('rejects issuance when the user has no CHECKING account at all', async () => {
    await addUserWithoutChecking();
    expectCode(
      await capture(() => banking.card.applyVirtualCard({ userId: NO_CHECKING_USER })),
      'VALIDATION',
    );
  });

  it('binds VIRTUAL and DEBIT cards (and never CREDIT) through addDemoCard', async () => {
    const virtual = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', monthlyLimit: '2000.00' });
    expect(virtual.linkedAccountId).toBe(CHECKING);
    expect(virtual.linkedAccountStatus).toBe('LINKED');
    expect(virtual.payableAmount).toBe('2000.00'); // limit ¥2,000 < balance ¥23,580

    // A DEBIT card is ACCOUNT-BOUND too: it draws on the same CHECKING cash as a VIRTUAL card.
    const debit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });
    expect(debit.linkedAccountId).toBe(CHECKING);
    expect(debit.linkedAccountStatus).toBe('LINKED');
    expect(debit.linkedAccountNumber).toBe('****8821');
    expect(debit.accountAvailableBalance).toBe('23580.00');
    expect(debit.payableAmount).toBe('23580.00'); // no monthly limit → the whole balance
    expect((await db().card.findUniqueOrThrow({ where: { id: debit.id } })).linkedAccountId).toBe(CHECKING);

    // Both bound cards point at the SAME settlement account: one balance, shared.
    expect(virtual.linkedAccountId).toBe(debit.linkedAccountId);
    expect(virtual.accountAvailableBalance).toBe(debit.accountAvailableBalance);

    // A CREDIT card draws on its credit line and is NEVER bound.
    const credit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'CREDIT', creditLimit: '1000.00' });
    expect(credit.linkedAccountStatus).toBe('NOT_APPLICABLE');
    expect(credit.linkedAccountId).toBeUndefined();
    expect(credit.accountAvailableBalance).toBeUndefined();
    expect(credit.payableAmount).toBeUndefined();
    expect((await db().card.findUniqueOrThrow({ where: { id: credit.id } })).linkedAccountId).toBeNull();

    // addDemoCard honours the same ownership / type fences as applyVirtualCard.
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', linkedAccountId: SAVINGS })), 'VALIDATION');
    const foreign = await addForeignUser();
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', linkedAccountId: foreign })), 'SECURITY_DENIED');
  });

  it('reports a MISSING binding once the bound account is deleted (never fabricated values)', async () => {
    await addSecondChecking();
    const card = await issueVirtual({ linkedAccountId: 'acct_checking2', monthlyLimit: '100.00' });
    await db().account.delete({ where: { id: 'acct_checking2' } });

    // `Card.linkedAccountId` is a REAL FK with Prisma's default SetNull, so deleting the account
    // CLEARS the recorded reference — the binding becomes MISSING, not "untrusted but recorded".
    expect((await db().card.findUniqueOrThrow({ where: { id: card.id } })).linkedAccountId).toBeNull();

    const reloaded = (await banking.card.getCards(DEMO_USER_ID)).find((view) => view.id === card.id)!;
    expect(reloaded.linkedAccountStatus).toBe('MISSING');
    expect(reloaded.linkedAccountId).toBeUndefined();
    expect(reloaded.linkedAccountNumber).toBeUndefined();
    expect(reloaded.linkedAccountName).toBeUndefined();
    expect(reloaded.accountAvailableBalance).toBeUndefined();
    expect(reloaded.payableAmount).toBeUndefined();
    // An absent balance is OMITTED, never serialized as a zero amount.
    expect(reloaded.accountAvailableBalance).not.toBe('0.00');
    expect(reloaded.payableAmount).not.toBe('0.00');
  });

  it('projects the seeded DEBIT card as LINKED and only a truly unbound card as account-free', async () => {
    // The seed binds `card_debit` to the paying CHECKING account, so it renders the full balance block.
    const debit = (await cardMap()).get(DEBIT)!;
    expect(debit.type).toBe('DEBIT');
    expect(debit.linkedAccountStatus).toBe('LINKED');
    expect(debit.linkedAccountId).toBe(CHECKING);
    expect(debit.linkedAccountNumber).toBe('****8821');
    expect(debit.linkedAccountName).toBe('活期账户');
    expect(debit.accountAvailableBalance).toBe('23580.00');
    expect(debit.payableAmount).toBe('23580.00');

    // A CREDIT card never looks a settlement account up.
    const credit = (await cardMap()).get(CREDIT)!;
    expect(credit.linkedAccountStatus).toBe('NOT_APPLICABLE');

    // A genuinely unbound card has to be inserted directly: the SDK binds every new DEBIT/VIRTUAL card.
    await insertUnboundCard({ id: 'card_unbound_view', type: 'VIRTUAL', numberMasked: '****7701' });

    for (const view of [credit, (await cardMap()).get('card_unbound_view')!]) {
      expect(view.linkedAccountStatus).not.toBe('LINKED');
      expect(view.linkedAccountId).toBeUndefined();
      expect(view.linkedAccountNumber).toBeUndefined();
      expect(view.linkedAccountName).toBeUndefined();
      expect(view.accountAvailableBalance).toBeUndefined();
      expect(view.payableAmount).toBeUndefined();
    }
  });
});

describe('banking-sdk · idempotent virtual-card issuance with account binding', () => {
  it('replays the SAME card for a repeated key (no second card, same binding)', async () => {
    const before = await db().card.count();
    const first = await issueVirtual({ idempotencyKey: 'issue-1', monthlyLimit: '3000.00', linkedAccountId: CHECKING });
    const second = await issueVirtual({ idempotencyKey: 'issue-1', monthlyLimit: '3000.00', linkedAccountId: CHECKING });

    expect(second.id).toBe(first.id);
    expect(second.linkedAccountId).toBe(CHECKING);
    expect(await db().card.count()).toBe(before + 1);
  });

  it('rejects a different monthly limit under the same key with CONFLICT', async () => {
    await issueVirtual({ idempotencyKey: 'issue-2', monthlyLimit: '3000.00' });
    expectCode(await capture(() => issueVirtual({ idempotencyKey: 'issue-2', monthlyLimit: '4000.00' })), 'CONFLICT');
  });

  it('rejects a different settlement account under the same key with CONFLICT', async () => {
    const second = await addSecondChecking();
    const first = await issueVirtual({ idempotencyKey: 'issue-3', linkedAccountId: CHECKING });
    expect(first.linkedAccountId).toBe(CHECKING);

    expectCode(await capture(() => issueVirtual({ idempotencyKey: 'issue-3', linkedAccountId: second })), 'CONFLICT');
  });
});

describe('banking-sdk · consumeCard happy path', () => {
  it('debits the bound account, writes a channel=CARD ledger row and a positive consumption row', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const occurredAt = demoNow();

    // The booking instant is SERVER-owned: it is injected through the test-only `options.now` second
    // argument, never through the public input set (a runtime `occurredAt` input is now `VALIDATION`).
    const result: ConsumeCardResult = await banking.card.consumeCard(
      {
        userId: DEMO_USER_ID,
        cardId: card.id,
        amount: '100.50',
        category: '餐饮',
        merchant: '测试商户',
      },
      { now: occurredAt },
    );

    // The returned view is exact canonical CNY text.
    expect(result.consumption.amount).toBe('100.50');
    expect(result.consumption.currency).toBe('CNY');
    expect(result.consumption.category).toBe('餐饮');
    expect(result.consumption.merchant).toBe('测试商户');
    expect(result.consumption.cardId).toBe(card.id);
    expect(result.consumption.accountId).toBe(CHECKING);
    expect(result.consumption.occurredAt).toBe(occurredAt);
    expect(result.consumption.executionKey).toBeUndefined();
    expect(result.accountAvailableBalance).toBe('23479.50');

    // The card view already reflects the spend: payable = min(balance, remaining monthly limit).
    expect(result.card.payableAmount).toBe('4899.50');
    expect(result.card.linkedAccountNumber).toBe('****8821');
    expect(result.card.accountAvailableBalance).toBe('23479.50');

    // The account was debited exactly once, by the exact integer minor amount.
    expect(await balanceOf()).toBe('23479.50');

    // A ledger row on the CARD channel: signed negative, DEBIT.
    const ledger = await db().transaction.findFirstOrThrow({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '测试商户' } });
    expect(ledger.accountId).toBe(CHECKING);
    expect(ledger.amountMinor).toBe(-10050n);
    expect(ledger.direction).toBe('DEBIT');
    expect(ledger.category).toBe('餐饮');
    expect(ledger.merchant).toBe('测试商户');
    expect(ledger.currency).toBe('CNY');
    expect(ledger.occurredAt.getTime()).toBe(occurredAt);

    // The durable consumption row stores the POSITIVE magnitude and the original result snapshot.
    const row = await db().cardConsumption.findUniqueOrThrow({ where: { id: result.consumption.id } });
    expect(row.amountMinor).toBe(10050n);
    expect(row.currency).toBe('CNY');
    expect(row.executionKey).toBeNull();
    expect(row.resultJson).not.toBeNull();
    expect((JSON.parse(row.resultJson!) as ConsumeCardResult).consumption.id).toBe(result.consumption.id);
  });
});

describe('banking-sdk · consumeCard monthly limit', () => {
  it('enforces the monthly limit with LIMIT_EXCEEDED and charges nothing', async () => {
    const card = await issueVirtual({ monthlyLimit: '100.00' });

    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '60.00' });
    const afterFirst = await balanceOf();

    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '50.00' })),
      'LIMIT_EXCEEDED',
    );

    // 60.00 + 50.00 exceeds the ¥100 limit → the rejected spend moved nothing at all.
    expect(await balanceOf()).toBe(afterFirst);
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(1);
  });

  it('treats a zero limit as "nothing is payable"', async () => {
    const card = await issueVirtual({ monthlyLimit: '0.00' });
    expect(card.payableAmount).toBe('0.00');

    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '0.01' })),
      'LIMIT_EXCEEDED',
    );
    expect(await balanceOf()).toBe('23580.00');
  });

  it('treats an omitted monthly limit as unlimited (governed by the account balance)', async () => {
    const card = await issueVirtual();
    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '12000.00' });

    expect(result.card.payableAmount).toBe('11580.00');
    expect(result.accountAvailableBalance).toBe('11580.00');
  });

  it('books every spend in the current business month and cannot escape the current monthly limit', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const monthStart = demoMonthRange().start.getTime();

    // (a) The caller no longer owns the booking instant, so a spend can never be back-dated out of the
    // current billing month: the stale shape is refused with VALIDATION and nothing is charged.
    const backdated = claimingInstant({ userId: DEMO_USER_ID, cardId: card.id, amount: '4900.00', occurredAt: monthStart - 1 });
    expectCode(await capture(() => banking.card.consumeCard(backdated)), 'VALIDATION');
    expect(await balanceOf()).toBe('23580.00');
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(0);

    // (b) Without any caller instant the spend is booked at the server's business clock (`demoNow()`),
    // which sits inside the current UTC+08:00 billing month — so it DOES consume this month's limit.
    const booked = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '4900.00' });
    expect(booked.consumption.occurredAt).toBe(demoNow());
    expect(demoNow()).toBeGreaterThanOrEqual(monthStart);
    expect(demoNow()).toBeLessThan(demoMonthRange().end.getTime());
    // Balance ¥18,680 is still far above the remaining ¥100 → the limit is the binding constraint.
    expect(booked.card.payableAmount).toBe('100.00');

    const exhausted = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '100.00' });
    expect(exhausted.card.payableAmount).toBe('0.00');
    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '100.01' })),
      'LIMIT_EXCEEDED',
    );
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(2);

    // (c) A booking pinned by the server-side seam exactly at the month boundary lands in the NEW
    // business month, so it counts against the current month's limit of that card (¥5,000 − ¥100).
    const fresh = await issueVirtual({ monthlyLimit: '5000.00' });
    const atBoundary = await banking.card.consumeCard(
      { userId: DEMO_USER_ID, cardId: fresh.id, amount: '100.00' },
      { now: demoMonthRange().start },
    );
    expect(atBoundary.consumption.occurredAt).toBe(monthStart);
    expect(atBoundary.card.payableAmount).toBe('4900.00');

    // 4,900 + 100 on the first card and 100 on the second — 23,580 − 5,100.
    expect(await balanceOf()).toBe('18480.00');
  });
});

describe('banking-sdk · consumeCard insufficient funds', () => {
  it('rejects a spend above the bound balance with INSUFFICIENT_FUNDS and writes nothing', async () => {
    const card = await issueVirtual();
    const before = await balanceOf();

    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '999999.00' })),
      'INSUFFICIENT_FUNDS',
    );

    expect(await balanceOf()).toBe(before);
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(0);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(0);
  });

  it('allows a spend of the whole balance but not one cent more', async () => {
    const card = await issueVirtual();
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '23580.00' });
    expect(await balanceOf()).toBe('0.00');

    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '0.01' })),
      'INSUFFICIENT_FUNDS',
    );
  });
});

describe('banking-sdk · consumeCard card-state fences', () => {
  it('rejects a FROZEN or LOST card with CONFLICT', async () => {
    const card = await issueVirtual();

    await banking.card.freezeCard(card.id, DEMO_USER_ID);
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.00' })), 'CONFLICT');

    await banking.card.unfreezeCard(card.id, DEMO_USER_ID);
    await banking.card.reportLostCard(card.id, DEMO_USER_ID);
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.00' })), 'CONFLICT');

    expect(await balanceOf()).toBe('23580.00');
    expect(await db().cardConsumption.count()).toBe(0);
  });

  it('rejects a card with no settlement binding with CONFLICT', async () => {
    // A genuinely unbound card exists only as a directly inserted row: nothing is recorded and there is
    // no explicit 补办 predecessor to inherit from, so nothing may be guessed.
    await insertUnboundCard({ id: 'card_unbound_consume', type: 'VIRTUAL', numberMasked: '****7702' });

    const balanceBefore = await balanceOf();
    const ledgerBefore = await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID } });

    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: 'card_unbound_consume', amount: '1.00' })), 'CONFLICT');
    // A CREDIT card never spends from a settlement account either.
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: CREDIT, amount: '1.00' })), 'CONFLICT');

    // Neither rejection moved money, wrote a ledger row or booked a consumption.
    expect(await balanceOf()).toBe(balanceBefore);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID } })).toBe(ledgerBefore);
    expect(await db().cardConsumption.count()).toBe(0);
  });

  it('rejects an unknown card id and another user\'s card with NOT_FOUND', async () => {
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: 'card_missing', amount: '1.00' })), 'NOT_FOUND');

    const card = await issueVirtual();
    expectCode(await capture(() => banking.card.consumeCard({ userId: FOREIGN_USER, cardId: card.id, amount: '1.00' })), 'NOT_FOUND');
    expect(await balanceOf()).toBe('23580.00');
  });

  it('rejects consumption when the bound account is no longer a CHECKING account', async () => {
    const second = await addSecondChecking();
    const card = await issueVirtual({ linkedAccountId: second });
    // The binding is a historical reference: the account can drift out from under it.
    await db().account.update({ where: { id: second }, data: { type: 'SAVINGS' } });

    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.00' })), 'CONFLICT');
    expect(await balanceOf(second)).toBe('1000.00');
  });
});

describe('banking-sdk · consumeCard input validation', () => {
  it('rejects a missing identity, a non-positive amount or an unsupported category', async () => {
    const card = await issueVirtual();

    expectCode(await capture(() => banking.card.consumeCard({ userId: '', cardId: card.id, amount: '1.00' })), 'VALIDATION');
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: '', amount: '1.00' })), 'VALIDATION');
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '0.00' })), 'VALIDATION');
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '-1.00' })), 'VALIDATION');
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: 'abc' })), 'VALIDATION');
    // Money is exact: sub-cent precision is refused, never rounded.
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.234' })), 'VALIDATION');
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.00', category: '不存在的类别' })), 'VALIDATION');
    // A caller-supplied instant is refused by the server-owned-time guard (before any read/write).
    expectCode(
      await capture(() => banking.card.consumeCard(claimingInstant({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.00', occurredAt: 1.5 }))),
      'VALIDATION',
    );

    expect(await db().cardConsumption.count()).toBe(0);
    expect(await balanceOf()).toBe('23580.00');
  });

  it('applies the documented defaults: category, merchant label and the demo clock', async () => {
    const card = await issueVirtual();
    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '10.00' });

    expect(result.consumption.category).toBe('其他');
    expect(result.consumption.merchant).toBe('本地模拟消费');
    expect(result.consumption.occurredAt).toBe(demoNow());
    expect(await balanceOf()).toBe('23570.00');
  });
});

describe('banking-sdk · consumeCard execution-key replay', () => {
  it('replays the original result for the same key without charging twice', async () => {
    const card = await issueVirtual({ monthlyLimit: '1000.00' });
    const request = { userId: DEMO_USER_ID, cardId: card.id, amount: '250.00', executionKey: 'spend-1' };

    const first = await banking.card.consumeCard(request);
    const second = await banking.card.consumeCard(request);

    expect(second.consumption.id).toBe(first.consumption.id);
    expect(second.consumption.amount).toBe('250.00');
    expect(second.accountAvailableBalance).toBe(first.accountAvailableBalance);
    // Exactly one charge, one ledger row and one ledger identity.
    expect(await balanceOf()).toBe('23330.00');
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(1);
  });

  it('replays the ORIGINAL snapshot even when the repeat asks for a different amount', async () => {
    const card = await issueVirtual({ monthlyLimit: '1000.00' });
    const first = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '250.00', executionKey: 'spend-2' });
    const replay = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '999.00', executionKey: 'spend-2' });

    // The persisted receipt wins — the SDK never re-prices a replayed identity.
    expect(replay.consumption.id).toBe(first.consumption.id);
    expect(replay.consumption.amount).toBe('250.00');
    expect(await balanceOf()).toBe('23330.00');
  });

  it('rejects the same key reused for a different card with CONFLICT', async () => {
    const first = await issueVirtual();
    const second = await issueVirtual();
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '10.00', executionKey: 'spend-3' });

    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: second.id, amount: '10.00', executionKey: 'spend-3' })),
      'CONFLICT',
    );
    expect(await balanceOf()).toBe('23570.00');
  });

  it('rejects the same key reused by a different user with CONFLICT', async () => {
    const card = await issueVirtual();
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '10.00', executionKey: 'spend-4' });

    expectCode(
      await capture(() => banking.card.consumeCard({ userId: FOREIGN_USER, cardId: card.id, amount: '10.00', executionKey: 'spend-4' })),
      'CONFLICT',
    );
  });

  it('rejects a replay whose persisted snapshot is missing with CONFLICT', async () => {
    const card = await issueVirtual();
    const first = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '10.00', executionKey: 'spend-5' });
    await db().cardConsumption.update({ where: { id: first.consumption.id }, data: { resultJson: null } });

    // Missing evidence is a conflict — never a rebuilt success.
    expectCode(
      await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '10.00', executionKey: 'spend-5' })),
      'CONFLICT',
    );
    expect(await balanceOf()).toBe('23570.00');
  });
});

describe('banking-sdk · consumeCard atomicity', () => {
  it('rolls the debit back when the ledger write fails (all-or-nothing)', async () => {
    const card = await issueVirtual();
    const before = await balanceOf();

    // The debit commits FIRST, the `channel='CARD'` ledger row SECOND. Failing the second write proves
    // the already-applied decrement genuinely rolls back with it.
    const error = await capture(() =>
      withInjectedWriteFailure('transaction', 'create', () =>
        banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '123.45' }),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected failure/);

    expect(await balanceOf()).toBe(before);
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(0);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(0);
  });
});

describe('banking-sdk · listCardConsumptions', () => {
  /** Two bound virtual cards + four spends at distinct instants. */
  async function seedSpends(): Promise<{ firstId: string; secondId: string; at: number }> {
    const first = await issueVirtual({ monthlyLimit: '5000.00' });
    const second = await issueVirtual({ monthlyLimit: '5000.00' });
    const at = demoNow();

    // Distinct instants are injected through the test-only `options.now` seam (the input set has no
    // `occurredAt`), so the newest-first ordering assertions stay meaningful.
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '1.00' }, { now: at - 3000 });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '2.00' }, { now: at - 2000 });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '3.00' }, { now: at - 1000 });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: second.id, amount: '4.00' }, { now: at - 500 });
    return { firstId: first.id, secondId: second.id, at };
  }

  it('returns the user\'s consumptions newest-first and filters by card', async () => {
    const { firstId, secondId } = await seedSpends();

    const all = await banking.card.listCardConsumptions(DEMO_USER_ID);
    expect(all.map((row) => row.amount)).toEqual(['4.00', '3.00', '2.00', '1.00']);
    expect(all[0].cardId).toBe(secondId);

    const onlyFirst = await banking.card.listCardConsumptions(DEMO_USER_ID, { cardId: firstId });
    expect(onlyFirst.map((row) => row.amount)).toEqual(['3.00', '2.00', '1.00']);
  });

  it('honours the limit, caps it, and breaks occurredAt ties by insertion order', async () => {
    const { at } = await seedSpends();
    const extra = await issueVirtual();
    // Same instant → the ordering falls back to `createdAt` (desc): the LATER write comes first.
    await db().cardConsumption.create({ data: { id: 'cons_tie_old', cardId: extra.id, accountId: CHECKING, userId: DEMO_USER_ID, amountMinor: 600n, currency: 'CNY', category: '其他', merchant: '同刻商户', occurredAt: new Date(at - 250), executionKey: null, createdAt: new Date(at - 9000) } });
    await db().cardConsumption.create({ data: { id: 'cons_tie_new', cardId: extra.id, accountId: CHECKING, userId: DEMO_USER_ID, amountMinor: 700n, currency: 'CNY', category: '其他', merchant: '同刻商户', occurredAt: new Date(at - 250), executionKey: null, createdAt: new Date(at - 8000) } });

    const limited = await banking.card.listCardConsumptions(DEMO_USER_ID, { limit: 2 });
    expect(limited.map((row) => row.amount)).toEqual(['7.00', '6.00']);

    const all = await banking.card.listCardConsumptions(DEMO_USER_ID, { limit: 500 });
    expect(all).toHaveLength(6);
    expect(all.findIndex((row) => row.id === 'cons_tie_new')).toBeLessThan(all.findIndex((row) => row.id === 'cons_tie_old'));
  });

  it('excludes another user\'s consumptions', async () => {
    await addForeignUser();
    await db().cardConsumption.create({ data: { id: 'cons_foreign', cardId: CREDIT, accountId: 'acct_foreign', userId: FOREIGN_USER, amountMinor: 12345n, currency: 'CNY', category: '餐饮', merchant: '外部商户', occurredAt: new Date(demoNow()), executionKey: null } });

    expect(await banking.card.listCardConsumptions(DEMO_USER_ID)).toEqual([]);
    const foreign = await banking.card.listCardConsumptions(FOREIGN_USER);
    expect(foreign.map((row) => row.id)).toEqual(['cons_foreign']);
    expect(foreign[0].amount).toBe('123.45');
  });

  it('validates the caller identity, the card filter and the limit', async () => {
    expectCode(await capture(() => banking.card.listCardConsumptions('')), 'SECURITY_DENIED');
    expectCode(await capture(() => banking.card.listCardConsumptions(DEMO_USER_ID, { cardId: '   ' })), 'VALIDATION');
    expectCode(await capture(() => banking.card.listCardConsumptions(DEMO_USER_ID, { limit: 0 })), 'VALIDATION');
    expectCode(await capture(() => banking.card.listCardConsumptions(DEMO_USER_ID, { limit: 1.5 })), 'VALIDATION');

    // Default page size is 20 and is never exceeded.
    expect(await banking.card.listCardConsumptions(DEMO_USER_ID)).toEqual([]);
  });
});

describe('banking-sdk · consumeCard concurrency', () => {
  it('two racing spends against a balance funding only one — exactly one succeeds, the other is INSUFFICIENT_FUNDS with no extra debit', async () => {
    await db().account.update({ where: { id: CHECKING }, data: { balanceMinor: moneyToCents('100.00') } });
    const card = await issueVirtual();

    const results = await Promise.allSettled([
      banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '80.00' }),
      banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '80.00' }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AppError);
    expect((rejected[0].reason as AppError).code).toBe('INSUFFICIENT_FUNDS');

    // Exactly ONE ¥80 debit: 100 - 80 = 20 — never negative, never charged twice.
    expect(await balanceOf()).toBe('20.00');
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(1);
  });

  it('two racing spends against one monthly limit — exactly one succeeds, the other is LIMIT_EXCEEDED with no extra debit', async () => {
    const card = await issueVirtual({ monthlyLimit: '100.00' });

    const results = await Promise.allSettled([
      banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '60.00' }),
      banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '60.00' }),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(AppError);
    expect((rejected[0].reason as AppError).code).toBe('LIMIT_EXCEEDED');

    // Exactly ONE ¥60 debit against the shared limit: 23580 - 60 = 23520.
    expect(await balanceOf()).toBe('23520.00');
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(1);
  });

  it('debits ONCE for a duplicate executionKey issued concurrently and both callers observe the SAME original result', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const request = { userId: DEMO_USER_ID, cardId: card.id, amount: '250.00', executionKey: 'race-key-1' };

    const [first, second] = await Promise.all([
      banking.card.consumeCard(request),
      banking.card.consumeCard(request),
    ]);

    // The second caller replays the PERSISTED original snapshot — never a second charge.
    expect(second.consumption.id).toBe(first.consumption.id);
    expect(second.consumption.amount).toBe('250.00');
    expect(second.accountAvailableBalance).toBe(first.accountAvailableBalance);
    expect(second.accountAvailableBalance).toBe('23330.00');

    expect(await balanceOf()).toBe('23330.00');
    expect(await db().cardConsumption.count({ where: { cardId: card.id } })).toBe(1);
    expect(await db().transaction.count({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } })).toBe(1);
  });
});

describe('banking-sdk · virtual cards sharing one settlement account', () => {
  it('two virtual cards on the same account share ONE balance — a spend on one moves the other\'s payable amount', async () => {
    const first = await issueVirtual();
    const second = await issueVirtual();
    expect(first.linkedAccountId).toBe(CHECKING);
    expect(second.linkedAccountId).toBe(CHECKING);

    const initial = await cardMap();
    expect(initial.get(first.id)!.accountAvailableBalance).toBe('23580.00');
    expect(initial.get(second.id)!.payableAmount).toBe('23580.00');

    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '100.00' });

    // The single debit shows on BOTH cards — the balance is never duplicated or double-counted.
    expect(await balanceOf()).toBe('23480.00');
    const after = await cardMap();
    expect(after.get(first.id)!.payableAmount).toBe('23480.00');
    expect(after.get(second.id)!.payableAmount).toBe('23480.00');
    expect(after.get(second.id)!.accountAvailableBalance).toBe('23480.00');

    const ledger = await db().transaction.findMany({ where: { channel: 'CARD', userId: DEMO_USER_ID, merchant: '本地模拟消费' } });
    expect(ledger).toHaveLength(1);
    expect(ledger[0].amountMinor).toBe(-10000n);
    expect(ledger.reduce((sum, row) => sum + row.amountMinor, 0n)).toBe(-10000n);
  });

  it('each shared card tracks its own monthly spend while the balance stays common', async () => {
    const first = await issueVirtual({ monthlyLimit: '5000.00' });
    const second = await issueVirtual({ monthlyLimit: '5000.00' });

    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '300.00' });
    const result = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: second.id, amount: '200.00' });

    // ONE balance: 23580 - 300 - 200 = 23080. The second card's own limit is reduced by its ¥200.
    expect(result.accountAvailableBalance).toBe('23080.00');
    expect(result.card.payableAmount).toBe('4800.00');
    expect(await balanceOf()).toBe('23080.00');

    const other = await viewOf(first.id);
    expect(other.accountAvailableBalance).toBe('23080.00');
    expect(other.payableAmount).toBe('4700.00');
  });
});

describe('banking-sdk · payableAmount syncs with the bound account', () => {
  it('reflects a balance change made OUTSIDE consume and caps it by the remaining monthly limit', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    expect((await viewOf(card.id)).payableAmount).toBe('5000.00'); // min(23580, 5000)

    // Lower the bound balance directly — the card view must follow without a consume.
    await db().account.update({ where: { id: CHECKING }, data: { balanceMinor: moneyToCents('1500.00') } });
    const lowered = await viewOf(card.id);
    expect(lowered.accountAvailableBalance).toBe('1500.00');
    expect(lowered.payableAmount).toBe('1500.00'); // min(1500, 5000)

    // Raise the balance ABOVE the monthly limit — payable is capped by the remaining limit.
    await db().account.update({ where: { id: CHECKING }, data: { balanceMinor: moneyToCents('30000.00') } });
    const raised = await viewOf(card.id);
    expect(raised.accountAvailableBalance).toBe('30000.00');
    expect(raised.payableAmount).toBe('5000.00'); // min(30000, 5000)
  });

  it('reflects a balance change made by an SDK transfer', async () => {
    const card = await issueVirtual();
    expect((await viewOf(card.id)).payableAmount).toBe('23580.00');

    await banking.transfer.createTransfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '580.00' });

    const view = await viewOf(card.id);
    expect(view.accountAvailableBalance).toBe('23000.00');
    expect(view.payableAmount).toBe('23000.00'); // no monthly limit → the whole balance
  });

  it('combines the shared balance with this card\'s remaining monthly limit (min)', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1000.00' });

    // remaining limit ¥4,000 < balance ¥22,580 → payable is the limit.
    expect((await viewOf(card.id)).payableAmount).toBe('4000.00');

    // Drop the balance BELOW the remaining limit → payable becomes the balance.
    await db().account.update({ where: { id: CHECKING }, data: { balanceMinor: moneyToCents('1500.00') } });
    const view = await viewOf(card.id);
    expect(view.accountAvailableBalance).toBe('1500.00');
    expect(view.payableAmount).toBe('1500.00'); // min(1500, 4000)
  });
});
