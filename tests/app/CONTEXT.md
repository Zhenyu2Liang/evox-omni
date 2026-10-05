# tests/app — REAL-application-entry (HTTP) end-to-end specs

## Intent

Drive the **real Next.js App Router route handlers** — importing their exported `POST`/`GET`
functions and calling them with real `NextRequest` objects — and assert the behaviour through the
HTTP envelope/SSE frames, the `Set-Cookie` header and the DB side effects.

This is deliberately NOT `tests/helpers/scenario.ts` (which re-instantiates the turn logic) and NOT
any mock pipeline: the whole production stack runs (`route → @/agent runTurn → banking tools →
security gateway beforeToolCall → Banking SDK → SQLite`). Only the MODEL is scripted: `tests/setup.ts`
forces `LLM_MODE=mock`, so the deterministic mock responder (`agent/providers/mock-responder.ts`)
answers. Offline, no API key, no network.

These specs are the **acceptance bar at the HTTP layer** — the missing "real app-entry E2E" coverage,
complementing the in-process `tests/scenarios/*` suites.

## API Surface

- `harness.ts` — **shared, test-only HTTP plumbing** (URL builders, request invokers, SSE readers).
  Contains NO business logic and does NOT re-implement the envelope (framing lives in
  `app/api/_lib/http.ts`). It NEVER imports route modules — each spec imports the handler(s) it drives
  and passes them in, so it stays importable by every app-entry spec.
  - **Identity is COOKIE-ONLY.** `HttpOptions` carries identity as a `Cookie` header, never a query
    param: `sessionId` (shorthand → `Cookie: banking_session=<id>`, built by the exported
    `sessionCookie()`) or a raw `cookie` (wins over `sessionId`). Omitting both sends NO cookie.
  - URL builders carry no identity: `chatUrl({stream?})`, `actionUrl(id,'confirm'|'verify'|'cancel')`,
    `taskUrl(id)`, `tasksUrl()` (base `http://localhost`).
  - Invokers (build a real `NextRequest`, call the handler, return `{status,ok,data,headers,res}`):
    `postJson(handler,path,body,opts?)`, `postRaw(handler,path,rawString,opts?)`,
    `getJson(handler,path,opts?)`. JSON bodies are parsed eagerly; a non-JSON / SSE body is left
    UNCONSUMED so the SSE readers can read it.
  - `idCtx(id)` → `IdRouteContext` (`{ params: Promise.resolve({ id }) }`) for `/…/[id]` handlers.
    NOTE: the invokers default `ctx` to `idCtx('')`, so an `/…/[id]` spec MUST pass `{ ctx: idCtx(id) }`.
  - SSE: `readSseFrames(res)` → raw `data:` payloads; `readSse(res)` → parsed `AgentStreamEvent[]`.
  - Types `RouteHandler`, `HttpOptions`, `HttpResult<T>`; frozen types imported from `@/lib/contracts/*`.
- `chat-http.test.ts` — `POST /api/chat` end-to-end (imports `{ POST as chatPost }`). Tests 1–8 +
  the mid-turn-failure reality check.
- `actions-http.test.ts` — `POST /api/actions/[id]/{confirm,verify,cancel}` end-to-end (imports the
  three route `POST`s) — the human-decision half of Case 12: GREEN inline read (no park); YELLOW
  confirm (executes the ORIGINAL args exactly once, audit `success`, repeat confirm is an idempotency
  no-op); RED verify with `MFA_CODE`; wrong code (200 `ok:false`/`awaiting_mfa`/`mfaResult:'failed'`,
  no money); honest `INSUFFICIENT_FUNDS` failure (200 `ok:false`/`failed`); cancel (no move,
  `ok:true`/`cancelled`); ownership 403 `SECURITY_DENIED` / unknown-id 404 `NOT_FOUND` on all three
  routes; missing/unknown-cookie 403 (identity is cookie-only); MFA-code secrecy; circuit breaker (3
  wrong verifies).
- `tasks-http.test.ts` — REAL DAG/task-lifecycle e2e (demo Case 11 at the app-entry layer). Imports
  `{ GET, POST }` from `@/app/api/tasks/[id]/route`, `{ GET }` from `@/app/api/tasks/route`, `{ POST }`
  from `.../actions/[id]/{confirm,verify}/route` and `chat/route`, and drives them via `harness.ts`:
  `POST /api/tasks/[id]` pause/cancel/retry, `POST /api/actions/[id]/{confirm,verify}` resuming a
  parked plan (REAL tool result written back), `GET /api/tasks/[id]` refresh recovery,
  `GET /api/tasks` newest-first listing, plus cookie-identity auth (missing cookie → 403, unknown id →
  404, foreign-owner → 403).
- `plan-parking-http.test.ts` — DAG plan PARKING during a REAL chat turn + post-confirm RESUME
  ("DAG 确认后继续"). The conditional limit-adjustment trigger
  (`如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元`) makes the mock responder emit a 3-node
  DAG (`analyze_spending` → condition `analyze.total > 2000` → YELLOW `set_card_limit`); 本月消费
  (~¥5,800) satisfies the condition so the gated node PARKS. Asserts the streamed `plan_update` walk
  settles at `waiting_confirmation` (node statuses analyze:success / check:success /
  setlimit:waiting_confirmation), the `confirmation_required` frame (tier `YELLOW`,
  toolName `set_card_limit`) plus `plan`+`confirmation` cards, the persisted plan / `AgentTaskNode`
  rows / `pendingAction` (YELLOW, `pending`), and that NOTHING moved (seeded `card_credit` 娱乐 limit
  stays 3000). Then `POST /api/actions/[id]/confirm` resumes the plan (`plan_update` status `success`,
  setlimit `success`), the real tool runs (limit 3000 → 1500) and the envelope is
  `status:'executed'`/`tier:'YELLOW'`.

## Constraints / Conventions

- **One fresh `sessionId` per turn** (`newId('sess')`) — the in-process circuit breaker is keyed by
  `sessionId`. The route mints the PERSISTED session id itself (`getOrCreateSession`), so the id
  asserted on is the one returned in the response body / cookie; specs send it back as the
  `banking_session` COOKIE on later confirm/verify/cancel/tasks calls.
- DB lifecycle like the other DB suites: `beforeEach(resetDatabase, 30000)` + `afterAll(disconnectTestPrisma)`; helpers come from `@/tests/helpers/db` and `@/tests/helpers/fixtures`.
- Deterministic & offline; **no fake timers**. Reset+seed per test.
- Import frozen types from `@/lib/contracts/*`; never redeclare them. `Envelope<T>` is the app-layer
  transport shape (declared structurally, not a contract).
- Reuse `@/lib/constants` (`MFA_CODE`, `SESSION_COOKIE`).
- **Identity is COOKIE-ONLY** (`app/api/_lib/session#resolveIdentity`): write/auth routes
  (`POST /api/actions/[id]/{confirm,verify,cancel}`, `POST /api/tasks`, `POST /api/tasks/[id]`) require
  the `banking_session` cookie; a `?sessionId=`/`?userId=` query param is IGNORED. Missing/unknown
  cookie → **403 `SECURITY_DENIED`**; an id that does NOT exist → **404 `NOT_FOUND`**; an id owned by
  ANOTHER session/user → **403 `SECURITY_DENIED`**. `GET /api/tasks/[id]` enforces ownership the same
  way; `GET /api/tasks` with no cookie returns `{ plans: [] }` (200).
- Domain outcomes are NOT HTTP errors: a wrong MFA code, a cancel, a repeat confirm or a failed tool
  all return **HTTP 200** with `{ ok:false, data:{ ok:false, status, … } }`. Only identity/ownership
  (`SECURITY_DENIED`→403), unknown id (`NOT_FOUND`→404) and transport/infra failures use the error
  envelope (status map in `app/api/_lib/http.ts`). A missing cookie on `POST /api/tasks/[id]` is
  rejected by `requireIdentity` BEFORE the body is parsed — a 403, never 400 `VALIDATION`.
- Seeding a durable plan for the task specs goes through the PRODUCTION APIs (`getOrCreateSession` +
  `runSubmitPlan`) so real `AgentTask`/`AgentTaskNode`/`PendingAction` rows exist. **A seeded task MUST
  be paired with a matching `AgentSession` row** — `agent/task-control.ts` `loadOwnedTask` verifies both
  `row.sessionId === sessionId` and a session whose `userId` matches, else it rejects with
  `SECURITY_DENIED`. `TaskPlanStatus` includes `'paused'`: `pauseTask` persists `'paused'` on the plan
  snapshot AND the `AgentTask` row.

## Faux-provider gotcha (important for SSE assertions)

`registerFauxProvider()` splits assistant text into **random-sized** `text_delta` chunks
(`splitStringByTokenSize` uses `Math.random()` in `@mariozechner/pi-ai/dist/providers/faux.js`), so the
**number** of `text_delta` frames varies run-to-run. When mirroring SSE frames against JSON-path events,
do NOT compare raw `text_delta` counts: project the structural events (excluding `text_delta`) and
compare the concatenated streamed text separately (`project()` + `streamedText()` in `chat-http.test.ts`).

## Known gap — SSE `error`-then-`done` is UNREACHABLE over real HTTP + mock

`app/api/chat/route.ts` documents a mid-stream `{type:'error'}` frame followed by `done`, but on the real
mock path neither producer fires:
- the mock responder never yields a model stop reason of `error`/`aborted`, so `runTurn`'s
  `agent_end` failure mapping never emits an `error` event;
- a throw from `runTurn` is caught by the route's OUTER try → a JSON error envelope (covered by the
  transport-failure test), never an SSE frame;
- `sseFrame` only serializes JSON-safe event objects, so the stream `start` catch cannot trigger.

The reachable invariant (well-formed, single-`done`-terminated frames, no `error` frame) is asserted in
the clearly-named `REACHABLE — …` test. The `error`-event path is only reachable via a mocked agent
(`tests/unit/agent/run-turn-failure.test.ts`).

## Plan PARKING over real HTTP + mock IS reachable (conditional-DAG trigger)

`agent/providers/mock-responder.ts#handlePlan` emits a GATED DAG for the conditional limit-adjustment
trigger: `analyze_spending` (GREEN) → condition (`analyze.total > <threshold>`) → YELLOW
`set_card_limit`. Because 本月消费 (~¥5,800) satisfies the condition, the gated node is reached and
PARKS, so the mid-turn plan-level `plan_update` + `confirmation_required` frames (and the `plan` /
`confirmation` cards) ARE produced by the real HTTP + mock chat path — covered by
`plan-parking-http.test.ts`. Confirming the chat-produced `PendingAction` RESUMES the parked plan to
`success` and writes the real tool result.

`tasks-http.test.ts` additionally covers a plan WITH a parked GATED node SEEDED via the production
planner, then driven by the real action/task handlers — confirm/verify RESUMES the parked plan and
writes the REAL tool result back (asserted on `AgentTaskNode`, a real `Transaction` row and the
decremented balance), pause/cancel/retry, refresh recovery, listing and 403/404 auth.

## Known gap — `423 CIRCUIT_OPEN` is UNREACHABLE over real HTTP

The confirm/verify route doc comments mention a `423 CIRCUIT_OPEN` error envelope and
`app/api/_lib/http.ts` maps the code (`CIRCUIT_OPEN: 423`), but **nothing ever throws
`AppError('CIRCUIT_OPEN')`** — a repo-wide scan finds the code only in that doc comment, the status map
and the `ErrorCode` union (`lib/errors.ts`). On a tripped breaker
`security-gateway.authorizeAction` returns the lock as a **domain** outcome
(`{ ok:false, status:'locked' }`), which `@/agent` `confirmAction`/`verifyAction` surface as a normal
**HTTP 200** with `data.ok:false` / `data.status:'locked'`. `actions-http.test.ts` therefore asserts the
reachable invariants (200 / `ok:false` / `'locked'`, a `CIRCUIT_BREAKER_TRIPPED` high-severity
`SecurityEvent`, and denied follow-up action calls) instead of a fabricated 423.

## Test Strategy

- `npx vitest run tests/app` — real route handlers + a fresh seeded DB per test.
- Assertions land on: the HTTP status + `{ok,data}/{ok,error}` envelope, the ordered `AgentStreamEvent`
  list (tool_start/tool_end status, cards, gate events), the `Set-Cookie: banking_session=` header, and
  DB rows (`account.balance` untouched, `pendingAction` tier/requiresMfa/status, `securityEvent`).
- `pendingAction.status`: YELLOW → `pending`, RED (MFA) → `awaiting_mfa` (see
  `security/security-gateway.ts` `gatewayCreatePendingAction`).
- `AgentTaskNode` has no `output` column: a parked node records its `{ pendingActionId }` inside the
  node's `output` JSON (`agent.readPendingActionId(node.output)`).

## Routing Table

- `./harness.ts` → shared HTTP plumbing (URL builders, invokers, SSE readers) — reuse for every app-entry spec
- `./chat-http.test.ts` → `POST /api/chat` real-handler e2e (GREEN/YELLOW/RED, injection, transport, SSE)
- `./actions-http.test.ts` → `POST /api/actions/[id]/{confirm,verify,cancel}` real-handler e2e (two-phase confirmation: YELLOW confirm, RED MFA verify, wrong code, honest failure, cancel, foreign-owner/missing-cookie 403, unknown-id 404, MFA secrecy, circuit breaker)
- `./tasks-http.test.ts` → real task/action handlers e2e (`/api/tasks`, `/api/tasks/[id]`, `/api/actions/[id]/{confirm,verify}`)
- `./plan-parking-http.test.ts` → `POST /api/chat` conditional-DAG PARKING + `POST /api/actions/[id]/confirm` RESUME ("DAG 确认后继续")

## Notes for Agents

- GREEN auto-executed reads write NO `AuditLog` row (audit rows are gated-only); assert GREEN at the
  tool-event / DB-state level.
- The remaining HTTP coverage gap is the `/api/chat` SSE `error`-frame, which is unreachable over the
  real HTTP + mock path (see the "Known gap" section above).
- The mock responder (`agent/providers/mock-responder.ts`) routes DIRECT single-action intents: e.g.
  "把信用卡娱乐限额调整到1500" → `set_card_limit`, "申购稳健理财A 1000元" → `subscribe_investment`,
  "取消Netflix订阅" → `cancel_subscription`.
