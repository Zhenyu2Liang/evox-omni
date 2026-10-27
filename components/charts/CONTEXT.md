# Native SVG chart context

## Boundaries

Static chart accessibility titles and empty-state labels use `useI18n()` with the product locale.
Financial values and supplied category names remain authoritative DTO data; localization never
converts an amount or changes category identity.

The public barrel exports SpendingPie, SpendingBar, SpendingTrend and MiniSparkline. Charts only
render supplied SDK DTOs. They never fetch data or calculate business metrics. Native SVG viewBox
geometry handles responsive sizing without a chart library. Bar and trend charts use the private
useChartWidth hook to measure their container with ResizeObserver, with a window resize fallback.
Their viewBox matches the measured width and supplied height, keeping plots full-width and text
at a stable pixel size. Observers and fallback listeners disconnect on unmount.

Category charts accept CategorySpend[], trends accept MonthlyTrendPoint[], and sparklines accept
exact MoneyInput[] strings. Public props include data, height and className; sparklines also accept
color. Each interactive leaf is a client component; the barrel remains neutral.

## Invariants

- Chart category series use terracotta, apricot, gold and rose; they do not reuse exact risk colours.
  Donut slices and bars share the same indexed category palette. Trends use terracotta with a light
  area fill to the zero baseline. Hovering or focusing a point highlights it in brand red.
  Values, exact labels and keyboard tooltip behaviour are independent of the colour change.

- Only geometry uses moneyToChartNumber. Tooltip, legend, SVG title and accessible labels retain
  the original exact amounts through formatCNY. Never derive financial labels from coordinates.
- chartTheme.tsx owns colors, scale, empty state and tooltip. Scale includes a zero baseline and
  places negative and positive values on opposite sides. `chartTicks` seeds minimum and maximum from
  `'0.00'`, so the minimum tick is zero or negative; its midpoint label is
  `divideDecimal(addDecimal(minimum, maximum), '2')` (`chartTheme.tsx:71`). `addDecimal` accepts
  signed decimal text and applies no nonnegative gate, so tick text may carry a minus sign.
- Bar, trend and donut points support hover, focus and tap. Escape hides the tooltip. Each point
  has an accessible name containing its full exact amount.
- Share values come from the SDK. Only positive shares are drawn; legends retain original data.
- Empty and all-zero series show a neutral placeholder. Single-point series never divide by zero.
- Private ChartTooltip accepts exact string entries, without chart-library callback payloads.

## Validation

tests/unit/planner/chart-presentation.test.ts checks maximum cents, single points, refunds and empty
states. financial-display.test.ts checks exact tooltip values. The browser acceptance suite checks
chart layout and keyboard tooltip interaction. SQLite test processes must run sequentially.

Human documentation: docs/cn/development.md and docs/cn/financial-values.md.
