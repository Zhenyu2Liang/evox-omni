# tests — Automated Test Suite (Vitest)

`review-e819d6e-boundaries.test.ts` preserves all four original reviewer probes byte-for-byte.
`repair-confirmation-boundaries.test.ts` adds 19 cases for ordinary/MFA write-time breaker denial,
audited unlock and at-most-once recovery, card mutation denial, RED receipt fallback after a
competing MFA commit (CONFLICT/CIRCUIT_OPEN), strict audit mismatch rejection, and frontend/HTTP
terminal-state versus active-MFA behaviour. No existing assertion is weakened.

Current recovery-security regressions: `review-95ff994-additional.test.ts` preserves the original
three reviewer probes byte-for-byte; `repair-recovery-security.test.ts` adds 15 cases for breaker
timing, receipt-only locked recovery, risk/MFA escalation, two fresh-recovery races at ¥1000,
six resource-owner violations, write-time owner changes and reconciliation audit atomicity.
`app/actions-recovery-http.test.ts` now requires `ok:false` and `needs_reconciliation` for an
unprovable plan outcome (request handling alone is not business success). Subscription SDK tests
only gain the required server identity argument; existing business assertions remain.

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
  schema when the schema version changes through the shared ORDERED provisioning LADDER
  (`helpers/prisma-cli.ts#provisionSchemaLadder`) whose PRIMARY rung is the byte-for-byte
  `prisma db push --force-reset --skip-generate`, falling back ADDITIVELY (only after a failure) to
  `db push --skip-generate` then a flag-less `db push` (clean-checkout hardening for genuine
  invocation-shape differences — the `Error: Schema engine error:` root cause is the engine log-level
  pin, see **Known Issues**). The guard
  **marker** (`prisma/.test-db-provisioned`) stores the **sha1 of `prisma/schema.prisma`** (written
  atomically via temp-file + rename); provisioning is skipped ONLY when the marker's hash equals the
  current schema hash AND `test.db` exists — so a stale `test.db` (provisioned before a schema
  change), an absent DB, or an old-format ISO-date marker all trigger a re-provision. Re-provisioning
  removes the WAL-mode `test.db` (+ `-wal`/`-shm`/`-journal`) before EACH rung, because `--force-reset`
  cannot re-reset an existing WAL file. After provisioning it
  pins the **runtime** `DATABASE_URL` to `?connection_limit=1` (single pooled connection — see
  "Fast test-DB path"). Exports `testDbUrl`/`testDbPath`.
- `helpers/` — shared test utilities (`db`, `fixtures`, `faux-agent`, `scenario`) + a barrel.
  See `helpers/CONTEXT.md` for the full helper API.
- `helpers/prisma-cli.ts` — Node-built-ins-only shared Prisma CLI/generate infrastructure used by BOTH
  `setup.ts` and `e2e/helpers.ts` (`removeSqliteFiles`, `runCliStep` (fail-loud: throws with FULL
  captured stdout+stderr+exit code), `runCliStepCaptured` (the non-throwing spawn primitive
  `runCliStep` delegates to), `provisionSchemaLadder` (the ORDERED `prisma db push` ladder: each rung
  runs ONLY after the previous FAILED, the DB file + sidecars are deleted before EVERY rung, and a
  total failure THROWS one error embedding every rung's FULL captured output + environment
  diagnostics — see `PushRung`/`ProvisionSchemaOptions`), `diagnosticCliOutput`,
  `prismaClientUsable`/`prismaClientGenerated`, `runPrismaGenerate`, `ensurePrismaClientGenerated` —
  its readiness gate keys on the USABILITY probe `prismaClientUsable` (the client that will actually
  be `require`d), NOT the worktree-local artifact-path proxy `prismaClientGenerated`).
  It is the RE-EXPORTING entry point for the schema-engine **log-level policy**
  (`SCHEMA_ENGINE_RUST_LOG`, `pinSchemaEngineLogging`, `prismaCliEnv` — `pinSchemaEngineLogging` is
  called at module load by `setup.ts` and `e2e/helpers.ts`) and for the binary-resolution helpers
  (`resolveRepoRoot`, `resolvePrismaBin`, `resolveTsxBin`, `cliCommand`): those now LIVE in the
  NON-TEST sibling module `lib/prisma-cli-env.ts` and are re-exported here with the public API
  unchanged, so every existing importer of THIS module keeps working. The per-spawn sanitization lives
  in `runCliStepCaptured`/`provisionDiagnostics` (via `lib/prisma-cli-env.ts#prismaCliEnv`) and
  `isMaskedSchemaEngineError` explains an empty `Schema engine error:` — see **Known Issues**.
  NOT in the `helpers/index.ts` barrel — specs must not import it.
- `../lib/prisma-cli-env.ts` (sibling, NON-TEST) — the shared schema-engine environment policy + CLI/binary
  resolution used by the two test entry points AND by the deploy script `scripts/db-push.ts`:
  `SCHEMA_ENGINE_RUST_LOG = 'info'`, the MUTATING `pinSchemaEngineLogging(env)` (called once at module
  load) and the NON-mutating `prismaCliEnv(env)` (the env for ONE spawned CLI step), plus
  `resolveRepoRoot`/`resolvePrismaBin`/`resolveTsxBin`/`cliCommand`. Node built-ins ONLY — no `vitest`,
  no `@/` alias, no import-time side effects.
- `unit/` — pure/logic specs for `security`, `planner`, `banking-sdk`, plus `agent` + `lib` facade specs (incl. `unit/lib/prisma-cli-env.test.ts` (10 tests) for the shared `lib/prisma-cli-env.ts` schema-engine env policy). See `unit/CONTEXT.md`.
- `scenarios/` — one spec per demo scenario, Tests 1–12, over the in-process pipeline. See `scenarios/CONTEXT.md`.
- `app/` — real app-entry (HTTP) specs driving the REAL Next.js route handlers
  (chat/SSE, action confirm|verify|cancel, task lifecycle, and `review-regressions-http.test.ts`
  reviewer regressions) plus the newer regression specs (`session-takeover-http`, `cancel-during-
  authorization-http`, `task-resume-retry-http`, `plan-pause-terminal-http`, `cumulative-risk-http`,
  `ledger-consistency-http`, `mfa-escalation-upgrade-http`, the round-5a linkage/concurrency specs
  `plan-linkage-http`, `cancel-safety-http`, `concurrent-execution-http`, and the confirm-continuation
  fence-loss coverage `confirm-continuation-fencing` (LIVE plan-owner-token branch) +
  `confirm-continuation-no-owner-fencing` (NO-OWNER branch-3 CAS, incl. a takeover-during-write skip)).
  See `app/CONTEXT.md`.
- `review-boundaries.test.ts`, `review-concurrency.test.ts`, `review-new-boundaries.test.ts`, `review-next-boundaries.test.ts`, `review-obsolete-executor.test.ts`, `review-result-recovery.test.ts`, `review-committed-side-effect.test.ts`, `review-idempotent-replay.test.ts`, `review-takeover-barriers.test.ts`, `review-audit-reliability.test.ts`, `review-restart-independence.test.ts` & `deploy-db-push.test.ts` — root-level `[integration]` / deploy specs (real route handlers + gateway/executor + the real deploy script + controllable barriers): plan/node linkage, cancel safety, exactly-once concurrent execution, de-dup scope, ledgered-but-not-terminal cumulative-risk exactness, no double-debit across the effect/persist window, revoke-on-cancel-before-CAS, plan-ownership fencing of an obsolete executor, gated-node result recovery, and the `RUST_LOG`-pinned deploy path. See the Routing Table entries below.

Run:

- `npm run test` → `vitest run` (all suites). `npm run test:watch` for watch mode.
- Target a layer: `npm run test -- tests/unit` · `npm run test -- tests/scenarios` · `npm run test -- tests/app`.
- Pure unit-only run without a DB: `VITEST_SKIP_DB_SETUP=1 npm run test -- tests/unit/planner tests/unit/lib/ledger-keys.test.ts tests/unit/agent/providers/provider-mock.test.ts`
  (`VITEST_SKIP_DB_SETUP=1` skips BOTH Prisma Client generation AND schema provisioning; note
  `tests/unit/security` and `tests/unit/planner/executor-claim-scope.test.ts` are DB-BACKED, so they
  fail without a DB — only the DB-free specs above run clean under the flag).

### Prerequisites

- `npm install` is enough for a normal run: `setup.ts` self-bootstraps a usable Prisma Client
  (`helpers/prisma-cli.ts#ensurePrismaClientGenerated`) and pushes the schema with `--skip-generate`
  on purpose — see "Clean-env bootstrap". Run **`npx prisma generate`** manually only for a run that
  skips setup (`VITEST_SKIP_DB_SETUP=1`) or before `tsc`/`next build`.
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
plan pause/resume + cancel, and refresh/action-entry recovery from persisted server state. The harness
includes a wedge-refresh-recover journey (`GET /api/actions` → `POST /api/actions/[id]/recover`) that
settles a stranded gated action from a plain refresh, without the hidden action id.
**Does NOT cover:** the real LLM, `next build`/`next start`, cross-browser, a11y/perf, or the
`unit`/`scenarios` layers. See `e2e/CONTEXT.md` for details and known limitations.

## Fast test-DB path (why the suite is fast — do not remove)

The full suite (**665 tests / 101 files**, 0 failures, cold-start on the isolated auto-provisioned `prisma/test.db` via the default `npx vitest run`) runs in ~90s (a cold run that provisions the test DB adds ~10s).
This depends on a deliberately fast SQLite configuration; if any piece is dropped, commits fall back to fsync and the suite balloons toward the 10-minute tool timeout:

- `helpers/db.ensureTestPragmas()` sets `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=10000`
  once per process (`WAL` is file-persistent; `synchronous`/`busy_timeout` are per-connection).
- `setup.ts` pins the runtime `DATABASE_URL` to `?connection_limit=1`, so the pool has a SINGLE
  connection and those per-connection pragmas apply to EVERY query. Without it Prisma opens extra
  pooled connections that keep the default `synchronous=FULL`; after the pool grows, every DB-backed
  write stalls ~2s and the DB specs run ~10× slower.
- Because the fast path leaves `test.db` in WAL mode, the provisioning LADDER deletes `test.db` (+ its
  `-wal`/`-shm`/`-journal` sidecars) before EACH rung — a `--force-reset` against an existing WAL file
  fails with "database disk image is malformed" — then tries the rungs in order (primary
  `prisma db push --force-reset --skip-generate`, then `db push --skip-generate`, then a flag-less
  `db push`). It only re-pushes when the
  marker's stored sha1 differs from the current `prisma/schema.prisma` (or the marker/DB is absent).

## Known Issues

- **No spec asserts on a message's inline `cards`.** For a `submit_plan` turn the `plan` card is delivered BOTH ways — inline in the `submit_plan`-calling assistant message's `cards` (surfaced on its `message_start`/`message_end` events) AND as a standalone `{type:'card', card}` event — because `agent/run-turn.ts#emitCard` pushes the SAME card into `buffer.current.cards` and the `card` event, and `runTurn` returns `buffer.events` by reference. Plan specs assert only the standalone `card` event (`app/plan-parking-http.test.ts:183`) and `plan_update` frames, so a UI double-render of the plan card (the UI promotes the standalone `card` to `activePlan` AND keeps the message's `cards`) is UNCOVERED.

- **GREEN auto-execute writes no `AuditLog` row.** Audit rows are written only for gated
  confirm/verify/cancel decisions — assert GREEN at the `beforeToolCall` chokepoint instead.
- **`CIRCUIT_OPEN`/423 and SSE `error`-frame are unreachable over real HTTP + mock.** `mapAppError`
  maps `CIRCUIT_OPEN`→423 but nothing throws it (a tripped breaker returns a domain `status:'locked'`
  as HTTP 200); the SSE `error`-then-`done` path is only exercised by `unit/agent/run-turn-failure.test.ts`.
  See `app/CONTEXT.md`.
- **The schema engine's INFO banner must never be suppressed (`RUST_LOG`).** Prisma parses the schema
  engine's stderr as `split(/\r?\n/).slice(1)` — it DROPS line 0, expecting the engine's banner
  (`{"level":"INFO",…,"target":"schema_engine"}`) to be there. The CLI spawns the engine with
  `env: { RUST_LOG: 'info', …process.env }`, so an AMBIENT `RUST_LOG` at/above `warn` OVERRIDES that
  default: the banner vanishes, the engine's ERROR line (including the LEGITIMATE
  `P1003 Database … does not exist` probe that `db push` relies on before creating a fresh SQLite
  file) lands at index 0 and gets discarded too, and the CLI reports an EMPTY
  `Error: Schema engine error:` — so a cold-checkout `db push` fails with no reason. The fix is
  env sanitization, not a bigger ladder: `lib/prisma-cli-env.ts` pins `SCHEMA_ENGINE_RUST_LOG = 'info'`
  (re-exported by `helpers/prisma-cli.ts`),
  `pinSchemaEngineLogging()` is called at module load by BOTH entry points (`tests/setup.ts`,
  `tests/e2e/helpers.ts`) so this process and every child it spawns (Prisma CLI, schema engine,
  `next dev`) inherit it, and `runCliStepCaptured` re-pins the level per spawn so even a caller passing
  an explicit env object cannot re-introduce the suppression. `RUST_BACKTRACE` is only defaulted
  (`?? '1'`), never overwritten. The ladder, the fail-loud throw and the absence of skip flags are
  unchanged; `isMaskedSchemaEngineError` just explains a masked-empty engine error in the thrown
  diagnostics if it ever recurs.

## Routing Table

- `./setup.ts` → Vitest global setup: env isolation (`DATABASE_URL`→test SQLite incl. `?connection_limit=1`, `LLM_MODE=mock`) + a module-load `pinSchemaEngineLogging()` (forces `RUST_LOG=info`, see **Known Issues**) + hash-aware schema provisioning through the shared ORDERED LADDER (`helpers/prisma-cli.ts#provisionSchemaLadder`; primary rung `prisma db push --force-reset --skip-generate`, then `db push --skip-generate`, then flag-less `db push`; re-pushes when the sha1 of `prisma/schema.prisma` changes; the DB file + sidecars are removed before every rung)
- `./helpers` → shared test utilities (db reset/seed + fast pragmas, fixtures, faux agent, scenario harness)
- `./unit` → pure/logic unit specs for security, planner, banking-sdk, agent, lib (incl. `unit/security/risk-engine-dedup.test.ts` → ledger dedup of the in-flight transfer total via `computeInFlightTransferTotal`, and `unit/lib/prisma-cli-env.test.ts` (10 tests) → the shared `lib/prisma-cli-env.ts` schema-engine env policy: the mutating entry-point pin vs the per-spawn non-mutating copy; plus `unit/lib/execution-receipt.test.ts` (PURE committed-fact ledger helpers: `executionReceiptId`/`requestDigest`), `unit/banking-sdk/transfer-receipt.test.ts` (DB-backed transfer committed-fact semantics: same-key replay, DIFFERENT-request `CONFLICT`, legacy ledger row recognized), and `unit/planner/executor-execution-right.test.ts` (DB-backed execution-right fencing after a plan takeover))
- `./scenarios` → full-pipeline integration specs, one per demo scenario (Tests 1–12)
- `./app` → real app-entry (HTTP) specs driving the real Next.js route handlers (chat/SSE, action confirm|verify|cancel, task lifecycle, reviewer regressions); newer specs cover cookie-only session takeover, cancel-during-authorization, concurrent resume/retry exactly-once, plan pause/terminal-state, cumulative ¥1000/day risk, ledger consistency, YELLOW→RED MFA upgrade — every top-level describe is labeled `[integration]` (these are handler tests, NOT browser E2E). `confirm-continuation-no-owner-fencing.test.ts` drives `@/agent`'s `task-fencing.ts#recordDecidedNodeFenced` NO-OWNER (branch-3) CAS over a REAL test SQLite (`getTestPrisma()`), seeding via `runSubmitPlan` + `executeGatedTool` on a 2-node plan: with no owner the decided node is recorded and the plan is SETTLED to `success` (the parked `PendingAction` untouched), and a takeover that claims the plan INSIDE the write window makes the CAS match 0 rows — the recorder returns `false`, the node is not overwritten and nothing settles (the spy wraps the REAL `agentTaskNode.updateMany` and calls the bound original; the CAS result is never fabricated). `app/actions-recovery-http.test.ts` drives the REAL recovery surface (`GET /api/actions` + `POST /api/actions/[id]/recover`) on a real fault-injected wedge: a STANDALONE `transfer_money` wedge surfaced with `attention:'recoverable'` is replayed idempotently to `executed` (side effect once); a PLAN-NODE wedge is surfaced with a non-`processing` attention and recover RESUMES the owning plan server-side; a repeat recover is a settled no-op
- `./e2e` → real-browser acceptance harness: boots `next dev` + real headless Chrome and drives the `/agent` UI end-to-end, asserting on RENDERED DOM (the ONLY true browser E2E layer). See `e2e/CONTEXT.md`.
- `./review-boundaries.test.ts` → `[integration]` reviewer-boundary regressions over the REAL route handlers (chat/tasks/actions): foreign body-`sessionId` vs cookie → 409; resume keeps a cancelled task cancelled; no fresh executable PendingAction after cancel-during-authorization; paused-plan confirm does NOT advance; two concurrent resumes run each unfinished node exactly once; concurrent HTTP resume adds no duplicate budget; ledgered-but-not-terminal actions counted once in cumulative risk
- `./review-concurrency.test.ts` → `[integration]` reviewer concurrency-bug regressions (the 5 cases from the `.codex-review` reference port): staggered resume / gated double-resume / orphan-after-cancel / independent plans / unlinked-cancel each assert EXACTLY-ONCE side effects and full revoke-on-cancel (assertions ported unrelaxed)
- `./review-new-boundaries.test.ts` → `[integration]` cross-cutting exactness regressions over the REAL route handlers + security gateway, using controllable barriers (`deferred()`/`bounded()`): a plan transfer already on the ledger but not yet terminal is counted EXACTLY ONCE in the cumulative daily/amount risk rules (a later ¥100 stays YELLOW; ¥1000 YELLOW, ¥1000.01 RED) while genuinely un-posted actions still count; resuming an investment node in the "effect posted, result not yet persisted" window cannot debit twice (balance ¥23,580 → ¥22,580, exactly one ¥1000 holding); a plan cancellation completed before the authorization compare-and-set prevents the debit (cumulative total ¥0, action `cancelled`, HTTP 200 `{ok:false,status:'cancelled'}`)
- `./review-followup-probes.test.ts` → `[integration]` reviewer reference-probe ports over the REAL route handlers + gateway (`.codex-review`), using controllable barriers (`deferred()`/`bounded()`): cancel preserves an already-ledgered/executed transfer while result persistence is in flight.
- `./review-recovery-probes.test.ts` → `[integration]` recovery reference-probe ports (`.codex-review`, `a10cd48`) over the REAL route handlers + DB with controllable fault injection (a spied failing node-result persistence; a seeded dead-owner execution claim). **All 3 green**: an already-executed gated node is reconciled from its persisted result and the DAG continues — no duplicate side effect, idempotent on repeat resume; a stale dead-owner claim is taken over and finishes the remaining work; same-key redemption replays the exact result while a distinct key is refused. The capability lives in `./agent` (executed-node reconciliation in `confirmation.ts`; stale-claim takeover via `{ staleBefore }` in `task-control.ts` resume/retry).
- `./review-final-boundaries.test.ts` → `[integration]` **frozen regression guard (GREEN)** over the REAL route handlers + DB with controllable barriers (`.codex-review` reference port): (1) recovering an executed `set_card_limit` node backfills its node result from the **persisted** `PendingAction.resultJson` (no tool re-invocation) so the resumed plan must NOT re-apply the node's old amount (¥1500) over a later independently authorized limit (¥500) — final limit stays ¥500 and the plan completes `success`; (2) plan/node writes are **token-fenced**, so a still-live old executor's late failure (after a stale-claim takeover completed the node) must NOT overwrite the takeover's result — the node stays `success` with exactly one budget side effect. Both invariants hold and the spec is kept as a regression guard.
- `./review-result-recovery.test.ts` (6 tests) → `[integration]` gated plan-node RESULT-RECOVERY regressions over the REAL confirm/task route handlers + DB with a persistence fault (`vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce(...)`, the REAL result-transaction write), every assertion re-read via `getTestPrisma()`: a `confirmed` action with a persisted `resultJson={ok:true,…}` finalizes `executed` / node `success` WITHOUT re-invoking the tool (side effect exactly once); a persisted `{ok:false,…}` result finalizes action/node/plan `failed` (never `executed`); recovery is idempotent and concurrent-safe (one side effect, one action); a simulated process restart recovers purely from persisted server state; and the result-transaction-rollback wedge (side effect committed, result write rejected) must NOT stay `waiting_confirmation` — it settles terminal `failed` carrying the `人工核对` message with the side effect exactly once
- `./review-next-boundaries.test.ts` (5 tests tagged `REVIEW_OBSOLETE_SUCCESSOR_RECLAIM`, `REVIEW_OBSOLETE_PROGRESS_EVENT`, `REVIEW_RESULT_TX_ROLLBACK_WEDGE`, `REVIEW_FAILED_RESULT_FINALIZATION`, `REVIEW_LEGACY_GUARD_COVERAGE`) → `[integration]` obsolete-executor / result-recovery boundary regressions over the REAL route handlers + DB (`deferred()`/`bounded()` barriers, `getTestPrisma()`): a replaced-plan-executor must not reclaim/overwrite a completed successor and a stale initial executor must not publish a plan-update after takeover; a `set_card_limit` node whose result transaction genuinely fails (fault injected at `pendingActionRepo.setPendingActionStatus`, the REAL result write) must recover WITHOUT re-applying the node's original ¥1500 over a later independently authorized ¥500 (final ¥500) and settle the plan `failed` with the `人工核对` message; recovery of a persisted `{ok:false}` result finalizes action/node/plan `failed` (never `executed`)
- `./review-obsolete-executor.test.ts` (4 tests) → `[integration]` plan-ownership FENCING acceptance over the REAL task route handler + gateway-routed `runTool` port + REAL executor + test SQLite (only a race barrier, never a mocked return value): after a `resume`/`retry` takeover rotates the plan `executionToken` (owner aged past `EXECUTION_CLAIM_TTL_MS`), the obsolete executor can NOT re-claim/reuse a completed node, run its successor tool, flip a takeover-completed dependency to `failed`/`skipped`, or publish a stale `onPlanUpdate`; two concurrent takeovers yield EXACTLY ONE side effect (frozen acceptance criteria — assertions never weakened).
- `./review-followup-integrity.test.ts` (4 tests) → `[integration]` **frozen acceptance guard (GREEN)** over the REAL route handlers + DB (`.codex-review` reference port): the three follow-up integrity defects closed by this task — (1) an INITIAL-executor `submit_plan` run loses its plan claim after a `resume` takeover and must launch ZERO successor tool calls; (2) a duplicate/`no-duplicate` YELLOW confirm must not fork a live continuation; (3) a standalone gated action in the "effect posted, result not persisted" wedge recovers. Kept byte-for-byte — do NOT edit or weaken.
- `./review-initial-executor-fencing.test.ts` (1 test) → `[integration]` DEFECT 1 (initial-executor lost-claim stop) over the REAL task route handler + REAL executor + test SQLite (`getTestPrisma()`, `deferred()`/`bounded()` barriers, only a race barrier — never a mocked return value): an INITIAL `submit_plan` run BLOCKED inside its first node's tool, after a `resume` takeover (triggered by aging `AgentTask.executionClaimedAt`) completes, launches ZERO successor tool calls, publishes NO stale post-takeover progress (asserts BOTH `onNodeUpdate` AND `onPlanUpdate` receive no post-takeover status for the zombie), and the persisted DB state (AgentTask status + node statuses) is consistent with the returned plan. Complements the frozen spec by adding the progress-event + DB/return-consistency assertions.
- `./review-confirmation-marker-lifecycle.test.ts` (3 tests) → `[integration]` DEFECT 2 (live-confirmation ref-count marker lifecycle) over the REAL confirm/verify route handlers + gateway (barrier via a spy on `securityGateway.authorizeAction`, as the frozen spec does): (a) a rejected REPEATED `verify` (RED MFA transfer ¥5000, code `123456`) on the SAME action does NOT clear the first still-live continuation's marker — the original completes, no premature `failed`, side effect EXACTLY ONCE; (b) an ABNORMAL EXIT (a thrown error inside the gated execution, fault injected at `pendingActionRepo.setPendingActionStatus`) on a RED `transfer_money ¥5000` whose side effect COMMITTED (debit + ledger + `ExecutionReceipt` in one tx) converges on resume to plan/node `success` + action `executed` — a committed receipt ⇒ executed, the tool is NEVER re-invoked and the outcome is never fabricated into `failed`/`人工核对` — with the side effect exactly once (balance 18580, debit count `before+1`), and the liveness bookkeeping releases so a LATER legitimate recovery still works; (c) final PendingAction / node / plan / API-response states are asserted consistent, not just the amount.
- `./review-standalone-recovery.test.ts` (6 tests) → `[integration]` DEFECT 3 (standalone gated-action wedge recovery) over the REAL confirm/actions route handlers + DB with REAL fault injection (`getTestPrisma()`, every injection asserts the spy actually HIT the target AND the WEDGED pre-recovery state BEFORE recovery): (a) a standalone `transfer_money` in the wedge replays to `executed`; a standalone `apply_virtual_card`/`set_card_limit` whose result-save transaction fails settles to a VISIBLE non-`confirmed` state (`needs_reconciliation`), appears in `GET /api/actions`, with NO duplicate side effect (no second card, limit never re-applied); (b) a SIMULATED PROCESS RESTART (module state reset via `vi.resetModules()` + fresh dynamic import asserting `liveCount===0`) still recovers or explicitly enters `needs_reconciliation`; (c) repeat-request + refresh consistency (asserts balance / ledger rows / PendingAction / API-response — not only a final amount); plus a failed replay settling `failed`.
- `./review-txn-facts.test.ts` (3 tests tagged `REVIEW_TXN_CONTACT_RENAMED`, `REVIEW_TXN_CONTACT_DELETED`, `REVIEW_TXN_PLAN_CANCEL`) → `[integration]` the UNIFIED TRANSACTION-FACT SOURCE over the REAL confirm/tasks/actions route handlers + REAL agent confirmation continuation + REAL gateway/SDK on isolated test SQLite, with REAL fault injection (`vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce`, every injection asserts the spy actually HIT the target AND the WEDGED pre-recovery state — `confirmed` + `resultJson=null` + exact debit/balance — BEFORE recovery): a committed standalone ¥200 transfer is recovered RECEIPT-FIRST from its committed execution evidence even after the recipient contact is renamed (a) / deleted (b) — action `executed`, balance 23380, exactly ONE recipient-scoped debit, message 从其已提交的执行凭证中恢复成功…未重新执行 (never a re-execution); (c) a gated plan-node transfer whose side effect commits but whose result write fails is NOT downgraded to `cancelled`/`failed` when the plan is cancelled: the debit is retained EXACTLY once, balance stays −amount, the action stays `confirmed` (visible via `GET /api/actions`), and a repeat confirm fails CLOSED with the 该操作所属的任务计划已取消…已拒绝执行 message (no second debit) — because `agent/confirmation.ts#cancelledPlanOutcome` refuses any action whose owning plan is `cancelled` BEFORE authorization, so a plan-linked wedge deliberately never reaches `executed` (the retained committed fact is the invariant).
- `./review-receipt-identity.test.ts` → `[integration]` committed-fact ATOMICITY / IDEMPOTENCY / EXECUTION-IDENTITY on the money ledger + the unified `ExecutionReceipt` over the REAL confirm/recover route handlers + REAL SDK + test SQLite (only real fault injection, asserted to have HIT): a receipt write that fails after the debit is attempted rolls the debit AND its ledger row back atomically (no orphan debit, no receipt); TWO concurrent recoveries of one standalone ¥200 wedge (effect committed, result write rolled back) apply the side effect EXACTLY once and both settle `executed`; the SAME key with a DIFFERENT request → `AppError('CONFLICT')` and no extra debit; the SAME key + SAME request replays the ORIGINAL result verbatim (one debit).
- `./review-committed-side-effect.test.ts` (3 tests) → `[integration]` "committed side effect, result NOT persisted" WEDGE recovery over the REAL confirm/recover/tasks/actions route handlers + REAL confirmation continuation/executor/SDK on isolated test SQLite, with REAL fault injection (`vi.spyOn(pendingActionRepo,'setPendingActionStatus').mockRejectedValueOnce`, the REAL result+status transaction, asserted to have FIRED and the wedged `confirmed`+`resultJson=null` state verified BEFORE recovery): (1) a PLAN-LINKED `transfer_money` ¥200 node — resuming the owning plan backfills the node from its committed `ExecutionReceipt` (`nxe:<planId>:<nodeId>`), landing plan `success` / node `success` / action `executed` / result `ok:true` with EXACTLY ONE receipt + ONE debit and a stable balance (the tool is never re-invoked); (2) a STANDALONE `transfer_money` ¥250 — `POST /api/actions/[id]/recover` replays receipt-first to `executed` (one receipt, one debit) and the terminal row is no longer surfaced by `GET /api/actions`; (3) a STANDALONE `apply_virtual_card` (NOT proven idempotent) — recover settles the queryable `needs_reconciliation` (never `failed`, never `executed`) with EXACTLY ONE virtual card and no ledger movement, and the row STAYS surfaced. Relays in the assertions: balance / ledger rows / `ExecutionReceipt` / `PendingAction.status` / node status / plan status are all mutually consistent.
- `./review-idempotent-replay.test.ts` (4 tests) → `[integration]` committed-fact IDEMPOTENT REPLAY (serial + concurrent) over the REAL confirm/recover route handlers + REAL SDK on isolated test SQLite, using a controllable barrier (a HELD `contactRepo.searchContacts`) asserted to have FIRED: same key + SAME request returns the FIRST committed original result (same `transactionId`, no second debit) for a sequential replay AND a concurrent race; same key + DIFFERENT request → `CONFLICT` with NO new side effect, and the returned recipient/amount never contradict the persisted ledger row.
- `./review-takeover-barriers.test.ts` (6 tests) → `[integration]` execution-right (fencing) TAKEOVER × cancel/pause barrier suite over the REAL task/confirm route handlers + REAL executor + test SQLite (`deferred()`/`bounded()` barriers, one side effect per winner): (a) a takeover while blocked in the `running` node notification launches ZERO tools and publishes NO stale progress; (b) a takeover immediately before the SDK write fences the pre-write zombie (NO duplicate side effect — one budget, one ledger key); (c) cancel-first fences the in-flight write before any side effect; (d) business-commits-first RETAINS the committed fact (no rollback); (e) pause-then-confirm leaves the plan `paused`; (f) two concurrent `resume`s yield exactly one executor.
- `./review-audit-reliability.test.ts` (3 tests) → `[integration]` execution/recovery AUDIT RELIABILITY over the REAL recover route handlers + REAL SDK on isolated test SQLite (`vi.spyOn(auditStore,'insertAuditLog')` fault for `opts.dedupeKey === \`exec:<id>\``, asserted to have FIRED): a critical execution-audit insert failure ROLLS BACK the settle (the action is never left `executed` without its audit; side effect exactly once); a historical "already-posted but missing audit" row is idempotently BACKFILLED on recovery (exactly ONE `exec:<id>` audit, ONE debit, never downgraded to `failed`); a repeat recovery neither double-debits nor double-audits.
- `./review-restart-independence.test.ts` (3 tests) → `[integration]` restart-independence / PERSISTED-STATE recovery over the REAL recover/tasks route handlers + REAL SDK on isolated test SQLite: a standalone wedge recovers after `vi.resetModules()` + a FRESH dynamic import of the recover route (in-process `liveCount` asserted before `>0` and after `===0`); a plan-linked wedge resumes + backfills via a fresh `taskPost`; a repeat recovery across the module reset is idempotent — proving correctness depends on PERSISTED server state (the `PendingAction` row + committed `ExecutionReceipt`), NOT the process map.
- `./review-convergence-refresh.test.ts` → `[integration]` state-convergence / refresh regressions over the REAL route handlers + DB (one REAL `securityGateway.authorizeAction` barrier + a `setPendingActionStatus` fault, never a fabricated return value): an in-flight confirm is surfaced by a plain refresh with `attention:'processing'` (from the persisted execution lease) and a concurrent duplicate confirm is refused with NO second side effect; a wedge (`confirmed` + `resultJson=null`) stays VISIBLE after a refresh AND after a simulated module-graph reload (empty in-process liveness) and is recoverable via the FRESHLY imported recover route from the refresh payload alone; a successful recovery is idempotent — a repeat never downgrades `executed`, adds no second side effect / execution audit / ledger movement.
- `./review-execution-barriers.test.ts` → `[integration]` execution-right (fencing) BARRIER regressions over the REAL planner executor + task/confirm route handlers + DB (`deferred()`/`bounded()`, barriers at THREE node-lifecycle points): a superseded ("zombie") run never launches the successor tool (pre-tool / while parked in an async notification / pre-write), publishes NO stale `onNodeUpdate`/`onPlanUpdate` progress, and leaves the DB equal to the WINNER's committed state (side effect counted exactly once); a takeover AFTER a committed gated side effect preserves the success fact (exactly one execution audit / one side effect) and never resurrects a settled plan.
- `./review-postfix-boundaries.test.ts` → `[integration]` post-fix boundary regressions over the REAL task/confirm/actions route handlers + DB (`deferred()`/`bounded()`): a node CLAIMED by a run must not start its tool or publish a plan after a `resume` takeover while its `running` notification is still blocked; a plain refresh must surface a standalone wedge without requiring the hidden action id to be confirmed again.
- `./deploy-db-push.test.ts` (1 test) → `[integration]` regression for the SUPPORTED deploy entrypoint `scripts/db-push.ts` (`npm run db:push`/`db:reset`): driven through `tsx` (via `cliCommand(resolveTsxBin(repoRoot), …)`, same as the E2E harness) with an ambient `RUST_LOG=warn` and a DELIBERATELY isolated absolute `DATABASE_URL`, a MISSING SQLite file self-provisions (exit 0 + the file appears) while `prisma/dev.db`/`test.db`/`e2e.db` stay asserted UNTOUCHED (before AND after).
- `../vitest.config.ts` → root-owned test runner config (`setupFiles`, `env: LLM_MODE=mock`, `fileParallelism: false`, `hookTimeout: 60000`) (sibling — read-only, escalate writes to root)
- `../lib/contracts` → frozen cross-module types the specs import (sibling — read-only)
- `../lib/prisma-cli-env.ts` → NON-TEST shared schema-engine env policy + CLI/binary resolution, imported by the test entry points AND the deploy script `scripts/db-push.ts` (sibling — re-exported by `./helpers/prisma-cli.ts`)
- `../prisma/schema.prisma` → SQLite schema the test DB is pushed from (sibling — read-only)

## Current transaction-boundary regressions

- `./review-unclosed-boundaries.test.ts` — four unchanged reviewer probes: post-commit SDK exception,
  pre-receipt ledger recovery, cancellation before a card-limit write, and required-audit rollback.
  Baseline `c1d2b55`: 0/4 pass; repaired branch: 4/4 pass.
- `./repair-sdk-boundaries.test.ts` — 16 additional cases: all 12 mutating tools reach the trusted
  transaction fence; legacy request matching; executed historical audit repair; inconsistent receipts
  enter reconciliation; strict audit deduplication rejects a different business outcome.
- Verified full suite: 105 files / 703 tests, zero failed or skipped. Browser acceptance is separate:
  six journeys in `e2e/acceptance.e2e.ts`.
- Transfer execution audits now commit with the debit, ledger and receipt. Audit-failure expectations
  require zero debit/receipt and an unchanged balance. Legacy replay never invents an original balance
  or replaces the recorded historical recipient name with today's contact name.

## Notes for Agents

- **Clean-env bootstrap.** `package.json` has no `postinstall` hook and `prisma generate` is a separate
  script, so a fresh checkout has only the `@prisma/client` POSTINSTALL STUB (no engine, no schema copy).
  `tests/setup.ts` self-bootstraps a usable client via `helpers/prisma-cli.ts#ensurePrismaClientGenerated`
  BEFORE the provision short-circuit (cheap no-op once generated); `e2e/helpers.ts` does the same.
  Without this, every DB-backed suite dies at IMPORT time with `@prisma/client did not initialize yet`.
  The skip gate is the USABILITY probe (`prismaClientUsable`): it skips only when a real `PrismaClient`
  actually CONSTRUCTS (the client `require`d after Node's upward `node_modules` walk), so a
  hoisted/parent-resolved layout — where `prisma generate` writes to the PARENT path and the
  worktree-local artifact path stays absent — is ACCEPTED, while a stub-only client (probe throws) still
  triggers a generate.
- **Provisioning FAILS LOUD.** Both `setup.ts` and `e2e/helpers.ts` provision through the shared
  `provisionSchemaLadder`, which drives each rung via `runCliStepCaptured` and, when EVERY rung fails,
  THROWS ONE error embedding every rung's FULL captured stdout+stderr (`diagnosticCliOutput`, tail
  preserved) plus environment diagnostics (resolved `DATABASE_URL`, the ambient vs the pinned
  `RUST_LOG`, cwd, project-local Prisma CLI path, a `prisma -v` version/engine summary,
  `node_modules/@prisma/engines/schema-engine*` presence, and an explicit
  `isMaskedSchemaEngineError` hint for an empty `Schema engine error:`) — never
  a `console.warn`-and-continue, so the real cause can
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
