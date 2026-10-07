# app/api — API Route Handlers (the HTTP edge)

## Intent

The **HTTP edge** of the AI Banking Agent: the Next.js App Router route handlers the browser
talks to. This node owns the **transport contract** only — request validation (zod), delegation
to the owning sibling nodes, and response serialization (JSON envelope / SSE frames).

It is deliberately **thin**: `validate (zod) → delegate → serialize`. It holds **no business
logic** — no permission/risk decisions (`@/security`), no money math (`@/lib/money`), no Prisma
writes (through `@/banking-sdk` / the agent's authorized path). It is the only place that knows
about HTTP, cookies, the JSON envelope, and SSE.

Dependency direction is strictly downward: `app/api` depends on `@/agent`, `@/planner`,
`@/banking-sdk`, `@/audit`, `@/security`, `@/lib`. Nothing below imports `app/api`.

## Public API Surface — endpoints

Every handler validates input with zod, delegates to the owner node, and returns the shared
envelope (below). Dynamic-route handlers receive `(req: NextRequest, ctx: IdRouteContext)` where
`ctx.params` is a `Promise` (Next 15); the id is `(await ctx.params).id`.

**Identity is cookie-only** (see Identity resolution): every authenticated surface takes its
session/user from the `banking_session` cookie, never from a query param.

| Method | Path | Request | Success `data` | Delegates to |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status:'ok', time:number, llmMode:'live'\|'mock' }` | `@/lib/config` |
| POST | `/api/chat` | body `ChatTurnRequest`; `?stream=0\|1` (default 1) | stream ⇒ SSE of `AgentStreamEvent` ending `{"type":"done"}`; non-stream ⇒ `ChatTurnResponse` | `@/agent` `runTurn` / `resumeTurn` |
| GET | `/api/actions` | — (cookie session only) | `PendingAction[]` — the caller session's surfaced actions (`SURFACED_STATUSES` = `pending`/`awaiting_mfa`/`needs_reconciliation`); refresh-restore | `@/lib/db/repositories/pendingAction` `listPendingActions` |
| POST | `/api/actions/[id]/confirm` | body `{}` | `ActionResponse` (cookie identity; ownership enforced: cross-session/user → `403 SECURITY_DENIED`; MFA escalation surfaced) | `_lib/agent-bridge` `confirmOwned` → `@/agent` `confirm` (forwards `{userId,sessionId}`) |
| POST | `/api/actions/[id]/verify` | body `{ code: string }` | `ActionResponse` (wrong code ⇒ 200 with `data.ok=false`, `status:'awaiting_mfa'`; ownership enforced) | `_lib/agent-bridge` `verifyOwned` → `@/agent` `verify` (forwards `{userId,sessionId}`) |
| POST | `/api/actions/[id]/cancel` | body `{}` | `ActionResponse` (`status:'cancelled'`; ownership enforced) | `_lib/agent-bridge` `cancelOwned` → `@/agent` `cancel` (forwards `{userId,sessionId}`) |
| GET | `/api/tasks` | — (cookie session only) | `{ plans: TaskPlan[] }` | persisted `AgentTask` rows via `@/lib/db/repositories/task` |
| GET | `/api/tasks/[id]` | — (cookie session only) | `AppTaskPlan` — a `TaskPlan` whose `results` ADDITIVELY carry each node's `pendingActionId` | persisted `AgentTask` row via `@/lib/db/repositories/task` |
| POST | `/api/tasks/[id]` | body `{ action:'pause'\|'resume'\|'cancel'\|'retry' }` | `TaskPlan` | `@/agent` execution control via `_lib/agent-bridge` (ownership enforced) |
| GET | `/api/audit` | query `{ toolName?, riskLevel?, status?, limit? }` (session from cookie) | `{ entries: AuditEntry[]; summary: AuditSummary }` | `@/audit` `listAudit` + `getAuditSummary` |
| GET | `/api/security` | — (session from cookie) | `{ status: SecurityStatus; events: SecurityEvent[]; circuitBreaker: { failures; max; locked } }` | `@/audit` `getSecurityStatus`/`listSecurityEvents` + `@/security` `circuitBreaker.getState`/`isLocked` |
| POST | `/api/security/reset` | session via cookie | `ResetData { sessionId, locked, failures, max, message }` | `@/security` `circuitBreaker.resetSession(sessionId, { actor, reason })` — audited unlock |
| GET | `/api/dashboard` | — | `DashboardSummary` | `@/banking-sdk` `banking.dashboard.getDashboardSummary` |
| GET | `/api/bills` | query `{ month? }` (`YYYY-MM`) | `{ analysis: SpendingAnalysis; transactions: TransactionView[]; anomalies: AnomalyItem[] }` | `@/banking-sdk` `banking.transaction.*` |
| GET | `/api/cards` | — | `{ cards: CardView[] }` | `@/banking-sdk` `banking.card.getCards` |
| GET | `/api/subscriptions` | — | `{ subscriptions: SubscriptionView[] }` | `@/banking-sdk` `banking.subscription.listSubscriptions` |

Read routes are **GREEN reads only**. Card/subscription/transfer **mutations are NOT exposed as
endpoints** — they are gated tools the agent invokes through the Security Gateway; the only
human-triggered execution path is the `actions/*` group. `POST /api/security/reset` is the one
non-`actions/*` mutation: an explicit user action that clears the session circuit breaker via the
audited `resetSession` (the runtime unlock path — see Notes).

## Response envelope & error mapping

- Success: `{ ok: true, data: T }`. Failure: `{ ok: false, error: { code: ErrorCode, message: string } }`
  (`ErrorCode` from `@/lib/errors`; envelope types in `_lib/types.ts`).
- `_lib/http.ts` owns the single mapping `AppError.code → HTTP status`:

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

- **Never leak internals**: raw exceptions, stack traces, Prisma errors and **the MFA code** must
  not appear in any body. A non-`AppError` throwable maps to `INTERNAL` with a generic message.
- **Domain outcomes are 200, not errors**: a wrong MFA code and a cancelled/pending action are
  normal results — `200 { ok:true, data: ActionResponse{ ok:false, … } }`. Reserve non-2xx for the
  error envelope above (e.g. `CIRCUIT_OPEN` → 423).

## Streaming contract (`POST /api/chat`)

- Default (`?stream=1` or omitted): `Content-Type: text/event-stream`. Each `AgentStreamEvent` is
  written as one frame `data: <JSON>\n\n` (via `sseFrame`); the turn terminates with
  `data: {"type":"done"}\n\n`. A mid-turn failure emits `data: {"type":"error","message":"<safe>"}\n\n`
  then `done`. The response is built with `sseResponse(stream)`.
- Non-streaming (`?stream=0` or `Accept: application/json`): `200 { ok:true, data: ChatTurnResponse }`
  where `data = { sessionId, events: AgentStreamEvent[] }`. `?stream=0` overrides the `Accept` header.
- Either mode drives the same agent entry point `@/agent` `runTurn(req, deps?)`, which **returns the
  full ordered event log** (there is no `onEvent` sink): the streaming path writes each returned event
  as a frame (appending its own `done` terminator only if the last returned event is not already
  `done`); the non-streaming path uses `ChatTurnResponse.events` verbatim.
- `Set-Cookie: banking_session=<sessionId>; Path=/; HttpOnly; SameSite=Lax` is set on EVERY SUCCESSFUL
  chat response (streaming and JSON) from the RETURNED session id (never a body-supplied id); a rejected
  turn (see below) sets no cookie. This cookie IS the trusted identity every other route reads.
- **Chat identity is COOKIE-ONLY.** The turn's session comes solely from the `banking_session`
  cookie (`_lib/session` `resolveSessionId`), never from the request body: a body `sessionId` that
  DISAGREES with the cookie — INCLUDING when no cookie is present — is rejected with `409 CONFLICT`
  and sets NO cookie, so a body `sessionId` can never select or mint a session (or exchange a foreign
  session id for an authorization cookie). The `Set-Cookie` always mirrors the session actually used
  (`res.sessionId`).

## Identity resolution (`_lib/session.ts`) — cookie-only, server-derived

Identity is TRUSTED server-side data; a query param NEVER forges, overrides or widens it.

- `resolveSessionId(req?)` → the `banking_session` cookie (`SESSION_COOKIE`) ONLY, else `undefined`.
  Any `?sessionId=` query param is IGNORED on every route.
- `resolveIdentity(req?)` → `Promise<{ sessionId: string; userId: string } | null>`: reads the cookie,
  loads the `AgentSession` row via `getSession`, returns `{ sessionId: row.id, userId: row.userId }`
  (`null` when the cookie is absent OR the session is unknown). The user id comes SERVER-SIDE from the
  session row.
- `requireIdentity(req?)` → `resolveIdentity` or throw `AppError('SECURITY_DENIED')` (403). Used by
  every authenticated handler — `actions/[id]/{confirm,verify,cancel}`, `GET /api/actions`,
  `GET`/`POST /api/tasks/[id]`, `POST /api/security/reset`.
- `resolveUserId()` → `getConfig().demoUserId || DEFAULT_DEMO_USER_ID`, NO `req`/query. This is the
  **NON-AUTHORITATIVE demo-read user**, used ONLY by the four GREEN read routes
  (`dashboard`/`bills`/`cards`/`subscriptions`) that render the single seeded demo user's simulated
  data — never for any auth/ownership/write decision.

## Shared helpers (`_lib/` — private folder, never a route)

- `_lib/types.ts` — app-layer transport types: `ApiEnvelope<T>`/`ApiSuccess`/`ApiFailure`,
  `ActionResponse`, `IdRouteContext`.
- `_lib/http.ts` — `ok`/`fail`/`mapAppError`/`jsonResponse`/`errorResponse`/`parseBody`/`parseQuery`
  plus SSE helpers `SSE_HEADERS`/`sseFrame`/`sseResponse`. `parseQuery`/`parseBody` throw
  `AppError('VALIDATION')` on a schema mismatch.
- `_lib/schemas.ts` — the shared zod query fragment `limitQuerySchema` (the `userId`/`sessionId`
  query schemas were removed: identity is cookie-only, so no route parses an identity query param).
- `_lib/session.ts` — `resolveSessionId` / `resolveIdentity` / `requireIdentity` / `resolveUserId`
  (see Identity resolution above).
- `_lib/agent-bridge.ts` — the ONE module that knows the agent control/ownership/plan API. It imports
  the control + plan-lookup fns STATICALLY from `@/agent`
  (`pauseTask`/`resumeTask`/`cancelTask`/`retryTask`, `findTaskByPendingAction`, `getTaskPlan`) and
  exposes: `resolveTaskControl(action) → TaskControlFn` (a `Record` lookup over those imports, still
  failing LOUDLY with `TOOL_FAILED` when an entry is missing);
  `confirmOwned`/`verifyOwned`/`cancelOwned` (forward the `{ userId, sessionId }` ownership bag);
  `locateOwningPlan(sessionId, actionId) → LocatedPlan` (`{ sessionId, taskId } | undefined`, the
  reverse lookup of the plan node parked on an action — call it BEFORE the decision clears the node);
  `withPlanUpdate(outcome, located)` (append a refreshed `plan_update` event to a SUCCESSFUL
  `ConfirmationOutcome`). Imports only `@/agent` — no Prisma, no DAG logic.
- `_lib/task-plans.ts` — pure mapping from persisted `AgentTask`/`AgentTaskNode` rows to the
  APP-LOCAL `AppTaskPlan` (= `TaskPlan` with `results: AppTaskNodeResult[]`); each node ADDITIVELY
  carries `pendingActionId?: string`, lifted from the node's parsed `output` via `@/agent`'s
  `readPendingActionId`. JSON columns are decoded with `safeParse`. `AppTaskPlan` stays assignable to
  the frozen `TaskPlan` (no `@/lib/contracts` change). Used by `/api/tasks*` (see Notes).

## Agent runtime surface this node depends on (`@/agent`, owner)

`runTurn` resolves the demo user internally and returns the **full ordered event log** (including a
trailing `{type:'done'}` event); it takes NO `onEvent` sink and NO `userId`. `confirm`/`verify`/`cancel`
return a `ConfirmationOutcome` which carries NO `sessionId`/`requiresMfa`/`mfaResult` — the actions
routes derive those (see Notes) and forward `{ userId, sessionId }` ownership through `_lib/agent-bridge`
(`confirmOwned`/`verifyOwned`/`cancelOwned`).

```ts
runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse>;   // ChatTurnRequest = { sessionId?; message }
resumeTurn(input: ResumeTurnInput, deps?: RunTurnDeps): Promise<ChatTurnResponse>;
confirm(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;  // opts forwarded from the ownership bag
verify(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
cancel(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
// ConfirmationOutcome = { ok; actionId; status: PendingActionStatus; tier: RiskLevel; message; result?; events }
// Task execution control (statically imported by the bridge): pauseTask/resumeTask/cancelTask/retryTask(sessionId, taskId) => TaskPlan
// Plan lookup: findTaskByPendingAction(sessionId, actionId) => { taskId; nodeId } | undefined
//              getTaskPlan(sessionId, taskId) => TaskPlan  // ownership-checked
// Also re-exported for the read model: readPendingActionId(output) => string | undefined
```

## Dependencies

- `@/agent` (read-only): chat runtime (`runTurn`/`resumeTurn` + `confirm`/`verify`/`cancel`, the
  aliases of `confirmAction`/`verifyAction`/`cancelAction`) + task execution control
  (`pauseTask`/`resumeTask`/`cancelTask`/`retryTask`) + plan lookup
  (`findTaskByPendingAction`/`getTaskPlan`) + `readPendingActionId`, all accessed through
  `_lib/agent-bridge` / `_lib/task-plans`.
- `@/banking-sdk` (read-only): read models (`banking.dashboard/transaction/card/subscription/…`, DTOs).
- `@/audit` (read-only): `listAudit`, `getAuditSummary`, `listSecurityEvents`, `getSecurityStatus`.
- `@/security` (read-only): `circuitBreaker.getState`/`isLocked` for `/api/security`; the audited `circuitBreaker.resetSession` for `/api/security/reset`.
- `@/planner` (read-only): `TaskPlan` type for the `/api/tasks*` read models.
- `@/lib` (read-only): contracts, `AppError`/`ErrorCode`/`Result`, `getConfig`, constants, money,
  and the typed read path `@/lib/db/repositories/*` (`session`, `task`, `pendingAction`) + `lib/json`.
- `../tests/app` (sibling — read-only, escalate writes to root): route-handler contract tests. They
  currently pass `?sessionId=` and set NO cookie, so they fail against the cookie-only identity model
  (see Known Issues).

## Constraints

- **No business logic here.** No permission/risk decisions, no money math, no Prisma writes.
- Route handlers thin and ≲ ~150 lines; push shared plumbing into `_lib/http.ts`.
- **Validate every body/query with zod** before delegating; reject with `AppError('VALIDATION')`.
- **Never import Prisma directly** — go through `@/banking-sdk`, `@/audit`, `@/security`, `@/planner`,
  or the typed read path `@/lib/db/repositories/*`.
- **Identity is cookie-only + server-derived** (`_lib/session.ts`): `requireIdentity` on every auth/write
  path; a query param must NEVER override it. `resolveUserId()` is the non-authoritative demo-read user
  (GREEN reads only) and must never gate access.
- Money is CNY rendered via `@/lib/money` (`¥1,234.56`); risk uses `RISK_LABEL` (🟢/🟡/🔴).
- **Determinism**: routes must build/render without network; agent runs use `LLM_MODE=mock`.
- No LLM chain-of-thought in any payload — only task steps, tool status, results.

## Test Strategy

- **Route-handler contract tests** in `../tests/app/` (Vitest). Handlers are plain
  `(req, ctx) => Response` functions, so tests build synthetic `Request`/`NextRequest` objects and
  invoke them directly, asserting: zod mismatch → `400 VALIDATION`, each `AppError` → its mapped
  status, success → `{ ok:true, data }`, domain failures → `200` with `data.ok=false`, and that the
  MFA code never appears in a body. An authenticated request MUST carry the `banking_session` cookie
  (identity is cookie-only) — a request without it (or with an unknown session) is `403 SECURITY_DENIED`.
- **Dependencies are mocked at the module boundary** (`vi.mock('@/agent')`, `vi.mock('@/banking-sdk')`,
  `vi.mock('@/audit')`) — no live Prisma, no network.
- **Transport tests** for `POST /api/chat`: SSE frames + single `done` terminator, and the `?stream=0`
  JSON fallback. End-to-end acceptance (the 12 demo scenarios) are driven through `@/agent` + `../tests`.
- `_lib/http.ts` (envelope/error-map/SSE encoders), `_lib/task-plans.ts` (row → `AppTaskPlan`),
  `_lib/session.ts` (`resolveIdentity`/`requireIdentity`) and `_lib/agent-bridge.ts` (capability
  resolution, plan location + refreshed-`plan_update` assembly, ownership forwarding) are pure.

## Known Issues

- **Root-owned `../tests/app/*.test.ts` still identify by `?sessionId=` (no cookie)** — the identity
  model is cookie-only now, so every authenticated call in `tests/app/harness.ts`
  (`actionUrl`/`taskUrl`/`tasksUrl`) fails closed with `403 SECURITY_DENIED`. The harness needs a cookie
  helper (`Cookie: banking_session=<id>`) and the call sites must pass the session as that cookie; two
  `tasks-http.test.ts` assertions also encode the old behavior (session-less control expected `400
  VALIDATION` → now `403`; unknown-id-without-identity → `403` before the `404`). `../tests` is
  root-owned — escalate the fix there.
- **Root-owned `../tests/app/*.test.ts` bootstrap sessions via a cookie-less body `sessionId`** — their
  shared harness sends the FIRST `POST /api/chat` with `{ sessionId: <fresh>, message }` and NO cookie,
  then reuses the returned cookie. With the cookie-only chat rule that first turn is now `409 CONFLICT`
  (a body `sessionId` can no longer mint a session), so the setup fails before any assertion. The fix
  belongs in `../tests/app` (root-owned — escalate): create the first turn WITHOUT a body `sessionId`
  and take the cookie from the response; send identity on action/task calls as the
  `Cookie: banking_session=<id>` header.

## Routing Table

- `./health/route.ts` → `GET /api/health` liveness + `llmMode` probe
- `./chat/route.ts` → `POST /api/chat` — one agent turn (SSE stream or JSON), session cookie on every response
- `./actions/route.ts` → `GET /api/actions` — the caller session's surfaced pending actions (`SURFACED_STATUSES`: `pending`/`awaiting_mfa`/`needs_reconciliation`) (cookie-only identity; refresh-restore)
- `./actions/[id]/confirm/route.ts` → `POST /api/actions/[id]/confirm` — execute a confirmed pending action (cookie identity, ownership-enforced, MFA-escalation surfaced)
- `./actions/[id]/verify/route.ts` → `POST /api/actions/[id]/verify` — MFA code submission for a RED action (ownership-enforced)
- `./actions/[id]/cancel/route.ts` → `POST /api/actions/[id]/cancel` — cancel a pending action (ownership-enforced)
- `./tasks/route.ts` → `GET /api/tasks` — list the caller session's task plans (cookie-scoped)
- `./tasks/[id]/route.ts` → `GET`/`POST /api/tasks/[id]` — read one plan (ownership-enforced, `pendingActionId` exposed) / control its execution (pause|resume|cancel|retry)
- `./audit/route.ts` → `GET /api/audit` — audit entries + summary (cookie-scoped)
- `./security/route.ts` → `GET /api/security` — security-center status + events + breaker counters (cookie-scoped)
- `./security/reset/route.ts` → `POST /api/security/reset` — clear the session's circuit breaker via the audited `resetSession` (owner identity required)
- `./dashboard/route.ts` → `GET /api/dashboard` — dashboard read model
- `./bills/route.ts` → `GET /api/bills` — spending analysis + transactions + anomalies
- `./cards/route.ts` → `GET /api/cards` — cards read model
- `./subscriptions/route.ts` → `GET /api/subscriptions` — subscriptions read model
- `./_lib/` → shared handler plumbing (envelope, error mapping, zod parse, SSE, session identity, task-plan mapping, agent bridge) — private `_`-folder, never a route
- `../tests/app/` → route-handler contract tests (sibling — read-only, escalate writes to parent)

## Notes for Agents

- **All handlers are implemented.** Each `route.ts` validates with zod, delegates to the owner node
  and serializes; the body is wrapped in try/catch → `errorResponse(e)`.
- **Next.js 15 route-export rule.** A `route.ts` may export ONLY HTTP-method handlers and known config
  fields (`dynamic`/`revalidate`/`runtime`/…). Any other runtime `export const` (e.g. a zod schema) fails
  the build with `Property 'X' is incompatible with index signature … not assignable to type 'never'`.
  Keep route-local zod schemas as NON-exported `const`s (or move them into `_lib/schemas.ts`); `export type`
  / `export interface` are fine.
- **Every auth/write route guards identity FIRST.** `confirm`/`verify`/`cancel`, `GET /api/actions`,
  `GET`/`POST /api/tasks/[id]` and `POST /api/security/reset` all call `requireIdentity(req)` before
  touching the body/DB — a missing cookie or unknown session → `403 SECURITY_DENIED` (fail-closed). The
  trusted `{ sessionId, userId }` is then used for the ownership check and forwarded to `@/agent`. A
  `?sessionId=`/`?userId=` query param is ignored everywhere (no query-trusted identity).
- **Actions routes enforce OWNERSHIP before delegating.** After `requireIdentity`, a `getPendingAction`
  guard rejects a session/user MISMATCH with `403 SECURITY_DENIED` (`'无权确认该操作。'` / `'无权验证该操作。'`
  / `'无权取消该操作。'`). They then delegate through `_lib/agent-bridge`
  (`confirmOwned`/`verifyOwned`/`cancelOwned`), forwarding the `{ userId, sessionId }` ownership bag.
  The routes map `ConfirmationOutcome` → `_lib/types.ActionResponse`: `sessionId` from the persisted
  `PendingAction` row (fallback the trusted identity), `tier` = the effective `outcome.tier`, and
  `mfaResult` derived (`verify` → `ok?'success':(status==='awaiting_mfa'?'failed':'not_required')`, else
  `'not_required'`).
  **MFA escalation is surfaced (confirm).** `requiresMfa = outcome.status === 'awaiting_mfa' || outcome.tier === 'RED'`
  (derived — `ConfirmationOutcome` carries no such field) and, when it escalates, `events` gets a
  `{ type:'mfa_required', actionId, hint }` prepended (deduped against the agent's own events) so the UI
  can prompt for the code. The MFA code is NEVER emitted. `verify` keeps a wrong code as a NORMAL 200
  `data.ok=false`.
  **Confirm/verify also forward PLAN progress**: BEFORE delegating, each calls
  `locateOwningPlan(row?.sessionId, id)` (a plain non-plan action → `undefined`, skipped silently) and,
  on a SUCCESSFUL outcome, `withPlanUpdate(outcome, located)` → appends a refreshed `plan_update` (the
  owning plan re-read via the ownership-checked `getTaskPlan`) to `events`, so `/agent` refreshes its
  plan view. `cancel` emits NO `plan_update` (a cancelled node would still read `waiting_confirmation` —
  not meaningful). A `cancel` of an unknown/settled action surfaces the owner's thrown
  `AppError('NOT_FOUND'|'CONFLICT')`.
- **`GET /api/actions`** is the refresh-restore endpoint: `requireIdentity` → `listPendingActions({ sessionId })`
  filtered to `SURFACED_STATUSES` = `pending`/`awaiting_mfa` (non-terminal — still awaiting a human
  decision) plus `needs_reconciliation` (TERMINAL — the manual-reconciliation entry for a gated side
  effect whose outcome could not be recorded; it must stay user-visible until a human settles it) →
  mapped to the frozen `PendingAction` contract
  (JSON args/summary via `safeParse`, epoch-ms timestamps) → `200 { ok:true, data: PendingAction[] }`.
  Never contains the MFA code.
- **Task plans & control (`/api/tasks*`).** Read models come from the persisted `AgentTask`/`AgentTaskNode`
  rows via `@/lib/db/repositories/task`, mapped to `AppTaskPlan` in `_lib/task-plans.ts` (each node's
  `pendingActionId` lifted from its parsed `output`). `GET /api/tasks` is cookie-scoped (a session-less
  caller gets `200 {plans:[]}`). `GET /api/tasks/[id]` requires identity, returns `404 NOT_FOUND` for an
  unknown id and `403 SECURITY_DENIED` for a foreign session/user. `POST /api/tasks/[id]` performs REAL
  execution control: `requireIdentity` first (403 if absent/unknown), then `404`/`403`, then delegates to
  `@/agent` via `_lib/agent-bridge` (`pauseTask`/`resumeTask`/`cancelTask`/`retryTask`) — `pause` stops
  before the next node, `cancel` stops and cancels the remaining nodes, `retry` re-runs only the failed
  node, `resume` continues without re-running succeeded nodes. The bridge fails loudly with `TOOL_FAILED`
  (502) when a control action resolves to no capability or the control returns no plan. There is NO
  `POST /api/tasks` collection handler.
- **`POST /api/security/reset`** is the runtime unlock path for a tripped breaker (the gateway's
  "前往安全中心解除限制" pointer). It requires identity (`requireIdentity`) then calls the AUDITED async
  `security.circuitBreaker.resetSession(sessionId, { actor: 'user' })`, which clears the breaker state AND
  records a `SECURITY_RESET` `SecurityEvent`, returning the fresh `CircuitBreakerState` used to build
  `ResetData`. It parses NO request body.
- Add a new client-callable capability as a route group here; a group with a dynamic id uses a
  `[id]/route.ts` leaf. Folders prefixed `_` (like `_lib`) are private and never routed.
- Any new shared domain type belongs in `@/lib/contracts` (root-owned); app-only transport types
  belong in `_lib/types.ts` (e.g. `AppTaskPlan`). Never redefine a root contract here.
