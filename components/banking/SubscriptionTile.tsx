/**
 * SubscriptionTile — read-model tile: one subscription (amount, cycle, next charge, remind).
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`).
 */
import type { SubscriptionView } from '@/banking-sdk';

export interface SubscriptionTileProps {
  subscription: SubscriptionView;
  className?: string;
}

export function SubscriptionTile(_props: SubscriptionTileProps) {
  return null;
}
