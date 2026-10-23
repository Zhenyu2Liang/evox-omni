# lib/db — Prisma data access

## Intent

Own the generated-client facade, native SQLite client factory, shared singleton, transaction scope,
and aggregate repositories. Business permissions and risk rules belong to `security/` and
`banking-sdk/`. Consumers must not create their own database clients.

## API Surface

- `prisma.ts` re-exports `generated/client`. Import model types and the runtime `Prisma` namespace
  through `@/lib/db/prisma`; use `import type` for type-only consumers. Standalone scripts use relative
  imports. Prisma 7 uses the `prisma-client` generator with explicit output `lib/db/generated`.
- `url.ts#resolveDatabaseUrl(url?, repoRoot?)` is shared by `prisma.config.ts` and the runtime factory.
  Explicit URLs override `DATABASE_URL`; an unset URL selects `file:./dev.db`. Relative file paths
  resolve against `<repoRoot>/prisma`, so the default is `prisma/dev.db`. The result is an absolute file
  URL; `file::memory:` is retained for isolated probes. Only SQLite file URLs are accepted.
- `database.ts#createDatabaseClient(url?)` creates the Prisma client with
  `@prisma/adapter-better-sqlite3`. Each client owns one native SQLite connection. The adapter reads
  64-bit integers as `bigint` and preserves DateTime encoding with `timestampFormat: 'unixepoch-ms'`.
  Connection setup enables `foreign_keys = ON` and `journal_mode = WAL` before application statements.
  Native lock waiting, transaction queue waiting and transaction execution each have a 10-second limit.
  Do not replace this factory with a bare constructor or the removed datasource constructor options.
- `serialized-connection.ts#serializeSqliteConnection(connection)` wraps that single native connection in a FIFO `ConnectionMutex`: every `queryRaw`/`executeRaw`/`executeScript`/`dispose` takes the lock, and `startTransaction` holds it for the WHOLE interactive transaction (the transaction handle's own statements bypass the mutex; `commit`/`rollback` release it). The queue has no deadline — `acquire()` is `await previous` on an unbounded promise chain (`:9-16`).
- `client.ts` exposes the process-wide `prisma` singleton, `DbClient`, `dbClient()`, and factory/URL
  exports. Development caches the singleton on `globalThis` for Next.js HMR. `dbClient()` returns the
  current transaction handle when present, otherwise the singleton. A read inside an existing
  transaction must use that transaction; the single connection cannot run a second global query while
  its transaction owns the connection.
- `serialized-connection.ts#serializeSqliteConnection` wraps the ONE native connection in a FIFO promise-chain mutex: every `queryRaw` / `executeRaw` / `executeScript` / `dispose` call acquires it, and `startTransaction` HOLDS it from BEGIN until `commit` / `rollback`, so an ordinary statement issued while another request's interactive transaction is open WAITS with no mutex timeout (bounded only by Prisma's `maxWait` / `timeout`). The mutex is PER CLIENT INSTANCE — independent clients do not share it and contend on native SQLite locks instead. Statements inside a transaction deliberately skip it ("Transaction statements already own the connection lock and must not acquire it again"). The mutex has NO queue-depth limit, NO timeout and NO cancellation: `acquire()` (`:9-16`) takes its FIFO slot synchronously (`this.tail = new Promise(...)` runs before `await previous`) and resolves only when the current holder calls the release returned at `:15`. Prisma model queries reach the adapter through `queryRaw`, so EVERY statement of EVERY request in one process queues on this single mutex. Divergence from `maxWait` / `timeout`: those two limits apply to interactive transactions only — a plain (non-transactional) statement queued behind another request's open transaction has no upper bound at all, and a transaction handle that is never committed or rolled back (`startTransaction` releases only inside the `commit`/`rollback` `finally` blocks at `:49-50`) holds the lock for the life of the process.
- There is no per-query `$queryRaw` / PRAGMA / schema round trip and no transaction retry loop (no `P2034` / `P1008` handling, no sleeps) in this layer: the only PRAGMAs run once per connection inside the adapter's awaited `connect()`.
- `unit-of-work.ts` carries the transaction handle through `AsyncLocalStorage`. Explicit banking
  execution boundaries compose business changes, receipts, audits and invocation status in one
  transaction.
- `repositories/` contains aggregate readers, mutations, runtime leases and compare-and-set claims.
  See `repositories/CONTEXT.md`. Repository functions may accept an explicit `DbClient` or
  `Prisma.TransactionClient` for atomic composition. Preserve identity checks and conditional writes;
  do not replace claims/revocations with separate read-modify-write statements.

## Wait, lock and timeout facts

- `timeout: 10000` (`database.ts:23`) is the adapter's busy-wait passed to better-sqlite3 (10 s `busy_timeout` equivalent); no `PRAGMA busy_timeout` is issued in this layer, and `PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;` runs ONCE in `connect()` (`database.ts:12`) — there is no per-call PRAGMA round trip.
- `transactionOptions: { maxWait: 10000, timeout: 10000 }` (`database.ts:25`) is the only transaction budget; transaction callbacks do not pass their own `maxWait`/`timeout`/`isolationLevel`, so every interactive transaction inherits 10 s.
- `maxWait` does NOT bound a wait that happens inside `startTransaction` (the mutex): the engine has already checked out the connection, so the real bound there is the unbounded mutex chain above.
- One client = one native connection + one mutex: a second transaction on the same client waits for the first to commit or roll back, and a plain (non-transaction) statement queues behind any open transaction.
- Default-client asymmetry: repositories defaulting to `dbClient()` join the ambient `withinTransaction` scope; those defaulting to the global `prisma` (`repositories/pendingAction.ts`, `repositories/circuitBreaker.ts`) always queue on the mutex, even inside a unit of work.
- `repositories/pendingAction.ts#claimPendingAction` fails fast — one `updateMany`, `Promise<boolean>`, no retry — except for `to === 'confirmed'` on the global client, where it opens a fresh interactive transaction (`assertActionMayStart`: one no-op writer lock + two reads, then the CAS).
- No retry, sleep, poll or busy-error helper exists anywhere under `lib/db`: no `SQLITE_BUSY` / `P2034` / "database is locked" matching, no `setTimeout`/`setInterval`.

## Constraints

- Generated code is ignored by Git. Run `pnpm db:generate` before type checking, building, or executing
  code that imports the client. `pnpm db:push` changes the database schema but does not generate code.
- `prisma.config.ts` owns CLI schema location, datasource URL and seed command. The schema declares
  `provider = "sqlite"` without an inline datasource URL. CLI and independent scripts use the
  application's environment loader without printing configuration values.
- Repository reads return generated model rows. JSON-text columns remain `string | null`; parse them
  with `lib/json`. Structured writes serialize with `toJson`.
- Booked money uses signed `BigInt` minor units. Rates, quantities and unrounded valuations use
  canonical decimal strings. Never coerce financial values through floating-point arithmetic.
- Enum-like fields are schema `String` fields; application contracts define allowed values.
  `PendingAction` status filters use the lists in `../contracts/security.ts`
  (`OPEN_` / `TERMINAL_` / `SETTLED_` / `RUN_BLOCKING_PENDING_ACTION_STATUSES`); never compare status
  literals locally.
- Keep database modules server-only. Type-only imports may reference generated types, but client UI
  code must not import the Prisma constructor, singleton or adapter.
- Do not issue import-time, fire-and-forget SQLite configuration queries. Connection configuration
  belongs in the adapter's awaited `connect()` method.
- Keep files below approximately 1000 lines and separate persistence from business rules.

## Routing Table

- [repositories/](repositories/CONTEXT.md) → aggregate queries, commands and durable runtime claims.
- [../contracts/task.ts](../contracts/task.ts) → `TaskNodeResult` / `TaskNodeSpec` / `TaskPlan` transport types
  (a result carries `id`, `name`, `status`, `tool`, `output`, `error`, `startedAt`, `endedAt`,
  `compensation`; there is no `summary` field and no `summary` column).
- [../../agent/workflows/persistence.ts](../../agent/workflows/persistence.ts) → the planner
  persistence ports (`persistPlan` / `persistNode` / `loadPlan`) that write `AgentTask` +
  `AgentTaskNode` rows over these repositories, plus the `toTaskPlan` read-back mapping.
- [schema.prisma](../../prisma/schema.prisma) → persisted schema and generator output.
- [prisma.config.ts](../../prisma.config.ts) → Prisma CLI configuration.
- [prisma-cli.ts](../../tests/helpers/prisma-cli.ts) → generated-schema freshness and factory-construction probes.

## Notes for Agents

Use the configured isolated database for tests, never reset `prisma/dev.db`. Native SQLite clients
must disconnect before deleting their database file or sidecars. Prisma 7 has no `connection_limit`
URL option; the adapter owns its one connection. Run checks through the root pnpm scripts; this
subtree has no separate test runner.
