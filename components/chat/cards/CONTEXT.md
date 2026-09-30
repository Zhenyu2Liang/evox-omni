# components/chat/cards — ChatCard renderers + dispatcher

## Intent

The **exhaustive renderers for the frozen `ChatCard` union** (`lib/contracts/agent.ts`) and the
`CardRenderer` dispatcher that switches on `card.type`. This is the only place that maps a `ChatCard`
variant to a component; every amount/status is rendered through `../../ui` primitives. All **Client
Components** (they sit inside the streaming chat surface).

## API Surface

Named exports, re-exported from `./index.ts`. `ChatCard`/`PendingActionSummary`/`TaskPlan` from
`@/lib/contracts/*`; SDK DTOs type-only from `@/banking-sdk`.

```ts
// types.ts — concrete payload shapes for the `data: unknown` fields + action-handler bundle
export interface BalanceCardData { balance: BalanceView; }
export interface TransferCardData { result: TransferResult; }
export interface SpendingCardData { analysis: SpendingAnalysis; }
export interface CardsCardData { cards: CardView[]; }
export interface InvestmentsCardData { products?: ProductView[]; holdings?: HoldingView[];
  comparison?: InvestmentComparison; }
export interface SubscriptionsCardData { subscriptions: SubscriptionView[]; }
export interface AnomalyCardData { report: AnomalyReport; }

/** Callbacks threaded from the chat container into interactive cards. */
export interface CardActionHandlers {
  actionId?: string;
  onConfirm?: (actionId: string) => void;
  onVerify?: (actionId: string, code: string) => void;
  onCancel?: (actionId: string) => void;
  onAcknowledge?: () => void;   // anomaly: 这是本人交易
  onViewDetail?: () => void;    // anomaly: 查看详情
  onFreeze?: () => void;        // anomaly: 冻结银行卡
  busy?: boolean;
  error?: string;
}

// CardRenderer.tsx — dispatches on card.type; default branch is assertNever(card) (compile-error on a new tier)
export interface CardRendererProps { card: ChatCard; action?: CardActionHandlers; className?: string; }
export function CardRenderer(p: CardRendererProps): JSX.Element;   // 'use client'
```

### The 11 card components (all `'use client'`, named exports)

```ts
export interface BalanceCardProps { data: BalanceView; className?: string; }
export function BalanceCard(p: BalanceCardProps): JSX.Element;        // total + per-account tiles

export interface TransferCardProps { data: TransferResult; className?: string; }
export function TransferCard(p: TransferCardProps): JSX.Element;      // recipient + amount + new balance

// confirmation = PendingActionSummary + actionId + [取消]/[确认] → confirj endpoint
export interface ConfirmationCardProps { action: PendingActionSummary; actionId?: string;
  onConfirm?: (actionId: string) => void; onCancel?: (actionId: string) => void;
  busy?: boolean; error?: string; className?: string; }
export function ConfirmationCard(p: ConfirmationCardProps): JSX.Element; // title + fields + tier badge

// MfaCard — RED verification; shows hint ONLY, never the code. [取消]/[验证]
export interface MfaCardProps { actionId: string; hint?: string;
  onSubmit?: (code: string) => void; onCancel?: (actionId: string) => void;
  busy?: boolean; error?: string; className?: string; }
export function MfaCard(p: MfaCardProps): JSX.Element;

export interface SpendingCardProps { data: SpendingAnalysis; className?: string; }
export function SpendingCard(p: SpendingCardProps): JSX.Element;      // composes ../../charts + top merchant

export interface CardsCardProps { data: CardView[]; className?: string; }
export function CardsCard(p: CardsCardProps): JSX.Element;            // renders ../../banking CardTile[]

export interface InvestmentsCardProps { data: InvestmentsCardData; className?: string; }
export function InvestmentsCard(p: InvestmentsCardProps): JSX.Element; // products/holdings/comparison tiles

export interface SubscriptionsCardProps { data: SubscriptionView[]; className?: string; }
export function SubscriptionsCard(p: SubscriptionsCardProps): JSX.Element; // SubscriptionTile[]

export interface AnomalyCardProps { data: AnomalyReport; onAcknowledge?: () => void;
  onViewDetail?: () => void; onFreeze?: () => void; className?: string; }
export function AnomalyCard(p: AnomalyCardProps): JSX.Element;        // [这是本人交易]/[查看详情]/[冻结银行卡]

export interface PlanCardProps { plan: TaskPlan; className?: string; }
export function PlanCard(p: PlanCardProps): JSX.Element;              // DAG timeline (✓/○) ↔ ../../banking

export interface ErrorCardProps { message: string; code?: string; detail?: string; className?: string; }
export function ErrorCard(p: ErrorCardProps): JSX.Element;            // safe, agent-facing error surface
```

## The exhaustive mapping (must stay in lock-step with the union)

| `ChatCard['type']` | payload narrowed to | component |
| --- | --- | --- |
| `balance` | `BalanceView` | `BalanceCard` |
| `transfer` | `TransferResult` | `TransferCard` |
| `confirmation` | `action: PendingActionSummary` | `ConfirmationCard` |
| `mfa` | `actionId`, `hint` | `MfaCard` |
| `spending` | `SpendingAnalysis` | `SpendingCard` |
| `cards` | `CardView[]` | `CardsCard` |
| `investments` | `InvestmentsCardData` | `InvestmentsCard` |
| `subscriptions` | `SubscriptionView[]` | `SubscriptionsCard` |
| `anomaly` | `AnomalyReport` | `AnomalyCard` |
| `plan` | `plan: TaskPlan` | `PlanCard` |
| `error` | `message: string` | `ErrorCard` |

`CardRenderer` narrows the frozen `data: unknown` field to the concrete DTO above; the `./app` serialiser
must populate `cards[].data` with exactly these shapes.

## Constraints

- **Exhaustiveness is mandatory**: `CardRenderer` switches on `card.type` with a `default` of
  `assertNever(card: never)`. Adding a `ChatCard` variant must break the build here.
- **All Client Components** (`'use client'`) — rendered inside the streaming chat.
- **Interactive cards never execute money movement themselves.** `ConfirmationCard`/`MfaCard` call the
  handlers passed from `../../chat/ChatWindow`, which POST to `./app` action routes. The browser only
  calls fetch; the server re-validates + executes.
- **MFA secrecy**: `MfaCard` renders `hint` only — never the code (`MFA_CODE` is server-side; do not import).
- **Money** via `Money`; **tiers** via `StatusBadge`; reuse `../../banking` tiles and `../../charts`
  rather than re-implementing tiles/charts inside cards.
- Named exports only; one card per file; files ≲ ~1000 lines.

## Test Strategy

- Primary guard is **compile-time**: the `assertNever` default makes a new card variant a `tsc` error.
- RTL render tests under the root `tests/` suite render each card with a fixture `ChatCard` and assert
  key content (amount via `Money`, tier badge label, field rows, MFA hint present / code absent).
- `CardRenderer` dispatch test: each `card.type` renders its component; unknown key fails to compile.
- `PlanCard` step status → ✓/○ mapping is the behavioural bit to assert.

## Routing Table

- `./types.ts` → card-data payload interfaces + `CardActionHandlers`
- `./CardRenderer.tsx` → the exhaustive `card.type` dispatcher
- `./BalanceCard.tsx` `./TransferCard.tsx` `./ConfirmationCard.tsx` `./MfaCard.tsx` `./SpendingCard.tsx`
  `./CardsCard.tsx` `./InvestmentsCard.tsx` `./SubscriptionsCard.tsx` `./AnomalyCard.tsx`
  `./PlanCard.tsx` `./ErrorCard.tsx` → the individual card renderers
- `./index.ts` → re-exports the cards, `CardRenderer`, and the types
- `../` → `ChatWindow`/`MessageBubble` render `CardRenderer` (parent — read-only)
- `../../banking/`, `../../charts/`, `../../ui/` → composed here (dependencies — read-only)
