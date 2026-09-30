/**
 * AssetSummaryCard — read-model tile: total assets / 活期余额 / 信用卡额度 / 本月消费.
 *
 * DESIGN STUB: frozen prop interface + named export. Body returns `null` (no JSX/logic yet).
 * Server-safe (no `'use client'`).
 */
import type { DashboardSummary } from '@/banking-sdk';

export interface AssetSummaryCardProps {
  summary: DashboardSummary;
  className?: string;
}

export function AssetSummaryCard(_props: AssetSummaryCardProps) {
  return null;
}
