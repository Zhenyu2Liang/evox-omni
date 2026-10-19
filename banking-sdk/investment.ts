/**
 * Banking SDK — investment products & holdings.
 * `listProducts` / `compareInvestments` / `listHoldings` are GREEN reads.
 * `subscribeInvestment` / `redeemInvestment` execute only (debit/credit the funding account and
 * create/extend/reduce a holding); tier policy (RED) is enforced by the Security Gateway, not here.
 *
 * `subscribeInvestment` enforces `minAmount` → throws `AppError('VALIDATION')` below it and
 * `AppError('INSUFFICIENT_FUNDS')` when the funding account cannot cover the amount. When a `HOLDING`
 * already exists for (user, product) the amount AGGREGATES into it — principal grows and the
 * unrounded market value grows by the newly purchased principal at cost — instead of opening a
 * second holding.
 *
 * `redeemInvestment` reduces one HOLDING. `redeemAmount` is an OPTIONAL principal portion: absent or
 * equal to the held principal CLOSES the holding (`HOLDING` → `REDEEMED`, one final credit); a
 * smaller positive portion credits the settled value of that portion, decrements the principal,
 * recomputes the unrounded remaining market value and keeps the holding `HOLDING`. Over-redeem or a
 * non-positive/malformed portion throws `AppError('VALIDATION')`. A distinct or absent identity on an
 * already-REDEEMED holding throws `AppError('CONFLICT')`.
 *
 * Both writes run in a SINGLE interactive transaction (`runInTransaction`): the balance change, the
 * holding change and the account-flow `Transaction` row commit together or not at all, so no partial
 * debit/credit can survive. The debit is a conditional decrement (`balance >= amount`) → a negative
 * balance is impossible even under concurrency.
 *
 * Optional at-most-once semantics (`input.idempotencyKey`, supplied by the planner as
 * `nodeExecutionKey(taskId, nodeId)`): a replayed plan node re-runs the tool, so a repeat with the
 * SAME key must not debit/credit twice. `subscribeInvestment` stores a CREATING purchase's key on the
 * `InvestmentHolding` (unique column) and an AGGREGATING purchase's key in the appended
 * `purchaseHistory` record, and replays either original outcome. `redeemInvestment` persists the
 * redemption's EXECUTION IDENTITY and ORIGINAL result payload on the holding inside the SAME
 * transaction — a full close as `redeemExecutionKey`/`redeemResult`, a PARTIAL redemption as a
 * `redemptionHistory` record — and a repeat with the SAME identity replays that original outcome.
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
import { assertMinorUnits, centsToMoney, moneyToCents, normalizeMoney, type MoneyAmount } from '../lib/money';
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
import { runInTransaction, type Tx } from './tx';
import { redemptionPortionValuation, remainingPortionMarketValue } from './valuation';
import type {
  HoldingPurchase,
  HoldingStatus,
  HoldingView,
  InvestResult,
  InvestmentComparison,
  InvestmentRiskLevel,
  ProductQuery,
  ProductView,
  RedeemInvestmentInput,
  SubscribeInvestmentInput,
} from './types';

/**
 * Re-export the exact, bounded proportional valuation so the Security Gateway mints the SAME
 * `expectedRedemptionAmount` the SDK settles (rule in `./valuation`).
 */
export { redemptionPortionValuation, remainingPortionMarketValue, settledRedemptionAmount } from './valuation';

/** Risk ordering `R1 < R2 < R3 < R4 < R5` (lower = safer). */
const RISK_RANK: Record<InvestmentRiskLevel, number> = { R1: 1, R2: 2, R3: 3, R4: 4, R5: 5 };

/** Maps an `InvestmentProduct` row to its public view model. */
function toProductView(row: InvestmentProduct): ProductView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    riskLevel: row.riskLevel as InvestmentRiskLevel,
    annualYieldRate: nonNegativeDecimal(row.annualYieldRate),
    termDays: row.termDays,
    minAmount: centsToMoney(row.minAmountMinor),
    description: row.description ?? undefined,
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

/**
 * One purchase recorded on a holding (`InvestmentHolding.purchaseHistory`, a JSON array). The FIRST
 * record is the CREATING purchase (its outcome is also persisted in `subscribeResult`); later records
 * are aggregations into the existing HOLDING. `marketValue` is the holding's unrounded estimated
 * market value AFTER this purchase; `newBalance` is the funding-account balance after its debit.
 */
interface PurchaseRecord {
  at: number;
  amount: MoneyAmount;
  totalPrincipal: MoneyAmount;
  marketValue: DecimalAmount;
  newBalance: MoneyAmount;
  sourceAccountId: string;
  executionKey?: string;
}

/**
 * One redemption outcome recorded on a holding (`InvestmentHolding.redemptionHistory`, a JSON array).
 * Only PARTIAL redemptions append here (a full close is persisted as
 * `redeemExecutionKey`/`redeemResult`). `valuation` is the UNROUNDED settled portion before the single
 * HALF_UP settlement.
 */
interface RedemptionRecord {
  at: number;
  redeemedPrincipal: MoneyAmount;
  valuation: DecimalAmount;
  settledAmount: MoneyAmount;
  remainingPrincipal: MoneyAmount;
  remainingMarketValue: DecimalAmount;
  newBalance: MoneyAmount;
  sourceAccountId: string;
  executionKey?: string;
}

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

/**
 * Replay only a complete original purchase outcome matching the purchase record that produced it.
 * A holding's `purchaseHistory[0]` is its CREATING purchase; later aggregations append after it, so
 * the original result is validated against that record — never against the holding's current
 * (possibly grown) principal.
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
      if (typeof record !== 'object' || record === null ||
          typeof record.at !== 'number' || !Number.isSafeInteger(record.at) ||
          typeof record.amount !== 'string' || normalizeMoney(record.amount) !== record.amount ||
          typeof record.totalPrincipal !== 'string' || normalizeMoney(record.totalPrincipal) !== record.totalPrincipal ||
          typeof record.marketValue !== 'string' || nonNegativeDecimal(record.marketValue) !== record.marketValue ||
          typeof record.newBalance !== 'string' || normalizeMoney(record.newBalance) !== record.newBalance ||
          typeof record.sourceAccountId !== 'string' || record.sourceAccountId.length === 0) {
        throw new Error('Invalid purchase record.');
      }
      return {
        amount: record.amount,
        at: record.at,
        totalPrincipal: record.totalPrincipal,
        marketValue: record.marketValue,
        newBalance: record.newBalance,
        sourceAccountId: record.sourceAccountId,
        executionKey: typeof record.executionKey === 'string' ? record.executionKey : undefined,
      };
    });
  } catch {
    return undefined;
  }
}

/**
 * Parse a holding's persisted ORIGINAL redemption payload. A corrupt/unparsable payload is a
 * data-integrity failure of an already-closed redemption: surface it as `CONFLICT` rather than
 * letting a raw exception escape the SDK (never a fabricated success, never swallowed).
 */
function parseRedeemResult(holding: InvestmentHolding, expectedAmount?: string): InvestResult {
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
        expectedAmount !== undefined && moneyToCents(expectedAmount) !== moneyToCents(stored.amount)) {
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
 * exact outcome and must not credit again. A record that is not a complete, canonical partial outcome
 * is a data-integrity failure → `CONFLICT`.
 */
function redemptionResultFromRecord(holding: InvestmentHolding, record: RedemptionRecord, expectedAmount?: string): InvestResult {
  try {
    if (typeof record !== 'object' || record === null ||
        typeof record.at !== 'number' || !Number.isSafeInteger(record.at) || !Number.isFinite(new Date(record.at).getTime()) ||
        typeof record.redeemedPrincipal !== 'string' || normalizeMoney(record.redeemedPrincipal) !== record.redeemedPrincipal || moneyToCents(record.redeemedPrincipal) <= 0n ||
        typeof record.valuation !== 'string' || nonNegativeDecimal(record.valuation) !== record.valuation ||
        typeof record.settledAmount !== 'string' || normalizeMoney(record.settledAmount) !== record.settledAmount || moneyToCents(record.settledAmount) < 0n ||
        valuationToMinor(record.valuation) !== moneyToCents(record.settledAmount) ||
        typeof record.remainingPrincipal !== 'string' || normalizeMoney(record.remainingPrincipal) !== record.remainingPrincipal || moneyToCents(record.remainingPrincipal) < 0n ||
        typeof record.remainingMarketValue !== 'string' || nonNegativeDecimal(record.remainingMarketValue) !== record.remainingMarketValue ||
        typeof record.newBalance !== 'string' || normalizeMoney(record.newBalance) !== record.newBalance || moneyToCents(record.newBalance) < 0n ||
        typeof record.sourceAccountId !== 'string' || record.sourceAccountId.length === 0 ||
        expectedAmount !== undefined && moneyToCents(expectedAmount) !== moneyToCents(record.settledAmount)) {
      throw new Error('Redemption record does not describe a complete outcome.');
    }
    return {
      success: true,
      holdingId: holding.id,
      productId: holding.productId,
      amount: record.settledAmount,
      newBalance: record.newBalance,
      sourceAccountId: record.sourceAccountId,
      occurredAt: record.at,
      redemptionValuation: record.valuation,
      settlementRounding: 'HALF_UP',
      partial: true,
      redeemedPrincipal: record.redeemedPrincipal,
      remainingPrincipal: record.remainingPrincipal,
      remainingMarketValue: record.remainingMarketValue,
      remainingProfit: subtractDecimal(record.remainingMarketValue, record.remainingPrincipal),
    };
  } catch {
    throw new AppError('CONFLICT', 'The investment redemption has no valid matching original execution result.', { holdingId: holding.id });
  }
}

/**
 * Subscribe to a product: enforce `minAmount`, atomically debit the funding account and CREATE a
 * holding — or, when a `HOLDING` already exists for (user, product), AGGREGATE into it — in one
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
      const purchasedMarketValue = nonNegativeDecimal(centsToMoney(amountMinor));
      const record: PurchaseRecord = {
        at: now,
        amount: centsToMoney(amountMinor),
        totalPrincipal: centsToMoney(amountMinor),
        marketValue: purchasedMarketValue,
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
      };
      await tx.investmentHolding.update({
        where: { id: holding.id },
        data: { subscribeResult: JSON.stringify(result) },
      });
      return result;
    }

    // Aggregate: grow the principal, value the newly purchased principal at cost (this purchase's
    // instant — no accrual, consistent with a fresh purchase), keep `HOLDING` and append a record.
    // The conditional write keyed on the OLD principal + `HOLDING` status makes a concurrent change
    // lose the race (count 0) instead of double-adding.
    const oldPrincipalMinor = existing.principalAmountMinor;
    const oldMarketValue = existing.estimatedMarketValue === null
      ? centsToMoney(oldPrincipalMinor)
      : nonNegativeDecimal(existing.estimatedMarketValue);
    const newPrincipalMinor = assertMinorUnits(oldPrincipalMinor + amountMinor);
    const newMarketValue = nonNegativeDecimal(addDecimal(oldMarketValue, centsToMoney(amountMinor)));
    const history = parseHistory<PurchaseRecord>(existing.purchaseHistory);
    const record: PurchaseRecord = {
      at: now,
      amount: centsToMoney(amountMinor),
      totalPrincipal: centsToMoney(newPrincipalMinor),
      marketValue: newMarketValue,
      newBalance: balanceAfter,
      sourceAccountId: account.id,
      executionKey: replayKey,
    };
    const aggregated = await tx.investmentHolding.updateMany({
      where: { id: existing.id, userId: input.userId, status: 'HOLDING', principalAmountMinor: oldPrincipalMinor },
      data: {
        principalAmountMinor: newPrincipalMinor,
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

/**
 * Redeem a holding. With no `redeemAmount`, or an amount equal to the held principal, the holding is
 * atomically closed (status → REDEEMED) and the whole settled valuation credited in one transaction;
 * the conditional status transition guarantees exactly one credit per holding, closing the concurrent
 * double-redeem race. A smaller positive `redeemAmount` redeems that PRINCIPAL portion: the settled
 * value of the portion is credited, the principal decremented and the unrounded remaining market
 * value recomputed, keeping the holding `HOLDING`. A larger, non-positive or malformed portion throws
 * `VALIDATION`.
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
  const holding = await investments.getHolding(input.holdingId);
  if (holding === null || holding.userId !== input.userId) {
    throw new AppError('NOT_FOUND', `持仓不存在：${input.holdingId}`, {
      holdingId: input.holdingId,
    });
  }
  // The requested PRINCIPAL portion is independent of the committed holding: a malformed or
  // non-positive amount is rejected before any write (over-redeem is checked against the holding).
  const requestedMinor = input.redeemAmount === undefined ? undefined : moneyToCents(input.redeemAmount);
  if (requestedMinor !== undefined && requestedMinor <= 0n) {
    throw new AppError('VALIDATION', '赎回本金金额必须大于零', { redeemAmount: centsToMoney(requestedMinor) });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const now = demoNow();

  return runInTransaction(async (tx): Promise<InvestResult> => {
    // Re-read the value at the write boundary: a stale pre-MFA quote cannot authorize a new amount.
    const current = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
    if (!current || current.userId !== input.userId) throw new AppError('NOT_FOUND', 'Investment holding does not exist.');
    const past = key !== undefined
      ? parseHistory<RedemptionRecord>(current.redemptionHistory).find((record) => record.executionKey === key)
      : undefined;

    if (current.status !== 'HOLDING') {
      // Already closed: only this identity's ORIGINAL outcome replays — a full close from
      // `redeemResult`, or an earlier PARTIAL redemption from `redemptionHistory`.
      if (key !== undefined && current.redeemExecutionKey === key && current.redeemResult !== null) {
        return parseRedeemResult(current, input.expectedRedemptionAmount);
      }
      if (past !== undefined) return redemptionResultFromRecord(current, past, input.expectedRedemptionAmount);
      throw new AppError('CONFLICT', 'Investment holding has already been redeemed.', {
        holdingId: input.holdingId,
        status: current.status,
      });
    }

    // Still HOLDING: replay a prior PARTIAL redemption with the SAME identity (no re-credit, no re-write).
    if (past !== undefined) return redemptionResultFromRecord(current, past, input.expectedRedemptionAmount);

    const totalPrincipalMinor = current.principalAmountMinor;
    const redeemPrincipalMinor = requestedMinor ?? totalPrincipalMinor;
    if (redeemPrincipalMinor > totalPrincipalMinor) {
      throw new AppError('VALIDATION', '赎回本金金额不能超过持仓本金', {
        redeemAmount: centsToMoney(redeemPrincipalMinor),
        totalPrincipal: centsToMoney(totalPrincipalMinor),
      });
    }

    const account = await accounts.getCheckingAccount(input.userId);
    if (account === null) throw new AppError('NOT_FOUND', 'Checking account does not exist.', { userId: input.userId });
    const marketValue = current.estimatedMarketValue === null
      ? centsToMoney(totalPrincipalMinor)
      : nonNegativeDecimal(current.estimatedMarketValue);
    // ONE valuation rule for full and partial: `marketValue × redeemedPrincipal / totalPrincipal`,
    // carried to at most 18 fractional digits (the SDK storage bound) with a single HALF_UP step. A
    // whole-principal redemption returns `marketValue` unchanged, so it settles the full valuation.
    const redemptionValuation = redemptionPortionValuation(marketValue, totalPrincipalMinor, redeemPrincipalMinor);
    const creditMinor = valuationToMinor(redemptionValuation);
    const credit = centsToMoney(creditMinor);
    if (input.expectedRedemptionAmount !== undefined && moneyToCents(input.expectedRedemptionAmount) !== creditMinor) {
      throw new AppError('CONFLICT', '赎回金额已变化，需要重新确认。');
    }

    if (redeemPrincipalMinor < totalPrincipalMinor) {
      // PARTIAL: keep `HOLDING`, shrink the principal, recompute the unrounded remaining value and
      // append the outcome. The guarded write comes FIRST (keyed on the OLD principal + `HOLDING`
      // status), so a concurrent change loses the race before any credit is made.
      const remainingPrincipalMinor = totalPrincipalMinor - redeemPrincipalMinor;
      const remainingMarketValue = remainingPortionMarketValue(marketValue, redemptionValuation);
      const remainingPrincipal = centsToMoney(remainingPrincipalMinor);
      const newBalanceMinor = assertMinorUnits(account.balanceMinor + creditMinor);
      const record: RedemptionRecord = {
        at: now,
        redeemedPrincipal: centsToMoney(redeemPrincipalMinor),
        valuation: redemptionValuation,
        settledAmount: credit,
        remainingPrincipal,
        remainingMarketValue,
        newBalance: centsToMoney(newBalanceMinor),
        sourceAccountId: account.id,
        executionKey: key,
      };
      const applied = await tx.investmentHolding.updateMany({
        where: { id: holding.id, userId: input.userId, status: 'HOLDING', principalAmountMinor: totalPrincipalMinor },
        data: {
          principalAmountMinor: remainingPrincipalMinor,
          estimatedMarketValue: remainingMarketValue,
          redemptionHistory: JSON.stringify([...parseHistory<RedemptionRecord>(current.redemptionHistory), record]),
        },
      });
      if (applied.count === 0) {
        // Concurrent change: re-read and replay ONLY this identity's committed outcome.
        const stored = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
        if (stored !== null && key !== undefined) {
          if (stored.redeemExecutionKey === key && stored.redeemResult !== null) {
            return parseRedeemResult(stored, input.expectedRedemptionAmount);
          }
          const past = parseHistory<RedemptionRecord>(stored.redemptionHistory).find((entry) => entry.executionKey === key);
          if (past !== undefined) return redemptionResultFromRecord(stored, past, input.expectedRedemptionAmount);
        }
        throw new AppError('CONFLICT', '该持仓已发生变化，请重新确认。', { holdingId: input.holdingId });
      }

      // Credit only AFTER the guarded holding write succeeded (never on a lost race).
      const credited = await tx.account.update({
        where: { id: account.id, userId: input.userId, balanceMinor: account.balanceMinor },
        data: { balanceMinor: newBalanceMinor },
      });
      // Account-flow row: mirrors the funding-account CREDIT as a ledger `Transaction` in the SAME
      // transaction, categorized as investment flow (`INVESTMENT_FLOW_CATEGORY`).
      await tx.transaction.create({
        data: {
          accountId: account.id,
          userId: input.userId,
          amountMinor: creditMinor,
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
        amount: credit,
        newBalance: centsToMoney(credited.balanceMinor),
        sourceAccountId: account.id,
        occurredAt: now,
        redemptionValuation,
        settlementRounding: 'HALF_UP',
        partial: true,
        redeemedPrincipal: record.redeemedPrincipal,
        remainingPrincipal,
        remainingMarketValue,
        remainingProfit: subtractDecimal(remainingMarketValue, remainingPrincipal),
      };
    }

    // FULL: atomic HOLDING → REDEEMED transition: count 0 means it was already redeemed (no double credit).
    const closed = await tx.investmentHolding.updateMany({
      where: { id: holding.id, userId: input.userId, status: 'HOLDING' },
      data: { status: 'REDEEMED' },
    });

    if (closed.count === 0) {
      // Already redeemed: re-read the COMMITTED row inside the transaction for its identity + result.
      const stored = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
      const storedKey = stored?.redeemExecutionKey ?? null;
      const storedResult = stored?.redeemResult ?? null;
      // SAME identity → replay the ORIGINAL result (credit nothing); anything else → CONFLICT.
      if (key !== undefined && stored && storedKey !== null && storedKey === key && storedResult !== null) {
        return parseRedeemResult(stored, input.expectedRedemptionAmount);
      }
      throw new AppError('CONFLICT', '该持仓已赎回', {
        holdingId: input.holdingId,
        status: 'REDEEMED',
      });
    }

    const currentAccount = await tx.account.findUniqueOrThrow({ where: { id: account.id, userId: input.userId } });
    const balanceMinor = assertMinorUnits(currentAccount.balanceMinor + creditMinor);
    const credited = await tx.account.update({
      where: { id: account.id, userId: input.userId, balanceMinor: currentAccount.balanceMinor },
      data: { balanceMinor },
    });

    const payload: InvestResult = {
      success: true,
      holdingId: holding.id,
      productId: holding.productId,
      amount: credit,
      newBalance: centsToMoney(credited.balanceMinor),
      sourceAccountId: account.id,
      occurredAt: now,
      redemptionValuation,
      settlementRounding: 'HALF_UP',
    };

    // Persist the execution identity + ORIGINAL payload in the SAME transaction: a replay with the
    // SAME identity returns this exact result, a different identity is rejected (never a false claim).
    await tx.investmentHolding.update({
      where: { id: holding.id },
      data: { redeemExecutionKey: key ?? null, redeemResult: JSON.stringify(payload) },
    });

    // Account-flow row: mirrors the funding-account CREDIT as a ledger `Transaction` in the SAME
    // transaction, categorized as investment flow (`INVESTMENT_FLOW_CATEGORY`) so redeemed principal
    // is never mislabeled as salary/大额消费 income.
    await tx.transaction.create({
      data: {
        accountId: account.id,
        userId: input.userId,
        amountMinor: creditMinor,
        direction: 'CREDIT',
        category: INVESTMENT_FLOW_CATEGORY,
        merchant: '赎回',
        channel: 'APP',
        occurredAt: new Date(now),
        currency: 'CNY',
      },
    });

    return payload;
  });
}

/** The user's active holdings, each with its recorded purchase history (best-effort presentation). */
export async function listHoldings(userId: string): Promise<HoldingView[]> {
  const rows = await investments.listHoldings(userId, 'HOLDING');
  return rows.map((row) => {
    const purchases = purchaseViews(row.purchaseHistory);
    return {
      id: row.id,
      productId: row.productId,
      productName: row.product.name,
      product: toProductView(row.product),
      riskLevel: row.product.riskLevel as InvestmentRiskLevel,
      amount: centsToMoney(row.principalAmountMinor),
      marketValue: row.estimatedMarketValue === null ? undefined : nonNegativeDecimal(row.estimatedMarketValue),
      profit: row.estimatedMarketValue !== null
        ? subtractDecimal(nonNegativeDecimal(row.estimatedMarketValue), centsToMoney(row.principalAmountMinor))
        : undefined,
      boughtAt: row.boughtAt.getTime(),
      status: row.status as HoldingStatus,
      lastPurchaseAt: purchases === undefined ? undefined : purchases[purchases.length - 1].at,
      purchases,
    };
  });
}
