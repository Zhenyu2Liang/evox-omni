/**
 * Unit: banking-sdk/investment — PARTIAL redemption of a portion of a holding.
 *
 * WHAT it pins down (all through the SDK barrel `@/banking-sdk` + the test SQLite):
 *   1. A `redeemAmount` STRICTLY SMALLER than the held principal redeems that PRINCIPAL portion: the
 *      holding STAYS `HOLDING` with a DECREMENTED principal, its unrounded market value is recomputed
 *      for the remainder, and ONE credit settles the portion's share of the market value HALF_UP to
 *      cents — `marketValue × redeemedPrincipal / totalPrincipal`.
 *   2. The partial outcome is persisted on `InvestmentHolding.redemptionHistory` (one JSON record per
 *      portion, carrying the quote + settled amount + remaining values + execution identity) while the
 *      account-flow `Transaction` row (`INVESTMENT_FLOW_CATEGORY`, CREDIT) mirrors the credit.
 *   3. REPLAY — a repeat with the SAME execution identity returns the persisted original outcome and
 *      credits NOTHING (even after a later FULL close).
 *   4. VALIDATION — an over-redeem (> held principal) or a non-positive/malformed portion is rejected
 *      with `AppError('VALIDATION')` BEFORE any write (no balance/holding/flow change).
 *
 * Fixtures: 活期 ¥23,580 (2358000 minor), the single holding `holding_wenjiana` (principal ¥5,000 =
 * 500000 minor, unrounded marketValue `5050`, status HOLDING), 稳健理财A.
 */
import { describe, expect, it } from 'vitest';
import { banking } from '@/banking-sdk';
import type { InvestResult, TransactionView } from '@/banking-sdk';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import { AppError } from '@/lib/errors';
import { getTestPrisma, useFreshDatabase } from '../../helpers/db';
import { DEMO_USER_ID } from '../../helpers/fixtures';

// Fresh seeded world before every case; disconnect Prisma on teardown.
useFreshDatabase();

/** The seeded HOLDING (principal ¥5,000, unrounded marketValue `5050`) — the redemption target. */
const SEEDED_HOLDING = 'holding_wenjiana';
/** The funding account every redemption credits (fixture balance ¥23,580). */
const CHECKING = 'acct_checking';
const CHECKING_START_MINOR = 2_358_000n; // ¥23,580.00

function db() {
  return getTestPrisma();
}

/** The seeded holding's current row (principal / market value / status / redemption history). */
function holdingRow() {
  return db().investmentHolding.findUnique({ where: { id: SEEDED_HOLDING } });
}

async function checkingBalanceMinor(): Promise<bigint> {
  const account = await db().account.findUnique({ where: { id: CHECKING } });
  if (!account) throw new Error(`${CHECKING} missing from fixtures`);
  return account.balanceMinor;
}

/** The investment-flow ledger rows (the account-flow CREDITs this spec settles), newest first. */
function flowRows(): Promise<TransactionView[]> {
  return banking.transaction.listTransactions(DEMO_USER_ID, { category: INVESTMENT_FLOW_CATEGORY });
}

/** One persisted partial-redemption record (`InvestmentHolding.redemptionHistory`, owned by the SDK). */
interface RedemptionRecord {
  at: number;
  redeemedPrincipal: string;
  valuation: string;
  settledAmount: string;
  remainingPrincipal: string;
  remainingMarketValue: string;
  newBalance: string;
  sourceAccountId: string;
  executionKey?: string;
}

function redemptionHistory(raw: string | null | undefined): RedemptionRecord[] {
  return raw === null || raw === undefined ? [] : (JSON.parse(raw) as RedemptionRecord[]);
}

/** Redeem a portion (or the whole holding when `redeemAmount` is omitted) of the seeded holding. */
function redeem(input: {
  redeemAmount?: string;
  idempotencyKey?: string;
  expectedRedemptionAmount?: string;
} = {}): Promise<InvestResult> {
  return banking.investment.redeemInvestment({
    userId: DEMO_USER_ID,
    holdingId: SEEDED_HOLDING,
    ...(input.redeemAmount !== undefined ? { redeemAmount: input.redeemAmount } : {}),
    ...(input.expectedRedemptionAmount !== undefined ? { expectedRedemptionAmount: input.expectedRedemptionAmount } : {}),
    ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
  });
}

/** Await `fn`, returning whatever it rejected with; fails loudly if it unexpectedly resolves. */
async function rejectionOf(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

describe('banking-sdk/investment · partial redemption (portion of principal)', () => {
  it('Case A · redeems a portion, keeps HOLDING and credits the settled share ONCE', async () => {
    // 2000 (principal) / 5000 of the ¥5,050 valuation = ¥2,020.00 settled.
    const result = await redeem({ redeemAmount: '2000.00', idempotencyKey: 'partial-1' });

    expect(result.partial).toBe(true);
    expect(result.amount).toBe('2020.00');
    expect(result.redemptionValuation).toBe('2020');
    expect(result.settlementRounding).toBe('HALF_UP');
    expect(result.redeemedPrincipal).toBe('2000.00');
    expect(result.remainingPrincipal).toBe('3000.00');
    expect(result.remainingMarketValue).toBe('3030');
    expect(result.remainingProfit).toBe('30');
    expect(result.newBalance).toBe('25600.00');

    // The holding SURVIVES with a smaller principal and a recomputed unrounded value.
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(300_000n);
    expect(row?.estimatedMarketValue).toBe('3030');

    // Exactly ONE credit: 2358000 + 202000 = 2560000 minor.
    expect(await checkingBalanceMinor()).toBe(2_560_000n);

    const flow = await flowRows();
    expect(flow).toHaveLength(1);
    expect(flow[0]).toMatchObject({
      amount: '2020.00',
      direction: 'CREDIT',
      category: INVESTMENT_FLOW_CATEGORY,
      merchant: '赎回',
      channel: 'APP',
    });

    // ONE persisted history record carrying the quote, the settlement and this portion's identity.
    const history = redemptionHistory(row?.redemptionHistory);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      redeemedPrincipal: '2000.00',
      valuation: '2020',
      settledAmount: '2020.00',
      remainingPrincipal: '3000.00',
      remainingMarketValue: '3030',
      newBalance: '25600.00',
      sourceAccountId: CHECKING,
      executionKey: 'partial-1',
    });
  });

  // Pins the DOCUMENTED at-most-once contract for a PARTIAL redemption: `investment.ts`'s module
  // header ("a repeat with the SAME identity returns that original outcome and credits nothing") and
  // `types.ts` `RedeemInvestmentInput.idempotencyKey` ("a repeat of a PARTIAL redemption replays the
  // stored partial outcome from redemptionHistory without crediting again"). The identity replay holds
  // while the holding is STILL `HOLDING`: the repeat returns the original outcome instead of
  // re-executing the portion and crediting a second time.
  it('Case B · replaying the SAME identity returns the original outcome and credits NOTHING', async () => {
    const first = await redeem({ redeemAmount: '2000.00', idempotencyKey: 'partial-1' });
    expect(first.newBalance).toBe('25600.00');
    expect(await checkingBalanceMinor()).toBe(2_560_000n);

    const replay = await redeem({ redeemAmount: '2000.00', idempotencyKey: 'partial-1' });

    // The SAME original outcome — no second credit, no second history record, no second flow row.
    expect(replay).toEqual(first);
    expect(await checkingBalanceMinor()).toBe(2_560_000n);
    const row = await holdingRow();
    expect(row?.principalAmountMinor).toBe(300_000n);
    expect(row?.estimatedMarketValue).toBe('3030');
    expect(redemptionHistory(row?.redemptionHistory)).toHaveLength(1);
    expect(await flowRows()).toHaveLength(1);
  });

  it('Case C · a distinct portion settles normally as a SECOND credit', async () => {
    const first = await redeem({ redeemAmount: '2000.00', idempotencyKey: 'k1' });
    expect(first.amount).toBe('2020.00');

    // 1000 (principal) / 3000 of the ¥3,030 remainder = ¥1,010.00 settled.
    const second = await redeem({ redeemAmount: '1000.00', idempotencyKey: 'k2' });
    expect(second.partial).toBe(true);
    expect(second.amount).toBe('1010.00');
    expect(second.redemptionValuation).toBe('1010');
    expect(second.redeemedPrincipal).toBe('1000.00');
    expect(second.remainingPrincipal).toBe('2000.00');
    expect(second.remainingMarketValue).toBe('2020');
    expect(second.remainingProfit).toBe('20');
    expect(second.newBalance).toBe('26610.00');

    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(200_000n);
    expect(row?.estimatedMarketValue).toBe('2020');
    // 2358000 + 202000 + 101000 = 2661000 minor.
    expect(await checkingBalanceMinor()).toBe(2_661_000n);

    const history = redemptionHistory(row?.redemptionHistory);
    expect(history).toHaveLength(2);
    expect(history.map((record) => record.executionKey)).toEqual(['k1', 'k2']);
    expect(history[1]).toMatchObject({
      redeemedPrincipal: '1000.00',
      settledAmount: '1010.00',
      remainingPrincipal: '2000.00',
      executionKey: 'k2',
    });

    // TWO credits, each settled proportionally.
    const flow = await flowRows();
    expect(flow).toHaveLength(2);
    expect(flow.map((row) => row.amount).sort()).toEqual(['1010.00', '2020.00']);
  });

  it('Case D · over-redeem is rejected before any write', async () => {
    const error = await rejectionOf(() => redeem({ redeemAmount: '6000.00' }));

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION');

    // NOTHING moved: balance, holding principal and the flow ledger are all untouched.
    expect(await checkingBalanceMinor()).toBe(CHECKING_START_MINOR);
    expect(await flowRows()).toHaveLength(0);
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(500_000n);
    expect(redemptionHistory(row?.redemptionHistory)).toHaveLength(0);
  });

  it('Case E · non-positive portions are rejected with no write', async () => {
    for (const bad of ['0.00', '-1.00']) {
      const error = await rejectionOf(() => redeem({ redeemAmount: bad, idempotencyKey: `bad-${bad}` }));
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('VALIDATION');
    }

    expect(await checkingBalanceMinor()).toBe(CHECKING_START_MINOR);
    expect(await flowRows()).toHaveLength(0);
    const row = await holdingRow();
    expect(row?.status).toBe('HOLDING');
    expect(row?.principalAmountMinor).toBe(500_000n);
    expect(redemptionHistory(row?.redemptionHistory)).toHaveLength(0);
  });

  it('Case F · a full close after a partial settles the remainder; the earlier partial still replays', async () => {
    const partial = await redeem({ redeemAmount: '2000.00', idempotencyKey: 'k1' });
    expect(partial.amount).toBe('2020.00');
    expect(await checkingBalanceMinor()).toBe(2_560_000n);

    // No `redeemAmount` → close the remaining principal; the whole remaining valuation settles.
    const close = await redeem();
    expect(close.partial).toBeUndefined();
    expect(close.amount).toBe('3030.00');
    expect(close.newBalance).toBe('28630.00');

    const closed = await holdingRow();
    expect(closed?.status).toBe('REDEEMED');
    // 2020 + 3030 = 5050 total credited: 2358000 + 505000 = 2863000 minor.
    expect(await checkingBalanceMinor()).toBe(2_863_000n);
    expect(await flowRows()).toHaveLength(2);

    // Replaying the EARLIER partial identity AFTER the full close still returns its original outcome…
    const replay = await redeem({ redeemAmount: '2000.00', idempotencyKey: 'k1' });
    expect(replay).toEqual(partial);

    // …and credits nothing more: the balance and the flow ledger are unchanged.
    expect(await checkingBalanceMinor()).toBe(2_863_000n);
    expect(await flowRows()).toHaveLength(2);
  });
});
