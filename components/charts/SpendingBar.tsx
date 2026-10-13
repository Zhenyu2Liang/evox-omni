'use client';

import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';
import type { CategorySpend } from '@/banking-sdk';
import { formatCNY, moneyToChartNumber } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, ChartTooltip, isChartEmpty } from './chartTheme';

export interface SpendingBarProps {
  data: CategorySpend[];
  height?: number;
  className?: string;
}

export function SpendingBar(p: SpendingBarProps) {
  const height = p.height ?? 280;
  const coordinates = p.data.map(point => ({ ...point, amountCoordinate: moneyToChartNumber(point.amount) }));
  const active = !isChartEmpty(coordinates.map(point => point.amountCoordinate));

  return (
    <ChartFrame height={height} className={p.className} active={active}>
      <BarChart data={coordinates} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={BANKING_PALETTE.light} vertical={false} />
        <XAxis
          dataKey="category"
          tick={{ fontSize: 12, fill: BANKING_PALETTE.navy }}
          tickLine={false}
          axisLine={{ stroke: BANKING_PALETTE.light }}
        />
        <YAxis
          tickFormatter={(value: number) => formatCNY(value.toFixed(2))}
          tick={{ fontSize: 12, fill: BANKING_PALETTE.navy }}
          tickLine={false}
          axisLine={false}
          width={88}
        />
        <Tooltip content={<ChartTooltip />} cursor={{ fill: BANKING_PALETTE.light }} />
        <Bar dataKey="amountCoordinate" name="支出" fill={BANKING_PALETTE.accent} radius={[6, 6, 0, 0]} />
      </BarChart>
    </ChartFrame>
  );
}
