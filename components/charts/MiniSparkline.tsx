'use client';

import { Line, LineChart } from 'recharts';
import { BANKING_PALETTE, ChartFrame, isChartEmpty } from './chartTheme';

export interface MiniSparklineProps {
  data: number[];
  height?: number;
  color?: string;
  className?: string;
}

export function MiniSparkline(p: MiniSparklineProps) {
  const height = p.height ?? 40;
  const color = p.color ?? BANKING_PALETTE.accent;
  const points = p.data.map((value, i) => ({ i, value }));

  return (
    <ChartFrame height={height} className={p.className} active={!isChartEmpty(p.data)}>
      <LineChart data={points} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartFrame>
  );
}
