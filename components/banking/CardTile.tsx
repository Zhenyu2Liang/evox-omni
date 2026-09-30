/**
 * CardTile — read-model tile: one bank card (masked number, status, limits, credit line).
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`).
 */
import type { CardView } from '@/banking-sdk';

export interface CardTileProps {
  card: CardView;
  className?: string;
}

export function CardTile(_props: CardTileProps) {
  return null;
}
