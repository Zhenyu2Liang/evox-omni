# App Node — Next.js App Router (pages + API route handlers)

Runtime tooling uses Next.js 16 and its default Turbopack bundler. Request parameters and cookies
are asynchronous. Database and Pi runtime packages remain server externals in `next.config.mjs`.
Styling uses Tailwind CSS 4 through `@tailwindcss/postcss`; the palette and radii are defined in
`globals.css` with `@theme`. ESLint 10 uses native flat configuration and the official Next.js plugin
directly; it does not load the older unsupported React/import/accessibility plugin bundle.

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
  `AppShell`) and colocated page folders (e.g. `app/security/ResetBreakerButton.tsx`).
- **Global chrome**: `app/layout.tsx` wraps server-rendered children in `app/_components/AppShell.tsx`.
  The shell uses `usePathname` for active-route highlighting and a persistent desktop sidebar.
  `navigation.ts` groups screens under assistant/tasks, banking, activity/security and optional
  developer tools. `DeveloperModeProvider` reads a strict preference cookie, defaulting to disabled;
  runtime history and chat reset/refresh controls are absent from normal navigation. This is a demo
  preference, not authentication. Reset uses explicit confirmation, revision and execution fences.
  Mobile navigation uses a native modal dialog with focus trapping, Escape dismissal, backdrop
  dismissal, focus restoration, and body scroll locking. Closed mobile navigation and the hidden
  desktop sidebar are excluded from keyboard navigation. The assistant owns viewport-sized content;
  other pages use ordinary document scrolling.
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
| `/` Home | `app/page.tsx` | no read dependencies | redirects to `/agent`, making the assistant the default entry |
| `/overview` | `app/overview/page.tsx` | `banking.dashboard.getDashboardSummary(userId)` | balance card, asset statistics, recent transactions, anomaly banner, assistant entry |
| `/agent` Chat | `app/agent/page.tsx` | `getDemoSession`: fixed workspace transcript, plan and pending actions | `<ChatWindow sessionId=…/>` (client) — input, message list, task timeline, cards, confirmation/MFA prompts |
| `/bills` | `app/bills/page.tsx` | `banking.transaction.analyzeSpending`, `listTransactions`, `listAnomalies` | month picker, category pie, monthly trend, recent transactions table, anomaly list |
| `/cards` | `app/cards/page.tsx` | `banking.card.getCards` | card tiles (储蓄卡/信用卡/虚拟卡), limits, status badges, freeze/unfreeze/limit actions |
| `/subscriptions` | `app/subscriptions/page.tsx` | `banking.subscription.listSubscriptions` | subscription list (name, monthly fee, next charge), annual cost summary, reminder/cancel actions |
| `/security` | `app/security/page.tsx` | `security.circuitBreaker.getState`, `audit.getSecurityStatus({ isLocked })`, `audit.listSecurityEvents` | 🟢/🟡/🔴 legend, recent verifications, circuit-breaker status (real failure count) + `ResetBreakerButton` (client, unlocks), SecurityEvents table |
| `/activity` | `app/activity/page.tsx` | owner-scoped `listOperationHistory` | ordinary business operation name, timestamp, status and verification; no tool diagnostics |
| `/audit` | `app/audit/page.tsx` | developer gate before `audit.listAudit`, `audit.getAuditSummary` | developer-only technical audit table, raw tool identity, arguments and results |
| `/contacts` | `app/contacts/page.tsx` | `banking.contact.listContacts` | masked contact cards, saved-recipient form and explicit deletion dialog |
| `/investments` | `app/investments/page.tsx` | `banking.investment.listProducts`, `listHoldings` | exact-money product and holding tiles; purchases remain in the assistant conversation |
| `/manual` | `app/manual/page.tsx` | browser manual-review inbox and action/task endpoints | open requests, recorded resolutions, eligible continuation controls |
| `/schedules` | `app/schedules/page.tsx` | browser `GET /api/schedules` | scheduled tasks, delivered notifications and due-task dispatch |
| `/runs` | `app/runs/page.tsx` | client `RunHistory` reads runtime endpoints | durable run history and event inspection |

Pages read on the **server** at initial render; the client refreshes through the matching `GET /api/*`
route. Demo user is resolved via `getConfig().demoUserId` (default `DEFAULT_DEMO_USER_ID`); the demo
session is created or loaded by `getDemoSession(userId)` with the fixed `demo:${userId}` identity.
All browsers share this workspace. There is no login, authentication cookie or old-session adoption.
The language cookie stores only the selected locale.

### API route handlers

All handlers are **thin**: `validate (zod) → delegate → serialize`. Every response uses the **envelope**
below. Path params come from `params`; query/body are zod-parsed. See `app/api/CONTEXT.md` for the
authoritative endpoint table.

**The server configures the single demo identity.** Routes call `requireIdentity(req)` or `resolveIdentity(req)` from `app/api/_lib/session.ts` to load the configured user and fixed demo session. Cookies and query identifiers cannot select a workspace. An optional chat body `sessionId` only asserts consistency with the fixed workspace; a mismatch returns 409. Page opening prepares the workspace without login. Persisted action/task ownership, confirmation/MFA, receipts and leases still control banking operations. Generic internal sessions cannot be selected through web requests.

| Method | Path | Request | Success data (`ok:true`) |
| --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status:'ok', time:number, llmMode:'live'\|'mock' }` |
| POST | `/api/chat` | body `ChatTurnRequest`; `?stream=0\|1` (default 1) | stream: SSE of `AgentStreamEvent`; non-stream: `ChatTurnResponse` |
| POST | `/api/actions/[id]/confirm` | body `{}` | `ActionResponse` |
| POST | `/api/actions/[id]/verify` | body `{ code: string }` | `ActionResponse` (`ok:false` + `status:'awaiting_mfa'` on wrong code) |
| POST | `/api/actions/[id]/cancel` | body `{}` | `ActionResponse` (`status:'cancelled'`) |
| GET | `/api/actions` | fixed demo identity | `PendingAction[]` — the session's surfaced pending actions (`pending`/`awaiting_mfa` awaiting a decision, plus the terminal `needs_reconciliation` manual-reconciliation entry) (refresh-restore entry) |
| GET | `/api/tasks` | query `{ limit? }` (fixed demo identity) | `{ plans: TaskPlan[] }` — the session's plans, newest-first |
| GET | `/api/tasks/[id]` | fixed demo identity | `TaskPlan` with node statuses + each node's `pendingActionId` (owning session+user only; foreign → 403, unknown → 404) |
| POST | `/api/tasks/[id]` | body `{ action:'pause'\|'resume'\|'cancel'\|'retry' }` (fixed demo identity) | `TaskPlan` (plan after the control; owning session/user only) |
| GET | `/api/activity` | query `{ limit? }` (fixed demo identity) | `{ entries: ActivityRecord[] }` — closed business event projection |
| GET | `/api/audit` | developer preference required; query `{ toolName?, riskLevel?, status?, limit? }` | `{ entries: AuditEntry[]; summary: AuditSummary }` |
| GET | `/api/security` | fixed demo identity | `{ status: SecurityStatus; events: SecurityEvent[]; circuitBreaker: { failures; max; locked } }` |
| POST | `/api/security/reset` | fixed demo identity; optional verification code | `ResetData { sessionId, locked, failures, max, message }` — audited, separately verified unlock of the account breaker |
| GET | `/api/dashboard` | `{}` (demo user) | `DashboardSummary` |
| GET | `/api/bills` | query `{ month? }` (`YYYY-MM`) | `{ analysis: SpendingAnalysis; transactions: TransactionView[]; anomalies: AnomalyItem[] }` |
| GET | `/api/cards` | `{}` (demo user) | `{ cards: CardView[] }` |
| GET | `/api/subscriptions` | `{}` (demo user) | `{ subscriptions: SubscriptionView[] }` |

`ActionResponse` (shared shape for every action route) is defined in `app/api/_lib/types.ts`:

```ts
interface ActionResponse {
  actionId: string;
  sessionId: string;
  ok: boolean;                 // true iff the action is now authorized/executed
  status: PendingActionStatus; // pending | awaiting_mfa | confirmed | executed | failed | cancelled | locked | needs_reconciliation
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
- Both modes call `agent.runTurn` with the fixed demo session, request ID and user text. Streaming
  passes `RunTurnDeps.onEvent` and publishes each grounded event after its journal commit. JSON mode
  returns the same ordered presentation events. The final `done` frame is emitted once.
- The route does not issue an authentication cookie. Workspace persistence is server-side;
  transport request IDs deduplicate retries without selecting identity or granting banking permission.

## Agent runtime surface this node depends on (`../agent`)

Route handlers call only these **agent-contract** entry points (owner: `../agent`); the app node never
constructs an `Agent` itself. Real signatures (verified against `../agent`):

```ts
runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse>; // persist-first onEvent sink is optional
resumeTurn(req: ResumeTurnInput): Promise<ChatTurnResponse>;
confirm(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>; // alias of confirmAction
verify(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>; // alias of verifyAction
cancel(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>; // alias of cancelAction
```

`confirm`/`verify`/`cancel` return `ConfirmationOutcome` (it lacks `sessionId`/`requiresMfa`/`mfaResult`),
so the action routes **derive** those `ActionResponse` fields: `sessionId` from the persisted
`PendingAction` row after checking fixed demo ownership, `requiresMfa` from `tier === 'RED'`, and
`mfaResult` from the verify outcome. A `data.ok === false` outcome (wrong MFA, blocked, cancelled) is a
normal `200` — never an HTTP error.

The `action` routes call `confirm`/`verify`/`cancel` through `app/api/_lib/agent-bridge.ts`, which also maps `pause`/`resume`/`cancel`/`retry` to `@/agent`'s `pauseTask`/`resumeTask`/`cancelTask`/`retryTask` (STATIC imports) for `POST /api/tasks/[id]`, and supplies the plan-forwarding helpers `locateOwningPlan` (+ `withPlanUpdate`) that confirm/verify use to emit a refreshed `plan_update`. `ConfirmOptions` carries `userId`/`sessionId`; the bridge forwards them.

## Dependencies

- `../components` (sibling — read-only): the React component library the pages compose (`ChatWindow`,
  chat cards, charts, banking tiles, ui primitives). Component API is owned there.
  Every component the pages use renders real markup — `ChatWindow`, `Card`, `CardTile`, `Table`,
  `Badge`, `StatusBadge`, `EmptyState`, `Money`, `SubscriptionTile`, `AssetSummaryCard`,
  `AnomalyBanner`, `RecentTransactions`, the charts, and `../components/security/*`
  (`PermissionLegend`, `CircuitBreakerStatus`, `SecurityEventList`).
- `../agent` (sibling — read-only): chat runtime (`runTurn`/`resumeTurn`/`confirm`/`verify`/`cancel`, `AgentStreamEvent` emission) plus task control/resume (`pauseTask`/`resumeTask`/`cancelTask`/`retryTask`, `getTaskPlan`, `findTaskByPendingAction`), all reached through `app/api/_lib/agent-bridge.ts`.
- `../banking-sdk` (sibling — read-only): read models (`banking.dashboard/account/transaction/card/subscription/…`, DTOs in `banking-sdk/types`).
- `../security` (sibling — read-only): circuit breaker — `circuitBreaker.getState/isLocked` plus the AUDITED `circuitBreaker.resetSession(sessionId, { actor })` (records a `SECURITY_RESET` SecurityEvent, returns the fresh state) used by `/api/security` and the Security Center. `resetSession` is the runtime unlock path (the gateway's "前往安全中心解除限制" pointer); the sync `reset()` is test-only.
- `../audit` (sibling — read-only): `listAudit`, `getAuditSummary`, `listSecurityEvents`, `getSecurityStatus`.
- `../planner` (sibling — read-only): exposes DAG/executor/buildPlan + types only — NO cross-request plan
  store. `/api/tasks*` reads persisted `AgentTask`/`AgentTaskNode` rows via
  `../lib/db/repositories/task`, mapped by the pure helper `app/api/_lib/task-plans.ts`. Execution
  control lives in `../agent`, not here.
- `../lib` (sibling — read-only): contracts (`ChatTurnRequest`, `ChatTurnResponse`, `AgentStreamEvent`, `AuditEntry`, `SecurityEvent`, `PendingActionStatus`, `TaskPlan`, `RiskLevel`), `AppError`/`ErrorCode`/`Result`, `getConfig`, `DEFAULT_DEMO_USER_ID`, `formatCNY` and localization helpers.
- `../tests` (sibling — read-only, escalate writes to root): automated tests; `../tests/app/` holds the
  route-handler specs that drive these handlers in-process (real `NextRequest`, real Prisma on the test
  SQLite, mock LLM).

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

- **Route-handler contract tests** live in `../tests/app/` (Vitest). Handlers are plain
  `(req: NextRequest, ctx) => Response` functions, so tests invoke them directly with synthetic
  `Request` objects and assert: zod rejection → `400 VALIDATION`, `AppError` → correct HTTP status,
  success → `{ ok:true, data }` envelope, and that the MFA code never appears in a body.
- **Dependencies are NOT module-mocked** (`vi.mock` is never used): the specs import the REAL handlers
  and run the whole production stack (route → `../agent` → tools → security gateway → `../banking-sdk` → a
  test SQLite); only the MODEL is scripted (`tests/setup.ts` forces `LLM_MODE=mock`, the faux provider).
  HTTP fixtures use `getDemoSession` for the configured user. Cookie/query values cannot choose
  another workspace; foreign resources still fail persisted ownership checks.
- **Integration/acceptance** (the 12 demo scenarios) are driven through `../agent` + `../tests`, not here;
  the app node contributes the SSE/JSON transport tests for `POST /api/chat` (stream frames + `done`,
  and `?stream=0` fallback).
- **Build sanity** for this node: `pnpm typecheck` + `pnpm build` (the build needs NO provisioned
  SQLite DB — the DB/cookie-backed server pages are `force-dynamic`; see the section below).

## Build-time Rendering (static vs dynamic)

Next App Router: a page is **statically prerendered at build time** unless it uses a dynamic API
(`cookies()`, `headers()`, `searchParams`) or opts out. Every DB/cookie-backed server page in `app/`
opts out explicitly with the standard one-line marker `export const dynamic = 'force-dynamic'`:

- **`force-dynamic` (server-rendered on demand, NEVER prerendered)** — every server page that reads
  live Prisma data and/or the request cookie:
  - `app/overview/page.tsx` `/overview` — `banking.dashboard.getDashboardSummary(userId)`.
  - `app/agent/page.tsx` `/agent` — fixed demo session, persisted transcript/actions/plan.
  - `app/activity/page.tsx` `/activity` — fixed demo identity + `listOperationHistory`.
  - `app/audit/page.tsx` `/audit` — developer gate + fixed demo identity + `audit.*`.
  - `app/bills/page.tsx` `/bills` — `await searchParams` + `banking.transaction.*`.
  - `app/cards/page.tsx` `/cards` — `banking.card.getCards(userId)`.
  - `app/contacts/page.tsx` `/contacts` — `banking.contact.listContacts(userId)`.
  - `app/investments/page.tsx` `/investments` — products and owned active holdings.
  - `app/security/page.tsx` `/security` — fixed demo identity + `security`/`audit`.
  - `app/subscriptions/page.tsx` `/subscriptions` — `banking.subscription.listSubscriptions(userId)`.
- **Client-data pages** — the following screens read their data at RUNTIME via
  `fetch('/api/*')`; their page module never touches the DB, so they need no DB at build:
  `app/manual/page.tsx` `/manual`, `app/schedules/page.tsx` `/schedules`,
  and `app/runs/page.tsx` `/runs` (the page composes the client `RunHistory`).
- `app/page.tsx` `/` redirects to `/agent`; it does not read the database.
- `app/layout.tsx` reads the validated language preference cookie and wraps the client shell in
  `LocaleProvider`. Every page now renders per request, including client-data pages and the redirect.
  Default locale is Chinese. The shell translates grouped navigation and exposes a language selector.
- `app/api/**/route.ts` — Route Handlers, dynamic by default (no static opt-in) — never prerendered.

**Consequence**: with every DB/cookie-backed server page opted out (`dynamic = 'force-dynamic'`),
`pnpm build` performs NO Prisma reads at build time. Root-layout cookie access makes pages dynamic.
A provisioned SQLite DB is NOT required for
`next build` (the README order `db:generate` → `db:push` → `db:seed` → `dev`/`build` is still
the order for a fully runnable app).

## Routing Table

- `./` → assistant redirect + root layout/globals (this node's own files: `layout.tsx`, `globals.css`, `page.tsx`)
- `./overview` → asset overview, recent transactions and anomaly banner
- `./_components/` → app-local client chrome (private `_` folder, never routed): `AppShell.tsx`, grouped `SidebarNavigation.tsx`, navigation definitions and SVG icons
- `./agent` → AI Agent chat page (renders the client `ChatWindow` with fixed demo identity and persisted conversation state)
- `./api` → HTTP API route handlers (chat SSE, actions list/confirm/verify/cancel, tasks list/read/control, audit, security + security reset, read models, health) + shared `_lib/` (http, types, schemas, fixed demo identity, task-plans, agent-bridge)
- `./activity` → ordinary business operation history
- `./audit` → developer-only Audit Log page
- `./bills` → Bills / 账单 page
- `./cards` → Cards page
- `./security` → Security Center page + `ResetBreakerButton.tsx` (client unlock button)
- `./subscriptions` → Subscriptions page
- `./contacts` → recipient management and explicit delete confirmation
- `./investments` → investment products and owned active holdings
- `./manual` → human-review inbox and resolutions
- `./schedules` → scheduled tasks and delivered notifications
- `./runs` → durable run history and events
- `../components` → React component library the pages compose (sibling — read-only, escalate writes to parent)
- `../agent` → Chat runtime the routes delegate to (sibling — read-only, escalate writes to parent)
- `../tests/app` → Route-handler contract tests (sibling — read-only, escalate writes to parent)

## Notes for Agents

- The pages and route handlers here are **fully implemented** (no `not implemented` stub bodies remain).
  Each route is thin (`validate → delegate → serialize`); shared plumbing lives in `app/api/_lib/`.
- Add a new client-callable capability as a route under `./api`; add a new screen as a page dir with its
  own `CONTEXT.md`. Never import Prisma into a page or a client component.
- **Pending operations are reachable through the assistant.** The chat's mount-time
  restore calls `fetchPendingActions()` for the fixed demo workspace and renders pending decisions and
  recovery entries without repeating the original request. Confirmations and verification inputs
  remain on `/agent`; the action APIs remain available for these inline cards.
- The global `AppShell` sidebar exposes normal screens and optional developer diagnostics. `/` immediately redirects to the assistant;
  `/overview` owns the former dashboard read model.
- Any new shared UI/transport type belongs in `../lib/contracts` (root-owned) — do not define it locally.
- **Chat anomaly-card actions are wired.** `../components/chat/ChatWindow.tsx` builds the sole
  `CardActionHandlers`, whose `onAcknowledge`/`onViewDetail`/`onFreeze` invoke `stream.send('…')` (real
  follow-up turns) alongside `onConfirm`/`onVerify`/`onCancel`. `/agent` mounts `<ChatWindow sessionId={…} className=…/>` using the fixed demo session. The `AnomalyBanner` usages here (`app/overview/page.tsx`, `app/bills/page.tsx`) pass no handler props
  (the banner is display-only). See `../components/chat/cards/CONTEXT.md`.
- **Fixed demo identity; persisted ownership; separately verified unlock.** Routes resolve the configured demo workspace before checking action/task ownership. A foreign resource returns `403 SECURITY_DENIED`; an unknown resource returns 404. `agent-bridge` forwards the fixed `{ userId, sessionId }`, and confirmation surfaces current MFA escalation without exposing codes. Pending actions retain their task/node links, so confirm/verify can refresh the owning plan before and after the decision. Security reset uses the audited `resetSession` policy and requires extra verification or cooldown while locked. Opening the demo does not bypass that policy.
- **Plan-node UI consumption belongs to `../components`.** Chat publishes grounded plan/decision events. Task routes read and control persisted plans with fixed demo ownership. Confirm/verify append updated plan snapshots. `/agent` restores the fixed workspace transcript and plan on page opening; `ChatWindow`, `useAgentStream` and `PlanCard` own their rendering.
