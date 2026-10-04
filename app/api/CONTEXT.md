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

| Method | Path | Request | Success `data` | Delegates to |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | — | `{ status:'ok', time:number, llmMode:'live'\|'mock' }` | `@/lib/config` |
| POST | `/api/chat` | body `ChatTurnRequest`; `?stream=0\|1` (default 1) | stream ⇒ SSE of `AgentStreamEvent` ending `{"type":"done"}`; non-stream ⇒ `ChatTurnResponse` | `@/agent` `runTurn` / `resumeTurn` |
| POST | `/api/actions/[id]/confirm` | body `{}` | `ActionResponse` (ownership enforced: cross-session/user → `403 SECURITY_DENIED`) | `_lib/agent-bridge` `confirmOwned` → `@/agent` `confirm` (forwards `{userId,sessionId}`) |
| POST | `/api/actions/[id]/verify` | body `{ code: string }` | `ActionResponse` (wrong code ⇒ 200 with `data.ok=false`, `status:'awaiting_mfa'`; ownership enforced) | `_lib/agent-bridge` `verifyOwned` → `@/agent` `verify` (forwards `{userId,sessionId}`) |
| POST | `/api/actions/[id]/cancel` | body `{}` | `ActionResponse` (`status:'cancelled'`; ownership enforced) | `_lib/agent-bridge` `cancelOwned` → `@/agent` `cancel` (forwards `{userId,sessionId}`) |
| GET | `/api/tasks` | query `{ sessionId?, limit? }` | `{ plans: TaskPlan[] }` | persisted `AgentTask` rows via `@/lib/db/repositories/task` |
| GET | `/api/tasks/[id]` | — | `TaskPlan` | persisted `AgentTask` row via `@/lib/db/repositories/task` |
| POST | `/api/tasks/[id]` | body `{ action:'pause'\|'resume'\|'cancel'\|'retry' }` | `TaskPlan` | `@/agent` execution control via `_lib/agent-bridge` (session-owned; see Notes) |
| GET | `/api/audit` | query `{ sessionId?, toolName?, riskLevel?, status?, limit? }` | `{ entries: AuditEntry[]; summary: AuditSummary }` | `@/audit` `listAudit` + `getAuditSummary` |
| GET | `/api/security` | query `{ sessionId? }` | `{ status: SecurityStatus; events: SecurityEvent[]; circuitBreaker: { failures; max; locked } }` | `@/audit` `getSecurityStatus`/`listSecurityEvents` + `@/security` `circuitBreaker.getState`/`isLocked` |
| POST | `/api/security/reset` | session via cookie / `?sessionId=` | `ResetData { sessionId, locked, failures, max, message }` | `@/security` `circuitBreaker.resetSession(sessionId, { actor, reason })` — audited unlock |
| GET | `/api/dashboard` | query `{ userId? }` | `DashboardSummary` | `@/banking-sdk` `banking.dashboard.getDashboardSummary` |
| GET | `/api/bills` | query `{ month? }` (`YYYY-MM`) | `{ analysis: SpendingAnalysis; transactions: TransactionView[]; anomalies: AnomalyItem[] }` | `@/banking-sdk` `banking.transaction.*` |
| GET | `/api/cards` | query `{ userId? }` | `{ cards: CardView[] }` | `@/banking-sdk` `banking.card.getCards` |
| GET | `/api/subscriptions` | query `{ userId? }` | `{ subscriptions: SubscriptionView[] }` | `@/banking-sdk` `banking.subscription.listSubscriptions` |

Read routes are **GREEN reads only**. Card/subscription/transfer **mutations are NOT exposed as
endpoints** — they are gated tools the agent invokes through the Security Gateway; the only
human-triggered execution path is the `actions/*` group. `POST /api/security/reset` is the one
non-`actions/*` mutation: an explicit user action that clears the session circuit breaker (the
runtime unlock path — see Notes).

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
- `Set-Cookie: banking_session=<sessionId>; Path=/; HttpOnly; SameSite=Lax` is set on EVERY chat
  response (streaming and JSON) from the returned session id.

## Session & user resolution (`_lib/session.ts`)

- `resolveUserId(req?)` → `?userId=` query → `getConfig().demoUserId` → `DEFAULT_DEMO_USER_ID`.
- `resolveSessionId(req?)` → `?sessionId=` query → `banking_session` cookie (`SESSION_COOKIE`),
  else `undefined` (the agent creates a session on the first chat turn).

## Shared helpers (`_lib/` — private folder, never a route)

- `_lib/types.ts` — app-layer transport types: `ApiEnvelope<T>`/`ApiSuccess`/`ApiFailure`,
  `ActionResponse`, `IdRouteContext`.
- `_lib/http.ts` — `ok`/`fail`/`mapAppError`/`jsonResponse`/`errorResponse`/`parseBody`/`parseQuery`
  plus SSE helpers `SSE_HEADERS`/`sseFrame`/`sseResponse`. `parseQuery`/`parseBody` throw
  `AppError('VALIDATION')` on a schema mismatch.
- `_lib/schemas.ts` — shared zod query fragments (`userIdQuerySchema`, `sessionIdQuerySchema`,
  `limitQuerySchema`).
- `_lib/session.ts` — `resolveUserId` / `resolveSessionId`.
- `_lib/agent-bridge.ts` — the ONE module that knows the agent control/ownership API: resolves the
  runtime task-control capability (`pauseTask`/`resumeTask`/`cancelTask`/`retryTask`) off a namespace
  import of `@/agent` (they are not named exports yet), failing LOUDLY with `TOOL_FAILED` when absent;
  forwards `{ userId, sessionId }` ownership to `confirm`/`verify`/`cancel`. Imports only `@/agent` —
  no Prisma, no DAG logic.
- `_lib/task-plans.ts` — pure mapping from persisted `AgentTask`/`AgentTaskNode` rows to the frozen
  `TaskPlan` contract (JSON columns decoded with `safeParse`); used by `/api/tasks*` (see Notes).

## Agent runtime surface this node depends on (`@/agent`, owner)

`runTurn` resolves the demo user internally and returns the **full ordered event log** (including a
trailing `{type:'done'}` event); it takes NO `onEvent` sink and NO `userId`. `confirm`/`verify`/`cancel`
return a `ConfirmationOutcome` which carries NO `sessionId`/`requiresMfa`/`mfaResult` — the actions
routes derive those (see Notes).

```ts
runTurn(req: ChatTurnRequest, deps?: RunTurnDeps): Promise<ChatTurnResponse>;   // ChatTurnRequest = { sessionId?; message }
resumeTurn(input: ResumeTurnInput, deps?: RunTurnDeps): Promise<ChatTurnResponse>;
confirm(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
verify(actionId: string, code: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
cancel(actionId: string, opts?: ConfirmOptions): Promise<ConfirmationOutcome>;
// ConfirmationOutcome = { ok; actionId; status: PendingActionStatus; tier: RiskLevel; message; result?; events }
```

## Dependencies

- `@/agent` (read-only): chat runtime (`runTurn`/`resumeTurn`/`confirm`/`verify`/`cancel`) + task
  execution control (`pauseTask`/`resumeTask`/`cancelTask`/`retryTask`), both accessed through
  `_lib/agent-bridge`.
- `@/banking-sdk` (read-only): read models (`banking.dashboard/transaction/card/subscription/…`, DTOs).
- `@/audit` (read-only): `listAudit`, `getAuditSummary`, `listSecurityEvents`, `getSecurityStatus`.
- `@/security` (read-only): `circuitBreaker.getState`/`isLocked` for `/api/security`; the audited `circuitBreaker.resetSession` for `/api/security/reset`.
- `@/planner` (read-only): `TaskPlan` type for `/api/tasks*` (no cross-request plan store — see Notes).
- `@/lib` (read-only): contracts, `AppError`/`ErrorCode`/`Result`, `getConfig`, constants, money,
  and the typed read path `@/lib/db/repositories/*` (`task`, `pendingAction`) + `lib/json`.
- `../tests/app` (sibling — read-only, escalate writes to root): route-handler contract tests.

## Constraints

- **No business logic here.** No permission/risk decisions, no money math, no Prisma writes.
- Route handlers thin and ≲ ~150 lines; push shared plumbing into `_lib/http.ts`.
- **Validate every body/query with zod** before delegating; reject with `AppError('VALIDATION')`.
- **Never import Prisma directly** — go through `@/banking-sdk`, `@/audit`, `@/security`, `@/planner`,
  or the typed read path `@/lib/db/repositories/*`.
- Demo user + session come from `_lib/session.ts`.
- Money is CNY rendered via `@/lib/money` (`¥1,234.56`); risk uses `RISK_LABEL` (🟢/🟡/🔴).
- **Determinism**: routes must build/render without network; agent runs use `LLM_MODE=mock`.
- No LLM chain-of-thought in any payload — only task steps, tool status, results.

## Test Strategy

- **Route-handler contract tests** in `../tests/app/` (Vitest). Handlers are plain
  `(req, ctx) => Response` functions, so tests build synthetic `Request`/`NextRequest` objects and
  invoke them directly, asserting: zod mismatch → `400 VALIDATION`, each `AppError` → its mapped
  status, success → `{ ok:true, data }`, domain failures → `200` with `data.ok=false`, and that the
  MFA code never appears in a body.
- **Dependencies are mocked at the module boundary** (`vi.mock('@/agent')`, `vi.mock('@/banking-sdk')`,
  `vi.mock('@/audit')`) — no live Prisma, no network.
- **Transport tests** for `POST /api/chat`: SSE frames + single `done` terminator, and the `?stream=0`
  JSON fallback. End-to-end acceptance (the 12 demo scenarios) is driven through `@/agent` + `../tests`.
- `_lib/http.ts` (envelope/error-map/SSE encoders) and `_lib/task-plans.ts` (row → `TaskPlan`) are pure.

## Routing Table

- `./health/route.ts` → `GET /api/health` liveness + `llmMode` probe
- `./chat/route.ts` → `POST /api/chat` — one agent turn (SSE stream or JSON), session cookie on every response
- `./actions/[id]/confirm/route.ts` → `POST /api/actions/[id]/confirm` — execute a confirmed pending action
- `./actions/[id]/verify/route.ts` → `POST /api/actions/[id]/verify` — MFA code submission for a RED action
- `./actions/[id]/cancel/route.ts` → `POST /api/actions/[id]/cancel` — cancel a pending action
- `./tasks/route.ts` → `GET /api/tasks` — list task plans for a session
- `./tasks/[id]/route.ts` → `GET`/`POST /api/tasks/[id]` — read one plan / steer it (pause|resume|cancel|retry)
- `./audit/route.ts` → `GET /api/audit` — audit entries + summary
- `./security/route.ts` → `GET /api/security` — security-center status + events + breaker counters
- `./security/reset/route.ts` → `POST /api/security/reset` — clear the session's circuit breaker (the unlock path)
- `./dashboard/route.ts` → `GET /api/dashboard` — dashboard read model
- `./bills/route.ts` → `GET /api/bills` — spending analysis + transactions + anomalies
- `./cards/route.ts` → `GET /api/cards` — cards read model
- `./subscriptions/route.ts` → `GET /api/subscriptions` — subscriptions read model
- `./_lib/` → shared handler plumbing (envelope, error mapping, zod parse, SSE, session, task-plan mapping, agent bridge) — private `_`-folder, never a route
- `../tests/app/` → route-handler contract tests (sibling — read-only, escalate writes to parent)

## Notes for Agents

- **All handlers are implemented.** Each `route.ts` validates with zod, delegates to the owner node
  and serializes; the body is wrapped in try/catch → `errorResponse(e)`.
- **Next.js 15 route-export rule.** A `route.ts` may export ONLY HTTP-method handlers and known config
  fields (`dynamic`/`revalidate`/`runtime`/…). Any other runtime `export const` (e.g. a zod schema) fails
  the build with `Property 'X' is incompatible with index signature … not assignable to type 'never'`.
  Keep route-local zod schemas as NON-exported `const`s (or move them into `_lib/schemas.ts`); `export type`
  / `export interface` are fine.
- **`POST /api/security/reset`** is the runtime unlock path for a tripped breaker (the gateway's
  "前往安全中心解除限制" pointer). Session id resolution matches `GET /api/security`. It calls the
  async (it records a `SECURITY_RESET` SecurityEvent) — call it as
  `await Promise.resolve(security.circuitBreaker.reset(sid))` so both `void` and `Promise` signatures work;
  then read the fresh state via `getState` for the response.
- **`@/planner` has no cross-request plan store.** `/api/tasks*` read the persisted `AgentTask`/
  `AgentTaskNode` rows through the sanctioned read path `@/lib/db/repositories/task` and map them to
  `TaskPlan` in `_lib/task-plans.ts`; the executor's `PlanControls` are in-process and not reachable
  across HTTP. `GET /api/tasks` with an unknown/empty session returns `{plans:[]}` (200);
  `GET /api/tasks/[id]` unknown → `404 NOT_FOUND`. `POST /api/tasks/[id]` is NOT best-effort: it REQUIRES the
  owning session (`resolveSessionId`, else `400 VALIDATION`; non-owner → `403 SECURITY_DENIED`) and delegates
  the
  REAL execution control to `@/agent` via `_lib/agent-bridge` (`pause`/`resume`/`cancel`/`retry`), failing
  loudly with `TOOL_FAILED` when the capability is absent (and when the control returns no plan).
- **Actions routes** map `ConfirmationOutcome` → `_lib/types.ActionResponse`: `requiresMfa = tier === 'RED'`,
  `sessionId` from the persisted `PendingAction` row (fallback `resolveSessionId`), `mfaResult` derived
  (`verify` → `ok?'success':(status==='awaiting_mfa'?'failed':'not_required')`, else `'not_required'`).
  A `cancel` of an unknown/settled action surfaces the owner's thrown `AppError('NOT_FOUND'|'CONFLICT')`.
  Each action route ALSO enforces OWNERSHIP before delegating: `resolveSessionId` + `resolveUserId`, then a
  `getPendingAction` guard that rejects an explicit session/user mismatch with `403 SECURITY_DENIED`; it then
  delegates through `_lib/agent-bridge` (`confirmOwned`/`verifyOwned`/`cancelOwned`), which forwards the
  `{ userId, sessionId }` ownership bag to `@/agent`.
- Add a new client-callable capability as a route group here; a group with a dynamic id uses a
  `[id]/route.ts` leaf. Folders prefixed `_` (like `_lib`) are private and never routed.
- Any new shared domain type belongs in `@/lib/contracts` (root-owned); app-only transport types
  belong in `_lib/types.ts`. Never redefine a root contract here.
