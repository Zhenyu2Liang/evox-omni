/**
 * Banking SDK — investment products & holdings.
 * `listProducts` / `compareInvestments` / `listHoldings` are GREEN reads.
 * `subscribeInvestment` / `redeemInvestment` execute only (debit/credit the funding account and
 * create/close a holding); tier policy (RED) is enforced by the Security Gateway, not here.
 *
 * `subscribeInvestment` enforces `minAmount` → throws `AppError('VALIDATION')` below it and
 * `AppError('INSUFFICIENT_FUNDS')` when the funding account cannot cover the amount.
 * `redeemInvestment` closes exactly one HOLDING → throws `AppError('CONFLICT')` if it was already
 * redeemed.
 *
 * Both writes run in a SINGLE interactive transaction (`runInTransaction`): the balance change, the
 * holding change and the account-flow `Transaction` row commit together or not at all, so no partial
 * debit/credit can survive. The debit is a conditional decrement (`balance >= amount`) → a negative
 * balance is impossible even under concurrency.
 *
 * Optional at-most-once semantics (`input.idempotencyKey`, supplied by the planner as
 * `nodeExecutionKey(taskId, nodeId)`): a replayed plan node re-runs the tool, so a repeat with the
 * SAME key must not debit/credit twice. `subscribeInvestment` stores the caller's key on the
 * `InvestmentHolding` and replays its full original `subscribeResult` (`./idempotent.ts`). `redeemInvestment`
 * persists the redemption's EXECUTION IDENTITY (`redeemExecutionKey`) and ORIGINAL result payload
 * (`redeemResult`) on the holding inside the SAME transaction: a repeat with the SAME identity
 * replays that original result, while a DIFFERENT or absent identity on an already-REDEEMED holding
 * throws `CONFLICT` — never a false success.
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
import { assertMinorUnits, centsToMoney, moneyToCents, normalizeMoney } from '../lib/money';
import { compareDecimal, nonNegativeDecimal, subtractDecimal, valuationToMinor } from '../lib/decimal';
import { INVESTMENT_FLOW_CATEGORY } from './categories';
import { createIdempotent, normalizeIdempotencyKey } from './idempotent';
import { runInTransaction, type Tx } from './tx';
import type {
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

/** Replay only a complete original purchase outcome matching its persisted holding. */
function parseSubscribeResult(holding: InvestmentHolding): InvestResult {
  try {
    if (holding.subscribeResult === null) throw new Error('Missing original purchase result.');
    const result: unknown = JSON.parse(holding.subscribeResult);
    if (typeof result !== 'object' || result === null || Array.isArray(result)) throw new Error('Invalid purchase result.');
    const stored = result as Record<string, unknown>;
    if (stored.success !== true || stored.holdingId !== holding.id || stored.productId !== holding.productId ||
        stored.amount !== centsToMoney(holding.principalAmountMinor) || typeof stored.newBalance !== 'string' ||
        normalizeMoney(stored.newBalance) !== stored.newBalance || moneyToCents(stored.newBalance) < 0n ||
        typeof stored.sourceAccountId !== 'string' || stored.sourceAccountId.length === 0 ||
        stored.occurredAt !== holding.boughtAt.getTime()) {
      throw new Error('Purchase result does not match the committed holding.');
    }
    return stored as unknown as InvestResult;
  } catch {
    throw new AppError('CONFLICT', 'The investment purchase has no valid original execution result.', { holdingId: holding.id });
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
 * Subscribe to a product: enforce `minAmount`, atomically debit the funding account and create the
 * holding in one transaction. The conditional decrement makes an overdraft impossible — when the
 * account cannot cover the amount the call throws `INSUFFICIENT_FUNDS` and nothing is written.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeat with the SAME
 * key replays the full original result persisted in the purchase transaction and never debits
 * a second time or reconstructs a balance from current account state.
 */
export async function subscribeInvestment(input: SubscribeInvestmentInput): Promise<InvestResult> {
  if (typeof input.userId !== 'string' || !input.userId.trim()) {
    throw new AppError('SECURITY_DENIED', 'Investment purchase requires a trusted owner identity.');
  }
  const amountMinor = moneyToCents(input.amount);
  if (amountMinor <= 0n) throw new AppError('VALIDATION', 'Purchase amount must be positive.');

  const now = demoNow();

  /** Debit the funding account and create the holding inside the caller's transaction. */
  const debitAndCreate = async (
    tx: Tx,
    replayKey: string | undefined,
  ): Promise<InvestResult> => {
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

    const holding = await tx.investmentHolding.create({
      data: {
        userId: input.userId,
        productId: input.productId,
        principalAmountMinor: amountMinor,
        estimatedMarketValue: nonNegativeDecimal(centsToMoney(amountMinor)),
        boughtAt: new Date(now),
        status: 'HOLDING',
        idempotencyKey: replayKey,
      },
    });

    const updated = await tx.account.findUnique({ where: { id: account.id } });
    if (!updated) {
      throw new AppError('NOT_FOUND', `未找到用户的活期账户：${input.userId}`, {
        userId: input.userId,
      });
    }
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
      amount: centsToMoney(holding.principalAmountMinor),
      newBalance: centsToMoney(updated.balanceMinor),
      sourceAccountId: account.id,
      occurredAt: holding.boughtAt.getTime(),
    };
    await tx.investmentHolding.update({
      where: { id: holding.id },
      data: { subscribeResult: JSON.stringify(result) },
    });
    return result;
  };

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key === undefined) {
    return runInTransaction((tx) => debitAndCreate(tx, undefined));
  }

  // Keyed path: ONE transaction keys the holding on `key`; a repeat replays it (no second debit).
  return createIdempotent<InvestResult>({
    key,
    find: async (tx) => {
      const existing = await tx.investmentHolding.findUnique({ where: { idempotencyKey: key } });
      if (existing === null) return null;
      if (existing.userId !== input.userId || existing.productId !== input.productId || existing.principalAmountMinor !== amountMinor) {
        throw new AppError('CONFLICT', 'The execution identity belongs to a different investment purchase.');
      }
      return parseSubscribeResult(existing);
    },
    create: (tx, replayKey) => debitAndCreate(tx, replayKey),
  });
}

/**
 * Redeem a holding: atomically close it (status → REDEEMED) and credit the funding account in one
 * transaction. The conditional status transition guarantees exactly one credit per holding, closing
 * the concurrent double-redeem race.
 *
 * Execution identity: the SAME transaction also persists the redemption's execution identity
 * (`redeemExecutionKey`) and ORIGINAL result payload (`redeemResult`) on the holding. A repeat with
 * the SAME identity (`input.idempotencyKey`, e.g. a replayed plan node) returns that original result
 * and credits nothing; a DISTINCT identity — or an absent key — on an already-REDEEMED holding
 * throws `CONFLICT` (never a false success). `InvestmentHolding.idempotencyKey` stays reserved for
 * subscribe dedup.
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

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const now = demoNow();

  return runInTransaction(async (tx): Promise<InvestResult> => {
    // Re-read the value at the write boundary: a stale pre-MFA quote cannot authorize a new amount.
    const current = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
    if (!current || current.userId !== input.userId) throw new AppError('NOT_FOUND', 'Investment holding does not exist.');
    if (current.status !== 'HOLDING') {
      if (key !== undefined && current.redeemExecutionKey === key && current.redeemResult !== null) {
        return parseRedeemResult(current, input.expectedRedemptionAmount);
      }
      throw new AppError('CONFLICT', 'Investment holding has already been redeemed.', {
        holdingId: input.holdingId,
        status: current.status,
      });
    }
    const account = await accounts.getCheckingAccount(input.userId);
    if (account === null) throw new AppError('NOT_FOUND', 'Checking account does not exist.', { userId: input.userId });
    const redemptionValuation = current.estimatedMarketValue === null
      ? centsToMoney(current.principalAmountMinor)
      : nonNegativeDecimal(current.estimatedMarketValue);
    const creditMinor = valuationToMinor(redemptionValuation);
    const credit = centsToMoney(creditMinor);
    if (current.status === 'HOLDING' && input.expectedRedemptionAmount !== undefined &&
        moneyToCents(input.expectedRedemptionAmount) !== creditMinor) {
      throw new AppError('CONFLICT', 'The redemption amount changed and requires a new confirmation.');
    }
    // Atomic HOLDING → REDEEMED transition: count 0 means it was already redeemed (no double credit).
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

/** The user's active holdings. */
export async function listHoldings(userId: string): Promise<HoldingView[]> {
  const rows = await investments.listHoldings(userId, 'HOLDING');
  return rows.map((row) => ({
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
  }));
}
