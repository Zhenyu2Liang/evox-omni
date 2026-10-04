# App Node — Next.js App Router (pages + API route handlers)

## Intent

The **presentation + routing edge** of the AI Banking Agent demo: Next.js App Router pages and the
HTTP API route handlers the browser talks to.
This node is a **thin routing + composition layer — it owns NO business logic**.
Pages fetch read models and compose `../components`; route handlers validate input, delegate to
`../agent` (chat runtime) / `../security` / `../audit` / `../planner` / `../banking-sdk`, and serialize.
It is the only place that knows about HTTP, cookies, sessions and JSON envelopes.

## Architecture — server/client boundary

- **Pages are React Server Components (RSC) by default.** They run on the server, fetch read models
  directly (no HTTP hop) from `../banking-sdk` read functions, `../audit` read functions, and
  `../lib/db/repositories` read functions, and pass **plain, JSON-serializable** data into client
  components from `../components`.
- **Client Components** (`'use client'`) own interactivity: chat streaming, action
  confirm/verify/cancel buttons, the Security-Center unlock button, and client-side refresh (polling
  the `GET /api/*` read routes). They reach the server **only through this node's own API routes**.
  Most come from `../components`; app-local client chrome lives under `app/_components/` (the global
  `NavBar`) and colocated page folders (e.g. `app/security/ResetBreakerButton.tsx`).
- **Global chrome**: `app/layout.tsx` renders a persistent top navigation (`app/_components/NavBar.tsx`,
  a client component using `usePathname` for active-route highlighting) above `{children}`, linking all
  seven pages (`/`, `/agent`, `/bills`, `/cards`, `/subscriptions`, `/security`, `/audit`).
- **Import firewall** (enforced): Server Components MAY import `banking-sdk`, `audit`, `security`,
  `planner`, `lib`. Client Components MUST NOT import Prisma, `banking-sdk`, `security`, `agent`, or
  `planner` — they call `/api/*` instead. Prisma is reachable only through `banking-sdk` /
  `lib/db/repositories` (never imported by `components`).
- Dependency direction is strictly downward: `app` depends on everything below; nothing below imports
  `app`.

## Public API Surface

### Page routes (Server Components)

| Route | File | Read dependencies | Composition (from `../components`) |
| --- | --- | --- | --- |
| `/` Dashboard | `app/page.tsx` | `banking.dashboard.getDashboardSummary(userId)` | balance card, stat tiles (总资产/活期余额/信用卡额度/本月消费), recent transactions, anomaly banner, AI Agent entry |
| `/agent` Chat | `app/agent/page.tsx` | none at render (client streams) | `<ChatWindow/>` (client) — input, message list, task timeline, cards, confirmation/MFA prompts |
| `/bills` | `app/bills/page.tsx` | `banking.transaction.analyzeSpending`, `listTransactions`, `listAnomalies` | month picker, category pie, monthly trend, recent transactions table, anomaly list |
| `/cards` | `app/cards/page.tsx` | `banking.card.getCards` | card tiles (储蓄卡/信用卡/虚拟卡), limits, status badges, freeze/unfreeze/limit actions |
| `/subscriptions` | `app/subscriptions/page.tsx` | `banking.subscription.listSubscriptions` | subscription list (name, monthly fee, next charge), annual cost summary, reminder/cancel actions |
| `/security` | `app/security/page.tsx` | `security.circuitBreaker.getState`, `audit.getSecurityStatus({ isLocked })`, `audit.listSecurityEvents` | 🟢/🟡/🔴 legend, recent verifications, circuit-breaker status (real failure count) + `ResetBreakerButton` (client, unlocks), SecurityEvents table |
| `/audit` | `app/audit/page.tsx` | `audit.listAudit`, `audit.getAuditSummary` | audit table (timestamp/userRequest/intent/toolName/riskLevel/confirmationRequired/confirmed/mfaRequired/mfaResult/toolResult/status) + summary badges |

Pages read on the **server** at initial render; the client refreshes through the matching `GET /api/*`
route. Demo user is resolved via `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`); the demo
session id comes from the `banking_session` cookie set by `POST /api/chat`.

### API route handlers

All handlers are **thin**: `validate (zod) → delegate → serialize`. Every response uses the **envelope**
below. Path params come from `params`; query/body are zod-parsed. See `app/api/CONTEXT.md` for the
authoritative endpoint table.

| Method | Path | Request | Success data (`ok:true`) |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status:'ok', time:number, llmMode:'live'\|'mock' }` |
| POST | `/api/chat` | body `ChatTurnRequest`; `?stream=0\|1` (default 1) | stream: SSE of `AgentStreamEvent`; non-stream: `ChatTurnResponse` |
| POST | `/api/actions/[id]/confirm` | body `{}` | `ActionResponse` |
| POST | `/api/actions/[id]/verify` | body `{ code: string }` | `ActionResponse` (`ok:false` + `status:'awaiting_mfa'` on wrong code) |
| POST | `/api/actions/[id]/cancel` | body `{}` | `ActionResponse` (`status:'cancelled'`) |
| GET | `/api/tasks` | query `{ sessionId?, limit? }` | `{ plans: TaskPlan[] }` |
| GET | `/api/tasks/[id]` | — | `TaskPlan` (persisted snapshot → refresh recovery) |
| POST | `/api/tasks/[id]` | body `{ action:'pause'\|'resume'\|'cancel'\|'retry' }` | `TaskPlan` (plan after the control; owning session only) |
| GET | `/api/audit` | query `{ sessionId?, toolName?, riskLevel?, status?, limit? }` | `{ entries: AuditEntry[]; summary: AuditSummary }` |
| GET | `/api/security` | query `{ sessionId? }` | `{ status: SecurityStatus; events: SecurityEvent[]; circuitBreaker: { failures; max; locked } }` |
| POST | `/api/security/reset` | session via cookie / `?sessionId=` | `ResetData { sessionId, locked, failures, max, message }` — AUDITED unlock of this session's breaker |
| GET | `/api/dashboard` | query `{ userId? }` | `DashboardSummary` |
| GET | `/api/bills` | query `{ month? }` (`YYYY-MM`) | `{ analysis: SpendingAnalysis; transactions: TransactionView[]; anomalies: AnomalyItem[] }` |
| GET | `/api/cards` | query `{ userId? }` | `{ cards: CardView[] }` |
| GET | `/api/subscriptions` | query `{ userId? }` | `{ subscriptions: SubscriptionView[] }` |

`ActionResponse` (shared shape for every action route) is defined in `app/api/_lib/types.ts`:

```ts
interface ActionResponse {
  actionId: string;
  sessionId: string;
  ok: boolean;                 // true iff the action is now authorized/executed
  status: PendingActionStatus; // pending | awaiting_mfa | confirmed | executed | failed | cancelled | locked
  tier: RiskLevel;
  requiresMfa: boolean;
  mfaResult?: 'success' | 'failed' | 'not_required';
  message: string;             // safe, user-facing (NEVER contains the MFA code)
  events: AgentStreamEvent[];  // continuation events to append to the chat (agent narrates the outcome)
}
```

## Response envelope & error mapping

- Success: `{ ok: true, data: T }`. Error: `{ ok: false, error: { code: ErrorCode, message: string } }`
  (`ErrorCode` from `../lib/errors`).
- Every handler wraps its body in try/catch and maps `AppError.code` → HTTP status via one shared
  helper (`app/api/_lib/http.ts`):

  | AppError code | HTTP |
  | --- | --- |
  | `VALIDATION` | 400 |
  | `NOT_FOUND` | 404 |
  | `SECURITY_DENIED` | 403 |
  | `MFA_FAILED` | 403 |
  | `CIRCUIT_OPEN` | 423 Locked |
  | `INSUFFICIENT_FUNDS` | 422 |
  | `LIMIT_EXCEEDED` | 422 |
  | `CONFLICT` | 409 |
  | `TOOL_FAILED` | 502 |
  | `INTERNAL` | 500 |

- **Never leak internals**: raw exceptions, stack traces, Prisma errors, and **the MFA code** must not
  appear in any response body. Non-`AppError` throwables map to `INTERNAL` with a generic message.
- **Domain outcomes are 200, not errors**: a wrong MFA code and a blocked/cancelled action are normal
  results — return `200 { ok:true, data: ActionResponse{ ok:false, … } }`. Reserve non-2xx for the
  error envelope above (e.g. `CIRCUIT_OPEN` → 423).

## Streaming contract (`POST /api/chat`)

- Default: `Content-Type: text/event-stream`. Each `AgentStreamEvent` is written as one SSE frame:
  `data: <JSON>\n\n`. The turn terminates with `data: {"type":"done"}\n\n`.
- A mid-turn failure emits `data: {"type":"error","message":"<safe message>"}\n\n` then `done`.
- Non-streaming fallback: `?stream=0` (or `Accept: application/json`) returns `200 { ok:true, data: ChatTurnResponse }`
  where `data = { sessionId, events: AgentStreamEvent[] }`.
- The route drives the same agent entry point either way: `agent.runTurn({ sessionId?, message })`
  (`../agent`). `runTurn` has NO `onEvent` sink — it returns the FULL ordered `AgentStreamEvent[]`
  (already ending in a `done` event). Streaming mode writes those events as SSE frames (guarding that
  exactly one `done` is emitted); `?stream=0` returns them verbatim in `ChatTurnResponse`.
- On every turn the route sets `Set-Cookie: banking_session=<sessionId>` (constant `SESSION_COOKIE`)
  so subsequent turns and `GET /api/*` reads share the session.

## Agent runtime surface this node depends on (`../agent`)

Route handlers call only these **agent-contract** entry points (owner: `../agent`); the app node never
constructs an `Agent` itself. Real signatures (verified against `../agent`):

```ts
runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse>; // full ordered events; no onEvent sink
resumeTurn(req: ResumeTurnInput): Promise<ChatTurnResponse>;
confirm(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>; // alias of confirmAction
verify(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>; // alias of verifyAction
cancel(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>; // alias of cancelAction
```

`confirm`/`verify`/`cancel` return `ConfirmationOutcome` (it lacks `sessionId`/`requiresMfa`/`mfaResult`),
so the action routes **derive** those `ActionResponse` fields: `sessionId` from the persisted
`PendingAction` row (falling back to the request cookie/query), `requiresMfa` from `tier === 'RED'`, and
`mfaResult` from the verify outcome. A `data.ok === false` outcome (wrong MFA, blocked, cancelled) is a
normal `200` — never an HTTP error.

The `action` routes call `confirm`/`verify`/`cancel` through `app/api/_lib/agent-bridge.ts`, which also
resolves `pauseTask`/`resumeTask`/`cancelTask`/`retryTask` at RUNTIME for `POST /api/tasks/[id]` (see
Known Issues). `ConfirmOptions` currently carries no `userId`/`sessionId`; the bridge forwards them via a
documented forward-compat cast.

## Dependencies

- `../components` (sibling — read-only): the React component library the pages compose (`ChatWindow`,
  chat cards, charts, banking tiles, ui primitives). Component API is owned there.
  Every component the pages use renders real markup — `ChatWindow`, `Card`, `CardTile`, `Table`,
  `Badge`, `StatusBadge`, `EmptyState`, `Money`, `SubscriptionTile`, `AssetSummaryCard`,
  `AnomalyBanner`, `RecentTransactions`, the charts, and `../components/security/*`
  (`PermissionLegend`, `CircuitBreakerStatus`, `SecurityEventList`).
- `../agent` (sibling — read-only): chat runtime (`runTurn`/`resumeTurn`/`confirm`/`verify`/`cancel`,
  `AgentStreamEvent` emission). Task execution control (`pause`/`resume`/`cancel`/`retry`) is delegated
  through `app/api/_lib/agent-bridge.ts` — see Known Issues.
- `../banking-sdk` (sibling — read-only): read models (`banking.dashboard/account/transaction/card/subscription/…`, DTOs in `banking-sdk/types`).
- `../security` (sibling — read-only): circuit breaker — `circuitBreaker.getState/isLocked` plus the AUDITED `circuitBreaker.resetSession(sessionId, { actor })` (records a `SECURITY_RESET` SecurityEvent, returns the fresh state) used by `/api/security` and the Security Center. `resetSession` is the runtime unlock path (the gateway's "前往安全中心解除限制" pointer); the sync `reset()` is test-only.
- `../audit` (sibling — read-only): `listAudit`, `getAuditSummary`, `listSecurityEvents`, `getSecurityStatus`.
- `../planner` (sibling — read-only): exposes DAG/executor/buildPlan + types only — NO cross-request plan
  store. `/api/tasks*` reads persisted `AgentTask`/`AgentTaskNode` rows via
  `../lib/db/repositories/task`, mapped by the pure helper `app/api/_lib/task-plans.ts`. Execution
  control lives in `../agent`, not here.
- `../lib` (sibling — read-only): contracts (`ChatTurnRequest`, `ChatTurnResponse`, `AgentStreamEvent`, `AuditEntry`, `SecurityEvent`, `PendingActionStatus`, `TaskPlan`, `RiskLevel`), `AppError`/`ErrorCode`/`Result`, `getConfig`, `SESSION_COOKIE`, `DEFAULT_DEMO_USER_ID`, `formatCNY`.
- `../tests` (sibling — read-only, escalate writes to root): automated tests (`../tests/app` would host route-handler contract tests; that directory does not exist yet).

## Constraints

- **No business logic here.** No permission/risk decisions (those live in `../security`), no money math
  (use `../lib/money`), no Prisma writes (go through `../banking-sdk` / the agent's authorized path).
- Route handlers stay **thin and ≲ ~150 lines**; page files ≲ ~120 lines. Split by responsibility;
  push shared handler plumbing into `app/api/_lib/` (private `_`-folder — never a route).
- **Validate every request body/query with zod** before delegating; reject with `AppError('VALIDATION')`.
- **Next.js route-export constraint**: an App Router `route.ts` may export ONLY HTTP-method handlers +
  known config fields (`dynamic`/`revalidate`/`runtime`). Route-local zod schemas MUST be non-exported
  consts (or live in `_lib/schemas.ts`) — exporting them breaks `next build`.
- Pages pass only **serializable** props to client components (no class instances, no `Date` — epoch ms).
- Money is CNY rendered via `formatCNY` (`¥1,234.56`); status uses 🟢/🟡/🔴 from `RISK_LABEL`.
- **Determinism**: pages/routes must build and render without network; agent runs use `LLM_MODE=mock`.
- No LLM chain-of-thought in the UI — only task steps, tool status, and results.

## Test Strategy

- **Route-handler contract tests** would live in `../tests/app/` (Vitest). Handlers are plain
  `(req: NextRequest, ctx) => Response` functions, so tests invoke them directly with synthetic
  `Request` objects and assert: zod rejection → `400 VALIDATION`, `AppError` → correct HTTP status,
  success → `{ ok:true, data }` envelope, and that the MFA code never appears in a body.
- **Dependencies are mocked at the module boundary** (`vi.mock('../agent')`, `vi.mock('../banking-sdk')`,
  etc.) — no live Prisma, no network.
- **Integration/acceptance** (the 12 demo scenarios) are driven through `../agent` + `../tests`, not here;
  the app node contributes the SSE/JSON transport tests for `POST /api/chat` (stream frames + `done`,
  and `?stream=0` fallback).
- **Build sanity** for this node: `npm run typecheck` + `npm run build` (the latter needs a provisioned
  SQLite DB — `npx prisma db push` + `npm run db:seed` — because the data pages are prerendered).

## Routing Table

- `./` → Dashboard page + root layout/globals (this node's own files: `layout.tsx`, `globals.css`, `page.tsx`)
- `./_components/` → app-local client chrome (private `_` folder, never routed): `NavBar.tsx` global top navigation
- `./agent` → AI Agent chat page (renders the client `ChatWindow`)
- `./api` → HTTP API route handlers (chat SSE, actions confirm/verify/cancel, tasks control, audit, security + security reset, read models, health) + shared `_lib/` (http, types, schemas, session, task-plans, agent-bridge)
- `./audit` → Audit Log page
- `./bills` → Bills / 账单 page
- `./cards` → Cards page
- `./security` → Security Center page + `ResetBreakerButton.tsx` (client unlock button)
- `./subscriptions` → Subscriptions page
- `../components` → React component library the pages compose (sibling — read-only, escalate writes to parent)
- `../agent` → Chat runtime the routes delegate to (sibling — read-only, escalate writes to parent)
- `../tests/app` → Route-handler contract tests (sibling — read-only, escalate writes to parent)

## Notes for Agents

- The pages and route handlers here are **fully implemented** (no `not implemented` stub bodies remain).
  Each route is thin (`validate → delegate → serialize`); shared plumbing lives in `app/api/_lib/`.
- Add a new client-callable capability as a route under `./api`; add a new screen as a page dir with its
  own `CONTEXT.md`. Never import Prisma into a page or a client component.
- The app is fully browsable via the global `NavBar` (`app/_components/NavBar.tsx`, mounted in
  `app/layout.tsx`) — every one of the seven pages is linked.
- Any new shared UI/transport type belongs in `../lib/contracts` (root-owned) — do not define it locally.
- **Chat anomaly-card actions are wired.** `../components/chat/ChatWindow.tsx` builds the sole
  `CardActionHandlers`, whose `onAcknowledge`/`onViewDetail`/`onFreeze` invoke `stream.send('…')` (real
  follow-up turns) alongside `onConfirm`/`onVerify`/`onCancel`. `/agent` mounts `<ChatWindow className=…/>`
  only. The `AnomalyBanner` usages here (`app/page.tsx:48`, `app/bills/page.tsx:100`) pass no handler props
  (the banner is display-only). See `../components/chat/cards/CONTEXT.md`.
- **Action routes enforce ownership; the reset is audited.** `POST /api/actions/[id]/{confirm,verify,cancel}`
  guard that the caller's session/user owns the `PendingAction` (explicit mismatch → `403 SECURITY_DENIED`)
  — the effective enforcement today — and forward `{ userId, sessionId }` to `@/agent` via `agent-bridge`
  (documented forward-compat cast) so the Security Gateway can additionally enforce it once `ConfirmOptions`
  carries those fields. `POST /api/security/reset` uses the AUDITED
  `security.circuitBreaker.resetSession(sessionId, { actor })` (records a `SECURITY_RESET` SecurityEvent),
  never the test-only sync `reset()`.

## Known Issues

- **Task execution control awaits the `../agent` control API.** `POST /api/tasks/[id]` routes
  `{pause|resume|cancel|retry}` to the RUNNING executor through `app/api/_lib/agent-bridge.ts`, which
  resolves `pauseTask`/`resumeTask`/`cancelTask`/`retryTask` off a namespace import of `@/agent` at RUNTIME
  and fails LOUDLY (`502 TOOL_FAILED`) when a capability is absent. `@/agent` does not export them yet, so
  POST returns `502` until that sibling lands them — no `./app` change will be needed then (the bridge
  self-heals). GET `/api/tasks/[id]` (persisted-plan read → refresh recovery) and the session-ownership
  guard work regardless.
- **Plan-node UI is not wired (cross-node, escalated).** A gated PLAN node (a tool parked by the planner
  executor) surfaces no confirmation/MFA card and the plan view does not refresh after confirm/verify,
  because `../agent` emits no `plan_update`/`confirmation_required` for plan nodes and `../components/chat`
  (`ChatWindow`/`useAgentStream`, `PlanCard`) does not consume `activePlan` or call `/api/tasks`. Both are
  read-only siblings → not editable from `./app`. `PlanCard` also collapses every non-`success`
  `TaskNodeStatus` to `○` (`../components/chat/cards/PlanCard.tsx`). The `./app` side is ready:
  persisted-plan GET + control POST + ownership.
