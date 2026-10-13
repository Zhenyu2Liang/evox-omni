'use client';

import { Cell, Legend, Pie, PieChart, Tooltip } from 'recharts';
import type { CategorySpend } from '@/banking-sdk';
import { formatCNY, moneyToChartNumber } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, ChartTooltip, isChartEmpty, seriesColor } from './chartTheme';

export interface SpendingPieProps {
  data: CategorySpend[];
  height?: number;
  className?: string;
}

export function SpendingPie(p: SpendingPieProps) {
  const height = p.height ?? 280;
  const coordinates = p.data.map(point => ({ ...point, shareCoordinate: Number(point.share) }));
  const active = !isChartEmpty(p.data.map(point => moneyToChartNumber(point.amount)));

  return (
    <ChartFrame height={height} className={p.className} active={active}>
      <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <Pie
          data={coordinates}
          dataKey="shareCoordinate"
          nameKey="category"
          innerRadius="55%"
          outerRadius="80%"
          paddingAngle={2}
        >
          {p.data.map((d, i) => (
            <Cell key={d.category} fill={seriesColor(i)} stroke={BANKING_PALETTE.light} />
          ))}
        </Pie>
        <Tooltip
          content={
            <ChartTooltip
              formatter={(value, item) => {
                const point = item.payload as CategorySpend | undefined;
                return `${formatCNY(point?.amount ?? '0.00')} · ${point?.share ?? value.toFixed(2)}%`;
              }}
            />
          }
        />
        <Legend />
      </PieChart>
    </ChartFrame>
  );
}
