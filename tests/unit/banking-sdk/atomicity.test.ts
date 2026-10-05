/**
 * banking-sdk · money-movement ATOMICITY regression.
 *
 * Runs under the MAIN Vitest config (`vitest.config.ts`, which includes `tests/**`), so it is part
 * of a plain `npm run test` — NOT behind a private/scoped config.
 *
 * WHAT it proves (the two hazards the interactive-transaction fix closes):
 *   1. Ledger-write failure ROLLBACK — if the second write of a money unit fails, the first (the
 *      balance debit) is rolled back: balance unchanged, no partial ledger/holding row survives,
 *      and the failure is surfaced (never swallowed, never a fabricated success).
 *   2. CONCURRENT overspend / double-credit — two racing calls can never drive the balance negative
 *      or credit one holding twice; exactly one wins, the loser fails cleanly with a typed AppError.
 *
 * Failure injection: we wrap the REAL interactive transaction's client in a Proxy that throws on one
 * chosen `model.method` (everything else forwards to the real tx). The real `$transaction` is used, so
 * the earlier write GENUINELY rolls back rather than us faking the outcome.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { RedeemInvestmentInput, SubscribeInvestmentInput, TransferInput } from '@/banking-sdk';
import { AppError } from '@/lib/errors';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Fresh seeded DB before each case + Prisma disconnect afterwards.
useFreshDatabase();
/** Funding account every transfer/subscribe/redeem touches (seed balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START = 23580;
/** The single seeded HOLDING (marketValue ¥5,050) — the redeem target. */
const SEEDED_HOLDING = 'holding_wenjiana';
const HOLDING_MARKET_VALUE = 5050;
/** 稳健理财A — minAmount ¥1,000. */
const PRODUCT = 'prod_wenjiana';

function db() {
  return getTestPrisma();
}

async function checkingBalance(): Promise<number> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (!account) throw new Error(`${CHECKING} missing from fixtures`);
  return account.balance;
}

async function setCheckingBalance(balance: number): Promise<void> {
  await db().account.update({ where: { id: CHECKING }, data: { balance } });
}

/** Count of the user's 转账 ledger rows carrying one of `remarks` (isolates the ones we wrote). */
function transferLedgerCount(remarks: string[]): Promise<number> {
  return db().transaction.count({
    where: { userId: DEMO_USER_ID, category: '转账', remark: { in: remarks } },
  });
}

/** EVERY ledger row of the user — proves no orphan `Transaction` row of any kind was written. */
function allLedgerCount(): Promise<number> {
  return db().transaction.count({ where: { userId: DEMO_USER_ID } });
}

function holdingCount(): Promise<number> {
  return db().investmentHolding.count({ where: { userId: DEMO_USER_ID } });
}

function transfer(input: TransferInput) {
  return banking.transfer.createTransfer(input);
}

/** Await `fn`, returning whatever it rejected with; fails loudly if it unexpectedly resolves. */
async function capture(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

/* --------------------------------------------------------- write-failure injection */

interface TxRunner {
  $transaction: (arg: unknown) => Promise<unknown>;
}

/** What the injected method does when called — it must throw (a bare Error or a typed `AppError`). */
type FailureThrower = () => never;

/** The default injection: a bare (non-SDK) error, i.e. an unexpected infrastructure failure. */
function injectedBareFailure(model: string, method: string): FailureThrower {
  return () => {
    throw new Error(`injected failure: ${model}.${method}`);
  };
}

/**
 * Wrap the shared Prisma client so the interactive transaction's `tx` throws on exactly one
 * `model.method`; every other access is forwarded to the REAL `tx`. Because the real transaction is
 * still used, any earlier write in the unit is genuinely rolled back when the injected method throws.
 */
function injectWriteFailure(tx: unknown, model: string, method: string, fail: FailureThrower): unknown {
  return new Proxy(tx as object, {
    get(target, prop) {
      if (prop === model) {
        const modelClient = Reflect.get(target, prop) as object;
        return new Proxy(modelClient, {
          get(modelTarget, modelProp) {
            if (modelProp === method) {
              return () => {
                fail();
              };
            }
            const value = Reflect.get(modelTarget, modelProp);
            return typeof value === 'function'
              ? (value as (...args: unknown[]) => unknown).bind(modelTarget)
              : value;
          },
        });
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Run `work` with `model.method` throwing inside the SDK's interactive transaction. */
async function withInjectedWriteFailure<T>(
  model: string,
  method: string,
  work: () => Promise<T>,
  fail: FailureThrower = injectedBareFailure(model, method),
): Promise<T> {
  const client = db() as unknown as TxRunner;
  const original = client.$transaction;
  if (typeof original !== 'function') {
    throw new Error('withInjectedWriteFailure: client.$transaction is not a function');
  }
  const injected: TxRunner['$transaction'] = (arg: unknown) =>
    original.call(client, (tx: unknown) =>
      (arg as (client: unknown) => Promise<unknown>)(injectWriteFailure(tx, model, method, fail)),
    );

  // Install/restore the mock ourselves via `defineProperty` — `vi.spyOn` + `restoreAllMocks`
  // does NOT round-trip Prisma's `$transaction` (a later read comes back `undefined`).
  Object.defineProperty(client, '$transaction', {
    value: injected,
    configurable: true,
    writable: true,
  });
  try {
    return await work();
  } finally {
    Object.defineProperty(client, '$transaction', {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

/* ---------------------------------------------------------------------- tests */

describe('banking-sdk · atomicity: concurrent overspend', () => {
  it('two racing transfers against a balance funding only one — exactly one succeeds, the other is INSUFFICIENT_FUNDS, balance never negative', async () => {
    const start = 300;
    await setCheckingBalance(start);

    const results = await Promise.allSettled([
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: 200, remark: 'RACE_A' }),
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_wangfang', amount: 200, remark: 'RACE_B' }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0].reason;
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('INSUFFICIENT_FUNDS');

    // The single successful debit applied; balance is exactly 100 (never negative).
    const balance = await checkingBalance();
    expect(balance).toBe(start - 200);
    expect(balance).toBeGreaterThanOrEqual(0);

    // Exactly ONE of the two racing transfers wrote its ledger row.
    expect(await transferLedgerCount(['RACE_A', 'RACE_B'])).toBe(1);
  });
});

describe('banking-sdk · atomicity: concurrent double-redeem', () => {
  it('two racing redeems of one holding — exactly one credits the account, the other is CONFLICT', async () => {
    const before = await checkingBalance();

    const input: RedeemInvestmentInput = { userId: DEMO_USER_ID, holdingId: SEEDED_HOLDING };
    const results = await Promise.allSettled([
      banking.investment.redeemInvestment(input),
      banking.investment.redeemInvestment(input),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0].reason;
    expect(failure).toBeInstanceOf(AppError);
    expect((failure as AppError).code).toBe('CONFLICT');

    // Credited exactly once (never twice).
    expect(await checkingBalance()).toBe(before + HOLDING_MARKET_VALUE);
  });
});

/**
 * THE ledger-rollback requirement: the MAIN production path (`banking.transfer.createTransfer`,
 * which debits the account and writes the DEBIT ledger row inside ONE interactive transaction) must
 * roll the debit back when the ledger write fails — the two writes commit or roll back together.
 */
describe('banking-sdk · atomicity: ledger-write failure rolls back the debit', () => {
  it('transfer: a failing ledger insert rolls back the debit (balance unchanged, no ledger row of any kind, error surfaced)', async () => {
    const ledgerRowsBefore = await allLedgerCount();
    const before = await transferLedgerCount(['ROLLBACK']);
    expect(before).toBe(0);
    expect(await checkingBalance()).toBe(CHECKING_START);

    const error = await capture(() =>
      withInjectedWriteFailure('transaction', 'create', () =>
        transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: 200, remark: 'ROLLBACK' }),
      ),
    );

    // Surfaced, never swallowed — and NOT a fabricated success.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected failure/);

    // The debit was rolled back — never a partial write, never a fabricated success.
    expect(await checkingBalance()).toBe(CHECKING_START);
    expect(await transferLedgerCount(['ROLLBACK'])).toBe(before);
    // No orphan ledger row of ANY kind was left behind by the aborted unit.
    expect(await allLedgerCount()).toBe(ledgerRowsBefore);
  });

  it('transfer: a TYPED AppError from the ledger write also rolls the debit back and keeps its code', async () => {
    const ledgerRowsBefore = await allLedgerCount();

    const error = await capture(() =>
      withInjectedWriteFailure(
        'transaction',
        'create',
        () => transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: 200, remark: 'ROLLBACK_TYPED' }),
        () => {
          throw new AppError('INTERNAL', 'ledger write failed');
        },
      ),
    );

    // The typed error crosses the transaction boundary intact (abort ⇒ rollback, not a silent retry).
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INTERNAL');
    expect((error as AppError).message).toBe('ledger write failed');

    expect(await checkingBalance()).toBe(CHECKING_START);
    expect(await transferLedgerCount(['ROLLBACK_TYPED'])).toBe(0);
    expect(await allLedgerCount()).toBe(ledgerRowsBefore);
  });

  it('subscribeInvestment: a failing holding insert rolls back the account debit', async () => {
    const beforeHoldings = await holdingCount();
    const ledgerRowsBefore = await allLedgerCount();
    expect(await checkingBalance()).toBe(CHECKING_START);

    const input: SubscribeInvestmentInput = { userId: DEMO_USER_ID, productId: PRODUCT, amount: 2000 };
    const error = await capture(() =>
      withInjectedWriteFailure('investmentHolding', 'create', () =>
        banking.investment.subscribeInvestment(input),
      ),
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/injected failure/);

    expect(await checkingBalance()).toBe(CHECKING_START);
    expect(await holdingCount()).toBe(beforeHoldings);
    expect(await allLedgerCount()).toBe(ledgerRowsBefore);
  });
});
