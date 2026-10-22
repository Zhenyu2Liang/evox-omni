/**
 * Unit: banking-sdk/investment — products, comparison, holdings, subscribe/redeem.
 *
 * Targets `@/banking-sdk` → banking.investment.listProducts/compareInvestments/listHoldings/
 * subscribeInvestment/redeemInvestment (+ types ProductView, InvestmentComparison, HoldingView,
 * InvestResult from '@/banking-sdk').
 *
 * Reads/writes InvestmentProduct & Holding rows and debits/credits accounts via Prisma →
 * requires test SQLite via ../../helpers/db. Seed: 稳健理财A (minAmount 1000); checking balance 23580.
 */
import { describe, it, expect } from 'vitest';
import { banking } from '@/banking-sdk';
import type {
  HoldingView,
  InvestResult,
  InvestmentComparison,
  ProductView,
  RedeemInvestmentInput,
  SubscribeInvestmentInput,
} from '@/banking-sdk';
import { AppError, type ErrorCode } from '@/lib/errors';
import { compareDecimal } from '@/lib/decimal';
import { useFreshDatabase } from '../../helpers/db';
import { ACCOUNTS, DEMO_USER_ID, PRODUCTS } from '../../helpers/fixtures';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

/** Seeded 活期 funding account (fixture balance ¥23,580). */
const CHECKING_START = ACCOUNTS.find((a) => a.id === 'acct_checking')!.balance;

/** Seeded product ids (see `tests/helpers/fixtures.ts` / `prisma/seed.ts`). */
const WENJIANA = 'prod_wenjiana';
const WENJIB = 'prod_wenjib';
const JINRONG = 'prod_jinrong';
const HUOBI = 'prod_huobi';
const ALL_PRODUCT_IDS = [WENJIANA, WENJIB, JINRONG, HUOBI];

/** The single seeded active holding (稳健理财A, marketValue 5050). */
const SEEDED_HOLDING = 'holding_wenjiana';

/**
 * Assert `promise` rejects with an `AppError` carrying `code`, and return it for `detail` checks.
 * Observes the same promise via `.rejects` (instanceof gate) and `.catch` (read the error), so the
 * rejection is never left unhandled.
 */
async function expectAppErrorCode(promise: Promise<unknown>, code: ErrorCode): Promise<AppError> {
  await expect(promise).rejects.toBeInstanceOf(AppError);
  const error = (await promise.catch((e: unknown) => e)) as AppError;
  expect(error.code).toBe(code);
  return error;
}

describe('banking-sdk/investment · listProducts', () => {
  it('returns all products; a riskLevel filter narrows the result', async () => {
    const all = await banking.investment.listProducts();
    expect(all).toHaveLength(PRODUCTS.length);
    expect(all.map((p) => p.id).sort()).toEqual([...ALL_PRODUCT_IDS].sort());

    const r2 = await banking.investment.listProducts({ riskLevel: 'R2' });
    expect(r2).toHaveLength(2);
    expect(r2.map((p) => p.id).sort()).toEqual([WENJIANA, WENJIB].sort());
    expect(r2.every((p) => p.riskLevel === 'R2')).toBe(true);
  });

  it('each ProductView carries id / code / name / riskLevel / annualYieldRate / termDays / minAmount', async () => {
    const all = await banking.investment.listProducts();
    const view = all.find((p) => p.id === WENJIANA) as ProductView | undefined;
    expect(view).toBeDefined();
    expect(view).toMatchObject({
      id: 'prod_wenjiana',
      code: 'WJA001',
      name: '稳健理财A',
      riskLevel: 'R2',
      annualYieldRate: '0.0325',
      termDays: 90,
      minAmount: '1000.00',
    });

    // Every product exposes the full public shape with the right primitive types.
    for (const product of all) {
      expect(typeof product.id).toBe('string');
      expect(typeof product.code).toBe('string');
      expect(typeof product.name).toBe('string');
      expect(['R1', 'R2', 'R3', 'R4', 'R5']).toContain(product.riskLevel);
      expect(typeof product.annualYieldRate).toBe('string');
      expect(typeof product.termDays).toBe('number');
      expect(typeof product.minAmount).toBe('string');
    }
  });
});

describe('banking-sdk/investment · compareInvestments', () => {
  it('returns products plus highestRateId and lowestRiskId', async () => {
    const cmp: InvestmentComparison = await banking.investment.compareInvestments(ALL_PRODUCT_IDS);

    expect(cmp.products).toHaveLength(4);
    // 进取混合C has the top rate (5.1); 货币基金 is the safest (R1).
    expect(cmp.highestRateId).toBe(JINRONG);
    expect(cmp.lowestRiskId).toBe(HUOBI);

    const highest = cmp.products.find((p) => p.id === cmp.highestRateId);
    const maxRate = cmp.products.reduce((highest, product) => compareDecimal(product.annualYieldRate, highest) > 0 ? product.annualYieldRate : highest, '0');
    expect(highest?.annualYieldRate).toBe(maxRate);

    const lowest = cmp.products.find((p) => p.id === cmp.lowestRiskId);
    expect(lowest?.riskLevel).toBe('R1');
  });

  it('rejects an empty comparison instead of reporting successful missing products', async () => {
    await expect(banking.investment.compareInvestments([])).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects a missing requested product instead of silently comparing the remainder', async () => {
    await expect(banking.investment.compareInvestments([WENJIANA, 'missing-product'])).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('compares each requested product once', async () => {
    const result = await banking.investment.compareInvestments([WENJIANA, WENJIANA]);
    expect(result.products).toHaveLength(1);
  });
});

describe('banking-sdk/investment · subscribeInvestment', () => {
  it("an amount below the product minAmount → throws AppError('VALIDATION')", async () => {
    const input: SubscribeInvestmentInput = { userId: DEMO_USER_ID, productId: WENJIANA, amount: '500.00' };
    const error = await expectAppErrorCode(banking.investment.subscribeInvestment(input), 'VALIDATION');
    expect(error.detail).toMatchObject({ amount: '500.00', minAmount: '1000.00' });
  });

  it('¥5000 into 稳健理财A (min 1000) succeeds and debits the account (newBalance 18580)', async () => {
    expect(CHECKING_START).toBe('23580.00');

    const input: SubscribeInvestmentInput = { userId: DEMO_USER_ID, productId: WENJIANA, amount: '5000.00' };
    const result: InvestResult = await banking.investment.subscribeInvestment(input);

    expect(result.success).toBe(true);
    expect(result.productId).toBe(WENJIANA);
    expect(result.amount).toBe('5000.00');
    expect(result.newBalance).toBe('18580.00');
    expect(typeof result.holdingId).toBe('string');
    expect(result.holdingId.length).toBeGreaterThan(0);
    expect(Number.isFinite(result.occurredAt)).toBe(true);

    // The funding account was really debited in the DB.
    const balance = await banking.account.getBalance(DEMO_USER_ID);
    const checking = balance.accounts.find((a) => a.id === 'acct_checking');
    expect(checking?.balance).toBe('18580.00');
  });

  it("an unknown productId → throws AppError('NOT_FOUND')", async () => {
    const input: SubscribeInvestmentInput = {
      userId: DEMO_USER_ID,
      productId: 'prod_does_not_exist',
      amount: '5000.00',
    };
    const error = await expectAppErrorCode(banking.investment.subscribeInvestment(input), 'NOT_FOUND');
    expect(error.detail).toMatchObject({ productId: 'prod_does_not_exist' });
  });

  it("insufficient funds → throws AppError('INSUFFICIENT_FUNDS')", async () => {
    // 999999 clears the ¥10,000 minAmount of 进取混合C but far exceeds the ¥23,580 balance.
    const input: SubscribeInvestmentInput = { userId: DEMO_USER_ID, productId: JINRONG, amount: '999999.00' };
    const error = await expectAppErrorCode(banking.investment.subscribeInvestment(input), 'INSUFFICIENT_FUNDS');
    expect(error.detail).toMatchObject({ balance: '23580.00', amount: '999999.00' });
  });

  it('creates a HOLDING and returns InvestResult { success, holdingId, productId, amount, newBalance, occurredAt }', async () => {
    const input: SubscribeInvestmentInput = { userId: DEMO_USER_ID, productId: WENJIB, amount: '5000.00' };
    const result: InvestResult = await banking.investment.subscribeInvestment(input);

    expect(result.success).toBe(true);
    expect(result.holdingId).toEqual(expect.any(String));
    expect(result.productId).toBe(WENJIB);
    expect(result.amount).toBe('5000.00');
    expect(result.newBalance).toBe('18580.00');
    expect(Number.isFinite(result.occurredAt)).toBe(true);

    const holdings = await banking.investment.listHoldings(DEMO_USER_ID);
    const created = holdings.find((h) => h.id === result.holdingId);
    expect(created).toBeDefined();
    expect(created).toMatchObject({
      productId: WENJIB,
      productName: '稳健理财B',
      riskLevel: 'R2',
      amount: '5000.00',
      status: 'HOLDING',
    });
  });
});

describe('banking-sdk/investment · redeemInvestment', () => {
  it('flips a holding HOLDING → REDEEMED and credits the funding account', async () => {
    expect(CHECKING_START).toBe('23580.00');

    // 口径 is mandatory: redeem every held share instead of guessing a principal portion.
    const input: RedeemInvestmentInput = { userId: DEMO_USER_ID, holdingId: SEEDED_HOLDING, mode: 'ALL' };
    const result: InvestResult = await banking.investment.redeemInvestment(input);

    expect(result.success).toBe(true);
    expect(result.holdingId).toBe(SEEDED_HOLDING);
    expect(result.productId).toBe(WENJIANA);
    // Credited by the redeemed SHARES × net value (5050 × 1 = 5050), never by the principal (5000).
    expect(result.amount).toBe('5050.00');
    expect(result.redeemedShares).toBe('5050');
    expect(result.netValuePerUnit).toBe('1');
    expect(result.remainingShares).toBe('0');
    // Realized profit is the settled cash minus the cost those shares consumed — redeeming never
    // mints profit of its own (5050 − 5000 = 50, exactly the seeded unrealized gain).
    expect(result.realizedProfit).toBe('50.00');
    expect(result.redeemedPrincipal).toBe('5000.00');
    expect(result.newBalance).toBe('28630.00');
    expect(Number.isFinite(result.occurredAt)).toBe(true);

    // The holding is closed and no longer reported among the active holdings.
    const active = await banking.investment.listHoldings(DEMO_USER_ID);
    expect(active.map((h) => h.id)).not.toContain(SEEDED_HOLDING);

    const balance = await banking.account.getBalance(DEMO_USER_ID);
    const checking = balance.accounts.find((a) => a.id === 'acct_checking');
    expect(checking?.balance).toBe('28630.00');
  });

  it("redeeming an unknown / already-redeemed holding → throws AppError('NOT_FOUND' | 'CONFLICT')", async () => {
    const unknown: RedeemInvestmentInput = { userId: DEMO_USER_ID, holdingId: 'holding_does_not_exist', mode: 'ALL' };
    await expectAppErrorCode(banking.investment.redeemInvestment(unknown), 'NOT_FOUND');

    const seeded: RedeemInvestmentInput = { userId: DEMO_USER_ID, holdingId: SEEDED_HOLDING, mode: 'ALL' };
    await banking.investment.redeemInvestment(seeded); // first redeem succeeds
    const again = banking.investment.redeemInvestment(seeded); // second → CONFLICT
    const error = await expectAppErrorCode(again, 'CONFLICT');
    expect(error.detail).toMatchObject({ holdingId: SEEDED_HOLDING, status: 'REDEEMED' });
  });
});

describe('banking-sdk/investment · listHoldings', () => {
  it("returns the user's active holdings (excludes REDEEMED ones)", async () => {
    const initial = await banking.investment.listHoldings(DEMO_USER_ID);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.id).toBe(SEEDED_HOLDING);

    await banking.investment.redeemInvestment({ userId: DEMO_USER_ID, holdingId: SEEDED_HOLDING, mode: 'ALL' });

    const after = await banking.investment.listHoldings(DEMO_USER_ID);
    expect(after).toHaveLength(0);
    expect(after.map((h) => h.id)).not.toContain(SEEDED_HOLDING);
  });

  it('each HoldingView carries productName / riskLevel / amount / profit / boughtAt / status', async () => {
    const holdings = await banking.investment.listHoldings(DEMO_USER_ID);
    const view = holdings.find((h) => h.id === SEEDED_HOLDING) as HoldingView | undefined;
    expect(view).toBeDefined();
    expect(view).toMatchObject({
      id: SEEDED_HOLDING,
      productId: WENJIANA,
      productName: '稳健理财A',
      riskLevel: 'R2',
      amount: '5000.00',
      marketValue: '5050',
      profit: '50',
      status: 'HOLDING',
    });
    expect(typeof view?.boughtAt).toBe('number');
    expect(Number.isFinite(view?.boughtAt)).toBe(true);
  });
});
