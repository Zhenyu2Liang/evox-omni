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
  `useAgentStream`, and the client action helpers `sendChatTurn`, `confirmAction`, `verifyAction`,
  `cancelAction`, `DEFAULT_ENDPOINTS`, `ChatEndpoints`.
- Card renderers (`./chat/cards`): `CardRenderer` (dispatches on `ChatCard['type']`) plus the 11 card
  components (`BalanceCard`, `TransferCard`, `ConfirmationCard`, `MfaCard`, `SpendingCard`, `CardsCard`,
  `InvestmentsCard`, `SubscriptionsCard`, `AnomalyCard`, `PlanCard`, `ErrorCard`) and their prop types.
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
  validated args server-side and returns the narration events.
- `POST /api/actions/:id/verify` — body `{ code: string }` → `ChatTurnResponse`. RED MFA path.
- `POST /api/actions/:id/cancel` — body `{}` → `ChatTurnResponse`.
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
- All components are **named exports** (no default exports) so the barrel facade stays tree-shakeable.

## Test Strategy

- Component tests are **Vitest** and live under the repo-root `tests/` suite (`tests/CONTEXT.md`),
  not co-located here (the root owns the test tree).
- The **exhaustive `CardRenderer` mapping** is enforced at compile time (`assertNever` default branch):
  a new `ChatCard` variant breaks `tsc`/`next build` until a renderer is added — this is the primary
  regression guard.
- Unit-testable without a DOM: `ui/Money` formatting, `StatusBadge` tier→label mapping, and the
  `useAgentStream` event→state reducer (pure fold, testable with `AgentStreamEvent[]` fixtures from the
  faux-provider scenarios).
- Rendering tests use React Testing Library (jsdom) rendering each card type with a fixture `ChatCard`
  and asserting key amounts/statuses; the `ChatWindow` integration test drives a scripted
  `AgentStreamEvent[]` sequence. (Test deps are added by the root `tests` owner.)

## Routing Table

- `./ui/` → Tailwind-styled primitives (Card, Button, Badge, StatusBadge, Money, Tabs, Dialog, Spinner, EmptyState, Table)
- `./chat/` → chat surface: ChatWindow, MessageBubble, Composer, ToolEventList, StreamingText, useAgentStream hook, client action helpers
- `./chat/cards/` → the `ChatCard` renderers + `CardRenderer` dispatcher + card-data/action-handler types
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
