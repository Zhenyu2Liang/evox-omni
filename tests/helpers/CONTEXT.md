# tests/helpers — shared test utilities

## Intent

Reusable utilities shared by every suite in `./tests`: test-DB lifecycle, the canonical demo
fixtures, a scripted-model agent builder, and the turn/decision harness. Keeps specs focused on
*what* to assert, not *how* to bootstrap.

These are **test infrastructure**. They contain no banking/security business logic — they wire up the
real modules and drive them. `db.ts` and `fixtures.ts` are **implemented** (they really reset + seed the DB);
`faux-agent.ts`/`scenario.ts` are **implemented** (they really build a scripted Pi `Agent` and drive real turns/decisions).

## API Surface

Import from the barrel (`../helpers`) or a specific module.

- `db.ts` — test-database lifecycle:
  - `getTestPrisma(): PrismaClient` — the Prisma singleton bound to the test DB (`@/lib/db/client`).
  - `ensureTestPragmas(): Promise<void>` — apply the fast SQLite PRAGMAs (`journal_mode=WAL`,
    `synchronous=NORMAL`, `busy_timeout=10000`) ONCE per process (memoized). Called by both
    `truncateAll()` and `seedDemoData()`, so it holds on every entry path.
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
- `prisma-cli.ts` — Node-built-ins-only shared Prisma CLI/generate plumbing (NOT in the `index.ts`
  barrel; specs must not import it — only `../setup.ts` and `../e2e/helpers.ts` do):
  - `resolveRepoRoot`/`resolvePrismaBin`/`resolveTsxBin`/`cliCommand` — locate the repo + the
    project-local Prisma/tsx binaries and build a directly-launchable invocation.
  - `runCliStepCaptured(command,args,opts): CliStepResult` — the NON-throwing spawn primitive.
  - `runCliStep(command,args,opts): string` — fail-loud wrapper: success = EXIT CODE 0; on failure
    throws the FULL captured stdout+stderr (`diagnosticCliOutput`) + spawn error.
  - `diagnosticCliOutput` / `spawnErrorText` / `removeSqliteFiles` — render CLI output (tail preserved),
    render a spawn failure, delete a SQLite file + sidecars (missing = fine).
  - `provisionSchemaLadder(opts): void` — provision a SQLite schema through an ORDERED LADDER of
    `prisma db push` invocation shapes (`PushRung`/`ProvisionSchemaOptions`): each rung runs ONLY after
    the previous FAILED, the `dbFiles` (+ sidecars) are deleted via `removeSqliteFiles` before EVERY
    rung, and `afterPush` (e.g. a usability probe + seed) is treated like part of the rung. On TOTAL
    failure it THROWS one error embedding EVERY rung's FULL output + environment diagnostics
    (`DATABASE_URL`, cwd, project-local Prisma CLI path, `prisma -v`, `@prisma/engines/schema-engine*`).
  - `prismaClientUsable`/`prismaClientGenerated`, `runPrismaGenerate`, `ensurePrismaClientGenerated` —
    the client self-bootstrap (readiness gate = the USABILITY probe, not artifact presence).
- `scenario.ts` — drive a full session turn + human decision:
  - `runTurn({sessionId,message,agent}): Promise<ScenarioResult>` — send a message, collect events.
  - `confirmAction(agent,actionId)` / `verifyAction(agent,actionId,code)` / `cancelAction(agent,actionId)` — human decision + narration.
    - Authorizes via `securityGateway.authorizeAction` / `cancelAction`, passing the action's real owner `{ userId: DEMO_USER_ID, sessionId: agent.sessionId ?? 'sess' }` (required; a missing/mismatched identity is refused with `SECURITY_DENIED`).
    - The post-authorize audit row records the EFFECTIVE `auth.tier` / `auth.requiresMfa` (a YELLOW transfer can escalate to RED at execution time); the cancel audit row keeps the parked `action.tier` / `action.requiresMfa`.
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

## Fast test-DB path (why the suite is fast — do not remove)

The test SQLite runs on a deliberately fast configuration; the whole `resetDatabase()` cycle is a few
ms and the full suite finishes in well under a minute. If any of these is dropped, commits fall back
to fsync and the suite balloons toward the 10-minute tool timeout:

- `ensureTestPragmas()` in `db.ts` sets `journal_mode=WAL` + `synchronous=NORMAL` + `busy_timeout=10000`.
  `journal_mode=WAL` is **persistent on the DB file**; `synchronous`/`busy_timeout` are **per-connection**.
- `tests/setup.ts` pins the runtime `DATABASE_URL` to `?connection_limit=1`, so the pool has a SINGLE
  connection and the per-connection pragmas above apply to EVERY query. Without it, Prisma opens extra
  pooled connections that keep the default `synchronous=FULL`, and after the pool grows every write
  stalls ~2s (the DB-backed specs run ~10× slower).
- `PRAGMA foreign_keys` is enforced; truncate order stays FK-safe (children → parents).

## Routing Table

- `./db.ts` → test-DB lifecycle (reset / truncate / connect / fast pragmas)
- `./fixtures.ts` → canonical demo dataset + seeder
- `./faux-agent.ts` → scripted-model Agent builder
- `./scenario.ts` → turn/decision harness + event collection
- `./prisma-cli.ts` → shared Prisma CLI/generate plumbing + the ORDERED provisioning ladder (`provisionSchemaLadder`), used by `../setup.ts` and `../e2e/helpers.ts` only (NOT in the barrel)
- `./index.ts` → barrel re-exports
- `../setup.ts` → provisions the schema (via the shared ladder) + points `DATABASE_URL` at the test SQLite, incl. `?connection_limit=1` (sibling — this node)

## Notes for Agents

- Every DB-backed suite should start with `useFreshDatabase()` so each test runs against a known world.
- `fauxProvider()` (from `@earendil-works/pi-ai`) supplies a per-test handle; register `handle.provider` in `createModels()` and pass its bound `streamSimple` as Agent `streamFn`. No global registration or unregister step. See the root
  `CONTEXT.md` "Pi Agent Integration" for the Agent/tool/`beforeToolCall` SDK facts.
- The circuit breaker is in-process keyed by `sessionId` — always use a unique id per test.
- Need a fast/reliable suite? Keep the "Fast test-DB path" invariant intact — do NOT remove the
  pragmas or the `connection_limit=1` URL, and do NOT weaken isolation to gain speed.
