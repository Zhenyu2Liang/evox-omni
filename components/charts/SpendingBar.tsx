'use client';

import type { CategorySpend } from '@/banking-sdk';
import { formatCNY, moneyToChartNumber } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, chartScale, chartTicks, isChartEmpty, seriesColor, useChartTooltip, useChartWidth } from './chartTheme';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface SpendingBarProps {
  data: CategorySpend[];
  height?: number;
  className?: string;
}

export function SpendingBar(p: SpendingBarProps) {
  const { t } = useI18n();
  const coordinates = p.data.map(point => ({ ...point, value: moneyToChartNumber(point.amount) }));
  const height = p.height ?? 280;
  const { width, containerRef } = useChartWidth();
  const scale = chartScale(coordinates.map(point => point.value), 20, height - 36);
  const ticks = chartTicks(p.data.map(point => point.amount));
  const left = Math.min(width * 0.45, Math.max(72, ...ticks.map(tick => tick.label.length * 6 + 12)));
  const right = width - 12;
  const tooltip = useChartTooltip();
  const slotWidth = Math.max(1, right - left) / Math.max(coordinates.length, 1);
  const barWidth = Math.min(48, slotWidth * 0.6);

  return (
    <ChartFrame height={height} className={p.className} containerRef={containerRef}
      active={!isChartEmpty(coordinates.map(point => point.value))} tooltip={tooltip.tooltip}>
      <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('chart.categories')}>
        <title>{t('chart.categories')}</title>
        {ticks.map((tick, index) => (
          <g key={index} aria-hidden="true">
            <line x1={left} x2={right} y1={scale.y(tick.value)} y2={scale.y(tick.value)} stroke={BANKING_PALETTE.navy} strokeOpacity="0.1" strokeDasharray="3 3" />
            <text x={left - 8} y={scale.y(tick.value) + 4} textAnchor="end" fontSize="11" fill={BANKING_PALETTE.navy}>
              {tick.label}
            </text>
          </g>
        ))}
        {coordinates.map((point, index) => {
          const x = left + slotWidth * (index + 0.5);
          const y = Math.min(scale.y(0), scale.y(point.value));
          return (
            <g key={point.category} className="group" {...tooltip.point(point.category, point.amount, seriesColor(index))}>
              <title>{`${point.category}: ${formatCNY(point.amount)}`}</title>
              <rect x={x - barWidth / 2} y={y} width={barWidth}
                height={Math.max(1, Math.abs(scale.y(0) - scale.y(point.value)))} rx="4" fill={seriesColor(index)}
                className="transition-colors group-hover:fill-banking-accent group-focus:fill-banking-accent" />
              <text x={x} y={height - 14} textAnchor="middle" fontSize="11" fill={BANKING_PALETTE.navy}>
                {point.category.slice(0, Math.max(1, Math.min(6, Math.floor(slotWidth / 11))))}
              </text>
            </g>
          );
        })}
      </svg>
    </ChartFrame>
  );
}
