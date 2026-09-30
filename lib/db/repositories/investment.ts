import type { InvestmentProduct, InvestmentHolding } from '@prisma/client';

export type HoldingWithProduct = InvestmentHolding & { product: InvestmentProduct };

export function listProducts(): Promise<InvestmentProduct[]> {
  throw new Error('not implemented');
}

export function getProduct(id: string): Promise<InvestmentProduct | null> {
  throw new Error('not implemented');
}

export function getProductByCode(code: string): Promise<InvestmentProduct | null> {
  throw new Error('not implemented');
}

export function listProductsByRisk(riskLevel: string): Promise<InvestmentProduct[]> {
  throw new Error('not implemented');
}

export function createProduct(input: { code: string; name: string; riskLevel: string; expectedRate: number; termDays: number; minAmount: number; description?: string | null }): Promise<InvestmentProduct> {
  throw new Error('not implemented');
}

export function listHoldings(userId: string, status?: string): Promise<HoldingWithProduct[]> {
  throw new Error('not implemented');
}

export function getHolding(id: string): Promise<HoldingWithProduct | null> {
  throw new Error('not implemented');
}

export function createHolding(input: { userId: string; productId: string; amount: number; marketValue?: number | null; boughtAt?: Date; status?: string }): Promise<InvestmentHolding> {
  throw new Error('not implemented');
}

export function updateHoldingStatus(id: string, status: string): Promise<InvestmentHolding> {
  throw new Error('not implemented');
}

export function sumActiveHoldings(userId: string): Promise<number> {
  throw new Error('not implemented');
}
