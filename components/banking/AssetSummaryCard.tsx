/**
 * AssetSummaryCard — read-model tile: total assets / 活期余额 / 信用卡额度 / 本月消费.
 *
 * Server-safe presentational component: no `'use client'`, no hooks, no fetching, no DB.
 * Renders the four headline money stats from a `DashboardSummary` (money via `ui/Money`).
 */
import { Card } from '../ui/Card';
import { Money } from '../ui/Money';
import type { DashboardSummary } from '@/banking-sdk';

export interface AssetSummaryCardProps {
  summary: DashboardSummary;
  className?: string;
}

interface AssetStatProps {
  label: string;
  amount: number;
  className?: string;
}

/** One labelled money stat (local, non-exported). */
function AssetStat({ label, amount, className }: AssetStatProps) {
  const cls = [
    'flex flex-col gap-1 rounded-xl bg-banking-light p-4 shadow-sm',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <span className="text-sm text-banking-navy/70">{label}</span>
      <span className="text-xl font-semibold text-banking-navy">
        <Money amount={amount} />
      </span>
    </div>
  );
}

export function AssetSummaryCard({ summary, className }: AssetSummaryCardProps) {
  return (
    <Card title="资产概览" className={className}>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <AssetStat label="总资产" amount={summary.totalAssets} />
        <AssetStat label="活期余额" amount={summary.checkingBalance} />
        <AssetStat label="信用卡额度" amount={summary.creditAvailable} />
        <AssetStat label={`本月消费 · ${summary.month}`} amount={summary.monthSpend} />
      </div>
    </Card>
  );
}
