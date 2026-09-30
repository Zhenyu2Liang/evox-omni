# components/charts — Recharts wrappers

## Intent

Thin, responsive **Recharts** wrappers that visualise spend analytics. Each takes plain SDK DTO
data (no fetching) and renders one chart. All are **Client Components** (Recharts needs the DOM).

## API Surface

All named exports, re-exported from `./index.ts`. Shared wrapper chrome (responsive container,
banking palette, tooltip styling, empty-data guard) lives in the private local `./chartTheme.tsx`.

```ts
// SpendingPie.tsx — category share donut, fed by SpendingAnalysis.byCategory (CategorySpend[])
export interface SpendingPieProps { data: CategorySpend[]; height?: number; className?: string; }
export function SpendingPie(p: SpendingPieProps): JSX.Element;          // 'use client'

// SpendingBar.tsx — horizontal/vertical bar of category totals
export interface SpendingBarProps { data: CategorySpend[]; height?: number; className?: string; }
export function SpendingBar(p: SpendingBarProps): JSX.Element;          // 'use client'

// SpendingTrend.tsx — monthly trend line, fed by SpendingAnalysis.monthlyTrend (MonthlyTrendPoint[])
export interface SpendingTrendProps { data: MonthlyTrendPoint[]; height?: number; className?: string; }
export function SpendingTrend(p: SpendingTrendProps): JSX.Element;      // 'use client'

// MiniSparkline.tsx — bare sparkline for compact tiles (no axes/grid)
export interface MiniSparklineProps { data: number[]; height?: number; color?: string; className?: string; }
export function MiniSparkline(p: MiniSparklineProps): JSX.Element;      // 'use client'
```

Types `CategorySpend`, `MonthlyTrendPoint` are imported **type-only** from `@/banking-sdk`.

## Constraints

- **Client Components** — every file starts with `'use client'` (Recharts is browser-only).
- **Props only** — no data fetching, no DB, no `banking-sdk` calls. Data is passed in.
- Charts are **responsive** (wrap in Recharts `ResponsiveContainer`); empty data renders nothing/a
  neutral placeholder, never throws.
- Use only the Tailwind `banking` palette colours for series; money axes/tooltips use `lib/money.formatCNY`.
- Reusable chart chrome lives in the private local helper `./chartTheme.tsx` (`BANKING_PALETTE`,
  `SERIES_COLORS`/`seriesColor`, `ChartFrame` = ResponsiveContainer + empty-data placeholder,
  `ChartTooltip`, `isChartEmpty`); it is NOT exported from `./index.ts`. Do not copy-paste it into
  each chart file.
- Named exports only; one chart per file.

## Test Strategy

- Not snapshot-tested (Recharts DOM output is brittle). Covered structurally: components render with
  fixture `CategorySpend[]`/`MonthlyTrendPoint[]` without throwing (RTL smoke test under root `tests/`).
- Data-shaping (e.g. percent maths) belongs in `banking-sdk`, not here — keep charts dumb.

## Routing Table

- `./SpendingPie.tsx` `./SpendingBar.tsx` `./SpendingTrend.tsx` `./MiniSparkline.tsx` → the chart wrappers
- `./index.ts` → re-exports all charts (the 4 public charts only — `chartTheme.tsx` stays private)
- `./chartTheme.tsx` → private shared chart chrome (palette, ResponsiveContainer wrapper, styled tooltip, empty guard)
- `../chat/cards/` → `SpendingCard` composes `SpendingPie` + `SpendingTrend` (sibling — read-only)
- `../../app/bills/` → the `/bills` page is the primary consumer: renders all four charts (`SpendingPie`, `SpendingBar`, `SpendingTrend`, `MiniSparkline`) from real `banking.transaction.analyzeSpending` output (sibling — read-only)
- `../banking/` → no banking tile embeds a chart today (`MiniSparkline` is used by `app/bills`, not by tiles) (sibling — read-only)
