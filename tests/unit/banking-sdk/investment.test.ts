/**
 * Unit: banking-sdk/investment — products, comparison, holdings, subscribe/redeem.
 *
 * Targets `@/banking-sdk` → banking.investment.listProducts/compareInvestments/listHoldings/
 * subscribeInvestment/redeemInvestment (+ types ProductView, InvestmentComparison, HoldingView,
 * InvestResult from '@/banking-sdk').
 *
 * Reads/writes InvestmentProduct & Holding rows and debits/credits accounts via Prisma →
 * requires test SQLite via ../helpers/db. Seed: 稳健理财A (minAmount 1000); checking balance 23580.
 */
import { describe, it } from 'vitest';

// import { banking } from '@/banking-sdk';                        // <- uncomment in Phase 2
// import type { ProductView, InvestmentComparison, HoldingView } from '@/banking-sdk';
// import { AppError } from '@/lib/errors';

describe('banking-sdk/investment · listProducts', () => {
  it.todo('returns all products; a riskLevel filter narrows the result');
  it.todo('each ProductView carries id / code / name / riskLevel / expectedRate / termDays / minAmount');
});

describe('banking-sdk/investment · compareInvestments', () => {
  it.todo('returns the products plus highestRateId (max expectedRate) and lowestRiskId (lowest risk level)');
  it.todo('an empty id set → empty products, undefined pick ids');
});

describe('banking-sdk/investment · subscribeInvestment', () => {
  it.todo("an amount below the product minAmount → throws AppError('VALIDATION')");
  it.todo('¥5000 into 稳健理财A (min 1000) succeeds and debits the account (newBalance 18580)');
  it.todo("an unknown productId → throws AppError('NOT_FOUND')");
  it.todo("insufficient funds → throws AppError('INSUFFICIENT_FUNDS')");
  it.todo('creates a HOLDING and returns InvestResult { success, holdingId, productId, amount, newBalance, occurredAt }');
});

describe('banking-sdk/investment · redeemInvestment', () => {
  it.todo('flips a holding HOLDING → REDEEMED and credits the funding account');
  it.todo("redeeming an unknown / already-redeemed holding → throws AppError('NOT_FOUND' | 'CONFLICT')");
});

describe('banking-sdk/investment · listHoldings', () => {
  it.todo("returns the user's active holdings (excludes REDEEMED ones)");
  it.todo('each HoldingView carries productName / riskLevel / amount / profit / boughtAt / status');
});
