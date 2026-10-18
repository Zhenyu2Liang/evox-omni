/**
 * tests/integration/card-consume-transaction.test.ts — SQLite-backed regressions for the
 * TRANSACTION and CONCURRENCY half of the virtual-card consumption hardening
 * (`banking-sdk/card.ts#consumeCard`), exercised through the REAL SDK against the REAL isolated
 * test database — no model, no HTTP edge, no browser.
 *
 * INVARIANTS UNDER TEST (root CONTEXT.md): "A VIRTUAL card is a debit instrument bound to one owned
 * CHECKING account … [it] debits that account and writes a `CardConsumption` row in one transaction,
 * guarded by the card's monthly limit and replayable by execution key." Concretely:
 *
 *  1. ALL-OR-NOTHING. The balance debit, the `channel='CARD'` ledger row and the `CardConsumption`
 *     row are ONE unit. A failure injected into the consumption INSERT — which runs AFTER the debit
 *     and AFTER the ledger row — rolls BOTH earlier writes back, leaving no trace of the spend.
 *  2. LIMIT FENCE. The monthly limit is read and enforced in the SAME transaction as the debit, from
 *     the card FAMILY's current-month spend, so concurrent spends cannot breach it: one debit per
 *     success, exactly `#successes` ledger rows and consumption rows, and never a negative balance.
 *  3. FUNDS FENCE. Without a monthly limit the atomic sufficient-funds debit alone bounds the spend:
 *     concurrent spends beyond the balance fail `INSUFFICIENT_FUNDS` and the balance never overdraws.
 *  4. EXECUTION-KEY REPLAY. Concurrent duplicates of ONE execution key charge ONCE; the loser's
 *     transaction rolls back and replays the winner's PERSISTED snapshot, so both callers observe the
 *     SAME `consumption.id` and the SAME `accountAvailableBalance`.
 *
 * HARNESS. Real Prisma singleton + `prisma/test.db` (`tests/helpers/db.ts`). The rollback proof uses
 * `withInjectedWriteFailure` (`tests/helpers/write-failure.ts`), which proxies the client's
 * `$transaction` so exactly ONE `model.method` call throws INSIDE the real interactive transaction —
 * the earlier writes therefore genuinely roll back instead of the outcome being faked.
 * CONCURRENCY SCOPE — what these bursts DO and DO NOT prove: every call is admitted at once
 * (`Promise.allSettled`), so all of them contend for the same card, the same monthly-limit read and
 * the same account row. The isolated test database is SQLite behind the `better-sqlite3` adapter,
 * which owns ONE native connection (`tests/setup.ts`), so the driver serializes the write
 * transactions: no call is ever refused with a driver-level `SQLITE_BUSY`/timeout, and each
 * transaction's limit/funds read therefore sees the previously COMMITTED state. What is proven here
 * is exactly the SDK's contract — the limit and the funds check live INSIDE the debit's transaction,
 * so a success always implies its own debit and its own pair of rows, and no interleaving can breach
 * either fence. True multi-writer parallelism is a property of a real database server, not of this
 * harness, and is deliberately not claimed here.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { banking, type ConsumeCardResult } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { centsToMoney, moneyToCents } from '@/lib/money';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { withInjectedWriteFailure } from '@/tests/helpers/write-failure';

const db = () => getTestPrisma();

/** Seeded settlement CHECKING account (¥23,580.00) — the default funding account of a new card. */
const CHECKING = 'acct_checking';
const SEEDED_CHECKING_BALANCE = '23580.00';

/**
 * Distinctive merchant labels (one per spec) so a ledger row's provenance is unambiguous: the seed
 * already ships `channel='CARD'` rows (tx_sep_*) on this account, so a burst of concurrent spends can
 * only be counted exactly when it is narrowed to a merchant label of its own.
 */
const ROLLBACK_MERCHANT = '集成回滚商户';
const LIMIT_RACE_MERCHANT = '集成限额并发商户';
const FUNDS_RACE_MERCHANT = '集成余额并发商户';
const REPLAY_MERCHANT = '集成执行身份并发商户';

const CATEGORY = '购物';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

/** Issue a virtual card bound to the default settlement account (no seed ships one). */
function issueVirtual(input: { monthlyLimit?: string; linkedAccountId?: string } = {}) {
  return banking.card.applyVirtualCard({ userId: DEMO_USER_ID, ...input });
}

/** Exact persisted balance of an account, in CNY minor units. */
async function balanceMinorOf(accountId: string = CHECKING): Promise<bigint> {
  const account = await db().account.findUniqueOrThrow({ where: { id: accountId } });
  return account.balanceMinor;
}

/** Force the account to an exact starting balance (the funds-fence specs need a tight one). */
async function setBalance(accountId: string, amount: string): Promise<void> {
  await db().account.update({ where: { id: accountId }, data: { balanceMinor: moneyToCents(amount) } });
}

/** `CardConsumption` rows booked against one card. */
function consumptionCount(cardId: string): Promise<number> {
  return db().cardConsumption.count({ where: { cardId } });
}

/** `channel='CARD'` ledger rows of an account, optionally narrowed to one merchant label. */
function cardLedgerCount(accountId: string, merchant?: string): Promise<number> {
  return db().transaction.count({
    where: { channel: 'CARD', accountId, ...(merchant !== undefined ? { merchant } : {}) },
  });
}

/**
 * Signed sum of the `channel='CARD'` ledger rows of one merchant label (negative = debits), so a
 * burst's money movement is checked against the ledger itself and not only against row counts.
 */
async function cardLedgerSumMinor(accountId: string, merchant: string): Promise<bigint> {
  const rows = await db().transaction.findMany({
    where: { channel: 'CARD', accountId, merchant },
    select: { amountMinor: true },
  });
  return rows.reduce((total, row) => total + row.amountMinor, 0n);
}

function fulfilledOf<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.filter((result): result is PromiseFulfilledResult<T> => result.status === 'fulfilled')
    .map((result) => result.value);
}

function rejectedOf<T>(results: PromiseSettledResult<T>[]): PromiseRejectedResult[] {
  return results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
}

/** Every rejection must be a typed SDK error with the expected code — never a raw driver error. */
function expectRejectionCodes(rejected: PromiseRejectedResult[], code: string): void {
  for (const rejection of rejected) {
    expect(rejection.reason).toBeInstanceOf(AppError);
    expect((rejection.reason as AppError).code).toBe(code);
  }
}

/** The exact CNY magnitude of a batch of committed consumptions. */
function sumConsumedMinor(consumptions: ConsumeCardResult[]): bigint {
  return consumptions.reduce((total, result) => total + moneyToCents(result.consumption.amount), 0n);
}

describe('card consumption · one transaction, all-or-nothing', () => {
  it('rolls the debit AND the ledger row back when the consumption insert fails', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    expect(card.linkedAccountId).toBe(CHECKING);

    const amount = '123.45';
    const balanceBefore = await balanceMinorOf();
    const ledgerBefore = await cardLedgerCount(CHECKING);
    const consumptionBefore = await db().cardConsumption.count();
    // A brand-new card means there is nothing to confuse the trace.
    expect(await consumptionCount(card.id)).toBe(0);

    // ORDER MATTERS: inside the unit the atomic debit and the `channel='CARD'` ledger row are written
    // BEFORE this insert. Failing the insert therefore proves both earlier writes roll back with it.
    await expect(withInjectedWriteFailure('cardConsumption', 'create', () =>
      banking.card.consumeCard({
        userId: DEMO_USER_ID,
        cardId: card.id,
        amount,
        category: CATEGORY,
        merchant: ROLLBACK_MERCHANT,
      }),
    )).rejects.toThrow(/injected failure: cardConsumption\.create/);

    // No decrement survived …
    expect(await balanceMinorOf()).toBe(balanceBefore);
    expect(centsToMoney(await balanceMinorOf())).toBe(SEEDED_CHECKING_BALANCE);
    // … no ledger row survived (the write that DID happen before the injected failure) …
    expect(await cardLedgerCount(CHECKING)).toBe(ledgerBefore);
    expect(await cardLedgerCount(CHECKING, ROLLBACK_MERCHANT)).toBe(0);
    expect(await cardLedgerSumMinor(CHECKING, ROLLBACK_MERCHANT)).toBe(0n);
    // … and no consumption row exists.
    expect(await db().cardConsumption.count()).toBe(consumptionBefore);
    expect(await consumptionCount(card.id)).toBe(0);

    // The card itself is untouched: no phantom spend reduces its own payable amount.
    const after = await banking.card.getCards(DEMO_USER_ID);
    const spendable = after.find((view) => view.id === card.id);
    expect(spendable?.accountAvailableBalance).toBe(SEEDED_CHECKING_BALANCE);
    expect(spendable?.payableAmount).toBe(centsToMoney(moneyToCents('5000.00')));
  });
});

describe('card consumption · concurrent spends respect the monthly limit', () => {
  it('lets exactly one of eight ¥60 spends through a ¥100 monthly limit, debiting once', async () => {
    await setBalance(CHECKING, '500.00');
    const card = await issueVirtual({ monthlyLimit: '100.00' });

    const startBalance = await balanceMinorOf();
    const ledgerBefore = await cardLedgerCount(CHECKING);
    const unit = moneyToCents('60.00');
    const limit = moneyToCents('100.00');

    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      banking.card.consumeCard({
        userId: DEMO_USER_ID,
        cardId: card.id,
        amount: '60.00',
        category: CATEGORY,
        merchant: LIMIT_RACE_MERCHANT,
      }),
    ));

    const fulfilled = fulfilledOf(results);
    const rejected = rejectedOf(results);

    // The limit is read inside the same transaction as the debit, so the second spend of ¥60 must see
    // the first one and stop: one success, seven typed refusals.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expectRejectionCodes(rejected, 'LIMIT_EXCEEDED');

    // One debit per success — the total can neither breach the monthly limit nor the account balance.
    const totalDebited = sumConsumedMinor(fulfilled);
    expect(totalDebited).toBe(BigInt(fulfilled.length) * unit);
    expect(totalDebited <= limit).toBe(true);
    expect(totalDebited <= startBalance).toBe(true);

    // Exactly one `CardConsumption` row and exactly one `channel='CARD'` ledger row per success.
    expect(await consumptionCount(card.id)).toBe(fulfilled.length);
    expect(await cardLedgerCount(CHECKING)).toBe(ledgerBefore + fulfilled.length);
    expect(await cardLedgerCount(CHECKING, LIMIT_RACE_MERCHANT)).toBe(fulfilled.length);
    // The ledger carries the same single debit: -60.00, never -120.00 and never -480.00.
    expect(await cardLedgerSumMinor(CHECKING, LIMIT_RACE_MERCHANT)).toBe(-totalDebited);

    // Exact final balance: start − total debited, and never an overdraft.
    const finalBalance = await balanceMinorOf();
    expect(finalBalance).toBe(startBalance - totalDebited);
    expect(finalBalance >= 0n).toBe(true);
    expect(centsToMoney(finalBalance)).toBe('440.00');

    // The winner's own snapshot agrees with the persisted truth.
    expect(fulfilled[0].accountAvailableBalance).toBe(centsToMoney(finalBalance));
  });
});

describe('card consumption · concurrent spends respect the account balance', () => {
  it('lets exactly one of eight ¥60 spends through a ¥100 balance, the rest INSUFFICIENT_FUNDS', async () => {
    await setBalance(CHECKING, '100.00');
    // No monthly limit at all: the atomic sufficient-funds debit is the ONLY fence.
    const card = await issueVirtual();
    expect(card.monthlyLimit).toBeUndefined();

    const startBalance = await balanceMinorOf();
    const ledgerBefore = await cardLedgerCount(CHECKING);

    const results = await Promise.allSettled(Array.from({ length: 8 }, () =>
      banking.card.consumeCard({
        userId: DEMO_USER_ID,
        cardId: card.id,
        amount: '60.00',
        category: CATEGORY,
        merchant: FUNDS_RACE_MERCHANT,
      }),
    ));

    const fulfilled = fulfilledOf(results);
    const rejected = rejectedOf(results);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(7);
    expectRejectionCodes(rejected, 'INSUFFICIENT_FUNDS');

    // Exactly ONE ¥60 debit: 100 − 60 = 40 — never negative, never charged twice.
    expect(await balanceMinorOf()).toBe(startBalance - moneyToCents('60.00'));
    expect(centsToMoney(await balanceMinorOf())).toBe('40.00');
    expect(await consumptionCount(card.id)).toBe(1);
    expect(await cardLedgerCount(CHECKING)).toBe(ledgerBefore + 1);
    expect(await cardLedgerCount(CHECKING, FUNDS_RACE_MERCHANT)).toBe(1);
    expect(await cardLedgerSumMinor(CHECKING, FUNDS_RACE_MERCHANT)).toBe(-moneyToCents('60.00'));
  });
});

describe('card consumption · concurrent duplicates of one execution key', () => {
  it('charges ONCE and both callers observe the SAME persisted snapshot', async () => {
    const card = await issueVirtual({ monthlyLimit: '5000.00' });
    const executionKey = 'integration:consume:race-1';
    const request = {
      userId: DEMO_USER_ID,
      cardId: card.id,
      amount: '250.00',
      category: CATEGORY,
      merchant: REPLAY_MERCHANT,
      executionKey,
    };

    const startBalance = await balanceMinorOf();
    const ledgerBefore = await cardLedgerCount(CHECKING);

    const [first, second] = await Promise.all([
      banking.card.consumeCard(request),
      banking.card.consumeCard(request),
    ]);

    // The loser's insert violates the `executionKey` unique constraint, its transaction rolls back
    // (debit undone) and it replays the winner's persisted result — no second charge.
    expect(second.consumption.id).toBe(first.consumption.id);
    expect(second.accountAvailableBalance).toBe(first.accountAvailableBalance);
    expect(second.consumption.amount).toBe('250.00');
    expect(second.card.payableAmount).toBe(first.card.payableAmount);

    expect(centsToMoney(await balanceMinorOf())).toBe('23330.00');
    expect(await balanceMinorOf()).toBe(startBalance - moneyToCents('250.00'));
    expect(await db().cardConsumption.count({ where: { executionKey } })).toBe(1);
    expect(await consumptionCount(card.id)).toBe(1);
    expect(await cardLedgerCount(CHECKING)).toBe(ledgerBefore + 1);
    expect(await cardLedgerCount(CHECKING, REPLAY_MERCHANT)).toBe(1);
    expect(await cardLedgerSumMinor(CHECKING, REPLAY_MERCHANT)).toBe(-moneyToCents('250.00'));
    // The single committed snapshot is what BOTH callers saw (proving replay, not re-derivation).
    expect(first.accountAvailableBalance).toBe(centsToMoney(startBalance - moneyToCents('250.00')));
  });
});
