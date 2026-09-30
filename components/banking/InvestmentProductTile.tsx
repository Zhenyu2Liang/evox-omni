/**
 * InvestmentProductTile — read-model tile: a product / holding (risk level, expected rate, term, amount).
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`).
 */
import type { HoldingView, ProductView } from '@/banking-sdk';

export interface InvestmentProductTileProps {
  product: ProductView;
  holding?: HoldingView;
  className?: string;
}

export function InvestmentProductTile(_props: InvestmentProductTileProps) {
  return null;
}
