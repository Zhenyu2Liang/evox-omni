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
 *   - an `executionKey` replays the PERSISTED original result (never a second charge) and is rejected
 *     when it is reused for another card/user or when the snapshot is missing;
 *   - `listCardConsumptions` is owner-scoped, newest-first, card-filterable and limit-capped;
 *   - the debit + ledger + consumption unit is ATOMIC (the real transaction rolls back).
 *
 * All money is asserted as exact canonical CNY decimal strings / integer minor units — never floats.
 *
 * Fixtures: demo user 李明 (`acct_checking` CHECKING ¥23,580 · `acct_savings` SAVINGS ¥50,000),
 * `card_credit` (CREDIT, ¥18,000 monthly limit) and `card_debit` (DEBIT, unbound). Neither seeded card
 * is account-bound, so these specs issue VIRTUAL cards through the SDK itself.
 *
 * NOTE: `CardConsumption` declares no relations, so the shared `truncateAll()` (written before this
 * ledger existed) does not clear it; the suite clears it in `beforeEach` so every test starts from a
 * genuinely empty spend history.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { banking } from '@/banking-sdk';
import type { ApplyVirtualCardInput, CardView, ConsumeCardResult } from '@/banking-sdk/types';
import { demoMonthRange, demoNow } from '@/lib/clock';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { withInjectedWriteFailure } from '../../helpers/write-failure';

useFreshDatabase();

const db = () => getTestPrisma();

/**
 * `truncateAll()` predates `CardConsumption` (a relation-free ledger), so it survives a reset.
 * Truncate it here — registered AFTER `useFreshDatabase()`'s hook, so it runs on the fresh world.
 */
beforeEach(async () => {
  await db().cardConsumption.deleteMany();
});

/** The user's default CHECKING account (¥23,580) — the fallback settlement account. */
const CHECKING = 'acct_checking';
/** A SAVINGS account — never a valid virtual-card settlement account. */
const SAVINGS = 'acct_savings';
const CREDIT = 'card_credit';
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

/** Issue a VIRTUAL card for the demo user (optionally overriding the binding / monthly limit). */
function issueVirtual(input: Omit<Partial<ApplyVirtualCardInput>, 'userId'> = {}): Promise<CardView> {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, ...input });
}

/** The exact balance of an account as canonical CNY text. */
async function balanceOf(accountId = CHECKING): Promise<string> {
  const row = await db().account.findUniqueOrThrow({ where: { id: accountId } });
  return centsToMoney(row.balanceMinor);
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

    // The binding is persisted (a historical reference column, not a relation).
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

  it('binds VIRTUAL cards (and only them) through addDemoCard', async () => {
    const virtual = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', monthlyLimit: '2000.00' });
    expect(virtual.linkedAccountId).toBe(CHECKING);
    expect(virtual.payableAmount).toBe('2000.00'); // limit ¥2,000 < balance ¥23,580

    // A non-virtual card keeps no settlement account.
    const debit = await banking.card.addDemoCard(DEMO_USER_ID, { type: 'DEBIT' });
    expect(debit.linkedAccountId).toBeUndefined();
    expect(debit.linkedAccountNumber).toBeUndefined();
    expect(debit.payableAmount).toBeUndefined();
    expect((await db().card.findUniqueOrThrow({ where: { id: debit.id } })).linkedAccountId).toBeNull();

    // addDemoCard honours the same ownership / type fences as applyVirtualCard.
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', linkedAccountId: SAVINGS })), 'VALIDATION');
    const foreign = await addForeignUser();
    expectCode(await capture(() => banking.card.addDemoCard(DEMO_USER_ID, { type: 'VIRTUAL', linkedAccountId: foreign })), 'SECURITY_DENIED');
  });

  it('exposes no balance/payable values when the bound account no longer exists (never fabricated)', async () => {
    await addSecondChecking();
    const card = await issueVirtual({ linkedAccountId: 'acct_checking2', monthlyLimit: '100.00' });
    await db().account.delete({ where: { id: 'acct_checking2' } });

    const reloaded = (await banking.card.getCards(DEMO_USER_ID)).find((view) => view.id === card.id)!;
    expect(reloaded.linkedAccountId).toBe('acct_checking2');
    expect(reloaded.linkedAccountNumber).toBeUndefined();
    expect(reloaded.accountAvailableBalance).toBeUndefined();
    expect(reloaded.payableAmount).toBeUndefined();
  });

  it('returns no linked-account fields for the seeded unbound cards', async () => {
    const unbound = (await banking.card.getCards(DEMO_USER_ID)).filter((view) => view.id === CREDIT || view.id === DEBIT);
    expect(unbound).toHaveLength(2);
    for (const view of unbound) {
      expect(view.linkedAccountId).toBeUndefined();
      expect(view.linkedAccountNumber).toBeUndefined();
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

    const result: ConsumeCardResult = await banking.card.consumeCard({
      userId: DEMO_USER_ID,
      cardId: card.id,
      amount: '100.50',
      category: '餐饮',
      merchant: '测试商户',
      occurredAt,
    });

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
    const ledger = await db().transaction.findFirstOrThrow({ where: { channel: 'CARD', userId: DEMO_USER_ID } });
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
    expect(await db().transaction.count({ where: { channel: 'CARD' } })).toBe(1);
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

  it('does not consume this month\'s limit for a spend in a previous business month', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const previousMonth = demoMonthRange().start.getTime() - 1;

    const previous = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '4900.00', occurredAt: previousMonth });
    // The ¥4,900 spent LAST month must not shrink this month's remaining ¥5,000 allowance.
    expect(previous.card.payableAmount).toBe('5000.00');

    const current = await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '100.00', occurredAt: demoNow() });
    expect(current.card.payableAmount).toBe('4900.00');
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
    expect(await db().transaction.count({ where: { channel: 'CARD' } })).toBe(0);
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

  it('rejects an unbound card with CONFLICT', async () => {
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: DEBIT, amount: '1.00' })), 'CONFLICT');
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: CREDIT, amount: '1.00' })), 'CONFLICT');
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
    expectCode(await capture(() => banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: card.id, amount: '1.00', occurredAt: 1.5 })), 'VALIDATION');

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
    expect(await db().transaction.count({ where: { channel: 'CARD' } })).toBe(1);
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
    expect(await db().transaction.count({ where: { channel: 'CARD' } })).toBe(0);
  });
});

describe('banking-sdk · listCardConsumptions', () => {
  /** Two bound virtual cards + four spends at distinct instants. */
  async function seedSpends(): Promise<{ firstId: string; secondId: string; at: number }> {
    const first = await issueVirtual({ monthlyLimit: '5000.00' });
    const second = await issueVirtual({ monthlyLimit: '5000.00' });
    const at = demoNow();

    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '1.00', occurredAt: at - 3000 });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '2.00', occurredAt: at - 2000 });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: first.id, amount: '3.00', occurredAt: at - 1000 });
    await banking.card.consumeCard({ userId: DEMO_USER_ID, cardId: second.id, amount: '4.00', occurredAt: at - 500 });
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
