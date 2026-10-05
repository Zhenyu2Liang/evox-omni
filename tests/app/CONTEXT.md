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

- `identity-http.test.ts` — cookie-only IDENTITY across ALL write/auth routes (`POST /api/actions/[id]/{confirm,verify,cancel}`,
  `POST /api/tasks`, `POST /api/tasks/[id]`, `POST /api/security/reset`): missing cookie → 403 `SECURITY_DENIED`;
  unknown session cookie → 403; a valid cookie for a session that does NOT own the target id → 403; a
  truly-unknown action/task id (valid cookie) → 404 `NOT_FOUND`; forged `?userId=`/`?sessionId=` query params
  CANNOT override cookie identity (still denied when the cookie is missing/foreign).
- `mfa-escalation-http.test.ts` — YELLOW→RED ESCALATION at execution time: a parked YELLOW transfer whose FRESH
  same-day total tips over ¥1000 is confirmed → the confirm response surfaces `requiresMfa:true`/`tier:'RED'` with
  an `{type:'mfa_required'}` event and NO money moves; then `verify` with `MFA_CODE` executes (audit row
  `mfaResult:'success'`, `mfaRequired:true`, `riskLevel:'RED'`); a wrong code moves NO money.
- `dag-recovery-http.test.ts` — REAL DAG control/recovery e2e driven by `POST /api/tasks/[id]`
  (pause/resume/cancel/retry), `GET /api/tasks/[id]` + `GET /api/actions` (refresh restore) and
  `POST /api/actions/[id]/confirm`. Proves the real invariants with a COUNTABLE node side effect (a GREEN
  `reserve_budget` node = exactly ONE `Budget` row): pause stops before the not-yet-run node; resume skips
  already-`success` nodes; cancel is terminal (executed node's row preserved, parked node `cancelled`, parked
  action revoked); retry re-runs ONLY the `failed` node on a FRESH gate action.
- `malicious-input-http.test.ts` — MALICIOUS input over HTTP: a prompt-injection message cannot bypass
  confirm/MFA (the money move stays gated); after a confirm, altering the amount/recipient in a FOLLOW-UP
  request cannot change the executed args (the ORIGINAL validated args run); forged identity query params rejected.
- `nl-entry-http.test.ts` — NATURAL-LANGUAGE ENTRY via `POST /api/chat` (mock responder) then completed through
  the REAL action routes: `把信用卡娱乐限额调整到1500` → gated `set_card_limit` (YELLOW) → confirm (limit
  3000→1500); `申购稳健理财A 1000元` → gated `subscribe_investment` (RED) → verify (holdings 1→2);
  `取消Netflix订阅` → gated `cancel_subscription` (YELLOW) → confirm (ACTIVE→CANCELLED); a transfer with missing
  info (no recipient/amount) → clarification (NO tool call, no read fallback).
- `review-regressions-http.test.ts` — HTTP e2e regressions a reviewer flagged in already-shipped
  areas: two YELLOW parks in ONE session escalate the SECOND confirm to RED/MFA at execution time;
  cancelling a plan revokes its parked action (plus cancel/confirm race orderings); a MID-RUN pause
  issued through `POST /api/tasks/[id]` halts the next node while resume re-runs only that node; and
  identity stays COOKIE-ONLY — a forged `?sessionId=`/`?userId=` query NEVER authenticates on
  `verify`/`cancel`/`tasks`/`reset`.
- `session-takeover-http.test.ts` — cookie-only takeover/isolation: a body `sessionId` that disagrees
  with the cookie (incl. no cookie) → `409` with NO `Set-Cookie`; cross-session action/plan isolation
  (403, victim action stays pending); missing-cookie fail-closed 403 across confirm/verify/cancel/tasks/
  security-reset; forged `?sessionId=`/`?userId=` never authenticates.
- `cancel-during-authorization-http.test.ts` — a cancel landing WHILE a park is in flight (controlled
  barrier held open inside the `runTool` seam): after cancel NO newly-executable `PendingAction`
  survives and `computeDailyTransferTotal` stays 0; cancel/confirm race both orderings.
- `task-resume-retry-http.test.ts` — CONCURRENT real `resume`/`retry` via `POST /api/tasks/[id]` (a
  rendezvous barrier forces both requests to overlap): the unfinished node's side effect happens
  EXACTLY ONCE (one `Budget` row / one fresh gate) and the persisted `AgentTask` status stays consistent.
- `plan-pause-terminal-http.test.ts` — confirming a parked node in a PAUSED plan must NOT advance it
  (only an explicit `resume` runs the rest); TERMINAL-state protection (a `cancelled` plan stays
  `cancelled` for resume/retry/pause in route AND DB; a completed plan never re-runs a node).
- `cumulative-risk-http.test.ts` — cumulative ¥1000/day rule through the REAL confirm/verify routes: an
  in-flight (ledgered-but-not-terminal) transfer is counted ONCE; concurrent ¥600+¥600 escalates the
  SECOND to RED/MFA; boundaries ¥1000 → YELLOW, ¥1000.01 → RED.
- `ledger-consistency-http.test.ts` — confirmed transfers: balance decrement === ledger delta and the
  matching transfer `Transaction` rows agree; refused/failed actions move NO money; N transfers accumulate.
- `mfa-escalation-upgrade-http.test.ts` — YELLOW→RED upgrade at execution time: the confirm response
  surfaces `requiresMfa:true`/tier `RED`/`awaiting_mfa` AND an `mfa_required` event; verify with
  `MFA_CODE` executes; the `AuditLog` row is consistent with the effective tier.

## Constraints / Conventions

- **Cookie-only session bootstrap.** `POST /api/chat` takes identity SOLELY from the `banking_session`
  cookie: a body `sessionId` that DISAGREES with the cookie — INCLUDING "no cookie present" — is
  rejected `409 CONFLICT` and sets NO cookie. The FIRST turn OMITS `sessionId` and sends NO cookie;
  the route MINTS the session and returns its id (`data.sessionId` in JSON mode, or the `Set-Cookie`
  header via `sessionIdFromResponse(res)` for SSE). That id is carried as the `banking_session` COOKIE
  (harness `sessionId` option) on later chat/confirm/verify/cancel/tasks calls. Use a fresh id per test
  (the in-process circuit breaker is keyed by `sessionId`).
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
  all return **HTTP 200** using the SAME envelope as success — outer `{ ok:true, data }` — carrying the
  domain outcome INSIDE `data` (`data.ok:false` / `data.status:'failed'|'cancelled'|…`); a failed domain
  outcome is NEVER an outer `ok:false`. Only identity/ownership
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

- `./identity-http.test.ts` → cookie-only identity across all write/auth routes (403 missing/unknown/foreign cookie, 404 unknown id, forged query params ignored)
- `./mfa-escalation-http.test.ts` → YELLOW→RED escalation at execution time (fresh daily total → confirm surfaces RED/requiresMfa, verify executes, wrong code moves nothing)
- `./dag-recovery-http.test.ts` → DAG control/recovery e2e (pause/resume/cancel/retry) + refresh restore (`GET /api/tasks/[id]`, `GET /api/actions`)
- `./malicious-input-http.test.ts` → prompt-injection over HTTP still gated + follow-up arg-override cannot change executed args
- `./nl-entry-http.test.ts` → natural-language entry via `POST /api/chat` → gated tool → confirm/verify completes
- `./review-regressions-http.test.ts` → reviewer regression e2e: two-park YELLOW→RED execution-time escalation in one session, plan-cancel revokes its parked action + cancel/confirm race orderings, a mid-run pause (via the real handler) halting the next node + resume re-running only that node, and forged-query-never-authenticates on verify/cancel/tasks/reset
- `./session-takeover-http.test.ts` → cookie-only takeover/isolation (body `sessionId` ≠ cookie → 409 no cookie; cross-session isolation 403; missing-cookie fail-closed; forged query never authenticates)
- `./cancel-during-authorization-http.test.ts` → cancel landing while a park is in flight (controlled barrier): no executable PendingAction survives, daily total stays 0, both race orderings
- `./task-resume-retry-http.test.ts` → concurrent real `resume`/`retry` over HTTP (rendezvous barrier): unfinished node runs EXACTLY ONCE, persisted status consistent
- `./plan-pause-terminal-http.test.ts` → confirming a parked node in a PAUSED plan does NOT advance it; terminal-state protection (cancelled stays cancelled; completed never re-runs)
- `./cumulative-risk-http.test.ts` → cumulative ¥1000/day rule over real confirm/verify (in-flight counted once; concurrent escalation; ¥1000/¥1000.01 boundaries)
- `./ledger-consistency-http.test.ts` → ledger/balance consistency (confirmed delta === ledger delta; refusals move no money; N transfers accumulate)
- `./mfa-escalation-upgrade-http.test.ts` → YELLOW→RED upgrade at execution time (confirm surfaces RED/awaiting_mfa + `mfa_required`; verify executes; audit consistent)

## Notes for Agents

- GREEN auto-executed reads write NO `AuditLog` row (audit rows are gated-only); assert GREEN at the
  tool-event / DB-state level.
- The remaining HTTP coverage gap is the `/api/chat` SSE `error`-frame, which is unreachable over the
  real HTTP + mock path (see the "Known gap" section above).
- The mock responder (`agent/providers/mock-responder.ts`) routes DIRECT single-action intents: e.g.
  "把信用卡娱乐限额调整到1500" → `set_card_limit`, "申购稳健理财A 1000元" → `subscribe_investment`,
  "取消Netflix订阅" → `cancel_subscription`.
