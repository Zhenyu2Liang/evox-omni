'use client';

import { BANKING_PALETTE, ChartFrame, chartScale, isChartEmpty } from './chartTheme';
import { formatCNY, moneyToChartNumber, type MoneyInput } from '@/lib/money';
import { useI18n } from '@/lib/i18n/LocaleProvider';

export interface MiniSparklineProps {
  data: MoneyInput[];
  height?: number;
  color?: string;
  className?: string;
}

export function MiniSparkline(p: MiniSparklineProps) {
  const { t } = useI18n();
  const values = p.data.map(moneyToChartNumber);
  const scale = chartScale(values, 4, 36);
  const x = (index: number) => values.length === 1 ? 100 : 4 + (index / (values.length - 1)) * 192;

  return (
    <ChartFrame height={p.height ?? 40} className={p.className} active={!isChartEmpty(values)}>
      <svg width="100%" height="100%" viewBox="0 0 200 40" preserveAspectRatio="none" role="img" aria-label={t('chart.sparkline')}>
        <title>{p.data.map(amount => formatCNY(amount)).join(' → ')}</title>
        {values.length === 1
          ? <circle cx="100" cy={scale.y(values[0])} r="3" fill={p.color ?? BANKING_PALETTE.deep} />
          : <polyline points={values.map((value, index) => `${x(index)},${scale.y(value)}`).join(' ')}
              fill="none" stroke={p.color ?? BANKING_PALETTE.deep} strokeWidth="2" vectorEffect="non-scaling-stroke" />}
      </svg>
    </ChartFrame>
  );
}
