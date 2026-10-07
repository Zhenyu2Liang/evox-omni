# components — AI Banking Agent UI Component Library

## Intent

The **presentational + light-client-state React component layer** for the AI Banking Agent demo.
It renders the chat surface, the ChatGPT-style card renderers, bank tiles and charts, and the
security visualisations. It is consumed by `./app` pages/routes and owns **no business logic,
no persistence, no risk decisions** — it displays data it is given and calls the app's API routes
for actions.

Design language (from root `./CONTEXT.md`): modern digital-banking fintech — deep-blue + white +
light-grey, rounded cards, soft shadows, charts, status badges, `¥` money, 🟢🟡🔴 for permission
tiers. Tailwind palette lives in `tailwind.config.ts` (`bg-banking-deep`, `text-banking-navy`,
`bg-banking-accent`, `bg-banking-success/warn/danger`, `bg-banking-light`; `rounded-xl`/`rounded-2xl`).

Two hard rules that shape the whole subtree:
1. **No `prisma` import, ever.** Components never touch the DB or `banking-sdk` write functions.
   Data arrives via **props** (server-fetched read models) or via **`fetch`** to `./app` API routes.
2. **Typed against frozen contracts.** All cross-module types are imported from `./lib/contracts/*`
   and the SDK DTOs from `./banking-sdk` (type-only). Never redeclare or fork a contract type.

## API Surface

Barrel facade: `components/index.ts` re-exports every public component and, from `./chat/cards`,
the card-data payload types and action-handler types. Sub-barrels re-export each child node.

Primary public exports (grouped — full per-component prop signatures live in each child CONTEXT.md):

- Chat surface (`./chat`): `ChatWindow`, `MessageBubble`, `Composer`, `ToolEventList`, `StreamingText`,
  `useAgentStream` (plus its `PendingHumanDecision` / `PendingReconciliation` types), and the client action
  helpers `sendChatTurn`, `confirmAction`, `verifyAction`, `cancelAction`, `controlTask`, `fetchTaskPlan`,
  `fetchPendingActions`, `DEFAULT_ENDPOINTS`, `ChatEndpoints`.
- Card renderers (`./chat/cards`): `CardRenderer` (dispatches on `ChatCard['type']`) plus the 11 **union** card
  components (`BalanceCard`, `TransferCard`, `ConfirmationCard`, `MfaCard`, `SpendingCard`, `CardsCard`,
  `InvestmentsCard`, `SubscriptionsCard`, `AnomalyCard`, `PlanCard`, `ErrorCard`) and their prop types
  (`CardActionHandlers`, `TaskControlAction`, the card-data payload types).
- Non-union card (`./chat/cards`): `ReconciliationCard` — an actionless amber warning card for a terminal
  `needs_reconciliation` action, rendered DIRECTLY by `ChatWindow`; it is NOT a `ChatCard` variant and is
  NOT dispatched by `CardRenderer` (so it is outside the `assertNever` exhaustiveness contract).
- Charts (`./charts`): `SpendingPie`, `SpendingBar`, `SpendingTrend`, `MiniSparkline`.
- Banking tiles (`./banking`): `AssetSummaryCard`, `RecentTransactions`, `CardTile`, `SubscriptionTile`,
  `InvestmentProductTile`, `AnomalyBanner`, `AgentTaskTimeline`.
- Security (`./security`): `PermissionLegend`, `SecurityEventList`, `CircuitBreakerStatus`.
- Primitives (`./ui`): `Card`, `Button`, `Badge`, `StatusBadge`, `Money`, `Tabs`, `Dialog`, `Spinner`,
  `EmptyState`, `Table`.

## ChatCard → component mapping (the core contract)

`ChatCard` (frozen in `lib/contracts/agent.ts`) is a discriminated union on `type`. `CardRenderer`
switches on `card.type` and delegates to exactly one component. The switch has a `default: assertNever(card)`
branch, so **adding or removing a `ChatCard` variant is a compile error here** — the mapping can never
silently miss a case.

| `ChatCard['type']` | `data` field narrowed to | Component | Node |
| --- | --- | --- | --- |
| `balance` | `BalanceView` | `BalanceCard` | chat/cards |
| `transfer` | `TransferResult` | `TransferCard` | chat/cards |
| `confirmation` | `PendingActionSummary` (field `action`) | `ConfirmationCard` | chat/cards |
| `mfa` | `actionId` + `hint` | `MfaCard` | chat/cards |
| `spending` | `SpendingAnalysis` | `SpendingCard` | chat/cards |
| `cards` | `CardView[]` | `CardsCard` | chat/cards |
| `investments` | `InvestmentsCardData` | `InvestmentsCard` | chat/cards |
| `subscriptions` | `SubscriptionView[]` | `SubscriptionsCard` | chat/cards |
| `anomaly` | `AnomalyReport` | `AnomalyCard` | chat/cards |
| `plan` | `TaskPlan` (field `plan`) | `PlanCard` | chat/cards |
| `error` | `message` (string) | `ErrorCard` | chat/cards |

Because most variants carry `data: unknown` in the frozen contract, `CardRenderer` narrows each
`data` to its concrete SDK DTO (see the table) before passing it down. The `./app` chat serialiser is
responsible for populating `cards[].data` with exactly these shapes.

## Closed loop (confirm / MFA / DAG control)

The interactive cards are wired into ONE closed loop, driven by `useAgentStream` + `./app` routes:

- **YELLOW confirm** — a `confirmation_required` event renders `ConfirmationCard` (summary fields + `Money`
  amount, 确认/取消). Confirm/Cancel only call `onConfirm`/`onCancel` → the hook POSTs to `./app`; the browser
  never fabricates success — the factual outcome arrives as server events.
- **RED MFA / escalation** — an `mfa_required` event renders `MfaCard` (code input + optional attempt count).
  A confirm response carrying `requiresMfa:true` / `tier:'RED'` (YELLOW→RED escalation, or a still-unverified
  RED action) switches the SAME `actionId` to MFA entry — never a dead-end. A wrong code is a normal `200`
  with `ok:false`; the card stays up showing the error and bumps `mfaAttempts`.
- **DAG control** — `PlanCard` renders each node's status (via `AgentTaskTimeline`) and Pause/Resume/Cancel/
  Retry controls conditioned on `plan.status`, calling `onControl(TaskControlAction)` → the hook's `controlTask`
  POSTs `{action}` to `/api/tasks/:id` and folds the returned snapshot into the live `activePlan` slot.
- **Refresh restore** — on mount `useAgentStream` rebuilds an in-flight decision AND the display-only
  `needs_reconciliation` list from `GET /api/actions`, and the live plan from `GET /api/tasks/:id`; `restoring`
  drives a loading state. Each is best-effort and never clobbers a live event-delivered state.

## Client / Server Component split

- **Client Components** (`'use client'`) — require hooks/interactivity/fetch/Recharts:
  - all of `./chat` (**every** chat component + `useAgentStream` + `actions`)
  - all of `./charts` (Recharts needs the DOM)
  - `ui/Button`, `ui/Tabs`, `ui/Dialog` (onClick / controlled state / portal)
- **Server-safe presentational Components** (no directive; render only, usable in either context):
  - `ui/Card`, `ui/Badge`, `ui/StatusBadge`, `ui/Money`, `ui/Spinner`, `ui/EmptyState`, `ui/Table`
  - all of `./banking` and `./security` (pure presentational; take props, no hooks/db)
- Rule: a Client Component may import a Server-safe presentational component, never the reverse.

## Client fetch contract (actions)

Chat + card actions call the app's API routes via `fetch` (see `./chat/actions.ts`). The routes are
owned by `./app`; the component layer only depends on this shape:

- `POST /api/chat` — body `ChatTurnRequest` (`{ sessionId?, message }`) → `ChatTurnResponse` (`{ sessionId, events: AgentStreamEvent[] }`).
  (The live chat stream may be delivered as SSE on the same path; `sendChatTurn` normalises to events.)
- `POST /api/actions/:id/confirm` — body `{}` → `ChatTurnResponse`. Executes a YELLOW action's original
  validated args server-side and returns the narration events. The raw `ActionResponse` also carries
  `{ ok, status, tier, requiresMfa, mfaResult }` which `postAction` folds into events (escalation handling).
- `POST /api/actions/:id/verify` — body `{ code: string }` → `ChatTurnResponse`. RED MFA path.
- `POST /api/actions/:id/cancel` — body `{}` → `ChatTurnResponse`.
- `GET /api/actions` — body none → the caller session's `PendingAction` rows requiring attention: the
  NON-TERMINAL `pending`/`awaiting_mfa` decisions PLUS the TERMINAL `needs_reconciliation` manual-reconciliation
  entries (accepted as a bare array or `{ actions: [...] }`). Drives the **refresh restore** of both the
  in-flight confirm/MFA decision and the display-only reconciliation list; read tolerantly by
  `fetchPendingActions` (never throws → best-effort `[]`). **Owned by `./app` (see Notes for Agents).**
- `GET /api/tasks/:id` — `{ ok:true, data: TaskPlan }` (plan refresh recovery); `POST /api/tasks/:id` body
  `{ action: 'pause'|'resume'|'cancel'|'retry' }` → `{ ok:true, data: TaskPlan }` (snapshot AFTER the control).
- Errors are surfaced as an `{ type: 'error', message }` `AgentStreamEvent` (never a raw exception in UI).
- `ChatEndpoints` + `DEFAULT_ENDPOINTS` centralise these URLs so pages can override them in tests.

`ChatWindow` consumes `AgentStreamEvent`s through `useAgentStream`: it folds `message_start`/
`text_delta`/`message_end` into the message list, `tool_start`/`tool_end` into a `ToolEventView[]`,
`card` into `ChatMessage.cards`, `plan_update`/`confirmation_required`/`mfa_required` into the active
plan/action state, and `security_event`/`error` into banners. No LLM chain-of-thought is ever rendered.

## Constraints

- **No `prisma` / no direct `banking-sdk` writes.** Reads come from props; mutations go through
  `./app` API routes. `components` depends on `lib` + `banking-sdk` (type-only) + `app` (routes, by URL).
- **Imports**: use the `@/*` path alias (`@/lib/contracts/agent`, `@/banking-sdk`, `@/lib/money`).
  Import SDK DTOs **type-only** (`import type`). Never redeclare a contract or DTO type.
- **Money** is always rendered via `ui/Money` → `lib/money.formatCNY`; never hand-format amounts.
- **Tiers** are always rendered via `ui/StatusBadge` / `security/PermissionLegend`, driven by
  `RiskLevel` (`'GREEN' | 'YELLOW' | 'RED'`) + `lib/constants.RISK_LABEL`. Never hard-code colours for a tier.
- **No MFA code is ever displayed.** `MfaCard` shows only the `hint`; the code is typed by the user.
- **No chain-of-thought.** Only task steps, tool status and factual results are shown.
- **One concern per file**, files ≲ ~1000 lines. Shared primitives live in `./ui` (lowest common ancestor).
- **Freshness/streaming**: components are pure w.r.t. props; live updates flow through `useAgentStream`.
- **Barrels stay NEUTRAL.** `'use client'` belongs on each interactive LEAF (e.g. `chat/ChatWindow.tsx`, `charts/SpendingPie.tsx`), never on an intermediate barrel (`chat/index.ts`, `chat/cards/index.ts`, `ui/index.ts`, …). A `'use client'` barrel star-re-exported through the neutral `./index.ts` facade resolves to `undefined` at SSR and breaks the consuming page — this is why `/agent` returned HTTP 500. Keep every barrel directive-free, mirroring the neutral `charts/index.ts`.
- All components are **named exports** (no default exports) so the barrel facade stays tree-shakeable.

## Test Strategy

- Component tests are **Vitest** and live under the repo-root `tests/` suite (`tests/CONTEXT.md`),
  not co-located here (the root owns the test tree).
- The **exhaustive `CardRenderer` mapping** is enforced at compile time (`assertNever` default branch):
  a new `ChatCard` variant breaks `tsc`/`next build` until a renderer is added — this is the primary
  regression guard.
- Unit-testable without a DOM: `ui/Money` formatting, `StatusBadge` tier→label mapping, the
  `useAgentStream` event→state reducer (pure fold, testable with `AgentStreamEvent[]` fixtures from the
  faux-provider scenarios), the `useAgentStream` refresh-restore reconciliation fold (seeds
  `pendingReconciliations` from `GET /api/actions`), and `PlanCard.controlActionsFor` (status → control-set mapping).
- **There is NO component/DOM test layer.** `@testing-library/react`, `jsdom` and `happy-dom` are NOT dependencies and no component render test exists; `vitest.config.ts` runs `environment: 'node'`. DOM-level coverage is ONLY the real-browser e2e suite (playwright-core on `prisma/e2e.db`): `tests/e2e/acceptance.e2e.ts` (`npx tsx`, NOT Vitest). Its helpers select on DOM contracts owned here (`AgentTaskTimeline`'s `ol.space-y-3 > li`, node-name `span.text-sm.font-medium.text-banking-deep`, status `span.rounded-full`) — a new status chip must preserve these classes.
  X/statuses; the `ChatWindow` integration test drives a scripted
  `AgentStreamEvent[]` sequence. (Test deps are added by the root `tests` owner.)

## Routing Table

- `./ui/` → Tailwind-styled primitives (Card, Button, Badge, StatusBadge, Money, Tabs, Dialog, Spinner, EmptyState, Table)
- `./chat/` → chat surface: ChatWindow, MessageBubble, Composer, ToolEventList, StreamingText, useAgentStream hook, client action helpers, task-control (pause/resume/cancel/retry) + refresh restore (pending decision + `needs_reconciliation` list)
- `./chat/cards/` → the `ChatCard` renderers + `CardRenderer` dispatcher + the non-union `ReconciliationCard` + card-data/action-handler types
- `./charts/` → Recharts wrappers (SpendingPie, SpendingBar, SpendingTrend, MiniSparkline)
- `./banking/` → read-model tiles/banners (AssetSummaryCard, RecentTransactions, CardTile, SubscriptionTile, InvestmentProductTile, AnomalyBanner, AgentTaskTimeline)
- `./security/` → security visualisations (PermissionLegend, SecurityEventList, CircuitBreakerStatus)
- `./index.ts` → barrel facade for the whole component library
- `../app/` → Next.js pages + API routes that consume these components (sibling — read-only, escalate writes to root)
- `../lib/contracts/` → frozen shared types imported by the cards/chat (dependency — read-only)
- `../banking-sdk/` → DTO view models rendered by tiles (dependency — read-only, type-only imports)
- `../tailwind.config.ts` → banking colour palette + radii used by every component (dependency — read-only)

## Notes for Agents

- The 12 demo scenarios are the acceptance bar; card/plan/anomaly renderers must make Tests 1–12 legible.
- `docs/` (design language, test-cases) is a root sibling; escalate any write there to the root.
- Money-moving buttons (confirm/verify/cancel) only ever call the `./app` action routes — the browser
  NEVER executes a gated banking op directly; the server re-validates and executes.
- **App-node interface the closed loop depends on (report needs, do NOT fork a frozen contract):**
  `GET /api/actions` must return the caller session's actionable `PendingAction`s — the NON-TERMINAL
  `pending`/`awaiting_mfa` for the in-flight decision AND the TERMINAL `needs_reconciliation` for the
  display-only reconciliation list (accepted shapes: a bare array or `{ actions: [...] }`; each row needs
  `{ id, status, tier, requiresMfa, summary }`).
  Optionally, a `pendingActionId` on a plan node result (NOT a declared `TaskNodeResult` field — the agent records it inside the node's `output` JSON, read via `readPendingActionId`) would let
  the plan view link a parked node to its decision; a server-provided MFA attempt count would let `mfaAttempts`
  survive reloads (it currently counts only in-session failed verifies).
