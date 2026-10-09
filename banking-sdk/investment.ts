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
 * `InvestmentHolding` and replays the persisted holding (`./idempotent.ts`). `redeemInvestment`
 * persists the redemption's EXECUTION IDENTITY (`redeemExecutionKey`) and ORIGINAL result payload
 * (`redeemResult`) on the holding inside the SAME transaction: a repeat with the SAME identity
 * replays that original result, while a DIFFERENT or absent identity on an already-REDEEMED holding
 * throws `CONFLICT` — never a false success.
 *
 * Note: subscribing/redeeming moves the funding-account BALANCE and writes an investment-flow
 * `Transaction` row (category `INVESTMENT_FLOW_CATEGORY`) in the SAME transaction, so investment
 * principal is kept out of the 本月 spending analysis (anchored at ¥5,800) and is never mislabeled
 * as 大额消费.
 */
import type { InvestmentHolding, InvestmentProduct } from '@prisma/client';
import { demoNow } from '../lib/clock';
import { accounts, investments } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { round2, subtractMoney } from '../lib/money';
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
    expectedRate: row.expectedRate,
    termDays: row.termDays,
    minAmount: row.minAmount,
    description: row.description ?? undefined,
  };
}

/** Investment products, optionally filtered by risk level. */
export async function listProducts(query: ProductQuery = {}): Promise<ProductView[]> {
  const rows = query.riskLevel
    ? await investments.listProductsByRisk(query.riskLevel)
    : await investments.listProducts();
  return rows.map(toProductView);
}

/** Compare the products with the given ids (returns them plus best-rate / lowest-risk picks). */
export async function compareInvestments(ids: string[]): Promise<InvestmentComparison> {
  if (ids.length === 0) {
    return { products: [], highestRateId: undefined, lowestRiskId: undefined };
  }

  const rows = await Promise.all(ids.map((id) => investments.getProduct(id)));
  const products = rows
    .filter((row): row is InvestmentProduct => row !== null)
    .map(toProductView);

  let highest: ProductView | undefined;
  let lowest: ProductView | undefined;
  for (const product of products) {
    if (highest === undefined || product.expectedRate > highest.expectedRate) highest = product;
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

/** A subscribe outcome: the persisted holding plus the funding-account balance after the write. */
interface SubscribeOutcome {
  holding: InvestmentHolding;
  newBalance: number;
}

/** Map a persisted holding (plus the balance after the write) onto the public `InvestResult`. */
function toSubscribeResult(outcome: SubscribeOutcome): InvestResult {
  return {
    success: true,
    holdingId: outcome.holding.id,
    productId: outcome.holding.productId,
    amount: outcome.holding.amount,
    newBalance: outcome.newBalance,
    occurredAt: outcome.holding.boughtAt.getTime(),
  };
}

/**
 * Parse a holding's persisted ORIGINAL redemption payload. A corrupt/unparsable payload is a
 * data-integrity failure of an already-closed redemption: surface it as `CONFLICT` rather than
 * letting a raw exception escape the SDK (never a fabricated success, never swallowed).
 */
function parseRedeemResult(stored: string, holdingId: string): InvestResult {
  try {
    return JSON.parse(stored) as InvestResult;
  } catch {
    throw new AppError('CONFLICT', '该持仓已赎回', { holdingId, status: 'REDEEMED' });
  }
}

/**
 * Subscribe to a product: enforce `minAmount`, atomically debit the funding account and create the
 * holding in one transaction. The conditional decrement makes an overdraft impossible — when the
 * account cannot cover the amount the call throws `INSUFFICIENT_FUNDS` and nothing is written.
 *
 * Optional at-most-once semantics: when `input.idempotencyKey` is supplied, a repeat with the SAME
 * key replays the persisted holding (same `holdingId` / `amount`, current balance) and never debits
 * a second time (see `./idempotent.ts`). Absent → unchanged behavior.
 */
export async function subscribeInvestment(input: SubscribeInvestmentInput): Promise<InvestResult> {
  const product = await investments.getProduct(input.productId);
  if (product === null) {
    throw new AppError('NOT_FOUND', `投资产品不存在：${input.productId}`, {
      productId: input.productId,
    });
  }

  const amount = round2(input.amount);
  if (!(amount > 0) || amount < product.minAmount) {
    throw new AppError('VALIDATION', `认购金额不满足要求（起购 ¥${product.minAmount}）`, {
      amount: input.amount,
      minAmount: product.minAmount,
    });
  }

  const account = await accounts.getCheckingAccount(input.userId);
  if (account === null) {
    throw new AppError('NOT_FOUND', `未找到用户的活期账户：${input.userId}`, {
      userId: input.userId,
    });
  }

  const now = demoNow();

  /** Debit the funding account and create the holding inside the caller's transaction. */
  const debitAndCreate = async (
    tx: Tx,
    replayKey: string | undefined,
  ): Promise<SubscribeOutcome> => {
    // Atomic sufficient-funds check + debit (rolls back with nothing written when short).
    const debited = await tx.account.updateMany({
      where: { id: account.id, userId: input.userId, balance: { gte: amount } },
      data: { balance: { decrement: amount } },
    });
    if (debited.count === 0) {
      const current = await tx.account.findUnique({ where: { id: account.id } });
      throw new AppError('INSUFFICIENT_FUNDS', '账户余额不足，无法完成认购', {
        balance: current?.balance ?? 0,
        amount,
      });
    }

    const holding = await tx.investmentHolding.create({
      data: {
        userId: input.userId,
        productId: input.productId,
        amount,
        marketValue: amount,
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
        amount: -amount, // DECREASE: negative
        direction: 'DEBIT',
        category: INVESTMENT_FLOW_CATEGORY,
        merchant: '认购' + product.name,
        channel: 'APP',
        occurredAt: new Date(now),
        currency: 'CNY',
      },
    });

    return { holding, newBalance: updated.balance };
  };

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  if (key === undefined) {
    return toSubscribeResult(await runInTransaction((tx) => debitAndCreate(tx, undefined)));
  }

  // Keyed path: ONE transaction keys the holding on `key`; a repeat replays it (no second debit).
  const outcome = await createIdempotent<SubscribeOutcome>({
    key,
    find: async (tx) => {
      const existing = await tx.investmentHolding.findUnique({ where: { idempotencyKey: key } });
      if (existing === null) return null;
      const current = await tx.account.findUnique({ where: { id: account.id } });
      return { holding: existing, newBalance: current?.balance ?? 0 };
    },
    create: (tx, replayKey) => debitAndCreate(tx, replayKey),
  });
  return toSubscribeResult(outcome);
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
  const holding = await investments.getHolding(input.holdingId);
  if (holding === null || holding.userId !== input.userId) {
    throw new AppError('NOT_FOUND', `持仓不存在：${input.holdingId}`, {
      holdingId: input.holdingId,
    });
  }

  const account = await accounts.getCheckingAccount(input.userId);
  if (account === null) {
    throw new AppError('NOT_FOUND', `未找到用户的活期账户：${input.userId}`, {
      userId: input.userId,
    });
  }

  const key = normalizeIdempotencyKey(input.idempotencyKey);
  const credit = round2(holding.marketValue ?? holding.amount);
  const now = demoNow();

  return runInTransaction(async (tx): Promise<InvestResult> => {
    // Atomic HOLDING → REDEEMED transition: count 0 means it was already redeemed (no double credit).
    const closed = await tx.investmentHolding.updateMany({
      where: { id: holding.id, userId: input.userId, status: { not: 'REDEEMED' } },
      data: { status: 'REDEEMED' },
    });

    if (closed.count === 0) {
      // Already redeemed: re-read the COMMITTED row inside the transaction for its identity + result.
      const stored = await tx.investmentHolding.findUnique({ where: { id: holding.id } });
      const storedKey = stored?.redeemExecutionKey ?? null;
      const storedResult = stored?.redeemResult ?? null;
      // SAME identity → replay the ORIGINAL result (credit nothing); anything else → CONFLICT.
      if (key !== undefined && storedKey !== null && storedKey === key && storedResult !== null) {
        return parseRedeemResult(storedResult, input.holdingId);
      }
      throw new AppError('CONFLICT', '该持仓已赎回', {
        holdingId: input.holdingId,
        status: 'REDEEMED',
      });
    }

    const credited = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: credit } },
    });

    const payload: InvestResult = {
      success: true,
      holdingId: holding.id,
      productId: holding.productId,
      amount: credit,
      newBalance: credited.balance,
      occurredAt: now,
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
        amount: credit, // INCREASE: positive
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
    riskLevel: row.product.riskLevel as InvestmentRiskLevel,
    amount: row.amount,
    marketValue: row.marketValue ?? undefined,
    profit: row.marketValue != null ? subtractMoney(row.marketValue, row.amount) : undefined,
    boughtAt: row.boughtAt.getTime(),
    status: row.status as HoldingStatus,
  }));
}
