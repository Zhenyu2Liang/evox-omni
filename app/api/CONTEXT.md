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
| POST | `/api/actions/[id]/confirm` | body `{}` | `ActionResponse` | `@/agent` `confirm` |
| POST | `/api/actions/[id]/verify` | body `{ code: string }` | `ActionResponse` (wrong code ⇒ 200 with `data.ok=false`, `status:'awaiting_mfa'`) | `@/agent` `verify` |
| POST | `/api/actions/[id]/cancel` | body `{}` | `ActionResponse` (`status:'cancelled'`) | `@/agent` `cancel` |
| GET | `/api/tasks` | query `{ sessionId?, limit? }` | `{ plans: TaskPlan[] }` | `@/planner` plan-store |
| GET | `/api/tasks/[id]` | — | `TaskPlan` | `@/planner` plan-store |
| POST | `/api/tasks/[id]` | body `{ action:'pause'\|'resume'\|'cancel'\|'retry' }` | `TaskPlan` | `@/planner` controls |
| GET | `/api/audit` | query `{ sessionId?, toolName?, riskLevel?, status?, limit? }` | `{ entries: AuditEntry[]; summary: AuditSummary }` | `@/audit` `listAudit` + `getAuditSummary` |
| GET | `/api/security` | query `{ sessionId? }` | `{ status: SecurityStatus; events: SecurityEvent[] }` | `@/audit` `getSecurityStatus`/`listSecurityEvents` + `@/security` `circuitBreaker.isLocked` |
| GET | `/api/dashboard` | query `{ userId? }` | `DashboardSummary` | `@/banking-sdk` `banking.dashboard.getDashboardSummary` |
| GET | `/api/bills` | query `{ month? }` (`YYYY-MM`) | `{ analysis: SpendingAnalysis; transactions: TransactionView[]; anomalies: AnomalyItem[] }` | `@/banking-sdk` `banking.transaction.*` |
| GET | `/api/cards` | query `{ userId? }` | `{ cards: CardView[] }` | `@/banking-sdk` `banking.card.getCards` |
| GET | `/api/subscriptions` | query `{ userId? }` | `{ subscriptions: SubscriptionView[] }` | `@/banking-sdk` `banking.subscription.listSubscriptions` |

Read routes are **GREEN reads only**. Card/subscription/transfer **mutations are NOT exposed as
endpoints** — they are gated tools the agent invokes through the Security Gateway; the only
human-triggered execution path is the `actions/*` group.

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
  where `data = { sessionId, events: AgentStreamEvent[] }`.
- Either mode drives the same agent entry point `@/agent` `runTurn(input, onEvent?)`: when `onEvent`
  is supplied each event is pushed as it occurs; the returned `ChatTurnResponse.events` is used
  verbatim for the non-streaming response.
- On the first turn the route sets `Set-Cookie: banking_session=<sessionId>` (`SESSION_COOKIE`).

## Session & user resolution (`_lib/session.ts`)

- `resolveUserId(req?)` → `?userId=` query → `getConfig().demoUserId` → `DEFAULT_DEMO_USER_ID`.
- `resolveSessionId(req?)` → `?sessionId=` query → `banking_session` cookie (`SESSION_COOKIE`),
  else `undefined` (the agent creates a session on the first chat turn).

## Shared helpers (`_lib/` — private folder, never a route)

- `_lib/types.ts` — app-layer transport types: `ApiEnvelope<T>`/`ApiSuccess`/`ApiFailure`,
  `ActionResponse`, `IdRouteContext`.
- `_lib/http.ts` — `ok`/`fail`/`mapAppError`/`jsonResponse`/`errorResponse`/`parseBody`/`parseQuery`
  plus SSE helpers `SSE_HEADERS`/`sseFrame`/`sseResponse`.
- `_lib/schemas.ts` — shared zod query fragments (`userIdQuerySchema`, `sessionIdQuerySchema`,
  `limitQuerySchema`).
- `_lib/session.ts` — `resolveUserId` / `resolveSessionId`.

## Agent runtime surface this node depends on (`@/agent`, owner)

```ts
type EventSink = (event: AgentStreamEvent) => void;
runTurn(input: { sessionId?: string; message: string; userId: string }, onEvent?: EventSink): Promise<ChatTurnResponse>;
resumeTurn(sessionId: string, onEvent?: EventSink): Promise<ChatTurnResponse>;
confirm(actionId: string, onEvent?: EventSink): Promise<ActionResponse>;
verify(actionId: string, code: string, onEvent?: EventSink): Promise<ActionResponse>;
cancel(actionId: string, onEvent?: EventSink): Promise<ActionResponse>;
```

## Dependencies

- `@/agent` (read-only): chat runtime (`runTurn`/`resumeTurn`/`confirm`/`verify`/`cancel`).
- `@/planner` (read-only): task-plan read + `PlanControls` for `/api/tasks*`.
- `@/banking-sdk` (read-only): read models (`banking.dashboard/transaction/card/subscription/…`, DTOs).
- `@/audit` (read-only): `listAudit`, `getAuditSummary`, `listSecurityEvents`, `getSecurityStatus`.
- `@/security` (read-only): `circuitBreaker.isLocked` for `/api/security`.
- `@/lib` (read-only): contracts, `AppError`/`ErrorCode`/`Result`, `getConfig`, constants, money.
- `../tests/app` (sibling — read-only, escalate writes to root): route-handler contract tests.

## Constraints

- **No business logic here.** No permission/risk decisions, no money math, no Prisma writes.
- Route handlers thin and ≲ ~150 lines; push shared plumbing into `_lib/http.ts`.
- **Validate every body/query with zod** before delegating; reject with `AppError('VALIDATION')`.
- **Never import Prisma directly** — go through `@/banking-sdk`, `@/audit`, `@/security`, `@/planner`.
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
- **Dependencies mocked at the module boundary** (`vi.mock('@/agent')`, `vi.mock('@/banking-sdk')`,
  `vi.mock('@/audit')`, `vi.mock('@/planner')`) — no live Prisma, no network.
- **Transport tests** for `POST /api/chat`: SSE frames + `done` terminator, and the `?stream=0`
  JSON fallback. End-to-end acceptance (the 12 demo scenarios) is driven through `@/agent` + `../tests`.
- `_lib/http.ts` (envelope/error-map/SSE encoders) is pure and unit-tested in place.

## Routing Table

- `./health/route.ts` → `GET /api/health` liveness + `llmMode` probe
- `./chat/route.ts` → `POST /api/chat` — one agent turn (SSE stream or JSON), first-turn session cookie
- `./actions/[id]/confirm/route.ts` → `POST /api/actions/[id]/confirm` — execute a confirmed pending action
- `./actions/[id]/verify/route.ts` → `POST /api/actions/[id]/verify` — MFA code submission for a RED action
- `./actions/[id]/cancel/route.ts` → `POST /api/actions/[id]/cancel` — cancel a pending action
- `./tasks/route.ts` → `GET /api/tasks` — list task plans for a session
- `./tasks/[id]/route.ts` → `GET`/`POST /api/tasks/[id]` — read one plan / steer it (pause|resume|cancel|retry)
- `./audit/route.ts` → `GET /api/audit` — audit entries + summary
- `./security/route.ts` → `GET /api/security` — security-center status + events
- `./dashboard/route.ts` → `GET /api/dashboard` — dashboard read model
- `./bills/route.ts` → `GET /api/bills` — spending analysis + transactions + anomalies
- `./cards/route.ts` → `GET /api/cards` — cards read model
- `./subscriptions/route.ts` → `GET /api/subscriptions` — subscriptions read model
- `./_lib/` → shared handler plumbing (envelope, error mapping, zod parse, SSE, session) — private `_`-folder, never a route
- `../tests/app/` → route-handler contract tests (sibling — read-only, escalate writes to parent)

## Notes for Agents

- **These are design stubs.** Every `route.ts` exports its handler signatures + zod schemas +
  JSDoc and throws `AppError('INTERNAL','not implemented')`; the `_lib/*` helpers (envelope,
  error map, zod parse, SSE, session) ARE implemented (pure transport, no business logic). Real
  handler bodies are a later implementation pass.
- Add a new client-callable capability as a route group here; a group with a dynamic id uses a
  `[id]/route.ts` leaf. Folders prefixed `_` (like `_lib`) are private and never routed.
- Any new shared domain type belongs in `@/lib/contracts` (root-owned); app-only transport types
  belong in `_lib/types.ts`. Never redefine a root contract here.
