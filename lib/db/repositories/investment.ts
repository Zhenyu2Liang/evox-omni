import type { InvestmentProduct, InvestmentHolding } from '@/lib/db/prisma';
import { dbClient } from '../client';
import { moneyToCents, type MoneyInput } from '../../money';
import { nonNegativeDecimal } from '../../decimal';

export type HoldingWithProduct = InvestmentHolding & { product: InvestmentProduct };

export function listProducts(): Promise<InvestmentProduct[]> {
  return dbClient().investmentProduct.findMany({ orderBy: { code: 'asc' } });
}

export function getProduct(id: string): Promise<InvestmentProduct | null> {
  return dbClient().investmentProduct.findUnique({ where: { id } });
}

export function getProductByCode(code: string): Promise<InvestmentProduct | null> {
  return dbClient().investmentProduct.findUnique({ where: { code } });
}

export function listProductsByRisk(riskLevel: string): Promise<InvestmentProduct[]> {
  return dbClient().investmentProduct.findMany({
    where: { riskLevel },
    orderBy: { code: 'asc' },
  });
}

export function createProduct(input: { code: string; name: string; riskLevel: string; annualYieldRate: string; termDays: number; minAmount: MoneyInput; description?: string | null }): Promise<InvestmentProduct> {
  return dbClient().investmentProduct.create({
    data: {
      code: input.code,
      name: input.name,
      riskLevel: input.riskLevel,
      annualYieldRate: nonNegativeDecimal(input.annualYieldRate),
      termDays: input.termDays,
      minAmountMinor: moneyToCents(input.minAmount),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });
}

export function listHoldings(userId: string, status?: string): Promise<HoldingWithProduct[]> {
  return dbClient().investmentHolding.findMany({
    where: { userId, ...(status !== undefined ? { status } : {}) },
    include: { product: true },
    orderBy: { boughtAt: 'desc' },
  });
}

export function getHolding(id: string): Promise<HoldingWithProduct | null> {
  return dbClient().investmentHolding.findUnique({
    where: { id },
    include: { product: true },
  });
}

export function createHolding(input: { userId: string; productId: string; amount: MoneyInput; marketValue?: MoneyInput | null; boughtAt?: Date; status?: string }): Promise<InvestmentHolding> {
  return dbClient().investmentHolding.create({
    data: {
      userId: input.userId,
      productId: input.productId,
      principalAmountMinor: moneyToCents(input.amount),
      ...(input.marketValue !== undefined ? { estimatedMarketValue: input.marketValue === null ? null : nonNegativeDecimal(input.marketValue) } : {}),
      ...(input.boughtAt !== undefined ? { boughtAt: input.boughtAt } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
}

export function updateHoldingStatus(id: string, status: string): Promise<InvestmentHolding> {
  return dbClient().investmentHolding.update({
    where: { id },
    data: { status },
  });
}

/** Sum of the user's principal invested across active (`HOLDING`) positions (CNY). */
export async function sumActiveHoldings(userId: string): Promise<bigint> {
  const rows = await dbClient().investmentHolding.findMany({ where: { userId, status: 'HOLDING' }, select: { principalAmountMinor: true } });
  return rows.reduce((total, row) => total + row.principalAmountMinor, 0n);
}
