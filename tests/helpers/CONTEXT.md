# tests/helpers — shared test utilities

## Intent

Reusable utilities shared by every suite in `./tests`: test-DB lifecycle, the canonical demo
fixtures, a scripted-model agent builder, and the turn/decision harness. Keeps specs focused on
*what* to assert, not *how* to bootstrap.

These are **test infrastructure**. They contain no banking/security business logic — they wire up the
real modules and drive them. `db.ts` and `fixtures.ts` are **implemented** (they really reset + seed the DB);
`faux-agent.ts`/`scenario.ts` are still documented **stubs**; their signatures are the frozen contract (bodies land in Phase 2).

## API Surface

Import from the barrel (`../helpers`) or a specific module.

- `db.ts` — test-database lifecycle:
  - `getTestPrisma(): PrismaClient` — the Prisma singleton bound to the test DB (`@/lib/db/client`).
  - `truncateAll(): Promise<void>` — delete all rows in FK-safe order (children → parents).
  - `resetDatabase(): Promise<void>` — `truncateAll()` + `fixtures.seedDemoData()` (the circuit breaker has no global reset; isolation comes from a unique `sessionId` per test).
  - `useFreshDatabase(): void` — register Vitest hooks (`beforeEach` → `resetDatabase()`, `afterAll` → disconnect).
  - `disconnectTestPrisma(): Promise<void>` — idempotent Prisma disconnect.
- `fixtures.ts` — the canonical demo dataset (constants) + seeder:
  - constants: `DEMO_USER_ID`/`DEMO_USER`, `CONTACTS` (张伟/王芳/妈妈/李华), `AMBIGUOUS_CONTACT`
    (2nd 王芳), `ACCOUNTS` (活期 ¥23,580), `ANOMALY_TRANSACTION` + `ANOMALY_OCCURRED_AT`
    (Apple Store ¥6,999 @ 2026-09-20 18:32), `MONTHLY_SPEND_TOTAL` (≈¥5,800), `PRODUCTS`/`CARDS`/`CARD_LIMITS`, types.
  - `seedDemoData(options?): Promise<void>` — insert the full dataset (call on a fresh DB).
  - `buildCurrentMonthSpend(now?)` / `buildPreviousMonthSpend(now?)` / `buildSubscriptions(now?)` / `buildHoldings(now?)` / `buildBudgets(now?)` / `buildScheduledTasks(now?)` — the date-relative rows (current/previous/next month), built from LOCAL components relative to `now` (default `demoNow()`).
- `faux-agent.ts` — build a REAL Pi `Agent` with a SCRIPTED model:
  - `buildFauxAgent(options): Agent` — faux provider + registed banking tools + production `beforeToolCall`.
  - script builders: `text`, `tool(name,args)`, `final`, `callThen(text,name,args)`; types `FauxStep`/`FauxToolCall`/`FauxAgentOptions`.
- `scenario.ts` — drive a full session turn + human decision:
  - `runTurn({sessionId,message,agent}): Promise<ScenarioResult>` — send a message, collect events.
  - `confirmAction(agent,actionId)` / `verifyAction(agent,actionId,code)` / `cancelAction(agent,actionId)` — human decision + narration.
  - `newSessionId(prefix?)`, `collectEvents(agent)`, `toolEventsOf(res,name)`, `cardsOfType(res,type)`; types `ScenarioResult`.

## Constraints

- **Only test infrastructure** — never re-implement security/permission/planner/SDK logic here; call
  the real modules.
- **Load-safe imports**: `db.ts`/`scenario.ts` must not construct Prisma (or import Prisma-constructing
  modules like `@/lib/db/client`) at module load in a way that breaks pure unit collections — resolve
  the client lazily inside functions.
- Fixtures are DATA: keep identities/amounts/dates matching the root `CONTEXT.md` "Data Model" (they
  are the acceptance bar). No logic.
- Import frozen types from `@/lib/contracts/*` (`AgentStreamEvent`, `ChatCard`, `TaskPlan`,
  `ToolEventView`, `PendingActionSummary`); never redeclare them.
- Timestamps are epoch ms; money is CNY. Keep files ≲ ~1000 lines.

## Routing Table

- `./db.ts` → test-DB lifecycle (reset / truncate / connect)
- `./fixtures.ts` → canonical demo dataset + seeder
- `./faux-agent.ts` → scripted-model Agent builder
- `./scenario.ts` → turn/decision harness + event collection
- `./index.ts` → barrel re-exports
- `../setup.ts` → provisions the schema + points `DATABASE_URL` at the test SQLite (sibling — this node)

## Notes for Agents

- Every DB-backed suite should start with `useFreshDatabase()` so each test runs against a known world.
- `registerFauxProvider()` (from `@mariozechner/pi-ai`) is how the model is scripted; see the root
  `CONTEXT.md` "Pi Agent Integration" for the Agent/tool/`beforeToolCall` SDK facts.
- The circuit breaker is in-process keyed by `sessionId` — always use a unique id per test.
