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
export function PlanCard(p: PlanCardProps): JSX.Element;              // status timeline ↔ ../../banking + dependency section

export interface ErrorCardProps { message: string; code?: string; detail?: string; className?: string; }
export function ErrorCard(p: ErrorCardProps): JSX.Element;            // safe, agent-facing error surface
```

**PlanCard structure.** `PlanCard` renders the plan goal + the plan-level status badge, then the
per-node **status timeline** via the composed `../../banking/AgentTaskTimeline` (the single status→meta
source — it maps all 8 `TaskNodeStatus` to a distinct icon/label/tone and shows a failed node's
`result.error` inline), then a **dependency timeline**: one row per node whose `dependencies` are
resolved to node NAMES through an id→name map built from `plan.nodes` (`依赖于: …`, or
`起始节点（无依赖）` when empty; a dependency id not present in the plan falls back to the raw id).
That section carries relationship text only — no status glyphs.

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

## Known Issues

- `PlanCard` renders no confirmation/MFA action for a `waiting_confirmation`/`waiting_verification` node — a parked plan node surfaces only as the 待确认/待验证 badge (there is no [确认]/[取消] button; the confirm path lives in `ConfirmationCard`/`MfaCard`, which are only emitted for direct tool blocks — see `../CONTEXT.md` Known Issues).
- `PlanCard` is a passive plan VIEW by design (takes only `{ plan }`): a `waiting_confirmation`/`waiting_verification` node surfaces as the 待确认/待验证 badge and renders NO confirm/cancel buttons itself. The actionable human-decision for a parked plan node is rendered ONCE by `ChatWindow` from `stream.pendingAction` (driven by the `confirmation_required`/`mfa_required` events), reusing `ConfirmationCard`/`MfaCard` — see `../CONTEXT.md` "Human-decision card".

## Constraints

- **Exhaustiveness is mandatory**: `CardRenderer` switches on `card.type` with a `default` of
  `assertNever(card: never)`. Adding a `ChatCard` variant must break the build here.
- **All Client Components** (`'use client'`) — rendered inside the streaming chat.
- **Interactive cards never execute money movement themselves.** `ConfirmationCard`/`MfaCard` call the
  confirm/verify/cancel handlers passed from `../../chat/ChatWindow`, which POST to `./app` action routes.
  `AnomalyCard`'s `onAcknowledge`/`onViewDetail`/`onFreeze` are supplied by `ChatWindow` too and simply
  `stream.send(...)` an ordinary chat message (chat → agent → Security Gateway); 冻结银行卡 drives
  `freeze_card` → YELLOW confirmation. The browser only calls fetch; the server re-validates + executes.
- **MFA secrecy**: `MfaCard` renders `hint` only — never the code (`MFA_CODE` is server-side; do not import).
- **Money** via `Money`; **tiers** via `StatusBadge`; reuse `../../banking` tiles and `../../charts`
  rather than re-implementing tiles/charts inside cards.
- **No competing status→meta table**: node statuses are rendered only through the composed
  `../../banking/AgentTaskTimeline`; do not fork its mapping. `PlanCard`'s dependency section shows
  relationship text (node names), never status glyphs.
- Named exports only; one card per file; files ≲ ~1000 lines.

## Test Strategy

- Primary guard is **compile-time**: the `assertNever` default makes a new card variant a `tsc` error.
- RTL render tests under the root `tests/` suite render each card with a fixture `ChatCard` and assert
  key content (amount via `Money`, tier badge label, field rows, MFA hint present / code absent).
- `CardRenderer` dispatch test: each `card.type` renders its component; unknown key fails to compile.
- `PlanCard`'s dependency-label resolution (dep ids → node names, empty → `起始节点（无依赖）`, unknown id
  fallback) is the behavioural bit to assert; the timeline itself is delegated to `AgentTaskTimeline`.

## Routing Table

- `./types.ts` → card-data payload interfaces + `CardActionHandlers`
- `./CardRenderer.tsx` → the exhaustive `card.type` dispatcher
- `./BalanceCard.tsx` `./TransferCard.tsx` `./ConfirmationCard.tsx` `./MfaCard.tsx` `./SpendingCard.tsx`
  `./CardsCard.tsx` `./InvestmentsCard.tsx` `./SubscriptionsCard.tsx` `./AnomalyCard.tsx`
  `./PlanCard.tsx` `./ErrorCard.tsx` → the individual card renderers
- `./index.ts` → re-exports the cards, `CardRenderer`, and the types
- `../` → `ChatWindow`/`MessageBubble` render `CardRenderer` (parent — read-only)
- `../../banking/`, `../../charts/`, `../../ui/` → composed here (dependencies — read-only)
