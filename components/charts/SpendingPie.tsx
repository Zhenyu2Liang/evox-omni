'use client';

import type { CategorySpend } from '@/banking-sdk';
import { formatCNY, moneyToChartNumber } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, isChartEmpty, seriesColor, useChartTooltip } from './chartTheme';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface SpendingPieProps {
  data: CategorySpend[];
  height?: number;
  className?: string;
}

export function SpendingPie(p: SpendingPieProps) {
  const { t } = useI18n();
  const tooltip = useChartTooltip();
  const shares = p.data.map(point => Math.max(0, Number(point.share) || 0));
  const total = shares.reduce((sum, share) => sum + share, 0);
  const circumference = 2 * Math.PI * 64;
  let offset = 0;

  return (
    <ChartFrame height={p.height ?? 280} className={p.className}
      active={total > 0 && !isChartEmpty(p.data.map(point => moneyToChartNumber(point.amount)))} tooltip={tooltip.tooltip}>
      <div className="flex h-full min-w-0 items-center gap-3">
        <svg className="min-w-0 flex-1" width="100%" height="100%" viewBox="0 0 180 180" role="group" aria-label={t('chart.shares')}>
          <title>{t('chart.shares')}</title>
          <circle cx="90" cy="90" r="64" fill="none" stroke={BANKING_PALETTE.light} strokeWidth="24" />
          {p.data.map((point, index) => {
            const length = total ? (shares[index] / total) * circumference : 0;
            const start = offset;
            offset += length;
            if (!length) return null;
            return (
              <circle key={point.category} cx="90" cy="90" r="64" fill="none" stroke={seriesColor(index)} strokeWidth="24"
                strokeDasharray={`${Math.max(0, length - Math.min(2, length / 4))} ${circumference}`}
                strokeDashoffset={-start} transform="rotate(-90 90 90)"
                {...tooltip.point(point.category, point.amount, seriesColor(index), `${point.share}%`)}>
                <title>{`${point.category}: ${formatCNY(point.amount)} · ${point.share}%`}</title>
              </circle>
            );
          })}
        </svg>
        <ul className="max-h-full w-[44%] shrink-0 space-y-2 overflow-y-auto pr-1 text-xs text-banking-navy">
          {p.data.map((point, index) => (
            <li key={point.category} className="flex items-start gap-2">
              <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ background: seriesColor(index) }} />
              <span className="min-w-0 break-words">
                <span className="block font-medium text-banking-deep">{point.category}</span>
                <span className="block">{formatCNY(point.amount)}</span>
                <span className="block text-banking-navy/60">{point.share}%</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </ChartFrame>
  );
}
