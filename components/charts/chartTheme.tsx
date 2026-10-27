'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { formatCNY, moneyToChartNumber } from '@/lib/money';
import { addDecimal, compareDecimal, divideDecimal, formatDecimalCNY } from '@/lib/decimal';
import { useI18n } from '@/lib/i18n/LocaleProvider';

/**
 * Private shared chart chrome for the wrappers in `./charts`.
 *
 * NOT part of the public barrel (`./index.ts`) — internal to this node only, so the four
 * chart files reuse one source of truth instead of copy-pasting palette/tooltip logic.
 *
 * Brand and status colours mirror the CSS theme in `app/globals.css`. Chart labels and series
 * combine warm and cool supporting colours; categories never borrow success/failure semantics.
 */
export const BANKING_PALETTE = {
  deep: '#3E3430',
  navy: '#786B63',
  plot: '#5E8988',
  accent: '#C8383C',
  success: '#16A34A',
  warn: '#F59E0B',
  danger: '#B42318',
  light: '#FBF8F5',
} as const;

/** Descriptive category colours; separate from brand emphasis and security status colours. */
export const SERIES_COLORS: readonly string[] = [
  '#6F9E9A', '#D5A069', '#A294B5', '#C68D87', '#9DAF91',
  '#8CABC0', '#CAB680', '#AD9984', '#B5A7BF', '#D7B79F',
];

/** Deterministic slice/series colour for a given index (wraps, tolerates negatives). */
export function seriesColor(index: number): string {
  const n = SERIES_COLORS.length;
  return SERIES_COLORS[((Math.trunc(index) % n) + n) % n];
}

/** True when there is nothing meaningful to plot: no points, or every value is 0/NaN. */
export function isChartEmpty(values: readonly number[]): boolean {
  return values.length === 0 || values.every((value) => !Number.isFinite(value) || value === 0);
}

/** Shared numeric scaling is restricted to geometry; labels retain their original amounts. */
export function chartScale(values: readonly number[], top: number, bottom: number) {
  const finite = values.filter(Number.isFinite);
  const minimum = Math.min(0, ...finite);
  const maximum = Math.max(0, ...finite);
  const span = maximum - minimum || 1;
  return {
    minimum,
    maximum,
    y: (value: number) => bottom - ((value - minimum) / span) * (bottom - top),
  };
}

/** Axis labels use exact original amounts; midpoint geometry alone uses numeric coordinates. */
export function chartTicks(amounts: readonly string[]): Array<{ value: number; label: string }> {
  let minimum = '0.00';
  let maximum = '0.00';
  for (const amount of amounts) {
    if (compareDecimal(amount, minimum) < 0) minimum = amount;
    if (compareDecimal(amount, maximum) > 0) maximum = amount;
  }
  const minimumCoordinate = moneyToChartNumber(minimum);
  const maximumCoordinate = moneyToChartNumber(maximum);
  const midpoint = divideDecimal(addDecimal(minimum, maximum), '2');
  return [
    { value: minimumCoordinate, label: formatDecimalCNY(minimum) },
    { value: (minimumCoordinate + maximumCoordinate) / 2, label: formatDecimalCNY(midpoint) },
    { value: maximumCoordinate, label: formatDecimalCNY(maximum) },
  ];
}

/** Match SVG coordinate units to CSS pixels so wide plots do not enlarge text. */
export function useChartWidth() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => {
      const measured = Math.round(container.getBoundingClientRect().width);
      if (measured > 0) setWidth(measured);
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(container);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  return { width, containerRef };
}

/** Hover, focus and tap share one exact financial tooltip. */
export function useChartTooltip() {
  const [tooltip, setTooltip] = useState<ChartTooltipProps>();
  const clear = () => setTooltip(undefined);
  return {
    tooltip: tooltip ? <ChartTooltip {...tooltip} active /> : null,
    point: (label: string, amount: string, color: string, suffix?: string) => ({
      tabIndex: 0,
      role: 'img' as const,
      'aria-label': `${label}: ${formatCNY(amount)}${suffix ? ` · ${suffix}` : ''}`,
      onMouseEnter: () => setTooltip({ label, entries: [{ amount, color, label: suffix }] }),
      onMouseLeave: clear,
      onFocus: () => setTooltip({ label, entries: [{ amount, color, label: suffix }] }),
      onBlur: clear,
      onClick: () => setTooltip({ label, entries: [{ amount, color, label: suffix }] }),
      onKeyDown: (event: KeyboardEvent<SVGElement>) => {
        if (event.key === 'Escape') clear();
      },
    }),
  };
}

export interface ChartFrameProps {
  /** Rendered height in px. */
  height: number;
  /** When false, no chart is rendered — a neutral placeholder is shown instead. */
  active: boolean;
  className?: string;
  children: ReactNode;
  tooltip?: ReactNode;
  containerRef?: Ref<HTMLDivElement>;
}

/**
 * Shared chart shell; Cartesian charts measure its width to keep labels at a readable pixel size.
 */
export function ChartFrame(p: ChartFrameProps) {
  const { t } = useI18n();
  if (!p.active) {
    return (
      <div
        ref={p.containerRef}
        className={p.className}
        style={{ width: '100%', height: p.height, background: BANKING_PALETTE.light }}
        role="img"
        aria-label={t('chart.empty')}
      />
    );
  }
  return (
    <div ref={p.containerRef} className={`relative min-w-0 ${p.className ?? ''}`} style={{ width: '100%', height: p.height }}>
      {p.children}
      {p.tooltip ? <div className="pointer-events-none absolute right-2 top-2 z-10 max-w-full">{p.tooltip}</div> : null}
    </div>
  );
}

/** Tooltip entries always contain the original exact decimal amount. */
export interface ChartTooltipEntry {
  amount: string;
  label?: string;
  color?: string;
}

export interface ChartTooltipProps {
  active?: boolean;
  entries: ChartTooltipEntry[];
  label?: string;
}

/** Shared styled tooltip content: banking colours, money formatted via `formatCNY`. */
export function ChartTooltip(p: ChartTooltipProps) {
  if (!p.active || p.entries.length === 0) return null;

  return (
    <div role="tooltip" className="rounded-lg border border-banking-navy/10 bg-white px-3 py-2 shadow-md">
      {p.label !== undefined && p.label !== null && p.label !== '' ? (
        <p className="mb-1 text-xs font-semibold text-banking-deep">{p.label}</p>
      ) : null}
      <ul className="space-y-0.5">
        {p.entries.map((item, i) => {
          return (
            <li key={i} className="flex items-center gap-2 text-xs text-banking-navy">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ background: item.color ?? BANKING_PALETTE.accent }}
              />
              <span>{item.label}</span>
              <span className="ml-auto pl-3 font-medium text-banking-deep">{formatCNY(item.amount)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
