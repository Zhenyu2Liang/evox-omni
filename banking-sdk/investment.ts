/**
 * Banking SDK — investment products & holdings, booked as 「净值 + 份额」
 * (see `docs/cn/investments.md`).
 *
 * `listProducts` / `compareInvestments` / `listHoldings` are GREEN reads.
 * `subscribeInvestment` / `redeemInvestment` execute only (debit/credit the funding account and
 * create/extend/reduce a holding); tier policy (RED) is enforced by the Security Gateway, not here.
 *
 * A position is SHARES × NET VALUE PER UNIT, never a principal amount. `subscribeInvestment` converts
 * the paid AMOUNT into shares at the product's published net value (`FLOOR(amount ÷ net value, 6 位
 * 小数)`, so a buy never mints shares it did not pay for), grows the position's remaining COST by the
 * amount and rewrites the unrounded market value snapshot. A product that publishes no net value
 * cannot be purchased — nothing is ever priced at an assumed `1.0`. When a `HOLDING` already exists
 * for (user, product) the purchase AGGREGATES into it (cost and shares grow together) instead of
 * opening a second holding.
 *
 * `redeemInvestment` requires an explicit口径 — `SHARES`, `AMOUNT` or `ALL`. A missing/unknown口径,
 * or the retired principal-based `redeemAmount` field, is rejected BEFORE any mutable state is read:
 * guessing a口径 is exactly what the contract forbids. Redemption settles
 * `HALF_UP(shares × net value)` exactly ONCE, consumes proportional cost
 * `HALF_UP(cost × shares ÷ total shares)`, books `settled − consumed cost` as realized profit and
 * closes the holding when no share remains; a partial redemption keeps the holding with fewer shares
 * and less cost. The approved confirmation snapshot (shares / net value / net value date / expected
 * settlement) is compared INSIDE the write transaction against the freshly re-read holding and
 * product — any change rejects the old authorization rather than settling at a silently repriced net
 * value.
 *
 * Both writes run in a SINGLE interactive transaction (`runInTransaction`): the balance change, the
 * holding change and the account-flow `Transaction` row commit together or not at all, so no partial
 * debit/credit can survive. A redemption is guarded by the OLD share count + `HOLDING` status, so two
 * concurrent redemptions cannot both succeed (no oversell, no overpay); a lost race re-reads and
 * replays ONLY the same execution identity, otherwise `CONFLICT`.
 *
 * Optional at-most-once semantics (`input.idempotencyKey`, supplied by the planner as
 * `nodeExecutionKey(taskId, nodeId)`): a replayed plan node re-runs the tool, so a repeat with the
 * SAME key must not debit/credit twice. `subscribeInvestment` stores a CREATING purchase's key on the
 * `InvestmentHolding` (unique column) and an AGGREGATING purchase's key in the appended
 * `purchaseHistory` record, and replays either original outcome. `redeemInvestment` persists the
 * redemption's EXECUTION IDENTITY and ORIGINAL result payload on the holding inside the SAME
 * transaction — a full close as `redeemExecutionKey`/`redeemResult`, a PARTIAL redemption as a
 * `redemptionHistory` record — and a repeat with the SAME identity replays that original outcome
 * (original shares, original net value, original settled amount). An OLD-format record without shares
 * replays its stored amount as-is: the original result is historical fact and no share count is
 * fabricated for it.
 *
 * Note: subscribing/redeeming moves the funding-account BALANCE and writes an investment-flow
 * `Transaction` row (category `INVESTMENT_FLOW_CATEGORY`) in the SAME transaction, so investment
 * principal is kept out of booked consumption analysis and is never mislabeled
 * as 大额消费.
 */
import type { InvestmentHolding, InvestmentProduct } from '@/lib/db/prisma';
import { demoNow } from '../lib/clock';
import { accounts, investments } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import {
  assertMinorUnits,
  centsToMoney,
  moneyToCents,
  normalizeMoney,
  type MoneyAmount,
  type MoneyInput,
} from '../lib/money';
import {
  addDecimal,
  compareDecimal,
  nonNegativeDecimal,
  subtractDecimal,
  valuationToMinor,
  type DecimalAmount,
} from '../lib/decimal';
import { INVESTMENT_FLOW_CATEGORY } from './categories';
import { createIdempotent, normalizeIdempotencyKey } from './idempotent';
import {
  REDEMPTION_FEE_RULE,
  SHARE_DECIMALS,
  floorToShares,
  marketValueFromShares,
  profitRateOf,
  redeemedCostMinor,
  remainingSharesOf,
  settlementFromShares,
  sharesFromAmount,
} from './net-value';
import { runInTransaction, type Tx } from './tx';
import type {
  DecimalInput,
  HoldingPurchase,
  HoldingRedemption,
  HoldingStatus,
  HoldingView,
  InvestResult,
  InvestmentComparison,
  InvestmentRiskLevel,
  ProductQuery,
  ProductView,
  RedeemInvestmentInput,
  RedeemMode,
  SubscribeInvestmentInput,
} from './types';

/**
 * Re-export the exact, bounded proportional valuation so the Security Gateway mints the SAME
 * `expectedRedemptionAmount` the SDK settles (rule in `./valuation`).
 */
export { redemptionPortionValuation, remainingPortionMarketValue, settledRedemptionAmount } from './valuation';

/** Risk ordering `R1 < R2 < R3 < R4 < R5` (lower = safer). */
const RISK_RANK: Record<InvestmentRiskLevel, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

/** A holding row with its product, as the repository returns it (never leaked outside the SDK). */
type HoldingRow = InvestmentHolding & { product: InvestmentProduct };

/* ------------------------------------------------------- net value & shares */

/**
 * The product's published net value, parsed defensively: `null`, non-canonical text or a
 * non-positive value counts as "no net value published", so a corrupt column can never price a
 * purchase or a redemption at an invented value.
 */
function productNetValue(product: InvestmentProduct): DecimalAmount | undefined {
  const raw = product.latestNetValuePerUnit;
  if (raw === null) return undefined;
  try {
    const netValue = nonNegativeDecimal(raw);
    if (netValue !== raw || compareDecimal(netValue, '0') <= 0) return undefined;
    return netValue;
  } catch {
    return undefined;
  }
}

/** The business date (epoch ms) of the published net value; absent when none is published. */
function productNetValueDate(product: InvestmentProduct): number | undefined {
  return productNetValue(product) === undefined ? undefined : product.latestNetValueDate?.getTime();
}

/**
 * The holding's recorded shares, or `undefined` when the column is empty, corrupt or non-positive.
 * A legacy holding whose shares were never derived is NOT guessed: the contract derives them in the
 * maintenance script (`scripts/investment-share-backfill.mjs`), never in a read or a write here.
 */
function recordedShares(raw: string | null): DecimalAmount | undefined {
  if (raw === null) return undefined;
  try {
    const shares = nonNegativeDecimal(raw);
    if (shares !== raw || compareDecimal(shares, '0') <= 0) return undefined;
    return shares;
  } catch {
    return undefined;
  }
}

/** How a holding's market value was derived — mirrors `HoldingView.valueBasis`. */
export type HoldingValueBasis = NonNullable<HoldingView['valueBasis']>;

/** A holding's derived valuation — the ONE rule shared by `listHoldings` and the dashboard. */
export interface HoldingValuation {
  /** Held shares; absent when the holding records none (历史数据不足). */
  shares?: DecimalAmount;
  /** Net value per unit used for the valuation; absent with no published net value. */
  netValuePerUnit?: DecimalAmount;
  /** Business date (epoch ms) of `netValuePerUnit`. */
  netValueDate?: number;
  /** Unrounded `shares × net value`, or the remaining cost when the position cannot be valued. */
  marketValue: DecimalAmount;
  /** Unrealized profit `marketValue − remaining cost`; absent when the position cannot be valued. */
  profit?: DecimalAmount;
  /** `profit ÷ remaining cost`; absent at zero cost or when the position cannot be valued. */
  profitRate?: DecimalAmount;
  valueBasis: HoldingValueBasis;
}

/**
 * Derive a holding's market value from its SHARES and the product's published net value — never from
 * the stored `estimatedMarketValue` snapshot, which can be stale. A holding whose shares were never
 * recorded, or whose product publishes no net value, reports its remaining COST and no profit
 * (历史数据不足) instead of inventing data.
 */
export function holdingValuation(row: HoldingRow): HoldingValuation {
  const cost = centsToMoney(row.principalAmountMinor);
  const shares = recordedShares(row.shares);
  const netValue = productNetValue(row.product);
  if (shares === undefined || netValue === undefined) {
    return { marketValue: cost, valueBasis: 'HISTORICAL_DATA_INSUFFICIENT' };
  }
  const marketValue = marketValueFromShares(shares, netValue);
  const profit = subtractDecimal(marketValue, cost);
  const netValueDate = row.product.latestNetValueDate?.getTime();
  return {
    shares,
    netValuePerUnit: netValue,
    ...(netValueDate !== undefined ? { netValueDate } : {}),
    marketValue,
    profit,
    profitRate: profitRateOf(profit, cost),
    valueBasis: 'NET_VALUE',
  };
}

/**
 * The holding's derived market value (CNY, unrounded) — exported so the dashboard sums exactly what
 * the holdings list shows instead of repeating the derivation rule.
 */
export function holdingMarketValue(row: HoldingRow): DecimalAmount {
  return holdingValuation(row).marketValue;
}

/** Maps an `InvestmentProduct` row to its public view model. */
function toProductView(row: InvestmentProduct): ProductView {
  const netValue = productNetValue(row);
  const netValueDate = productNetValueDate(row);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    riskLevel: row.riskLevel as InvestmentRiskLevel,
    annualYieldRate: nonNegativeDecimal(row.annualYieldRate),
    termDays: row.termDays,
    minAmount: centsToMoney(row.minAmountMinor),
    description: row.description ?? undefined,
    ...(netValue !== undefined ? { latestNetValuePerUnit: netValue } : {}),
    ...(netValueDate !== undefined ? { latestNetValueDate: netValueDate } : {}),
  };
}

/** Investment products, optionally filtered by risk level. */
export async function listProducts(query: ProductQuery = {}): Promise<ProductView[]> {
  if (query.riskLevel !== undefined && (typeof query.riskLevel !== 'string' || !Object.hasOwn(RISK_RANK, query.riskLevel))) {
    throw new AppError('VALIDATION', 'Investment risk level must be R1 through R5.');
  }
  const rows = query.riskLevel
    ? await investments.listProductsByRisk(query.riskLevel)
    : await investments.listProducts();
  return rows.map(toProductView);
}

/** Compare the products with the given ids (returns them plus best-rate / lowest-risk picks). */
export async function compareInvestments(ids: string[]): Promise<InvestmentComparison> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !id.trim())) {
    throw new AppError('VALIDATION', 'Investment comparison requires non-empty product IDs.');
  }
  const uniqueIds = [...new Set(ids)];
  const rows = await Promise.all(uniqueIds.map(async id => {
    const product = await investments.getProduct(id);
    if (!product) throw new AppError('NOT_FOUND', 'Investment product does not exist.', { productId: id });
    return product;
  }));
  const products = rows.map(toProductView);

  let highest: ProductView | undefined;
  let lowest: ProductView | undefined;
  for (const product of products) {
    if (highest === undefined || compareDecimal(product.annualYieldRate, highest.annualYieldRate) > 0) highest = product;
    if (lowest === undefined || RISK_RANK[product.riskLevel] < RISK_RANK[lowest.riskLevel]) {
      lowest = product;
    }
  }

  return {
    products,
    highestRateId: highest?.id,
    lowestRiskId: lowest?.id,
  };
}

/* ------------------------------------------------------------ history records */

/**
 * One purchase recorded on a holding (`InvestmentHolding.purchaseHistory`, a JSON array). The FIRST
 * record is the CREATING purchase (its outcome is also persisted in `subscribeResult`); later records
 * are aggregations into the existing HOLDING. `marketValue` is the holding's unrounded estimated
 * market value AFTER this purchase; `newBalance` is the funding-account balance after its debit.
 * The share / net-value fields are absent on records written before the 「净值 + 份额」 model.
 */
interface PurchaseRecord {
  at: number;
  amount: MoneyAmount;
  totalPrincipal: MoneyAmount;
  marketValue: DecimalAmount;
  /** Shares bought by this purchase (`FLOOR(amount ÷ net value, 6 位小数)`). */
  shares?: DecimalAmount;
  /** Net value per unit this purchase was priced at. */
  netValuePerUnit?: DecimalAmount;
  /** Business date (epoch ms) of `netValuePerUnit`. */
  netValueDate?: number;
  /** Held shares after this purchase. */
  totalShares?: DecimalAmount;
  newBalance: MoneyAmount;
  sourceAccountId: string;
  executionKey?: string;
}

/**
 * One PARTIAL redemption recorded on a holding (`InvestmentHolding.redemptionHistory`, a JSON array);
 * a full close is persisted as `redeemExecutionKey`/`redeemResult` instead. `settledAmount` is the
 * CNY credited (HALF_UP of `shares × netValue`, once), `cost` the proportional cost consumed.
 */
interface RedemptionRecord extends HoldingRedemption {
  /** Shares left in the holding after this redemption. */
  remainingShares: DecimalAmount;
  /** Remaining position cost after this redemption (CNY). */
  remainingCost: MoneyAmount;
  /** Remaining unrounded market value after this redemption (CNY). */
  remainingMarketValue: DecimalAmount;
  /** Funding-account balance after this redemption's credit (CNY). */
  newBalance: MoneyAmount;
  sourceAccountId: string;
  executionKey?: string;
}

/** A persisted redemption record — the current shape or a legacy principal-portion one. */
type RawRedemptionRecord = Record<string, unknown>;

/** Parse a nullable JSON-array TEXT column defensively; `null`, blank or corrupt → `[]`. */
function parseHistory<T>(raw: string | null): T[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** A history record that is not a complete, canonical outcome (never replayed as a success). */
function invalidRecord(): never {
  throw new Error('Invalid investment history record.');
}

/** Epoch ms of a history record. */
function requireTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) {
    return invalidRecord();
  }
  return value;
}

/** Canonical CNY text (any sign) of a history record. */
function requireMoney(value: unknown): MoneyAmount {
  if (typeof value !== 'string' || normalizeMoney(value) !== value) return invalidRecord();
  return value;
}

/** Canonical non-negative CNY text of a history record. */
function requireNonNegativeMoney(value: unknown): MoneyAmount {
  const amount = requireMoney(value);
  if (moneyToCents(amount) < 0n) return invalidRecord();
  return amount;
}

/** Canonical positive CNY text of a history record. */
function requirePositiveMoney(value: unknown): MoneyAmount {
  const amount = requireMoney(value);
  if (moneyToCents(amount) <= 0n) return invalidRecord();
  return amount;
}

/** Canonical non-negative decimal text (shares, net values, unrounded market values). */
function requireDecimal(value: unknown): DecimalAmount {
  if (typeof value !== 'string') return invalidRecord();
  try {
    if (nonNegativeDecimal(value) !== value) return invalidRecord();
  } catch {
    return invalidRecord();
  }
  return value;
}

/** Canonical POSITIVE decimal text (a share count or a net value). */
function requirePositiveDecimal(value: unknown): DecimalAmount {
  const text = requireDecimal(value);
  if (compareDecimal(text, '0') <= 0) return invalidRecord();
  return text;
}

/** A non-empty text field of a history record. */
function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return invalidRecord();
  return value;
}

/** An optional canonical decimal field: absent stays absent, present must be canonical. */
function optionalPositiveDecimal(value: unknown): DecimalAmount | undefined {
  return value === undefined ? undefined : requirePositiveDecimal(value);
}

/** An optional canonical non-negative money field: absent stays absent, present must be canonical. */
function optionalNonNegativeMoney(value: unknown): MoneyAmount | undefined {
  return value === undefined ? undefined : requireNonNegativeMoney(value);
}

/** An optional canonical decimal money field: absent stays absent, present must be canonical. */
function optionalDecimal(value: unknown): DecimalAmount | undefined {
  return value === undefined ? undefined : requireDecimal(value);
}

/**
 * Replay only a complete original purchase outcome matching the purchase record that produced it.
 * A holding's `purchaseHistory[0]` is its CREATING purchase; later aggregations append after it, so
 * the original result is validated against that record — never against the holding's current
 * (possibly grown) shares or cost.
 */
function parseSubscribeResult(holding: InvestmentHolding): InvestResult {
  try {
    const creating = parseHistory<PurchaseRecord>(holding.purchaseHistory)[0];
    if (holding.subscribeResult === null || creating === undefined) throw new Error('Missing original purchase result.');
    const result: unknown = JSON.parse(holding.subscribeResult);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Invalid purchase result.');
    const stored = result as Record<string, unknown>;
    if (stored.success !== true || stored.holdingId !== holding.id || stored.productId !== holding.productId ||
        stored.amount !== creating.amount || typeof stored.newBalance !== 'string' ||
        normalizeMoney(stored.newBalance) !== stored.newBalance || moneyToCents(stored.newBalance) < 0n ||
        typeof stored.sourceAccountId !== 'string' || stored.sourceAccountId.length === 0 ||
        stored.occurredAt !== creating.at) {
      throw new Error('Purchase result does not match the committed purchase record.');
    }
    return stored as unknown as InvestResult;
  } catch {
    throw new AppError('CONFLICT', 'The investment purchase has no valid original execution result.', { holdingId: holding.id });
  }
}

/**
 * Rebuild the stored outcome of an AGGREGATING purchase from its `purchaseHistory` record: a repeat
 * with the SAME execution identity must return this exact outcome and must not debit or aggregate
 * again. A record that is not a complete, canonical purchase outcome is a data-integrity failure →
 * `CONFLICT`.
 */
function purchaseResultFromRecord(holding: InvestmentHolding, record: PurchaseRecord): InvestResult {
  try {
    if (typeof record !== 'object' || record === null ||
        typeof record.at !== 'number' || !Number.isSafeInteger(record.at) || !Number.isFinite(new Date(record.at).getTime()) ||
        typeof record.amount !== 'string' || normalizeMoney(record.amount) !== record.amount || moneyToCents(record.amount) <= 0n ||
        typeof record.newBalance !== 'string' || normalizeMoney(record.newBalance) !== record.newBalance || moneyToCents(record.newBalance) < 0n ||
        typeof record.sourceAccountId !== 'string' || record.sourceAccountId.length === 0) {
      throw new Error('Purchase record does not describe a complete outcome.');
    }
    const shares = optionalPositiveDecimal(record.shares);
    const totalShares = optionalPositiveDecimal(record.totalShares);
    return {
      success: true,
      holdingId: holding.id,
      productId: holding.productId,
      amount: record.amount,
      newBalance: record.newBalance,
      sourceAccountId: record.sourceAccountId,
      occurredAt: record.at,
      addedToExisting: true,
      lastPurchaseAt: record.at,
      ...(shares !== undefined ? { subscribedShares: shares } : {}),
      ...(totalShares !== undefined ? { totalShares } : {}),
    };
  } catch {
    throw new AppError('CONFLICT', 'The investment purchase has no valid original execution result.', { holdingId: holding.id });
  }
}

/**
 * The holding's recorded purchases as public views (oldest → newest), or `undefined` when no valid
 * history is recorded. History is presentation-only: an absent, empty or corrupt column yields
 * `undefined` rather than a fabricated purchase.
 */
function purchaseViews(raw: string | null): HoldingPurchase[] | undefined {
  const records = parseHistory<PurchaseRecord>(raw);
  if (records.length === 0) return undefined;
  try {
    return records.map((record): HoldingPurchase => {
      if (typeof record !== 'object' || record === null) return invalidRecord();
      const shares = optionalPositiveDecimal(record.shares);
      const netValuePerUnit = optionalPositiveDecimal(record.netValuePerUnit);
      const totalShares = optionalPositiveDecimal(record.totalShares);
      const netValueDate = record.netValueDate === undefined ? undefined : requireTimestamp(record.netValueDate);
      return {
        amount: requirePositiveMoney(record.amount),
        at: requireTimestamp(record.at),
        totalPrincipal: requireMoney(record.totalPrincipal),
        marketValue: requireDecimal(record.marketValue),
        ...(shares !== undefined ? { shares } : {}),
        ...(netValuePerUnit !== undefined ? { netValuePerUnit } : {}),
        ...(netValueDate !== undefined ? { netValueDate } : {}),
        ...(totalShares !== undefined ? { totalShares } : {}),
        newBalance: requireMoney(record.newBalance),
        sourceAccountId: requireText(record.sourceAccountId),
        executionKey: typeof record.executionKey === 'string' ? record.executionKey : undefined,
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * The holding's recorded partial redemptions as public views (oldest → newest), or `undefined` when
 * no valid history is recorded. A record from before the 「净值 + 份额」 model carries no share count,
 * so the whole history is reported as absent rather than fabricated.
 */
function redemptionViews(raw: string | null): HoldingRedemption[] | undefined {
  const records = parseHistory<RawRedemptionRecord>(raw);
  if (records.length === 0) return undefined;
  try {
    return records.map((record): HoldingRedemption => {
      if (typeof record !== 'object' || record === null) return invalidRecord();
      const mode = record.mode;
      if (mode !== 'SHARES' && mode !== 'AMOUNT' && mode !== 'ALL') return invalidRecord();
      const netValueDate = record.netValueDate === undefined ? undefined : requireTimestamp(record.netValueDate);
      return {
        at: requireTimestamp(record.at),
        mode,
        shares: requirePositiveDecimal(record.shares),
        netValuePerUnit: requirePositiveDecimal(record.netValuePerUnit),
        ...(netValueDate !== undefined ? { netValueDate } : {}),
        settledAmount: requireNonNegativeMoney(record.settledAmount),
        feeAmount: requireNonNegativeMoney(record.feeAmount),
        feeRule: requireText(record.feeRule),
        cost: requireNonNegativeMoney(record.cost),
        realizedProfit: requireMoney(record.realizedProfit),
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * Parse a holding's persisted ORIGINAL redemption payload (a full close). A corrupt/unparsable
 * payload is a data-integrity failure of an already-closed redemption: surface it as `CONFLICT`
 * rather than letting a raw exception escape the SDK (never a fabricated success, never swallowed).
 */
function parseRedeemResult(holding: InvestmentHolding, expectedSettlementAmount?: MoneyInput): InvestResult {
  try {
    if (holding.status !== 'REDEEMED' || holding.redeemResult === null) throw new Error('Missing original redemption result.');
    const result: unknown = JSON.parse(holding.redeemResult);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Invalid redemption result.');
    const stored = result as Record<string, unknown>;
    if (stored.success !== true || stored.holdingId !== holding.id || stored.productId !== holding.productId ||
        typeof stored.amount !== 'string' || normalizeMoney(stored.amount) !== stored.amount || moneyToCents(stored.amount) < 0n ||
        typeof stored.newBalance !== 'string' || normalizeMoney(stored.newBalance) !== stored.newBalance || moneyToCents(stored.newBalance) < 0n ||
        typeof stored.sourceAccountId !== 'string' || stored.sourceAccountId.length === 0 ||
        typeof stored.occurredAt !== 'number' || !Number.isSafeInteger(stored.occurredAt) || !Number.isFinite(new Date(stored.occurredAt).getTime()) ||
        typeof stored.redemptionValuation !== 'string' || nonNegativeDecimal(stored.redemptionValuation) !== stored.redemptionValuation ||
        stored.settlementRounding !== 'HALF_UP' || valuationToMinor(stored.redemptionValuation) !== moneyToCents(stored.amount) ||
        expectedSettlementAmount !== undefined && moneyToCents(expectedSettlementAmount) !== moneyToCents(stored.amount)) {
      throw new Error('Redemption result does not match the committed holding or settlement.');
    }
    return stored as unknown as InvestResult;
  } catch {
    throw new AppError('CONFLICT', 'The investment redemption has no valid matching original execution result.', { holdingId: holding.id });
  }
}

/**
 * Rebuild the stored outcome of a PARTIAL redemption from its `redemptionHistory` record: a repeat
 * with the SAME execution identity — even after the holding was later fully closed — must return this
 * exact outcome and must not credit again. Both the current 「净值 + 份额」 shape and the legacy
 * principal-portion shape are replayable; the legacy one replays its stored amount AS-IS and never
 * fabricates the shares it never recorded. Anything incomplete → `CONFLICT`.
 */
function redemptionResultFromRecord(
  holding: InvestmentHolding,
  record: RawRedemptionRecord,
  expectedSettlementAmount?: MoneyInput,
): InvestResult {
  try {
    if (typeof record !== 'object' || record === null) return invalidRecord();
    const occurredAt = requireTimestamp(record.at);
    const settledAmount = requireNonNegativeMoney(record.settledAmount);
    const newBalance = requireNonNegativeMoney(record.newBalance);
    const sourceAccountId = requireText(record.sourceAccountId);
    if (expectedSettlementAmount !== undefined && moneyToCents(expectedSettlementAmount) !== moneyToCents(settledAmount)) {
      return invalidRecord();
    }
    const replayed: InvestResult = {
      success: true,
      holdingId: holding.id,
      productId: holding.productId,
      amount: settledAmount,
      newBalance,
      sourceAccountId,
      occurredAt,
    };

    if (record.shares !== undefined) {
      // Current shape: the ORIGINAL shares, net value and settled amount are the historical fact.
      const shares = requirePositiveDecimal(record.shares);
      const netValuePerUnit = requirePositiveDecimal(record.netValuePerUnit);
      const mode = record.mode;
      if (mode !== 'SHARES' && mode !== 'AMOUNT' && mode !== 'ALL') return invalidRecord();
      const redemptionValuation = marketValueFromShares(shares, netValuePerUnit);
      if (valuationToMinor(redemptionValuation) !== moneyToCents(settledAmount)) return invalidRecord();
      const netValueDate = record.netValueDate === undefined ? undefined : requireTimestamp(record.netValueDate);
      const remainingShares = optionalPositiveDecimal(record.remainingShares);
      const remainingCost = optionalNonNegativeMoney(record.remainingCost);
      const remainingMarketValue = optionalDecimal(record.remainingMarketValue);
      return {
        ...replayed,
        redemptionValuation,
        settlementRounding: 'HALF_UP',
        partial: true,
        mode,
        redeemedShares: shares,
        ...(remainingShares !== undefined ? { remainingShares } : {}),
        netValuePerUnit,
        ...(netValueDate !== undefined ? { netValueDate } : {}),
        feeAmount: requireNonNegativeMoney(record.feeAmount),
        feeRule: requireText(record.feeRule),
        realizedProfit: requireMoney(record.realizedProfit),
        ...(remainingCost !== undefined ? { remainingCost, remainingPrincipal: remainingCost } : {}),
        redeemedPrincipal: requireNonNegativeMoney(record.cost),
        ...(remainingMarketValue !== undefined ? { remainingMarketValue } : {}),
        ...(remainingMarketValue !== undefined && remainingCost !== undefined
          ? { remainingProfit: subtractDecimal(remainingMarketValue, remainingCost) }
          : {}),
      };
    }

    // Legacy principal-portion shape: replay the stored amount as-is, no share count invented.
    const valuation = requireDecimal(record.valuation);
    if (valuationToMinor(valuation) !== moneyToCents(settledAmount)) return invalidRecord();
    const remainingPrincipal = requireNonNegativeMoney(record.remainingPrincipal);
    const remainingMarketValue = requireDecimal(record.remainingMarketValue);
    return {
      ...replayed,
      redemptionValuation: valuation,
      settlementRounding: 'HALF_UP',
      partial: true,
      redeemedPrincipal: requirePositiveMoney(record.redeemedPrincipal),
      remainingPrincipal,
      remainingMarketValue,
      remainingProfit: subtractDecimal(remainingMarketValue, remainingPrincipal),
    };
  } catch {
    throw new AppError('CONFLICT', 'The investment redemption has no valid matching original execution result.', { holdingId: holding.id });
  }
}

/* ---------------------------------------------------------------- subscribe */

/**
 * Subscribe to a product: enforce `minAmount`, price the paid AMOUNT into shares at the product's
 * published net value, atomically debit the funding account and CREATE a holding — or, when a
 * `HOLDING` already exists for (user, product), AGGREGATE cost and shares into it — in one
 * transaction. The conditional decrement makes an overdraft impossible: when the account cannot cover
 * the amount the call throws `INSUFFICIENT_FUNDS` and nothing is written.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeat with the SAME
 * key replays the full original result persisted in the purchase transaction and never debits or
 * aggregates a second time or reconstructs a balance from current account state.
 */
export async function subscribeInvestment(input: SubscribeInvestmentInput): Promise<InvestResult> {
  if (typeof input.userId !== 'string' || !input.userId.trim()) {
    throw new AppError('SECURITY_DENIED', 'Investment purchase requires a trusted owner identity.');
  }
  const amountMinor = moneyToCents(input.amount);
  if (amountMinor <= 0n) throw new AppError('VALIDATION', 'Purchase amount must be positive.');

  const now = demoNow();

  /** Debit the funding account and create-or-aggregate the holding inside the caller's transaction. */
  const debitAndCreate = async (tx: Tx, replayKey: string | undefined): Promise<InvestResult> => {
    // Mutable eligibility applies only to a new purchase, after committed-result replay.
    const product = await investments.getProduct(input.productId);
    if (product === null) throw new AppError('NOT_FOUND', 'Investment product does not exist.', { productId: input.productId });
    if (amountMinor < product.minAmountMinor) {
      throw new AppError('VALIDATION', `Purchase amount is below the minimum ${centsToMoney(product.minAmountMinor)}.`, {
        amount: centsToMoney(amountMinor), minAmount: centsToMoney(product.minAmountMinor),
      });
    }
    // A purchase is priced at the product's published net value; there is no assumed `1.0`.
    const netValue = productNetValue(product);
    if (netValue === undefined) {
      throw new AppError('VALIDATION', '该产品未发布净值，暂不可申购', { productId: input.productId });
    }
    const netValueDate = productNetValueDate(product);
    // Shares are FLOOR-ed BEFORE the debit: an amount that buys no share is rejected, never charged.
    const purchasedShares = sharesFromAmount(centsToMoney(amountMinor), netValue);

    const account = await accounts.getCheckingAccount(input.userId);
    if (account === null) throw new AppError('NOT_FOUND', 'Checking account does not exist.', { userId: input.userId });
    // Atomic sufficient-funds check + debit (rolls back with nothing written when short).
    const debited = await tx.account.updateMany({
      where: { id: account.id, userId: input.userId, balanceMinor: { gte: amountMinor } },
      data: { balanceMinor: { decrement: amountMinor } },
    });
    if (debited.count === 0) {
      const current = await tx.account.findUnique({ where: { id: account.id } });
      throw new AppError('INSUFFICIENT_FUNDS', '账户余额不足，无法完成认购', {
        balance: centsToMoney(current?.balanceMinor ?? 0n),
        amount: centsToMoney(amountMinor),
      });
    }
    const updated = await tx.account.findUnique({ where: { id: account.id } });
    if (!updated) {
      throw new AppError('NOT_FOUND', `未找到用户的活期账户：${input.userId}`, {
        userId: input.userId,
      });
    }
    const balanceAfter = centsToMoney(updated.balanceMinor);

    // Buy-more: an existing HOLDING for (user, product) AGGREGATES instead of opening a second row.
    const existing = await tx.investmentHolding.findFirst({
      where: { userId: input.userId, productId: input.productId, status: 'HOLDING' },
      orderBy: { boughtAt: 'asc' },
    });

    if (existing === null) {
      const purchasedMarketValue = marketValueFromShares(purchasedShares, netValue);
      const record: PurchaseRecord = {
        at: now,
        amount: centsToMoney(amountMinor),
        totalPrincipal: centsToMoney(amountMinor),
        marketValue: purchasedMarketValue,
        shares: purchasedShares,
        netValuePerUnit: netValue,
        ...(netValueDate !== undefined ? { netValueDate } : {}),
        totalShares: purchasedShares,
        newBalance: balanceAfter,
        sourceAccountId: account.id,
        executionKey: replayKey,
      };
      const holding = await tx.investmentHolding.create({
        data: {
          userId: input.userId,
          productId: input.productId,
          principalAmountMinor: amountMinor,
          estimatedMarketValue: purchasedMarketValue,
          shares: purchasedShares,
          boughtAt: new Date(now),
          status: 'HOLDING',
          idempotencyKey: replayKey,
          purchaseHistory: JSON.stringify([record]),
        },
      });
      // Account-flow row: mirrors the funding-account DEBIT as a ledger `Transaction` in the SAME
      // transaction, categorized as investment flow (`INVESTMENT_FLOW_CATEGORY`) so principal is kept
      // out of consumption analysis and is never mislabeled as salary/大额消费.
      await tx.transaction.create({
        data: {
          accountId: account.id,
          userId: input.userId,
          amountMinor: -amountMinor,
          direction: 'DEBIT',
          category: INVESTMENT_FLOW_CATEGORY,
          merchant: '认购' + product.name,
          channel: 'APP',
          occurredAt: new Date(now),
          currency: 'CNY',
        },
      });
      const result: InvestResult = {
        success: true,
        holdingId: holding.id,
        productId: holding.productId,
        amount: record.amount,
        newBalance: balanceAfter,
        sourceAccountId: account.id,
        occurredAt: now,
        addedToExisting: false,
        lastPurchaseAt: now,
        subscribedShares: purchasedShares,
        totalShares: purchasedShares,
      };
      await tx.investmentHolding.update({
        where: { id: holding.id },
        data: { subscribeResult: JSON.stringify(result) },
      });
      return result;
    }

    // Aggregate: cost grows by the paid amount, shares grow by the shares bought, and the unrounded
    // market value snapshot is rewritten as `totalShares × net value` in the SAME instant (no accrual,
    // consistent with a fresh purchase). The conditional write keyed on the OLD cost + `HOLDING`
    // status makes a concurrent change lose the race (count 0) instead of double-adding.
    const heldShares = recordedShares(existing.shares);
    if (heldShares === undefined) {
      // No share count to grow: shares are derived by the maintenance script, never guessed here.
      throw new AppError('CONFLICT', '该持仓尚未记录份额，暂不可追加申购', { holdingId: existing.id });
    }
    const oldPrincipalMinor = existing.principalAmountMinor;
    const newPrincipalMinor = assertMinorUnits(oldPrincipalMinor + amountMinor);
    const totalShares = addDecimal(heldShares, purchasedShares);
    const newMarketValue = marketValueFromShares(totalShares, netValue);
    const history = parseHistory<PurchaseRecord>(existing.purchaseHistory);
    const record: PurchaseRecord = {
      at: now,
      amount: centsToMoney(amountMinor),
      totalPrincipal: centsToMoney(newPrincipalMinor),
      marketValue: newMarketValue,
      shares: purchasedShares,
      netValuePerUnit: netValue,
      ...(netValueDate !== undefined ? { netValueDate } : {}),
      totalShares,
      newBalance: balanceAfter,
      sourceAccountId: account.id,
      executionKey: replayKey,
    };
    const aggregated = await tx.investmentHolding.updateMany({
      where: { id: existing.id, userId: input.userId, status: 'HOLDING', principalAmountMinor: oldPrincipalMinor },
      data: {
        principalAmountMinor: newPrincipalMinor,
        shares: totalShares,
        estimatedMarketValue: newMarketValue,
        purchaseHistory: JSON.stringify([...history, record]),
      },
    });
    if (aggregated.count === 0) {
      // The holding changed between the read and the write: a concurrent aggregate/redeem, not our
      // identity's committed outcome (a serialized same-key RETRY replays through `find` instead).
      // Throwing rolls our debit back; returning here would commit a duplicate debit.
      throw new AppError('CONFLICT', '该持仓已被并发修改，请重试', { holdingId: existing.id });
    }
    await tx.transaction.create({
      data: {
        accountId: account.id,
        userId: input.userId,
        amountMinor: -amountMinor,
        direction: 'DEBIT',
        category: INVESTMENT_FLOW_CATEGORY,
        merchant: '认购' + product.name,
        channel: 'APP',
        occurredAt: new Date(now),
        currency: 'CNY',
      },
    });
    return {
      success: true,
      holdingId: existing.id,
      productId: existing.productId,
      amount: record.amount,
      newBalance: balanceAfter,
      sourceAccountId: account.id,
      occurredAt: now,
      addedToExisting: true,
      lastPurchaseAt: now,
      subscribedShares: purchasedShares,
      totalShares,
    };
  };

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key === undefined) {
    return runInTransaction((tx) => debitAndCreate(tx, undefined));
  }

  // Keyed path: a CREATING purchase keys the holding on the unique column (P2002 replay on the create
  // race); an AGGREGATING purchase records the key in its `purchaseHistory` record, which `find`
  // scans — so a repeat with the SAME key replays and never debits or aggregates twice.
  return createIdempotent<InvestResult>({
    key,
    find: async (tx) => {
      const recorded = await tx.investmentHolding.findUnique({ where: { idempotencyKey: key } });
      if (recorded !== null) {
        if (recorded.userId !== input.userId || recorded.productId !== input.productId) {
          throw new AppError('CONFLICT', 'The execution identity belongs to a different investment purchase.');
        }
        const replayed = parseSubscribeResult(recorded);
        if (replayed.amount !== centsToMoney(amountMinor)) {
          throw new AppError('CONFLICT', 'The execution identity belongs to a different investment purchase.');
        }
        return replayed;
      }
      const holding = await tx.investmentHolding.findFirst({
        where: { userId: input.userId, productId: input.productId, status: 'HOLDING' },
        orderBy: { boughtAt: 'asc' },
      });
      if (holding === null) return null;
      const entry = parseHistory<PurchaseRecord>(holding.purchaseHistory).find((record) => record.executionKey === key);
      if (entry === undefined) return null;
      if (entry.amount !== centsToMoney(amountMinor)) {
        throw new AppError('CONFLICT', 'The execution identity belongs to a different investment purchase.');
      }
      return purchaseResultFromRecord(holding, entry);
    },
    create: (tx, replayKey) => debitAndCreate(tx, replayKey),
  });
}

/* ------------------------------------------------------------------- redeem */

/** The clarification the contract demands when no口径 — or the retired principal口径 — arrives. */
const REDEEM_MODE_REQUIRED = '赎回需要明确口径：请确认按「份额」还是按「金额」赎回';

/**
 * Resolve the redemption口径 BEFORE any read of mutable state. A missing or unknown口径, or the
 * retired principal-based `redeemAmount` field, is a clarification request — there is no default.
 */
function resolveRedeemMode(input: RedeemInvestmentInput): RedeemMode {
  if (input.redeemAmount !== undefined) {
    // 「赎回本金」is not a口径 any more: it must never be honoured again.
    throw new AppError('VALIDATION', REDEEM_MODE_REQUIRED, { redeemAmount: input.redeemAmount, reason: 'PRINCIPAL_MODE_RETIRED' });
  }
  const mode = input.mode;
  if (mode !== 'SHARES' && mode !== 'AMOUNT' && mode !== 'ALL') {
    throw new AppError('VALIDATION', REDEEM_MODE_REQUIRED, { mode: typeof mode === 'string' ? mode : null });
  }
  return mode;
}

/** Reject a mixed口径: each mode accepts exactly one input field (and `ALL` accepts none). */
function assertRedeemArguments(input: RedeemInvestmentInput, mode: RedeemMode): void {
  if (mode === 'ALL') {
    if (input.shares !== undefined || input.amount !== undefined) {
      throw new AppError('VALIDATION', '赎回口径不可混用：全额赎回不接受份额或金额', {
        mode, shares: input.shares ?? null, amount: input.amount ?? null,
      });
    }
    return;
  }
  if (mode === 'SHARES') {
    if (input.amount !== undefined) {
      throw new AppError('VALIDATION', '赎回口径不可混用：按份额赎回不能同时给出赎回金额', { mode });
    }
    if (input.shares === undefined) throw new AppError('VALIDATION', '按份额赎回需要给出赎回份额', { mode });
    return;
  }
  if (input.shares !== undefined) {
    throw new AppError('VALIDATION', '赎回口径不可混用：按金额赎回不能同时给出赎回份额', { mode });
  }
  if (input.amount === undefined) throw new AppError('VALIDATION', '按金额赎回需要给出赎回金额', { mode });
}

/** A requested share count: positive, at most {@link SHARE_DECIMALS} fractional digits. */
function normalizeRequestedShares(input: DecimalInput | undefined): DecimalAmount {
  if (input === undefined) throw new AppError('VALIDATION', '按份额赎回需要给出赎回份额');
  const shares = nonNegativeDecimal(input);
  if (compareDecimal(shares, '0') <= 0) throw new AppError('VALIDATION', '赎回份额必须大于零', { shares: input });
  if (floorToShares(shares) !== shares) {
    throw new AppError('VALIDATION', `赎回份额最多允许 ${SHARE_DECIMALS} 位小数`, { shares: input });
  }
  return shares;
}

/** A requested amount口径: positive CNY, read as minor units. */
function normalizeRequestedAmount(input: MoneyInput | undefined): bigint {
  if (input === undefined) throw new AppError('VALIDATION', '按金额赎回需要给出赎回金额');
  const amountMinor = moneyToCents(input);
  if (amountMinor <= 0n) throw new AppError('VALIDATION', '赎回金额必须大于零', { amount: centsToMoney(amountMinor) });
  return amountMinor;
}

/**
 * The shares this redemption targets, resolved against the freshly re-read position:
 * `SHARES` → the given shares, `AMOUNT` → `FLOOR(amount ÷ net value, 6)` (a zero-share amount is
 * rejected by `sharesFromAmount`), `ALL` → every held share. An over-sized request is rejected —
 * never silently clamped to a full redemption.
 */
function resolveTargetShares(
  mode: RedeemMode,
  position: {
    heldShares: DecimalAmount;
    netValue: DecimalAmount;
    requestedShares?: DecimalAmount;
    requestedAmountMinor?: bigint;
  },
): DecimalAmount {
  if (mode === 'ALL') return position.heldShares;
  if (mode === 'SHARES') {
    const shares = position.requestedShares ?? invalidRecord();
    if (compareDecimal(shares, position.heldShares) > 0) {
      throw new AppError('VALIDATION', '赎回份额不能超过持有份额', {
        redeemedShares: shares, totalShares: position.heldShares,
      });
    }
    return shares;
  }
  const marketValueMinor = valuationToMinor(marketValueFromShares(position.heldShares, position.netValue));
  const requestedMinor = position.requestedAmountMinor ?? invalidRecord();
  if (requestedMinor > marketValueMinor) {
    throw new AppError('VALIDATION', '赎回金额超过持仓市值，请改用全额赎回或按份额赎回', {
      amount: centsToMoney(requestedMinor), marketValue: centsToMoney(marketValueMinor),
    });
  }
  const shares = sharesFromAmount(centsToMoney(requestedMinor), position.netValue);
  if (compareDecimal(shares, position.heldShares) > 0) {
    throw new AppError('VALIDATION', '赎回份额不能超过持有份额', {
      redeemedShares: shares, totalShares: position.heldShares,
    });
  }
  return shares;
}

/**
 * Compare the confirmation snapshot the user approved against the freshly re-read holding and
 * product INSIDE the write transaction. Any change — a different net value, a different net value
 * date, a different share count, or a recomputed settlement that no longer matches — rejects the old
 * authorization instead of settling at a silently repriced amount. Absent snapshots settle at the
 * current values.
 */
function assertConfirmedSnapshot(
  input: RedeemInvestmentInput,
  actual: { settledMinor: bigint; shares: DecimalAmount; netValue: DecimalAmount; netValueDate: number | undefined },
): void {
  const stale = (field: string): never => {
    throw new AppError('CONFLICT', '净值或持仓已变化，请重新确认', { holdingId: input.holdingId, field });
  };
  const expectedSettlement = input.expectedSettlementAmount ?? input.expectedRedemptionAmount;
  if (expectedSettlement !== undefined && moneyToCents(expectedSettlement) !== actual.settledMinor) {
    stale('expectedSettlementAmount');
  }
  if (input.expectedShares !== undefined && compareDecimal(nonNegativeDecimal(input.expectedShares), actual.shares) !== 0) {
    stale('expectedShares');
  }
  if (input.expectedNetValue !== undefined && compareDecimal(nonNegativeDecimal(input.expectedNetValue), actual.netValue) !== 0) {
    stale('expectedNetValue');
  }
  if (input.expectedNetValueDate !== undefined && input.expectedNetValueDate !== actual.netValueDate) {
    stale('expectedNetValueDate');
  }
}

/**
 * Redeem a holding under an explicit口径 (`SHARES` / `AMOUNT` / `ALL`). The settled cash is
 * `HALF_UP(shares × net value)` rounded ONCE, the consumed cost is proportional to the redeemed
 * shares, and the difference is booked as realized profit:
 *
 *  - a redemption that leaves no share CLOSES the holding (`HOLDING` → `REDEEMED`, one final credit),
 *  - a partial one keeps it `HOLDING` with fewer shares, less cost and a freshly derived market value.
 *
 * A missing/unknown口径 or the retired `redeemAmount` field throws `VALIDATION` before anything is
 * read; mixing口径, over-size requests and amounts beyond the position's market value throw
 * `VALIDATION` too. The write is guarded on the OLD share count + `HOLDING` status, so two concurrent
 * redemptions cannot both succeed.
 *
 * Execution identity: the SAME transaction persists the redemption's EXECUTION IDENTITY and ORIGINAL
 * result payload on the holding — a full close as `redeemExecutionKey`/`redeemResult`, a PARTIAL
 * redemption as a `redemptionHistory` record. A repeat with the SAME identity (`input.idempotencyKey`,
 * e.g. a replayed plan node) returns that original outcome and credits nothing — including a PARTIAL
 * redemption that a later full close has since followed. A DISTINCT identity — or an absent key — on
 * an already-REDEEMED holding throws `CONFLICT` (never a false success). `InvestmentHolding.idempotencyKey`
 * stays reserved for subscribe dedup.
 */
export async function redeemInvestment(input: RedeemInvestmentInput): Promise<InvestResult> {
  if (typeof input.userId !== 'string' || !input.userId.trim()) {
    throw new AppError('SECURITY_DENIED', 'Investment redemption requires a trusted owner identity.');
  }
  // The口径 is decided BEFORE any read of mutable state — no default, no guessing.
  const mode = resolveRedeemMode(input);
  assertRedeemArguments(input, mode);
  const requestedShares = mode === 'SHARES' ? normalizeRequestedShares(input.shares) : undefined;
  const requestedAmountMinor = mode === 'AMOUNT' ? normalizeRequestedAmount(input.amount) : undefined;
  const expectedSettlementAmount = input.expectedSettlementAmount ?? input.expectedRedemptionAmount;

  const holding = await investments.getHolding(input.holdingId);
  if (holding === null || holding.userId !== input.userId) {
    throw new AppError('NOT_FOUND', `持仓不存在：${input.holdingId}`, {
      holdingId: input.holdingId,
    });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const now = demoNow();

  return runInTransaction(async (tx): Promise<InvestResult> => {
    // Re-read the position and its product at the write boundary: a stale pre-MFA quote cannot
    // authorize a settlement at a net value or a share count the user never approved.
    const current = await tx.investmentHolding.findUnique({
      where: { id: holding.id },
      include: { product: true },
    });
    if (!current || current.userId !== input.userId) throw new AppError('NOT_FOUND', 'Investment holding does not exist.');
    const history = parseHistory<RawRedemptionRecord>(current.redemptionHistory);
    const past = key !== undefined
      ? history.find((record) => record.executionKey === key)
      : undefined;

    if (current.status !== 'HOLDING') {
      // Already closed: only this identity's ORIGINAL outcome replays — a full close from
      // `redeemResult`, or an earlier PARTIAL redemption from `redemptionHistory`.
      if (key !== undefined && current.redeemExecutionKey === key && current.redeemResult !== null) {
        return parseRedeemResult(current, expectedSettlementAmount);
      }
      if (past !== undefined) return redemptionResultFromRecord(current, past, expectedSettlementAmount);
      throw new AppError('CONFLICT', 'Investment holding has already been redeemed.', {
        holdingId: input.holdingId,
        status: current.status,
      });
    }

    // Still HOLDING: replay a prior PARTIAL redemption with the SAME identity (no re-credit, no re-write).
    if (past !== undefined) return redemptionResultFromRecord(current, past, expectedSettlementAmount);

    const netValue = productNetValue(current.product);
    if (netValue === undefined) {
      throw new AppError('VALIDATION', '该产品未发布净值，暂不可赎回', { productId: current.productId });
    }
    const netValueDate = productNetValueDate(current.product);
    const heldShares = recordedShares(current.shares);
    if (heldShares === undefined) {
      // No recorded share count: shares are derived by the maintenance script, never guessed here.
      throw new AppError('CONFLICT', '该持仓尚未记录份额，暂不可赎回', { holdingId: current.id });
    }

    const targetShares = resolveTargetShares(mode, { heldShares, netValue, requestedShares, requestedAmountMinor });
    const settledAmount = settlementFromShares(targetShares, netValue);
    const settledMinor = moneyToCents(settledAmount);
    const feeAmount = '0.00';
    const feeRule = REDEMPTION_FEE_RULE;
    const redeemedCost = redeemedCostMinor(current.principalAmountMinor, targetShares, heldShares);
    const remainingCostMinor = current.principalAmountMinor - redeemedCost;
    const realizedProfitMinor = assertMinorUnits(settledMinor - redeemedCost);
    const remainingShares = remainingSharesOf(heldShares, targetShares);
    const redemptionValuation = marketValueFromShares(targetShares, netValue);

    // Stale authorization is rejected here, inside the write transaction, before any write.
    assertConfirmedSnapshot(input, { settledMinor, shares: targetShares, netValue, netValueDate });

    const account = await accounts.getCheckingAccount(input.userId);
    if (account === null) throw new AppError('NOT_FOUND', 'Checking account does not exist.', { userId: input.userId });

    // FULL CLOSE: the redemption consumed every share (mode `ALL`, or a SHARES/AMOUNT redemption that
    // happens to consume the whole position). The guarded write is keyed on the OLD shares + status,
    // so exactly one of two concurrent redemptions closes the holding and is credited.
    if (remainingShares === '0') {
      const closed = await tx.investmentHolding.updateMany({
        where: { id: holding.id, userId: input.userId, status: 'HOLDING', shares: current.shares },
        data: {
          status: 'REDEEMED',
          shares: '0',
          principalAmountMinor: 0n,
          estimatedMarketValue: '0',
          realizedProfitMinor: assertMinorUnits(current.realizedProfitMinor + realizedProfitMinor),
        },
      });

      if (closed.count === 0) {
        // Lost the race: re-read the COMMITTED row inside the transaction and replay ONLY this
        // identity's outcome; anything else is a conflict (no second credit).
        const stored = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
        if (stored !== null && key !== undefined) {
          if (stored.redeemExecutionKey === key && stored.redeemResult !== null) {
            return parseRedeemResult(stored, expectedSettlementAmount);
          }
          const recorded = parseHistory<RawRedemptionRecord>(stored.redemptionHistory)
            .find((entry) => entry.executionKey === key);
          if (recorded !== undefined) return redemptionResultFromRecord(stored, recorded, expectedSettlementAmount);
        }
        throw new AppError('CONFLICT', '该持仓已发生变化，请重新确认。', { holdingId: input.holdingId });
      }

      const currentAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id, userId: input.userId } });
      const balanceMinor = assertMinorUnits(currentAccount.balanceMinor + settledMinor);
      const credited = await tx.account.update({
        where: { id: account.id, userId: input.userId, balanceMinor: currentAccount.balanceMinor },
        data: { balanceMinor },
      });

      const payload: InvestResult = {
        success: true,
        holdingId: holding.id,
        productId: holding.productId,
        amount: settledAmount,
        newBalance: centsToMoney(credited.balanceMinor),
        sourceAccountId: account.id,
        occurredAt: now,
        redemptionValuation,
        settlementRounding: 'HALF_UP',
        mode,
        redeemedShares: targetShares,
        remainingShares,
        netValuePerUnit: netValue,
        ...(netValueDate !== undefined ? { netValueDate } : {}),
        feeAmount,
        feeRule,
        realizedProfit: centsToMoney(realizedProfitMinor),
        remainingCost: '0.00',
        redeemedPrincipal: centsToMoney(redeemedCost),
        remainingPrincipal: '0.00',
      };

      // Persist the execution identity + ORIGINAL payload in the SAME transaction: a replay with the
      // SAME identity returns this exact result, a different identity is rejected (never a false claim).
      await tx.investmentHolding.update({
        where: { id: holding.id },
        data: { redeemExecutionKey: key ?? null, redeemResult: JSON.stringify(payload) },
      });

      // Account-flow row: mirrors the funding-account CREDIT as a ledger `Transaction` in the SAME
      // transaction, categorized as investment flow (`INVESTMENT_FLOW_CATEGORY`) so redeemed cash is
      // never mislabeled as salary/大额消费 income.
      await tx.transaction.create({
        data: {
          accountId: account.id,
          userId: input.userId,
          amountMinor: settledMinor,
          direction: 'CREDIT',
          category: INVESTMENT_FLOW_CATEGORY,
          merchant: '赎回',
          channel: 'APP',
          occurredAt: new Date(now),
          currency: 'CNY',
        },
      });

      return payload;
    }

    // PARTIAL: keep `HOLDING`, write the new shares / remaining cost / freshly derived market value and
    // append the outcome. The guarded write comes FIRST (keyed on the OLD shares + `HOLDING` status),
    // so a concurrent change loses the race before any credit is made.
    const remainingCost = centsToMoney(remainingCostMinor);
    const remainingMarketValue = marketValueFromShares(remainingShares, netValue);
    const newBalanceMinor = assertMinorUnits(account.balanceMinor + settledMinor);
    const record: RedemptionRecord = {
      at: now,
      mode,
      shares: targetShares,
      netValuePerUnit: netValue,
      ...(netValueDate !== undefined ? { netValueDate } : {}),
      settledAmount,
      feeAmount,
      feeRule,
      cost: centsToMoney(redeemedCost),
      realizedProfit: centsToMoney(realizedProfitMinor),
      remainingShares,
      remainingCost,
      remainingMarketValue,
      newBalance: centsToMoney(newBalanceMinor),
      sourceAccountId: account.id,
      executionKey: key,
    };
    const applied = await tx.investmentHolding.updateMany({
      where: { id: holding.id, userId: input.userId, status: 'HOLDING', shares: current.shares },
      data: {
        principalAmountMinor: remainingCostMinor,
        shares: remainingShares,
        estimatedMarketValue: remainingMarketValue,
        realizedProfitMinor: assertMinorUnits(current.realizedProfitMinor + realizedProfitMinor),
        redemptionHistory: JSON.stringify([...history, record]),
      },
    });
    if (applied.count === 0) {
      // Concurrent change: re-read and replay ONLY this identity's committed outcome.
      const stored = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
      if (stored !== null && key !== undefined) {
        if (stored.redeemExecutionKey === key && stored.redeemResult !== null) {
          return parseRedeemResult(stored, expectedSettlementAmount);
        }
        const recorded = parseHistory<RawRedemptionRecord>(stored.redemptionHistory)
          .find((entry) => entry.executionKey === key);
        if (recorded !== undefined) return redemptionResultFromRecord(stored, recorded, expectedSettlementAmount);
      }
      throw new AppError('CONFLICT', '该持仓已发生变化，请重新确认。', { holdingId: input.holdingId });
    }

    // Credit only AFTER the guarded holding write succeeded (never on a lost race).
    const credited = await tx.account.update({
      where: { id: account.id, userId: input.userId, balanceMinor: account.balanceMinor },
      data: { balanceMinor: newBalanceMinor },
    });
    await tx.transaction.create({
      data: {
        accountId: account.id,
        userId: input.userId,
        amountMinor: settledMinor,
        direction: 'CREDIT',
        category: INVESTMENT_FLOW_CATEGORY,
        merchant: '赎回',
        channel: 'APP',
        occurredAt: new Date(now),
        currency: 'CNY',
      },
    });
    return {
      success: true,
      holdingId: holding.id,
      productId: holding.productId,
      amount: settledAmount,
      newBalance: centsToMoney(credited.balanceMinor),
      sourceAccountId: account.id,
      occurredAt: now,
      redemptionValuation,
      settlementRounding: 'HALF_UP',
      partial: true,
      mode,
      redeemedShares: targetShares,
      remainingShares,
      netValuePerUnit: netValue,
      ...(netValueDate !== undefined ? { netValueDate } : {}),
      feeAmount,
      feeRule,
      realizedProfit: record.realizedProfit,
      remainingCost,
      redeemedPrincipal: record.cost,
      remainingPrincipal: remainingCost,
      remainingMarketValue,
      remainingProfit: subtractDecimal(remainingMarketValue, remainingCost),
    };
  });
}

/* ---------------------------------------------------------------- holdings */

/** The user's active holdings, each valued from its SHARES × the product's net value. */
export async function listHoldings(userId: string): Promise<HoldingView[]> {
  const rows = await investments.listHoldings(userId, 'HOLDING');
  return rows.map((row) => {
    const purchases = purchaseViews(row.purchaseHistory);
    const redemptions = redemptionViews(row.redemptionHistory);
    const valuation = holdingValuation(row);
    const realizedProfit = centsToMoney(row.realizedProfitMinor);
    return {
      id: row.id,
      productId: row.productId,
      productName: row.product.name,
      product: toProductView(row.product),
      riskLevel: row.product.riskLevel as InvestmentRiskLevel,
      amount: centsToMoney(row.principalAmountMinor),
      ...(valuation.shares !== undefined ? { shares: valuation.shares } : {}),
      ...(valuation.netValuePerUnit !== undefined ? { latestNetValue: valuation.netValuePerUnit } : {}),
      ...(valuation.netValueDate !== undefined ? { latestNetValueDate: valuation.netValueDate } : {}),
      marketValue: valuation.marketValue,
      ...(valuation.profit !== undefined ? { profit: valuation.profit } : {}),
      ...(valuation.profitRate !== undefined ? { profitRate: valuation.profitRate } : {}),
      realizedProfit,
      ...(valuation.profit !== undefined ? { cumulativeProfit: addDecimal(realizedProfit, valuation.profit) } : {}),
      valueBasis: valuation.valueBasis,
      boughtAt: row.boughtAt.getTime(),
      status: row.status as HoldingStatus,
      lastPurchaseAt: purchases === undefined ? undefined : purchases[purchases.length - 1].at,
      purchases,
      redemptions,
    };
  });
}
