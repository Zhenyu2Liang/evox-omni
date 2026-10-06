# tests — Automated Test Suite (Vitest)

## Intent

The **acceptance bar** for the AI Banking Agent demo, expressed as executable tests.
It proves two things, deterministically and **offline** (no network, no API key):

1. the **security model** is code-enforced (tiers, confirmation, MFA, circuit breaker, injection
   defense) via pure **unit** tests, and
2. the **12 demo scenarios** work end-to-end through the full pipeline
   (Pi Agent → banking tools → Security Gateway `beforeToolCall` → Banking SDK → audit) via
   **scenario** tests driven by a *scripted* model (`registerFauxProvider()`, `LLM_MODE=mock`) and via
   **app-entry (HTTP)** tests that drive the REAL Next.js route handlers, and
3. the **user journeys** render correctly in a **real browser** (`e2e/`, headless system Chrome via
   `playwright-core` against the real `/agent` page) — the only layer that asserts on RENDERED DOM.

Only the model is mocked; the tools, the security chokepoint, the route handlers and the DB are the real ones.
This node owns test infrastructure and fixtures — NOT the business logic under test (that lives in
`security/`, `planner/`, `banking-sdk/`, `agent/`).

## API Surface

- `setup.ts` — Vitest **global setup** (`setupFiles`). Sets `DATABASE_URL` → the isolated test
  SQLite (`prisma/test.db`, git-ignored, absolute path), forces `LLM_MODE=mock`, and provisions the
  schema when the schema version changes (`prisma db push --force-reset --skip-generate`). The guard
  **marker** (`prisma/.test-db-provisioned`) stores the **sha1 of `prisma/schema.prisma`** (written
  atomically via temp-file + rename); provisioning is skipped ONLY when the marker's hash equals the
  current schema hash AND `test.db` exists — so a stale `test.db` (provisioned before a schema
  change), an absent DB, or an old-format ISO-date marker all trigger a re-provision. Re-provisioning
  removes the WAL-mode `test.db` (+ `-wal`/`-shm`/`-journal`) first, because `--force-reset` cannot
  re-reset an existing WAL file. After provisioning it
  pins the **runtime** `DATABASE_URL` to `?connection_limit=1` (single pooled connection — see
  "Fast test-DB path"). Exports `testDbUrl`/`testDbPath`.
- `helpers/` — shared test utilities (`db`, `fixtures`, `faux-agent`, `scenario`) + a barrel.
  See `helpers/CONTEXT.md` for the full helper API.
- `helpers/prisma-cli.ts` — Node-built-ins-only shared Prisma CLI/generate infrastructure used by BOTH
  `setup.ts` and `e2e/helpers.ts` (`resolveRepoRoot`, `resolvePrismaBin`, `resolveTsxBin`, `cliCommand`,
  `removeSqliteFiles`, `runCliStep` (fail-loud: throws with FULL captured stdout+stderr+exit code),
  `diagnosticCliOutput`, `prismaClientUsable`/`prismaClientGenerated`, `runPrismaGenerate`,
  `ensurePrismaClientGenerated`). NOT in the `helpers/index.ts` barrel — specs must not import it.
- `unit/` — pure/logic specs for `security`, `planner`, `banking-sdk`, plus `agent` + `lib` facade specs. See `unit/CONTEXT.md`.
- `scenarios/` — one spec per demo scenario, Tests 1–12, over the in-process pipeline. See `scenarios/CONTEXT.md`.
- `app/` — real app-entry (HTTP) specs driving the REAL Next.js route handlers
  (chat/SSE, action confirm|verify|cancel, task lifecycle, and `review-regressions-http.test.ts`
  reviewer regressions) plus the newer regression specs (`session-takeover-http`, `cancel-during-
  authorization-http`, `task-resume-retry-http`, `plan-pause-terminal-http`, `cumulative-risk-http`,
  `ledger-consistency-http`, `mfa-escalation-upgrade-http`, and the round-5a linkage/concurrency specs `plan-linkage-http`, `cancel-safety-http`, `concurrent-execution-http`). See `app/CONTEXT.md`.
- `review-boundaries.test.ts`, `review-concurrency.test.ts` & `review-new-boundaries.test.ts` — root-level `[integration]` reviewer-reference ports (real route handlers + gateway/executor + controllable barriers): plan/node linkage, cancel safety, exactly-once concurrent execution, de-dup scope, ledgered-but-not-terminal cumulative-risk exactness, no double-debit across the effect/persist window, and revoke-on-cancel-before-CAS. See the Routing Table entries below.

Run:

- `npm run test` → `vitest run` (all suites). `npm run test:watch` for watch mode.
- Target a layer: `npm run test -- tests/unit` · `npm run test -- tests/scenarios` · `npm run test -- tests/app`.
- Pure unit-only run without a DB: `VITEST_SKIP_DB_SETUP=1 npm run test -- tests/unit/planner tests/unit/lib/ledger-keys.test.ts tests/unit/agent/providers/provider-mock.test.ts`
  (`VITEST_SKIP_DB_SETUP=1` skips BOTH Prisma Client generation AND schema provisioning; note
  `tests/unit/security` and `tests/unit/planner/executor-claim-scope.test.ts` are DB-BACKED, so they
  fail without a DB — only the DB-free specs above run clean under the flag).

### Prerequisites

- `npm install`, then **`npx prisma generate`** before any spec imports `@prisma/client`
  (e.g. `lib/db/client`, `banking-sdk`) — `setup.ts` pushes the schema with `--skip-generate` on purpose.
- `vitest.config.ts` (root-owned) wires `setupFiles: ['tests/setup.ts']` + `env: { LLM_MODE: 'mock' }`
  and sets `fileParallelism: false` + `hookTimeout: 60000`, so files run sequentially against the ONE
  shared `prisma/test.db` — a plain `npm run test` is deterministic (no manual flag needed).

## Constraints

- **Offline & deterministic.** No suite may require the network or a real LLM. Models are scripted
  (`registerFauxProvider`); time and ids are injectable; the DB is the isolated test SQLite.
- **Unique `sessionId` per test.** The circuit breaker is in-process, keyed by `sessionId`; a lock
  from Test 10 must not leak into other specs. Use `scenario.newSessionId()` (or `newId('sess')`).
- **Test isolation.** DB-backed suites reset + seed via `helpers/db.resetDatabase()`; never share
  mutable DB state. Specs use explicit-timed hooks (`beforeEach(resetDatabase, 30000)`), not `useFreshDatabase()`. (Banking-sdk unit suites use `useFreshDatabase()`.)
- **Implemented.** Every spec has real assertions (no `it.todo`); DB-backed suites reset + seed
  per test. Specs stay **load-safe** (no top-level Prisma construction outside DB-backed cases).
- **DB-backed suites share one `prisma/test.db`** and run sequentially — enforced by
  `fileParallelism: false` in `vitest.config.ts` (`--no-file-parallelism` also works if needed).
- **Never re-implement the code under test.** Tests assert behaviour through the public
  facades (`@/security`, `@/planner`, `@/banking-sdk`, `@/agent`) or the REAL route handlers; they do not fork contracts or logic.
- Specs import frozen types from `@/lib/contracts/*`; they never redeclare them.
- Keep files ≲ ~1000 lines; one spec file per unit/scenario/app concern.

## Test Strategy

Three layers, mirroring the acceptance bar:

- **Unit (pure, no LLM):** `security/` (permission policy table, transfer thresholds, gateway
  decide/serialize/parseBlockReason + `buildPendingActionSummary`, injection patterns, circuit-breaker
  trip at 3 failures, MFA verify, gateway concurrency + execution-time re-risk), `planner/` (DAG
  validation/topological order/cycle detection, readiness gating on `success`/`skipped`, condition
  evaluation, gated node → `waiting_confirmation`, durable cancel-sweep), `banking-sdk/` (funds
  invariant, `minAmount`, ambiguous recipient → `CONFLICT` with candidates, subscription cancel,
  investment subscribe, ledger-write rollback atomicity).
- **Scenario (full pipeline, faux LLM):** Tests 1–12 drive a real turn + human decision and assert the
  agent text, tool events, cards, `PendingAction`/audit rows and DB side effects. All 12 are implemented
  (no `it.todo`) and green.
- **App-entry (real HTTP route handlers):** `app/` invokes the REAL exported `POST /api/chat`
  (JSON `?stream=0` + SSE default) and the action/task handlers, proving money moves only after a human
  confirm/verify, honest failure narratives, no secret leaks, ownership/not-found handling, the DAG
  task lifecycle (pause/cancel/retry + refresh recovery) and the circuit breaker at the HTTP boundary.
  `review-regressions-http.test.ts` additionally locks down reviewer-flagged regressions: two YELLOW
  parks in ONE session escalate the SECOND confirm to RED/MFA at execution time; a plan-cancel revokes
  its parked action (both cancel/confirm race orderings); a mid-run pause halts the next node while
  resume re-runs only it; and identity stays COOKIE-ONLY (a forged `?sessionId=`/`?userId=` query NEVER
  authenticates on verify/cancel/tasks/reset).

Fixtures: the canonical demo dataset (user 李明; contacts 张伟/王芳/妈妈/李华; the Apple Store ¥6,999
anomaly @ 2026-09-20 18:32; products incl. 稳健理财A; subscriptions; cards) is defined in
`helpers/fixtures.ts`. Cross-module knowledge belongs to the modules under test, not to fixtures.

## Real-Browser E2E (tests/e2e — NOT run by vitest)

A separate acceptance layer ABOVE the HTTP specs: `tests/e2e/acceptance.e2e.ts` boots the REAL app
(`next dev`) on a free port and drives the REAL `/agent` UI in headless system Chrome
(`playwright-core`, NO browser download), asserting on RENDERED DOM. Its file name avoids
`.test.`/`.spec.` so `npm run test` NEVER picks it up — run it explicitly.

```
npx tsx tests/e2e/acceptance.e2e.ts
```

Prerequisites (once, in a fresh worktree): `npm install` only — the harness generates the Prisma Client itself if missing (no manual `prisma generate` needed). It uses an ISOLATED E2E DB
(`prisma/e2e.db`, git-ignored, provisioned by the harness itself — no manual `db push`/`db:seed` needed), `.env` must set `LLM_MODE=mock`,
and it needs a system Chrome. It prints one `PASS|FAIL|SKIP <journey> — <evidence>` line per journey
and exits non-zero iff any journey FAILs (a SKIP does not fail the run).
**Covers:** NL → confirmation/MFA card → human-decision flows, MFA success + wrong-code rejection,
plan pause/resume + cancel, and refresh/action-entry recovery from persisted server state.
**Does NOT cover:** the real LLM, `next build`/`next start`, cross-browser, a11y/perf, or the
`unit`/`scenarios` layers. See `e2e/CONTEXT.md` for details and known limitations.

## Fast test-DB path (why the suite is fast — do not remove)

The full suite (538 tests / 70 files) runs in ~50s (a cold run that provisions the test DB adds ~10s).
This depends on a deliberately fast SQLite configuration; if any piece is dropped, commits fall back to fsync and the suite balloons toward the 10-minute tool timeout:

- `helpers/db.ensureTestPragmas()` sets `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=10000`
  once per process (`WAL` is file-persistent; `synchronous`/`busy_timeout` are per-connection).
- `setup.ts` pins the runtime `DATABASE_URL` to `?connection_limit=1`, so the pool has a SINGLE
  connection and those per-connection pragmas apply to EVERY query. Without it Prisma opens extra
  pooled connections that keep the default `synchronous=FULL`; after the pool grows, every DB-backed
  write stalls ~2s and the DB specs run ~10× slower.
- Because the fast path leaves `test.db` in WAL mode, `setup.ts` DELETES `test.db` (+ its
  `-wal`/`-shm`/`-journal` sidecars) before re-running `prisma db push --force-reset` — a `--force-reset`
  against an existing WAL file fails with "database disk image is malformed". It only re-pushes when the
  marker's stored sha1 differs from the current `prisma/schema.prisma` (or the marker/DB is absent).

## Known Issues

- **No spec asserts on a message's inline `cards`.** For a `submit_plan` turn the `plan` card is delivered BOTH ways — inline in the `submit_plan`-calling assistant message's `cards` (surfaced on its `message_start`/`message_end` events) AND as a standalone `{type:'card', card}` event — because `agent/run-turn.ts#emitCard` pushes the SAME card into `buffer.current.cards` and the `card` event, and `runTurn` returns `buffer.events` by reference. Plan specs assert only the standalone `card` event (`app/plan-parking-http.test.ts:183`) and `plan_update` frames, so a UI double-render of the plan card (the UI promotes the standalone `card` to `activePlan` AND keeps the message's `cards`) is UNCOVERED.

- **GREEN auto-execute writes no `AuditLog` row.** Audit rows are written only for gated
  confirm/verify/cancel decisions — assert GREEN at the `beforeToolCall` chokepoint instead.
- **`CIRCUIT_OPEN`/423 and SSE `error`-frame are unreachable over real HTTP + mock.** `mapAppError`
  maps `CIRCUIT_OPEN`→423 but nothing throws it (a tripped breaker returns a domain `status:'locked'`
  as HTTP 200); the SSE `error`-then-`done` path is only exercised by `unit/agent/run-turn-failure.test.ts`.
  See `app/CONTEXT.md`.

- **`review-recovery-probes.test.ts` has 2 RED tests that are NOT test bugs — they demand unwired
  SOURCE capabilities.** A verbatim port of `.codex-review` reference probes (`a10cd48`, no source
  change), asserting recovery behaviour that does not exist yet. Do NOT weaken/relax them; the fix
  lands OUTSIDE `./tests`:
  - Test 1 "resume recovers an already-executed gated node after its plan callback fails" → expected
    `'success'`/1 budget, observed `'waiting_confirmation'`/0. Root cause: the confirm path records the
    action `executed` (`confirmation.ts#executeAuthorizedAction` → `recordActionResult`) BEFORE
    `resumeOwningPlan` persists the node result; when that persistence fails (a crash/failure between
    effect and write) the node row keeps `status:'waiting_confirmation'` + `output.pendingActionId`, and
    a later resume re-parks the node instead of reconciling it — `executeGatedToolOnce` →
    `findInFlightPlanActionId` treats `'executed'` as in-flight (`IN_FLIGHT_PLAN_ACTION_STATUSES` in
    `agent/confirmation.ts`), so the node never advances and downstream nodes never run (**permanent livelock**).
    Missing behaviour: reconcile a node whose linked `PendingAction` is already terminal `executed` by
    recording its real outcome and continuing the DAG (in `agent/confirmation.ts`/`agent/task-control.ts`).
  - Test 2 "resume can recover a persisted executor claim whose owner died long ago" → expected
    `'success'`/1 budget, observed `'running'`/0. Root cause: `agent/task-control.ts#resumeTask` calls
    `claimTaskExecution(taskId, token)` with NO `{ staleBefore }` (L477), so a dead owner's token
    (`executionToken:'dead-process-claim'`) blocks the claim → early `return reloadPlan(...)`, leaving the
    plan persisted `'running'` with no executor. Missing behaviour: **stale-claim takeover** — pass
    `{ staleBefore: <now − STALE_CLAIM_MS> }` (and similarly in `retryTask`). The primitive already exists
    and is unused: `lib/db/repositories/task.ts#claimTaskExecution`/`claimNodeExecution` accept
    `opts?:{staleBefore?:Date}` (added by `06d7e3d`) with **no production caller anywhere**.

## Routing Table

- `./setup.ts` → Vitest global setup: env isolation (`DATABASE_URL`→test SQLite incl. `?connection_limit=1`, `LLM_MODE=mock`) + hash-aware schema provisioning (re-pushes when the sha1 of `prisma/schema.prisma` changes; removes the WAL-mode `test.db` first)
- `./helpers` → shared test utilities (db reset/seed + fast pragmas, fixtures, faux agent, scenario harness)
- `./unit` → pure/logic unit specs for security, planner, banking-sdk, agent, lib (incl. `unit/security/risk-engine-dedup.test.ts` → ledger dedup of the in-flight transfer total via `computeInFlightTransferTotal`)
- `./scenarios` → full-pipeline integration specs, one per demo scenario (Tests 1–12)
- `./app` → real app-entry (HTTP) specs driving the real Next.js route handlers (chat/SSE, action confirm|verify|cancel, task lifecycle, reviewer regressions); newer specs cover cookie-only session takeover, cancel-during-authorization, concurrent resume/retry exactly-once, plan pause/terminal-state, cumulative ¥1000/day risk, ledger consistency, YELLOW→RED MFA upgrade — every top-level describe is labeled `[integration]` (these are handler tests, NOT browser E2E)
- `./e2e` → real-browser acceptance harness: boots `next dev` + real headless Chrome and drives the `/agent` UI end-to-end, asserting on RENDERED DOM (the ONLY true browser E2E layer). See `e2e/CONTEXT.md`.
- `./review-boundaries.test.ts` → `[integration]` reviewer-boundary regressions over the REAL route handlers (chat/tasks/actions): foreign body-`sessionId` vs cookie → 409; resume keeps a cancelled task cancelled; no fresh executable PendingAction after cancel-during-authorization; paused-plan confirm does NOT advance; two concurrent resumes run each unfinished node exactly once; concurrent HTTP resume adds no duplicate budget; ledgered-but-not-terminal actions counted once in cumulative risk
- `./review-concurrency.test.ts` → `[integration]` reviewer concurrency-bug regressions (the 5 cases from the `.codex-review` reference port): staggered resume / gated double-resume / orphan-after-cancel / independent plans / unlinked-cancel each assert EXACTLY-ONCE side effects and full revoke-on-cancel (assertions ported unrelaxed)
- `./review-new-boundaries.test.ts` → `[integration]` cross-cutting exactness regressions over the REAL route handlers + security gateway, using controllable barriers (`deferred()`/`bounded()`): a plan transfer already on the ledger but not yet terminal is counted EXACTLY ONCE in the cumulative daily/amount risk rules (a later ¥100 stays YELLOW; ¥1000 YELLOW, ¥1000.01 RED) while genuinely un-posted actions still count; resuming an investment node in the "effect posted, result not yet persisted" window cannot debit twice (balance ¥23,580 → ¥22,580, exactly one ¥1000 holding); a plan cancellation completed before the authorization compare-and-set prevents the debit (cumulative total ¥0, action `cancelled`, HTTP 200 `{ok:false,status:'cancelled'}`)
- `./review-followup-probes.test.ts` → `[integration]` reviewer reference-probe ports over the REAL route handlers + gateway (`.codex-review`), using controllable barriers (`deferred()`/`bounded()`): cancel preserves an already-ledgered/executed transfer while result persistence is in flight.
- `./review-recovery-probes.test.ts` → `[integration]` reviewer reference-probe ports for crash/resume recovery (`.codex-review`, `a10cd48`). **2 of 3 tests are RED** (see Known Issues — demand source capabilities outside `./tests`, not relaxable); the 3rd (same-key redemption replay) is green.
- `../vitest.config.ts` → root-owned test runner config (`setupFiles`, `env: LLM_MODE=mock`, `fileParallelism: false`, `hookTimeout: 60000`) (sibling — read-only, escalate writes to root)
- `../lib/contracts` → frozen cross-module types the specs import (sibling — read-only)
- `../prisma/schema.prisma` → SQLite schema the test DB is pushed from (sibling — read-only)

## Notes for Agents

- **Clean-env bootstrap.** `package.json` has no `postinstall` hook and `prisma generate` is a separate
  script, so a fresh checkout has only the `@prisma/client` POSTINSTALL STUB (no engine, no schema copy).
  `tests/setup.ts` self-bootstraps a usable client via `helpers/prisma-cli.ts#ensurePrismaClientGenerated`
  BEFORE the provision short-circuit (cheap no-op once generated); `e2e/helpers.ts` does the same.
  Without this, every DB-backed suite dies at IMPORT time with `@prisma/client did not initialize yet`.
- **Provisioning FAILS LOUD.** `setup.ts` runs the push through `runCliStep`, which THROWS on a non-zero
  exit with the FULL captured stdout+stderr (never a `console.warn`-and-continue), so the real cause can
  never be masked by a later `The table main.X does not exist in the current database.` cascade.
- **All specs are implemented acceptance tests** (no `it.todo`). Keep them green; fix the seam
  (injectable `now`/`id`, unique sessionId, fresh DB), never weaken an assertion to pass.
- The gateway is the security chokepoint: prove in Test 4 that injection text changes NOTHING about
  the tier — the money move still requires human MFA.
- Do not weaken determinism to make a test pass (fake timers, real network, shared DB state); fix the
  seam (injectable `now`/`id`, unique sessionId, fresh DB) instead.
- Speed comes from the "Fast test-DB path" invariant, NOT from skipping resets — keep the pragmas and
  the `connection_limit=1` URL, and never trade isolation for speed.
- **Identity is COOKIE-ONLY.** Write/auth routes (`/api/actions/[id]/{confirm,verify,cancel}`,
  `/api/tasks*`, `/api/security/reset`) authenticate ONLY via the `banking_session` cookie
  (`SESSION_COOKIE`); `?sessionId=`/`?userId=` query params are IGNORED. Missing/unknown cookie → 403
  `SECURITY_DENIED`; unknown id → 404 `NOT_FOUND`; foreign-owned id → 403. App-entry specs pass
  identity as a `Cookie` header via `harness.ts` (`{ sessionId }` shorthand or a raw `cookie`).
  BOOTSTRAP: the FIRST chat turn OMITS body `sessionId` and sends NO cookie (the route mints the
  session and returns its id via `data.sessionId`/`Set-Cookie`); a body `sessionId` that disagrees
  with the cookie → **409**.
- **Gateway ownership is mandatory.** `securityGateway.authorizeAction(id, { userId, sessionId, mfaCode? })`
  and `cancelAction(id, { userId, sessionId })` REQUIRE non-optional `userId`+`sessionId` (no demo-user
  fallback; missing/mismatch → `SECURITY_DENIED`). Pass the parked action's OWN `sessionId` and that
  session's `userId` (`DEMO_USER_ID` = 'user_liming'). `AuthorizationResult` carries the EFFECTIVE
  `tier`/`requiresMfa` on BOTH success and failure.
- `tsc --noEmit` must stay at **0 errors** and `npx next build` at **exit 0** — a green `vitest run` alone is not sufficient (Vitest
  transpiles without type-checking; the build type-checks the whole project and prerenders the app
  against a provisioned dev DB).
