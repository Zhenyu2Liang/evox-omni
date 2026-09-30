import type { InvestmentProduct, InvestmentHolding } from '@prisma/client';
import { prisma } from '../client';

export type HoldingWithProduct = InvestmentHolding & { product: InvestmentProduct };

export function listProducts(): Promise<InvestmentProduct[]> {
  return prisma.investmentProduct.findMany({ orderBy: { code: 'asc' } });
}

export function getProduct(id: string): Promise<InvestmentProduct | null> {
  return prisma.investmentProduct.findUnique({ where: { id } });
}

export function getProductByCode(code: string): Promise<InvestmentProduct | null> {
  return prisma.investmentProduct.findUnique({ where: { code } });
}

export function listProductsByRisk(riskLevel: string): Promise<InvestmentProduct[]> {
  return prisma.investmentProduct.findMany({
    where: { riskLevel },
    orderBy: { code: 'asc' },
  });
}

export function createProduct(input: { code: string; name: string; riskLevel: string; expectedRate: number; termDays: number; minAmount: number; description?: string | null }): Promise<InvestmentProduct> {
  return prisma.investmentProduct.create({
    data: {
      code: input.code,
      name: input.name,
      riskLevel: input.riskLevel,
      expectedRate: input.expectedRate,
      termDays: input.termDays,
      minAmount: input.minAmount,
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });
}

export function listHoldings(userId: string, status?: string): Promise<HoldingWithProduct[]> {
  return prisma.investmentHolding.findMany({
    where: { userId, ...(status !== undefined ? { status } : {}) },
    include: { product: true },
    orderBy: { boughtAt: 'desc' },
  });
}

export function getHolding(id: string): Promise<HoldingWithProduct | null> {
  return prisma.investmentHolding.findUnique({
    where: { id },
    include: { product: true },
  });
}

export function createHolding(input: { userId: string; productId: string; amount: number; marketValue?: number | null; boughtAt?: Date; status?: string }): Promise<InvestmentHolding> {
  return prisma.investmentHolding.create({
    data: {
      userId: input.userId,
      productId: input.productId,
      amount: input.amount,
      ...(input.marketValue !== undefined ? { marketValue: input.marketValue } : {}),
      ...(input.boughtAt !== undefined ? { boughtAt: input.boughtAt } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
    },
  });
}

export function updateHoldingStatus(id: string, status: string): Promise<InvestmentHolding> {
  return prisma.investmentHolding.update({
    where: { id },
    data: { status },
  });
}

/** Sum of the user's principal invested across active (`HOLDING`) positions (CNY). */
export async function sumActiveHoldings(userId: string): Promise<number> {
  const agg = await prisma.investmentHolding.aggregate({
    where: { userId, status: 'HOLDING' },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}
