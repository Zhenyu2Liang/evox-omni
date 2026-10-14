# components/banking — Read-model tiles & banners

## Intent

Presentational **bank tiles, lists and banners** that render server-fetched read models (SDK DTOs)
for the dashboard, bills, cards, subscriptions pages and as embedded chat cards. Pure display:
data in via props, no fetching, no DB, no risk decisions. These localized client leaves use
`useI18n` only for display text. Optional action callbacks remain owned by their caller.

## API Surface

All named exports, re-exported from `./index.ts`. SDK DTO types imported **type-only** from `@/banking-sdk`.

```ts
// AssetSummaryCard.tsx — total assets / 活期余额 / 信用卡额度 / 本月消费
export interface AssetSummaryCardProps { summary: DashboardSummary; className?: string; }
export function AssetSummaryCard(p: AssetSummaryCardProps): JSX.Element;  // Localized client leaf

// RecentTransactions.tsx — transaction list (uses ui/Table or a list); money via ui/Money
export interface RecentTransactionsProps { transactions: TransactionView[]; limit?: number;
  title?: ReactNode; className?: string; }
export function RecentTransactions(p: RecentTransactionsProps): JSX.Element; // Localized client leaf

// CardTile.tsx — one bank card (number masked, status, limits, credit line)
export interface CardTileProps { card: CardView; className?: string; }
export function CardTile(p: CardTileProps): JSX.Element;                   // Localized client leaf

// SubscriptionTile.tsx — one subscription (amount, cycle, next charge, remind)
export interface SubscriptionTileProps { subscription: SubscriptionView; className?: string; }
export function SubscriptionTile(p: SubscriptionTileProps): JSX.Element;   // Localized client leaf

// InvestmentProductTile.tsx — a product / holding (risk level, expected rate, term, amount)
export interface InvestmentProductTileProps { product: ProductView; holding?: HoldingView;
  className?: string; }
export function InvestmentProductTile(p: InvestmentProductTileProps): JSX.Element; // Localized client leaf

// AnomalyBanner.tsx — suspicious-spend banner; optional actions
export interface AnomalyBannerProps { anomaly: AnomalyItem;
  onAcknowledge?: () => void; onViewDetail?: () => void; onFreeze?: () => void; className?: string; }
export function AnomalyBanner(p: AnomalyBannerProps): JSX.Element;        // Callbacks optional

// AgentTaskTimeline.tsx — DAG step timeline (✓/○ per node) from a TaskPlan / its results
export interface AgentTaskTimelineProps { plan?: TaskPlan; results?: TaskNodeResult[];
  className?: string; }
export function AgentTaskTimeline(p: AgentTaskTimelineProps): JSX.Element; // Localized client leaf
```

`TaskPlan`/`TaskNodeResult` come from `@/lib/contracts/task`.

## Constraints

- **Presentational**: no `fetch`, no `prisma`, no `banking-sdk` imports except **type-only** DTOs.
- **Money** via `ui/Money`; **statuses/tiers** via `ui/Badge`/`ui/StatusBadge`; surfaces via `ui/Card`.
- Tiles are localized Client Components. Their only hook is `useI18n`; server pages pass
  serializable read-model props. Optional `AnomalyBanner` action callbacks come from a client
  ancestor. Do not add data fetching, database access or business decisions to these leaves.
- **Empty/zero cases**: render an `ui/EmptyState` (or nothing) rather than crashing on empty arrays.
- Named exports only; one tile per file; files ≲ ~1000 lines.

## Test Strategy

- Covered by RTL render tests under the root `tests/` suite with fixture DTOs (assert key amounts,
  statuses, masked numbers). No logic beyond formatting → low test surface.
- `AgentTaskTimeline` step mapping (status → ✓/○ + label) is the one behavioural bit to assert.

## Routing Table

- `./AssetSummaryCard.tsx` `./RecentTransactions.tsx` `./CardTile.tsx` `./SubscriptionTile.tsx`
  `./InvestmentProductTile.tsx` `./AnomalyBanner.tsx` `./AgentTaskTimeline.tsx` → the tiles above
- `./index.ts` → re-exports all tiles
- `../chat/cards/` → cards reuse these tiles (`CardsCard`→`CardTile`, etc.) (sibling — read-only)
- `../../app/` → dashboard/bills/cards/subscriptions pages render these tiles (sibling — read-only)
