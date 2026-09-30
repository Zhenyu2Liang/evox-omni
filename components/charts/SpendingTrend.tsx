'use client';

import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import type { MonthlyTrendPoint } from '@/banking-sdk';
import { formatCNY } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, ChartTooltip, isChartEmpty } from './chartTheme';

export interface SpendingTrendProps {
  data: MonthlyTrendPoint[];
  height?: number;
  className?: string;
}

export function SpendingTrend(p: SpendingTrendProps) {
  const height = p.height ?? 280;
  const active = !isChartEmpty(p.data.map((d) => d.amount));

  return (
    <ChartFrame height={height} className={p.className} active={active}>
      <LineChart data={p.data} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={BANKING_PALETTE.light} vertical={false} />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 12, fill: BANKING_PALETTE.navy }}
          tickLine={false}
          axisLine={{ stroke: BANKING_PALETTE.light }}
        />
        <YAxis
          tickFormatter={(v: number) => formatCNY(v)}
          tick={{ fontSize: 12, fill: BANKING_PALETTE.navy }}
          tickLine={false}
          axisLine={false}
          width={88}
        />
        <Tooltip content={<ChartTooltip />} />
        <Line
          type="monotone"
          dataKey="amount"
          name="支出"
          stroke={BANKING_PALETTE.accent}
          strokeWidth={2}
          dot={{ r: 3, fill: BANKING_PALETTE.accent }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ChartFrame>
  );
}
