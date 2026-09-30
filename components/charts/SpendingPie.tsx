'use client';

import { Cell, Legend, Pie, PieChart, Tooltip } from 'recharts';
import type { CategorySpend } from '@/banking-sdk';
import { formatCNY } from '@/lib/money';
import { BANKING_PALETTE, ChartFrame, ChartTooltip, isChartEmpty, seriesColor } from './chartTheme';

export interface SpendingPieProps {
  data: CategorySpend[];
  height?: number;
  className?: string;
}

export function SpendingPie(p: SpendingPieProps) {
  const height = p.height ?? 280;
  const active = !isChartEmpty(p.data.map((d) => d.amount));

  return (
    <ChartFrame height={height} className={p.className} active={active}>
      <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
        <Pie
          data={p.data}
          dataKey="share"
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
                const amount = Number((item.payload as CategorySpend | undefined)?.amount ?? 0);
                return `${formatCNY(amount)} · ${value.toFixed(1)}%`;
              }}
            />
          }
        />
        <Legend />
      </PieChart>
    </ChartFrame>
  );
}
