/**
 * banking-sdk · money-movement ATOMICITY regression.
 *
 * Runs under the MAIN Vitest config (`vitest.config.ts`, which includes `tests/**`), so it is part
 * of a plain `pnpm test` — NOT behind a private/scoped config.
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
import { moneyToCents } from '@/lib/money';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';
import { withInjectedWriteFailure } from '../../helpers/write-failure';

// Fresh seeded DB before each case + Prisma disconnect afterwards.
useFreshDatabase();
/** Funding account every transfer/subscribe/redeem touches (seed balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START = 2_358_000n;
/** The single seeded HOLDING (marketValue ¥5,050) — the redeem target. */
const SEEDED_HOLDING = 'holding_wenjiana';
const HOLDING_MARKET_VALUE = 505_000n;
/** 稳健理财A — minAmount ¥1,000. */
const PRODUCT = 'prod_wenjiana';

function db() {
  return getTestPrisma();
}

async function checkingBalance(): Promise<bigint> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (!account) throw new Error(`${CHECKING} missing from fixtures`);
  return account.balanceMinor;
}

async function setCheckingBalance(balance: string): Promise<void> {
  await db().account.update({ where: { id: CHECKING }, data: { balanceMinor: moneyToCents(balance) } });
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

/* ---------------------------------------------------------------------- tests */

describe('banking-sdk · atomicity: concurrent overspend', () => {
  it('two racing transfers against a balance funding only one — exactly one succeeds, the other is INSUFFICIENT_FUNDS, balance never negative', async () => {
    const start = '300.00';
    await setCheckingBalance(start);

    const results = await Promise.allSettled([
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'RACE_A' }),
      transfer({ userId: DEMO_USER_ID, contactId: 'contact_wangfang', amount: '200.00', remark: 'RACE_B' }),
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
    expect(balance).toBe(moneyToCents(start) - 20_000n);
    expect(balance).toBeGreaterThanOrEqual(0n);

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
        transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'ROLLBACK' }),
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
        () => transfer({ userId: DEMO_USER_ID, contactId: 'contact_zhangwei', amount: '200.00', remark: 'ROLLBACK_TYPED' }),
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

    const input: SubscribeInvestmentInput = { userId: DEMO_USER_ID, productId: PRODUCT, amount: '2000.00' };
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
