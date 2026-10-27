'use client';

import type { MonthlyTrendPoint } from '@/banking-sdk';
import { formatCNY, moneyToChartNumber } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, chartScale, chartTicks, isChartEmpty, useChartTooltip, useChartWidth } from './chartTheme';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface SpendingTrendProps {
  data: MonthlyTrendPoint[];
  height?: number;
  className?: string;
}

export function SpendingTrend(p: SpendingTrendProps) {
  const { t } = useI18n();
  const coordinates = p.data.map(point => ({ ...point, value: moneyToChartNumber(point.amount) }));
  const height = p.height ?? 280;
  const { width, containerRef } = useChartWidth();
  const scale = chartScale(coordinates.map(point => point.value), 20, height - 36);
  const ticks = chartTicks(p.data.map(point => point.amount));
  const left = Math.min(width * 0.45, Math.max(72, ...ticks.map(tick => tick.label.length * 6 + 12)));
  const right = width - 12;
  const plotWidth = Math.max(1, right - left);
  const labelStride = Math.max(1, Math.ceil(coordinates.length / Math.max(2, Math.floor(plotWidth / 68))));
  const tooltip = useChartTooltip();
  const x = (index: number) => coordinates.length === 1 ? left + plotWidth / 2 : left + (index / (coordinates.length - 1)) * plotWidth;

  return (
    <ChartFrame height={height} className={p.className} containerRef={containerRef}
      active={!isChartEmpty(coordinates.map(point => point.value))} tooltip={tooltip.tooltip}>
      <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} role="group" aria-label={t('chart.trend')}>
        <title>{t('chart.trend')}</title>
        {ticks.map((tick, index) => (
          <g key={index} aria-hidden="true">
            <line x1={left} x2={right} y1={scale.y(tick.value)} y2={scale.y(tick.value)} stroke={BANKING_PALETTE.navy} strokeOpacity="0.1" strokeDasharray="3 3" />
            <text x={left - 8} y={scale.y(tick.value) + 4} textAnchor="end" fontSize="11" fill={BANKING_PALETTE.navy}>
              {tick.label}
            </text>
          </g>
        ))}
        <polyline points={coordinates.map((point, index) => `${x(index)},${scale.y(point.value)}`).join(' ')}
          fill="none" stroke={BANKING_PALETTE.plot} strokeWidth="2.5" strokeLinejoin="round" />
        {coordinates.map((point, index) => (
          <g key={point.month} className="group" {...tooltip.point(point.month, point.amount, BANKING_PALETTE.accent)}>
            <title>{`${point.month}: ${formatCNY(point.amount)}`}</title>
            <circle cx={x(index)} cy={scale.y(point.value)} r="12" fill="transparent" />
            <circle cx={x(index)} cy={scale.y(point.value)} r="4" fill={BANKING_PALETTE.plot} stroke="white" strokeWidth="2"
              className="group-hover:fill-banking-accent group-focus:fill-banking-accent" />
            {index === coordinates.length - 1 || (index % labelStride === 0 &&
              (index === 0 || x(coordinates.length - 1) - x(index) >= 68)) ? (
              <text x={x(index)} y={height - 14} textAnchor={index === coordinates.length - 1 && coordinates.length > 1 ? 'end' : 'middle'}
                fontSize="11" fill={BANKING_PALETTE.navy}>{point.month}</text>
            ) : null}
          </g>
        ))}
      </svg>
    </ChartFrame>
  );
}
