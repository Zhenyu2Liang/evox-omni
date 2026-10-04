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
  - SSE: `readSseFrames(res)` → raw `data:` payloads; `readSse(res)` → parsed `AgentStreamEvent[]`.
  - Types `RouteHandler`, `HttpOptions`, `HttpResult<T>`; frozen types imported from `@/lib/contracts/*`.
- `chat-http.test.ts` — `POST /api/chat` end-to-end (imports `{ POST as chatPost }`). Tests 1–8 +
  the mid-turn-failure reality check.
- `actions-http.test.ts` — `POST /api/actions/[id]/{confirm,verify,cancel}` end-to-end (imports the three route `POST`s) — the human-decision half of Case 12: GREEN inline read (no park); YELLOW confirm (executes the ORIGINAL args exactly once, audit `success`, repeat confirm is an idempotency no-op); RED verify with `MFA_CODE`; wrong code (200 `ok:false`/`awaiting_mfa`/`mfaResult:'failed'`, no money); honest `INSUFFICIENT_FUNDS` failure (200 `ok:false`/`failed`); cancel (no move, `ok:true`/`cancelled`); ownership 403 `SECURITY_DENIED` / unknown-id 404 `NOT_FOUND` on all three routes; MFA-code secrecy; circuit breaker (3 wrong verifies).

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

## Test Strategy

- `npx vitest run tests/app` — real route handlers + a fresh seeded DB per test.
- Assertions land on: the HTTP status + `{ok,data}/{ok,error}` envelope, the ordered `AgentStreamEvent`
  list (tool_start/tool_end status, cards, gate events), the `Set-Cookie: banking_session=` header, and
  DB rows (`account.balance` untouched, `pendingAction` tier/requiresMfa/status, `securityEvent`).
- `pendingAction.status`: YELLOW → `pending`, RED (MFA) → `awaiting_mfa` (see
  `security/security-gateway.ts` `gatewayCreatePendingAction`).

## Routing Table

- `./harness.ts` → shared HTTP plumbing (URL builders, invokers, SSE readers) — reuse for every app-entry spec
- `./chat-http.test.ts` → `POST /api/chat` real-handler e2e (GREEN/YELLOW/RED, injection, transport, SSE)
- `./actions-http.test.ts` → `POST /api/actions/[id]/{confirm,verify,cancel}` real-handler e2e (two-phase confirmation: YELLOW confirm, RED MFA verify, wrong code, honest failure, cancel, ownership 403 / 404, MFA secrecy, circuit breaker)

## Notes for Agents

- Add the action/task specs (`/api/actions/[id]/{confirm,verify,cancel}`, `/api/tasks`) on TOP of
  `harness.ts` — pass the specific handler into the invokers; do not duplicate request/SSE plumbing.
- GREEN auto-executed reads write NO `AuditLog` row (audit rows are gated-only); assert GREEN at the
  tool-event / DB-state level.
