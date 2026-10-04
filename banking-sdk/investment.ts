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
 * Both writes run in a SINGLE interactive transaction (`runInTransaction`): the balance change and
 * the holding change commit together or not at all, so no partial debit/credit can survive. The
 * debit is a conditional decrement (`balance >= amount`) → a negative balance is impossible even
 * under concurrency.
 *
 * Note: subscribing/redeeming moves the funding-account BALANCE only — it deliberately does NOT
 * write a `Transaction` row, so the demo's 本月 spending analysis stays anchored at ¥5,800.
 */
import type { InvestmentProduct } from '@prisma/client';
import { demoNow } from '../lib/clock';
import { accounts, investments } from '../lib/db/repositories';
import { AppError } from '../lib/errors';
import { round2, subtractMoney } from '../lib/money';
import { runInTransaction } from './tx';
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

/**
 * Subscribe to a product: enforce `minAmount`, atomically debit the funding account and create the
 * holding in one transaction. The conditional decrement makes an overdraft impossible — when the
 * account cannot cover the amount the call throws `INSUFFICIENT_FUNDS` and nothing is written.
 */
export async function subscribeInvestment(
  input: SubscribeInvestmentInput,
): Promise<InvestResult> {
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
  const { holdingId, newBalance } = await runInTransaction(async (tx) => {
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
      },
    });

    const updated = await tx.account.findUnique({ where: { id: account.id } });
    if (!updated) {
      throw new AppError('NOT_FOUND', `未找到用户的活期账户：${input.userId}`, {
        userId: input.userId,
      });
    }
    return { holdingId: holding.id, newBalance: updated.balance };
  });

  return {
    success: true,
    holdingId,
    productId: input.productId,
    amount,
    newBalance,
    occurredAt: now,
  };
}

/**
 * Redeem a holding: atomically close it (status → REDEEMED) and credit the funding account in one
 * transaction. The conditional status transition guarantees exactly one credit per holding, closing
 * the concurrent double-redeem race; a second attempt throws `CONFLICT`.
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

  const credit = round2(holding.marketValue ?? holding.amount);
  const now = demoNow();
  const newBalance = await runInTransaction(async (tx) => {
    // Atomic HOLDING → REDEEMED transition: count 0 means it was already redeemed (no double credit).
    const closed = await tx.investmentHolding.updateMany({
      where: { id: holding.id, userId: input.userId, status: { not: 'REDEEMED' } },
      data: { status: 'REDEEMED' },
    });
    if (closed.count === 0) {
      throw new AppError('CONFLICT', '该持仓已赎回', {
        holdingId: input.holdingId,
        status: 'REDEEMED',
      });
    }

    const credited = await tx.account.update({
      where: { id: account.id },
      data: { balance: { increment: credit } },
    });
    return credited.balance;
  });

  return {
    success: true,
    holdingId: holding.id,
    productId: holding.productId,
    amount: credit,
    newBalance,
    occurredAt: now,
  };
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
