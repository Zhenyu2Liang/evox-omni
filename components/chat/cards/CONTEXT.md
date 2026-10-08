# components/chat/cards — ChatCard renderers + dispatcher

## Intent

The **exhaustive renderers for the frozen `ChatCard` union** (`lib/contracts/agent.ts`) and the
`CardRenderer` dispatcher that switches on `card.type`. This is the only place that maps a `ChatCard`
variant to a component; every amount/status is rendered through `../../ui` primitives. All **Client
Components** (they sit inside the streaming chat surface).

It also holds `ReconciliationCard` — a NON-union, actionless card for a terminal `needs_reconciliation`
action. It is NOT a `ChatCard` variant and is NOT dispatched by `CardRenderer`; `ChatWindow` renders it
directly (see below).

Two pure, non-`'use client'` helper modules live here too: `./confirmationStatus.ts` (the terminal
status → badge mapping used by `ConfirmationCard`) and `./maskPhone.ts` (phone 脱敏 used by
`TransferCard`).

## API Surface

Named exports, re-exported from `./index.ts`. `ChatCard`/`PendingActionSummary`/`PendingActionStatus`/
`TaskPlan` from `@/lib/contracts/*`; SDK DTOs type-only from `@/banking-sdk`.

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

/** Control action requested from a plan card's task-control buttons. */
export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'retry';

/** Callbacks threaded from the chat container into interactive cards. */
export interface CardActionHandlers {
  actionId?: string;
  onConfirm?: (actionId: string) => void;
  onVerify?: (actionId: string, code: string) => void;
  onCancel?: (actionId: string) => void;
  onAcknowledge?: () => void;   // anomaly: 这是本人交易
  onViewDetail?: () => void;    // anomaly: 查看详情
  onFreeze?: () => void;        // anomaly: 冻结银行卡
  onTaskControl?: (action: TaskControlAction) => void;  // plan: pause/resume/cancel/retry
  mfaAttempts?: number;         // MFA: failed verification attempts so far
  busy?: boolean;
  error?: string;
}

// CardRenderer.tsx — dispatches on card.type; default branch is assertNever(card) (compile-error on a new tier)
export interface CardRendererProps { card: ChatCard; action?: CardActionHandlers; className?: string; }
export function CardRenderer(p: CardRendererProps): JSX.Element;   // 'use client'
```

```ts
// confirmationStatus.ts — pure terminal-status → badge mapping (NO 'use client')
export type BadgeTone = NonNullable<BadgeProps['tone']>;   // the ui/Badge tone union, re-used
export type TerminalActionStatus = 'executed' | 'failed' | 'cancelled' | 'needs_reconciliation';
export function isTerminalStatus(value: unknown): value is TerminalActionStatus;
export function asTerminalStatus(value: unknown): TerminalActionStatus | undefined;
export interface TerminalStatusView { tone: BadgeTone; label: string; explanation?: string; }
export const RECONCILIATION_EXPLANATION: string;   // the needs_reconciliation one-liner
export function terminalStatusView(status: TerminalActionStatus, reason?: string): TerminalStatusView;

// maskPhone.ts — pure phone 脱敏 helper (NO 'use client')
export function maskPhone(phone?: string | null): string;
```

### The 11 `ChatCard` renderers (all `'use client'`, named exports)

```ts
export interface BalanceCardProps { data: BalanceView; className?: string; }
export function BalanceCard(p: BalanceCardProps): JSX.Element;        // total + per-account tiles

export interface TransferCardProps { data: TransferResult; className?: string; }
export function TransferCard(p: TransferCardProps): JSX.Element;      // recipient (masked phone) + amount + new balance

// confirmation = PendingActionSummary + actionId + [取消]/[确认] → confirm endpoint.
// A TERMINAL `status` replaces the buttons with a status badge (see "ConfirmationCard — terminal-status rendering").
export interface ConfirmationCardProps { action: PendingActionSummary; actionId?: string;
  onConfirm?: (actionId: string) => void; onCancel?: (actionId: string) => void;
  busy?: boolean; error?: string; status?: PendingActionStatus; statusMessage?: string; className?: string; }
export function ConfirmationCard(p: ConfirmationCardProps): JSX.Element; // title + fields + tier badge (+ terminal badge instead of buttons)

// MfaCard — RED verification; shows hint ONLY, never the code. [取消]/[验证]
export interface MfaCardProps { actionId: string; hint?: string;
  onSubmit?: (code: string) => void; onCancel?: (actionId: string) => void;
  busy?: boolean; error?: string; attempts?: number; maxAttempts?: number; className?: string; }
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

export interface PlanCardProps { plan: TaskPlan; onControl?: (action: TaskControlAction) => void;
  busy?: boolean; className?: string; }
export function PlanCard(p: PlanCardProps): JSX.Element;              // status timeline ↔ ../../banking + dependency section + task-control footer

export interface ErrorCardProps { message: string; code?: string; detail?: string; className?: string; }
export function ErrorCard(p: ErrorCardProps): JSX.Element;            // safe, agent-facing error surface
```

### `ConfirmationCard` — terminal-status rendering

`ConfirmationCard` reads the action's status so a SETTLED gated action can never keep looking
actionable. The status is taken from, in order: the `status` PROP, else a runtime `status` field the
chat layer stamps onto the inline card's `action` object. `PendingActionSummary` is FROZEN and has no
such field, so it is read structurally through a LOCAL type (`PendingActionSummary & { status?:
unknown; message?: unknown }`) — the contract is never edited. The optional one-line explanation comes
from the `statusMessage` PROP, else the runtime `action.message`. **Props win over the runtime fields
in both cases.** The per-status logic lives in the pure, unit-testable `./confirmationStatus.ts`
(`isTerminalStatus` / `asTerminalStatus` / `terminalStatusView`, with an `assertNever` guard so a new
terminal status is a compile error).

| `status` | kind | footer | body |
| --- | --- | --- | --- |
| *(absent)* | non-terminal | 取消 + 确认 buttons (unchanged) | fields + amount |
| `pending` / `awaiting_mfa` / `confirmed` / `locked` | non-terminal | 取消 + 确认 buttons (unchanged) | fields + amount |
| `executed` | terminal | `Badge tone="success"` → 已执行 | fields + amount |
| `failed` | terminal | `Badge tone="danger"` → 失败 | + the failure reason line ONLY when a non-empty `reason` is supplied |
| `cancelled` | terminal | `Badge tone="neutral"` → 已取消 | fields + amount |
| `needs_reconciliation` | terminal | `Badge tone="warn"` → 需人工核对 | + the standard one-liner `该操作结果未能确认，需人工核对处理。` |

The tier `<StatusBadge>` in the title and the `fields`/`amount` body render are UNCHANGED for every
status; the existing `error` prop still renders as a danger `Badge`. Terminal statuses never claim more
than the server says (`executed` says only 已执行). Colours come ONLY from `ui/Badge` tones via the
local `BadgeTone = NonNullable<BadgeProps['tone']>` — never hard-coded.

### Phone masking — `./maskPhone.ts`

`TransferCard` renders the recipient phone through `maskPhone(phone)` (脱敏) so a full number is never
shown in the chat. Rules: absent / empty / whitespace-only → `''`; trimmed length ≤ 4 → `'****'`;
5–10 chars → first 2 + `*`-masked middle + last 2 (7 chars → `'13***45'`); ≥ 11 chars → first 3 +
exactly 4 stars + last 4 (11-digit → `'138****5678'`). Pure and unit-testable.

### `ReconciliationCard` — the non-union, actionless card

`ReconciliationCard` renders a TERMINAL `needs_reconciliation` action: a gated side effect that MAY have
committed but whose outcome could not be recorded, so a human must reconcile it out-of-band. It is
deliberately ACTIONLESS — NO 确认/取消, NO code input, NO button that sends a chat message — so the
operation is never re-invoked and the browser never executes a banking op. It is visually distinct from
`ConfirmationCard` (🟡 tier badge + 确认/取消) and `MfaCard` (🔴 code entry) via an amber warning banner
and a left accent border (never a `StatusBadge`), so it can never be mistaken for a live 🟡/🔴 decision.

It is NOT a `ChatCard` variant and `CardRenderer` never dispatches to it (the union is unchanged); the
`../../chat/ChatWindow` renders one per restored `pendingReconciliations` entry.

```ts
export interface ReconciliationCardProps { action: PendingActionSummary; actionId?: string; className?: string; }
export function ReconciliationCard(p: ReconciliationCardProps): JSX.Element; // 'use client'
```

**PlanCard structure.** `PlanCard` renders the plan goal + the plan-level status badge, then the
per-node **status timeline** via the composed `../../banking/AgentTaskTimeline` (the single status→meta
source — it maps all 8 `TaskNodeStatus` to a distinct icon/label/tone and shows a failed node's
`result.error` inline), then a **dependency timeline**: one row per node whose `dependencies` are
resolved to node NAMES through an id→name map built from `plan.nodes` (`依赖于: …`, or
`起始节点（无依赖）` when empty; a dependency id not present in the plan falls back to the raw id).
That section carries relationship text only — no status glyphs.

`PlanCard` then renders a **task-control footer**, conditioned on `plan.status`:
`running | pending | waiting_confirmation` → 暂停 + 取消; `paused` → 继续 + 取消; `failed` → 重试;
`success | cancelled` → no footer. The buttons are `ui/Button` (secondary for 暂停/继续/重试, danger for
取消), all disabled while `busy` (and when no `onControl` is supplied). They only invoke the injected
`onControl(TaskControlAction)` handler — the browser never mutates the task itself.

`MfaCard` optionally renders the failed-attempt count (`验证失败，已尝试 N 次（共 M 次）`) when
`attempts > 0` and, when provided, `maxAttempts`.

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
must populate `cards[].data` with exactly these shapes. It also threads the shared `CardActionHandlers`
into the interactive cards (`onControl`/`busy` → `PlanCard`; `mfaAttempts` → `MfaCard.attempts`). The
`confirmation` case passes `action={p.card.action}` only — `ConfirmationCard` reads the action's runtime
`status`/`message` fields itself, so no `CardRenderer` change is needed. Note: the `plan` renderer here
is NOT the live plan path — a `plan` card is promoted into `activePlan` and rendered ONCE by
`../../chat/ChatWindow` (see `../CONTEXT.md` "Plan dedupe" and "Human-decision card").
`ReconciliationCard` is intentionally NOT a variant of this union (it is not agent-emitted — it is a
client-side restore surface; see the section above).

## Known Issues

- `PlanCard`'s task-control footer acts on the WHOLE plan (`pause`/`resume`/`cancel`/`retry`), distinct from the per-NODE human decision: a `waiting_confirmation`/`waiting_verification` node surfaces as the 待确认/待验证 badge and renders NO node-level confirm/cancel buttons. The actionable human-decision for a parked plan node is rendered ONCE by `ChatWindow` from `stream.pendingAction` (driven by the `confirmation_required`/`mfa_required` events), reusing `ConfirmationCard`/`MfaCard` — see `../CONTEXT.md` "Human-decision card".

## Constraints

- **Exhaustiveness is mandatory**: `CardRenderer` switches on `card.type` with a `default` of
  `assertNever(card: never)`. Adding a `ChatCard` variant must break the build here.
- **All Client Components** (`'use client'`) — rendered inside the streaming chat. The two helper
  modules (`confirmationStatus.ts`, `maskPhone.ts`) are PURE and carry NO directive (like `types.ts`).
- **Interactive cards never execute money movement themselves.** `ConfirmationCard`/`MfaCard` call the
  confirm/verify/cancel handlers passed from `../../chat/ChatWindow`, which POST to `./app` action routes.
  `PlanCard`'s task-control footer likewise calls the injected `onControl` only. `AnomalyCard`'s
  `onAcknowledge`/`onViewDetail`/`onFreeze` are supplied by `ChatWindow` too and simply
  `stream.send(...)` an ordinary chat message (chat → agent → Security Gateway); 冻结银行卡 drives
  `freeze_card` → YELLOW confirmation. The browser only calls fetch; the server re-validates + executes.
- **Terminal-status-aware `ConfirmationCard`**: a terminal status (the `status` prop, else the runtime
  `action.status`) hides 取消/确认 and shows a `ui/Badge` status pill; statuses and their tones come from
  `./confirmationStatus.ts` only — never hard-code a tier/status colour.
- **Phone numbers are masked**: `TransferCard` renders recipient phones via `./maskPhone.ts`; never
  render a raw phone number.
- **MFA secrecy**: `MfaCard` renders `hint` + the failed-attempt count only — never the code
  (`MFA_CODE` is server-side; do not import).
- **`ReconciliationCard` is actionless and non-union.** It renders a terminal `needs_reconciliation`
  action with no confirm/cancel/MFA and is never dispatched by `CardRenderer`; `ChatWindow` renders it
  directly from `pendingReconciliations`.
- **Money** via `Money`; **tiers** via `StatusBadge`; reuse `../../banking` tiles and `../../charts`
  rather than re-implementing tiles/charts inside cards.
- **No competing status→meta table**: node statuses are rendered only through the composed
  `../../banking/AgentTaskTimeline`; do not fork its mapping. `PlanCard`'s dependency section shows
  relationship text (node names), never status glyphs.
- Named exports only; one card per file; files ≲ ~1000 lines.

## Test Strategy

- Primary guard is **compile-time**: the `assertNever` default makes a new card variant a `tsc` error,
  the `Record<TaskPlanStatus, …>` label/tone maps are exhaustive over the frozen plan statuses, and
  `terminalStatusView`'s `assertNever` makes a new `TerminalActionStatus` a `tsc` error.
- `./confirmationStatus.ts` (`isTerminalStatus`/`asTerminalStatus`/`terminalStatusView`) and
  `./maskPhone.ts` are PURE — unit-testable without a DOM (terminal/non-terminal classification, the
  `failed` reason only when non-empty, the `needs_reconciliation` one-liner, and each masking length band).
- RTL render tests under the root `tests/` suite render each card with a fixture `ChatCard` and assert
  key content (amount via `Money`, tier badge label, field rows, MFA hint present / code absent).
- `CardRenderer` dispatch test: each `card.type` renders its component; unknown key fails to compile.
- `ReconciliationCard` render test: a terminal `needs_reconciliation` `PendingActionSummary` renders the
  amber warning + fields/amount with NO confirm/cancel/MFA control.
- `ConfirmationCard` render test: a runtime terminal `status` on `action` (or the `status` prop) hides
  取消/确认 and shows the matching `Badge` label; a non-terminal/absent status keeps the buttons.
- `PlanCard`'s dependency-label resolution (dep ids → node names, empty → `起始节点（无依赖）`, unknown id
  fallback) is the behavioural bit to assert; the timeline itself is delegated to `AgentTaskTimeline`.
  Its status→control mapping (`controlActionsFor`) and emitted `TaskControlAction`s are also behavioural.

## Routing Table

- `./types.ts` → card-data payload interfaces + `TaskControlAction` + `CardActionHandlers`
- `./confirmationStatus.ts` → pure terminal-status → badge mapping for `ConfirmationCard` (`isTerminalStatus`/`asTerminalStatus`/`terminalStatusView`/`BadgeTone`/`TerminalStatusView`/`RECONCILIATION_EXPLANATION`)
- `./maskPhone.ts` → pure phone 脱敏 helper used by `TransferCard`
- `./CardRenderer.tsx` → the exhaustive `card.type` dispatcher
- `./BalanceCard.tsx` `./TransferCard.tsx` `./ConfirmationCard.tsx` `./MfaCard.tsx` `./SpendingCard.tsx`
  `./CardsCard.tsx` `./InvestmentsCard.tsx` `./SubscriptionsCard.tsx` `./AnomalyCard.tsx`
  `./PlanCard.tsx` `./ErrorCard.tsx` → the individual `ChatCard` renderers
- `./ReconciliationCard.tsx` → the non-union, actionless terminal-`needs_reconciliation` card (rendered by `../ChatWindow`, not `CardRenderer`)
- `./index.ts` → re-exports the cards, `CardRenderer`, the status/masking helpers, and the types (barrel stays NEUTRAL — no `'use client'`)
- `../` → `ChatWindow`/`MessageBubble` render `CardRenderer` (parent — read-only)
- `../../banking/`, `../../charts/`, `../../ui/` → composed here (dependencies — read-only)
