'use client';

import type { ReactElement } from 'react';
import { ResponsiveContainer } from 'recharts';
import { formatCNY } from '@/lib/money';

/**
 * Private shared chart chrome for the wrappers in `./charts`.
 *
 * NOT part of the public barrel (`./index.ts`) — internal to this node only, so the four
 * chart files reuse one source of truth instead of copy-pasting palette/tooltip logic.
 *
 * The colour literals below mirror `tailwind.config.ts` (`banking.*`) and are the ONLY
 * colours the charts are allowed to use.
 */
export const BANKING_PALETTE = {
  deep: '#0B1F3A',
  navy: '#123A6B',
  accent: '#2563EB',
  success: '#16A34A',
  warn: '#F59E0B',
  danger: '#DC2626',
  light: '#F5F7FA',
} as const;

/** Ordered series colours, cycled to colour pie slices / multi-series charts. */
export const SERIES_COLORS: readonly string[] = [
  BANKING_PALETTE.accent,
  BANKING_PALETTE.navy,
  BANKING_PALETTE.success,
  BANKING_PALETTE.warn,
  BANKING_PALETTE.danger,
  BANKING_PALETTE.deep,
];

/** Deterministic slice/series colour for a given index (wraps, tolerates negatives). */
export function seriesColor(index: number): string {
  const n = SERIES_COLORS.length;
  return SERIES_COLORS[((Math.trunc(index) % n) + n) % n];
}

/** True when there is nothing meaningful to plot: no points, or every value is 0/NaN. */
export function isChartEmpty(values: readonly number[]): boolean {
  return values.length === 0 || values.every((v) => !v || Number.isNaN(v));
}

export interface ChartFrameProps {
  /** Rendered height in px. */
  height: number;
  /** When false, no chart is rendered — a neutral placeholder is shown instead. */
  active: boolean;
  className?: string;
  children: ReactElement;
}

/**
 * Shared chart shell: wraps a single Recharts chart in a responsive container of a fixed
 * height, or renders a neutral light-grey placeholder when there is nothing to plot.
 */
export function ChartFrame(p: ChartFrameProps) {
  if (!p.active) {
    return (
      <div
        className={p.className}
        style={{ width: '100%', height: p.height, background: BANKING_PALETTE.light }}
        role="img"
        aria-label="暂无可展示的数据"
      />
    );
  }
  return (
    <div className={p.className} style={{ width: '100%', height: p.height }}>
      <ResponsiveContainer width="100%" height={p.height}>
        {p.children}
      </ResponsiveContainer>
    </div>
  );
}

/** One entry in a Recharts tooltip payload (`payload` keeps the original datum). */
export interface ChartTooltipItem {
  name?: string | number;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  /** Original datum (e.g. a `CategorySpend`) for composite labels. */
  payload?: unknown;
}

export interface ChartTooltipProps {
  active?: boolean;
  payload?: ChartTooltipItem[];
  label?: string | number;
  /**
   * Formats one item's value. Defaults to `formatCNY(Number(value))`.
   * `item.payload` exposes the original datum for composite labels.
   */
  formatter?: (value: number, item: ChartTooltipItem) => string;
}

/** Shared styled tooltip content: banking colours, money formatted via `formatCNY`. */
export function ChartTooltip(p: ChartTooltipProps) {
  if (!p.active || !p.payload || p.payload.length === 0) return null;

  return (
    <div className="rounded-lg border border-banking-navy/10 bg-white px-3 py-2 shadow-md">
      {p.label !== undefined && p.label !== null && p.label !== '' ? (
        <p className="mb-1 text-xs font-semibold text-banking-deep">{p.label}</p>
      ) : null}
      <ul className="space-y-0.5">
        {p.payload.map((item, i) => {
          const value = Number(item.value);
          const safe = Number.isFinite(value) ? value : 0;
          const text = p.formatter ? p.formatter(safe, item) : formatCNY(safe);
          return (
            <li key={i} className="flex items-center gap-2 text-xs text-banking-navy">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: item.color ?? BANKING_PALETTE.accent }}
              />
              <span>{item.name}</span>
              <span className="ml-auto pl-3 font-medium text-banking-deep">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
