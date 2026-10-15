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
- `client.ts` exposes the process-wide `prisma` singleton, `DbClient`, `dbClient()`, and factory/URL
  exports. Development caches the singleton on `globalThis` for Next.js HMR. `dbClient()` returns the
  current transaction handle when present, otherwise the singleton. A read inside an existing
  transaction must use that transaction; the single connection cannot run a second global query while
  its transaction owns the connection.
- `unit-of-work.ts` carries the transaction handle through `AsyncLocalStorage`. Explicit banking
  execution boundaries compose business changes, receipts, audits and invocation status in one
  transaction.
- `repositories/` contains aggregate readers, mutations, runtime leases and compare-and-set claims.
  See `repositories/CONTEXT.md`. Repository functions may accept an explicit `DbClient` or
  `Prisma.TransactionClient` for atomic composition. Preserve identity checks and conditional writes;
  do not replace claims/revocations with separate read-modify-write statements.

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
- Keep database modules server-only. Type-only imports may reference generated types, but client UI
  code must not import the Prisma constructor, singleton or adapter.
- Do not issue import-time, fire-and-forget SQLite configuration queries. Connection configuration
  belongs in the adapter's awaited `connect()` method.
- Keep files below approximately 1000 lines and separate persistence from business rules.

## Routing Table

- [repositories/](repositories/CONTEXT.md) → aggregate queries, commands and durable runtime claims.
- [schema.prisma](../../prisma/schema.prisma) → persisted schema and generator output.
- [prisma.config.ts](../../prisma.config.ts) → Prisma CLI configuration.
- [prisma-cli.ts](../../tests/helpers/prisma-cli.ts) → generated-schema freshness and factory-construction probes.

## Notes for Agents

Use the configured isolated database for tests, never reset `prisma/dev.db`. Native SQLite clients
must disconnect before deleting their database file or sidecars. Prisma 7 has no `connection_limit`
URL option; the adapter owns its one connection. Run checks through the root pnpm scripts; this
subtree has no separate test runner.
