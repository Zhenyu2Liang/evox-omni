# tests — Automated Test Suite (Vitest)

## Intent

The **acceptance bar** for the AI Banking Agent demo, expressed as executable tests.
It proves two things, deterministically and **offline** (no network, no API key):

1. the **security model** is code-enforced (tiers, confirmation, MFA, circuit breaker, injection
   defense) via pure **unit** tests, and
2. the **12 demo scenarios** work end-to-end through the full pipeline
   (Pi Agent → banking tools → Security Gateway `beforeToolCall` → Banking SDK → audit) via
   **scenario** tests driven by a *scripted* model (`registerFauxProvider()`, `LLM_MODE=mock`).

Only the model is mocked in scenarios; the tools, the security chokepoint and the DB are the real ones.
This node owns test infrastructure and fixtures — NOT the business logic under test (that lives in
`security/`, `planner/`, `banking-sdk/`, `agent/`).

## API Surface

- `setup.ts` — Vitest **global setup** (`setupFiles`). Sets `DATABASE_URL` → the isolated test
  SQLite (`prisma/test.db`, git-ignored, absolute path), forces `LLM_MODE=mock`, and provisions the
  schema once (`prisma db push --force-reset --skip-generate`, marker-guarded). Exports `testDbUrl`/`testDbPath`.
- `helpers/` — shared test utilities (`db`, `fixtures`, `faux-agent`, `scenario`) + a barrel.
  See `helpers/CONTEXT.md` for the full helper API.
- `unit/` — pure/logic specs for `security`, `planner`, `banking-sdk`. See `unit/CONTEXT.md`.
- `scenarios/` — one spec per demo scenario, Tests 1–12. See `scenarios/CONTEXT.md`.

Run:

- `npm run test` → `vitest run` (all suites). `npm run test:watch` for watch mode.
- Target a layer: `npm run test -- tests/unit` · `npm run test -- tests/scenarios`.
- Pure unit-only run without a DB: `VITEST_SKIP_DB_SETUP=1 npm run test -- tests/unit/security`.

### Prerequisites

- `npm install`, then **`npx prisma generate`** before any spec imports `@prisma/client`
  (e.g. `lib/db/client`, `banking-sdk`) — `setup.ts` pushes the schema with `--skip-generate` on purpose.
- `vitest.config.ts` (root-owned) already wires `setupFiles: ['tests/setup.ts']` + `env: { LLM_MODE: 'mock' }`.
  It is MISSING `test.fileParallelism: false` (and a raised `hookTimeout`): without them every test file runs
  in parallel against the ONE shared `prisma/test.db`, so reset/seed race (socket timeouts). Run sequentially; escalate to root.

## Constraints

- **Offline & deterministic.** No suite may require the network or a real LLM. Models are scripted
  (`registerFauxProvider`); time and ids are injectable; the DB is the isolated test SQLite.
- **Unique `sessionId` per test.** The circuit breaker is in-process, keyed by `sessionId`; a lock
  from Test 10 must not leak into other specs. Use `scenario.newSessionId()`.
- **Test isolation.** DB-backed suites reset + seed via `helpers/db.resetDatabase()` (typically in
  `beforeEach` through `useFreshDatabase()`); never share mutable DB state across tests.
- **Stub-first.** Specs are currently `it.todo` scaffolds (no assertions) mapping every intended
  case; bodies are filled in Phase 2 once the modules under test are implemented. Specs must remain
  **load-safe** (no runtime import of Prisma-constructing modules) so pure collections never fail.
- **Never re-implement the code under test.** Tests assert behaviour through the public
  facades (`@/security`, `@/planner`, `@/banking-sdk`, `@/agent`); they do not fork contracts or logic.
- Specs import frozen types from `@/lib/contracts/*`; they never redeclare them.
- Keep files ≲ ~1000 lines; one spec file per unit/ scenario concern.

## Test Strategy

Two layers, mirroring the acceptance bar:

- **Unit (pure, no LLM):** `security/` (permission policy table, transfer thresholds, gateway
  decide/serialize/parseBlockReason + `buildPendingActionSummary`, injection patterns, circuit-breaker
  trip at 3 failures, MFA verify), `planner/` (DAG validation/topological order/cycle detection,
  condition evaluation, gated node → `waiting_confirmation`), `banking-sdk/` (funds invariant,
  `minAmount`, ambiguous recipient → `CONFLICT` with candidates, subscription cancel, investment subscribe).
- **Scenario (full pipeline, faux LLM):** Tests 1–12 drive a real turn + human decision and assert the
  agent text, tool events, cards, `PendingAction`/audit rows and DB side effects. Each scenario maps to
  its `it.todo` list in `scenarios/test-*.test.ts`.

Fixtures: the canonical demo dataset (user 李明; contacts 张伟/王芳/妈妈/李华; the Apple Store ¥6,999
anomaly @ 2026-09-20 18:32; products incl. 稳健理财A; subscriptions; cards) is defined in
`helpers/fixtures.ts`. Cross-module knowledge belongs to the modules under test, not to fixtures.

## Routing Table

- `./setup.ts` → Vitest global setup: env isolation (`DATABASE_URL`→test SQLite, `LLM_MODE=mock`) + one-time schema provisioning
- `./helpers` → shared test utilities (db reset/seed, fixtures, faux agent, scenario harness)
- `./unit` → pure/logic unit specs for security, planner, banking-sdk
- `./scenarios` → full-pipeline integration specs, one per demo scenario (Tests 1–12)
- `../vitest.config.ts` → root-owned test runner config; **needs `setupFiles: ['tests/setup.ts']`** (sibling — read-only, escalate writes to root)
- `../lib/contracts` → frozen cross-module types the specs import (sibling — read-only)
- `../prisma/schema.prisma` → SQLite schema the test DB is pushed from (sibling — read-only)

## Notes for Agents

- **The specs are the acceptance checklist, not yet real tests.** Filling in a scenario's `it.todo`
  bodies is Phase 2 work; do it only after that module is implemented, and keep them green.
- The gateway is the security chokepoint: prove in Test 4 that injection text changes NOTHING about
  the tier — the money move still requires human MFA.
- Do not weaken determinism to make a test pass (fake timers, real network, shared DB state); fix the
  seam (injectable `now`/`id`, unique sessionId, fresh DB) instead.
