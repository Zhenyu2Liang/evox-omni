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
  - URL builders: `chatUrl({stream?,sessionId?})`, `actionUrl(id,'confirm'|'verify'|'cancel',sessionId?)`,
    `taskUrl(id,sessionId?)`, `tasksUrl(sessionId?)` (base `http://localhost`).
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
  routes; MFA-code secrecy; circuit breaker (3 wrong verifies).
- `tasks-http.test.ts` — REAL DAG/task-lifecycle e2e (demo Case 11 at the app-entry layer). Imports
  `{ GET, POST }` from `@/app/api/tasks/[id]/route`, `{ GET }` from `@/app/api/tasks/route`, `{ POST }`
  from `.../actions/[id]/{confirm,verify}/route` and `chat/route`, and drives them via `harness.ts`:
  `POST /api/tasks/[id]` pause/cancel/retry, `POST /api/actions/[id]/{confirm,verify}` resuming a
  parked plan (REAL tool result written back), `GET /api/tasks/[id]` refresh recovery,
  `GET /api/tasks` newest-first listing, plus 400/403/404 auth.

## Constraints / Conventions

- **One fresh `sessionId` per turn** (`newId('sess')`) — the in-process circuit breaker is keyed by
  `sessionId`. Note the route mints the PERSISTED session id itself (`getOrCreateSession`), so the id
  asserted on is the one returned in the response body / cookie.
- DB lifecycle like the other DB suites: `beforeEach(resetDatabase, 30000)` +
  `afterAll(disconnectTestPrisma)`; helpers come from `@/tests/helpers/db` and `@/tests/helpers/fixtures`.
- Deterministic & offline; **no fake timers**. Reset+seed per test.
- Import frozen types from `@/lib/contracts/*`; never redeclare them. `Envelope<T>` is the app-layer
  transport shape (declared structurally, not a contract).
- Reuse `@/lib/constants` (`MFA_CODE`, `SESSION_COOKIE`).
- Domain outcomes are NOT HTTP errors: a wrong MFA code, a cancel, a repeat confirm or a failed tool
  all return **HTTP 200** with `{ ok:false, data:{ ok:false, status, … } }`. Only ownership
  (`SECURITY_DENIED`→403), unknown id (`NOT_FOUND`→404) and transport/infra failures use the error
  envelope (status map in `app/api/_lib/http.ts`).
- Seeding a durable plan for the task specs goes through the PRODUCTION APIs (`getOrCreateSession` +
  `runSubmitPlan`) so real `AgentTask`/`AgentTaskNode`/`PendingAction` rows exist. **A seeded task MUST
  be paired with a matching `AgentSession` row** — `agent/task-control.ts` `loadOwnedTask` verifies both
  `row.sessionId === sessionId` and a session whose `userId` matches, else it rejects with
  `SECURITY_DENIED`. `TaskPlanStatus` has no `'paused'`: a paused plan surfaces as resumable `pending`.

## Faux-provider gotcha (important for SSE assertions)

`registerFauxProvider()` splits assistant text into **random-sized** `text_delta` chunks
(`splitStringByTokenSize` uses `Math.random()` in `@mariozechner/pi-ai/dist/providers/faux.js`), so the
**number** of `text_delta` frames varies run-to-run. When mirroring SSE frames against JSON-path events,
do NOT compare raw `text_delta` counts: project the structural events (excluding `text_delta`) and
compare the concatenated streamed text separately (`project()` + `streamedText()` in `chat-http.test.ts`).

## Known gap — SSE `error`-then-`done` is UNREACHABLE over real HTTP + mock

`app/api/chat/route.ts` documents a mid-stream `{type:'error'}` frame followed by `done`, but on the real
mock path neither producer fires:
- the mock responder never yields a model stop reason of `error`/`aborted`, so `runTurn`'s `agent_end`
  failure mapping never emits an `error` event;
- a throw from `runTurn` is caught by the route's OUTER try → a JSON error envelope (covered by the
  transport-failure test), never an SSE frame;
- `sseFrame` only serializes JSON-safe event objects, so the stream `start` catch cannot trigger.

The reachable invariant (well-formed, single-`done`-terminated frames, no `error` frame) is asserted in
the clearly-named `REACHABLE — …` test. The `error`-event path is only reachable via a mocked agent
(`tests/unit/agent/run-turn-failure.test.ts`).

## Known gap — plan PARKING EVENTS are UNREACHABLE over real HTTP + mock (honest split)

`agent/providers/mock-responder.ts#handlePlan` emits ONLY GREEN plan nodes (`analyze_spending` OR
`get_balance` + `note`), so a `submit_plan` issued through `POST /api/chat` NEVER parks. Therefore the
mid-turn plan-level `plan_update` + `confirmation_required`/`mfa_required` frames (and their cards)
cannot be produced by the real HTTP + mock chat path. They remain covered at the **`@/agent`-level faux
harness** (`tests/scenarios/test-11-conditional-dag.test.ts`) — deliberately NOT re-done here.

What the real HTTP path DOES cover (in `tasks-http.test.ts`): a plan WITH a parked GATED node is seeded
via the production planner, then the real action/task handlers drive it — confirm/verify RESUMES the
parked plan and writes the REAL tool result back (asserted on `AgentTaskNode`, a real `Transaction` row
and the decremented balance), pause/cancel/retry, refresh recovery, listing and 400/403/404.

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
- `./actions-http.test.ts` → `POST /api/actions/[id]/{confirm,verify,cancel}` real-handler e2e (two-phase confirmation: YELLOW confirm, RED MFA verify, wrong code, honest failure, cancel, ownership 403 / 404, MFA secrecy, circuit breaker)
- `./tasks-http.test.ts` → real task/action handlers e2e (`/api/tasks`, `/api/tasks/[id]`, `/api/actions/[id]/{confirm,verify}`)

## Notes for Agents

- GREEN auto-executed reads write NO `AuditLog` row (audit rows are gated-only); assert GREEN at the
  tool-event / DB-state level.
- The remaining HTTP coverage gaps are the `/api/chat` SSE `error`-frame and the plan parking EVENT
  emission — both unreachable over the real HTTP + mock path (see the two "Known gap" sections above).
