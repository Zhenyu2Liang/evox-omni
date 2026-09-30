/**
 * AnomalyBanner — read-model banner: suspicious-spend banner; optional action callbacks.
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`); callbacks are passed down by an ancestor Client Component.
 */
import type { AnomalyItem } from '@/banking-sdk';

export interface AnomalyBannerProps {
  anomaly: AnomalyItem;
  onAcknowledge?: () => void;
  onViewDetail?: () => void;
  onFreeze?: () => void;
  className?: string;
}

export function AnomalyBanner(_props: AnomalyBannerProps) {
  return null;
}
