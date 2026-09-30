/**
 * Banking SDK — investment products & holdings.
 * `listProducts` / `compareInvestments` / `listHoldings` are GREEN reads.
 * `subscribeInvestment` / `redeemInvestment` execute only (debit/credit the funding account and
 * create/close a holding); tier policy (RED) is enforced by the Security Gateway, not here.
 *
 * `subscribeInvestment` enforces `minAmount` → throws `AppError('VALIDATION')` below it and
 * `AppError('INSUFFICIENT_FUNDS')` when the funding account cannot cover the amount.
 */
import type {
  HoldingView,
  InvestResult,
  InvestmentComparison,
  ProductQuery,
  ProductView,
  RedeemInvestmentInput,
  SubscribeInvestmentInput,
} from './types';

/** Investment products, optionally filtered by risk level. */
export async function listProducts(query: ProductQuery = {}): Promise<ProductView[]> {
  throw new Error('not implemented');
}

/** Compare the products with the given ids (returns them plus best-rate / lowest-risk picks). */
export async function compareInvestments(ids: string[]): Promise<InvestmentComparison> {
  throw new Error('not implemented');
}

/** Subscribe to a product: enforce `minAmount`, debit the funding account, create a holding. */
export async function subscribeInvestment(
  input: SubscribeInvestmentInput,
): Promise<InvestResult> {
  throw new Error('not implemented');
}

/** Redeem a holding: close it (status → REDEEMED) and credit the funding account. */
export async function redeemInvestment(input: RedeemInvestmentInput): Promise<InvestResult> {
  throw new Error('not implemented');
}

/** The user's active holdings. */
export async function listHoldings(userId: string): Promise<HoldingView[]> {
  throw new Error('not implemented');
}
