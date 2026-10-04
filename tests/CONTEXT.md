# tests — Automated Test Suite (Vitest)

## Intent

The **acceptance bar** for the AI Banking Agent demo, expressed as executable tests.
It proves two things, deterministically and **offline** (no network, no API key):

1. the **security model** is code-enforced (tiers, confirmation, MFA, circuit breaker, injection
   defense) via pure **unit** tests, and
2. the **12 demo scenarios** work end-to-end through the full pipeline
   (Pi Agent → banking tools → Security Gateway `beforeToolCall` → Banking SDK → audit) via
   **scenario** tests driven by a *scripted* model (`registerFauxProvider()`, `LLM_MODE=mock`) and via
   **app-entry (HTTP)** tests that drive the REAL Next.js route handlers.

Only the model is mocked; the tools, the security chokepoint, the route handlers and the DB are the real ones.
This node owns test infrastructure and fixtures — NOT the business logic under test (that lives in
`security/`, `planner/`, `banking-sdk/`, `agent/`).

## API Surface

- `setup.ts` — Vitest **global setup** (`setupFiles`). Sets `DATABASE_URL` → the isolated test
  SQLite (`prisma/test.db`, git-ignored, absolute path), forces `LLM_MODE=mock`, and provisions the
  schema once (`prisma db push --force-reset --skip-generate`, marker-guarded). After provisioning it
  pins the **runtime** `DATABASE_URL` to `?connection_limit=1` (single pooled connection — see
  "Fast test-DB path"). Exports `testDbUrl`/`testDbPath`.
- `helpers/` — shared test utilities (`db`, `fixtures`, `faux-agent`, `scenario`) + a barrel.
  See `helpers/CONTEXT.md` for the full helper API.
- `unit/` — pure/logic specs for `security`, `planner`, `banking-sdk`, plus `agent` + `lib` facade specs. See `unit/CONTEXT.md`.
- `scenarios/` — one spec per demo scenario, Tests 1–12, over the in-process pipeline. See `scenarios/CONTEXT.md`.
- `app/` — real app-entry (HTTP) specs driving the REAL Next.js route handlers. See `app/CONTEXT.md`.

Run:

- `npm run test` → `vitest run` (all suites). `npm run test:watch` for watch mode.
- Target a layer: `npm run test -- tests/unit` · `npm run test -- tests/scenarios` · `npm run test -- tests/app`.
- Pure unit-only run without a DB: `VITEST_SKIP_DB_SETUP=1 npm run test -- tests/unit/security`.

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

Fixtures: the canonical demo dataset (user 李明; contacts 张伟/王芳/妈妈/李华; the Apple Store ¥6,999
anomaly @ 2026-09-20 18:32; products incl. 稳健理财A; subscriptions; cards) is defined in
`helpers/fixtures.ts`. Cross-module knowledge belongs to the modules under test, not to fixtures.

## Fast test-DB path (why the suite is fast — do not remove)

The full suite runs in ~25–30s. This depends on a deliberately fast SQLite configuration; if any piece
is dropped, commits fall back to fsync and the suite balloons toward the 10-minute tool timeout:

- `helpers/db.ensureTestPragmas()` sets `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=10000`
  once per process (`WAL` is file-persistent; `synchronous`/`busy_timeout` are per-connection).
- `setup.ts` pins the runtime `DATABASE_URL` to `?connection_limit=1`, so the pool has a SINGLE
  connection and those per-connection pragmas apply to EVERY query. Without it Prisma opens extra
  pooled connections that keep the default `synchronous=FULL`; after the pool grows, every DB-backed
  write stalls ~2s and the DB specs run ~10× slower.

## Known Issues

- **GREEN auto-execute writes no `AuditLog` row.** Audit rows are written only for gated
  confirm/verify/cancel decisions — assert GREEN at the `beforeToolCall` chokepoint instead.
- **`CIRCUIT_OPEN`/423 and SSE `error`-frame are unreachable over real HTTP + mock.** `mapAppError`
  maps `CIRCUIT_OPEN`→423 but nothing throws it (a tripped breaker returns a domain `status:'locked'`
  as HTTP 200); the SSE `error`-then-`done` path is only exercised by `unit/agent/run-turn-failure.test.ts`.
  See `app/CONTEXT.md`.

## Routing Table

- `./setup.ts` → Vitest global setup: env isolation (`DATABASE_URL`→test SQLite incl. `?connection_limit=1`, `LLM_MODE=mock`) + one-time schema provisioning
- `./helpers` → shared test utilities (db reset/seed + fast pragmas, fixtures, faux agent, scenario harness)
- `./unit` → pure/logic unit specs for security, planner, banking-sdk, agent, lib
- `./scenarios` → full-pipeline integration specs, one per demo scenario (Tests 1–12)
- `./app` → real app-entry (HTTP) specs driving the real Next.js route handlers (chat/SSE, action confirm|verify|cancel, task lifecycle)
- `../vitest.config.ts` → root-owned test runner config (`setupFiles`, `env: LLM_MODE=mock`, `fileParallelism: false`, `hookTimeout: 60000`) (sibling — read-only, escalate writes to root)
- `../lib/contracts` → frozen cross-module types the specs import (sibling — read-only)
- `../prisma/schema.prisma` → SQLite schema the test DB is pushed from (sibling — read-only)

## Notes for Agents

- **All specs are implemented acceptance tests** (no `it.todo`). Keep them green; fix the seam
  (injectable `now`/`id`, unique sessionId, fresh DB), never weaken an assertion to pass.
- The gateway is the security chokepoint: prove in Test 4 that injection text changes NOTHING about
  the tier — the money move still requires human MFA.
- Do not weaken determinism to make a test pass (fake timers, real network, shared DB state); fix the
  seam (injectable `now`/`id`, unique sessionId, fresh DB) instead.
- Speed comes from the "Fast test-DB path" invariant, NOT from skipping resets — keep the pragmas and
  the `connection_limit=1` URL, and never trade isolation for speed.
- `tsc --noEmit` must stay at **0 errors** — a green `vitest run` alone is not sufficient (Vitest
  transpiles without type-checking).
