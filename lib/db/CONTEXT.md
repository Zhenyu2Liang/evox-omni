# lib/db — Prisma data access

## Intent

The Prisma client singleton and the repository layer. This is the **only** subtree allowed to import
`@prisma/client` / `prisma`. Every other module (`banking-sdk`, `agent`, `planner`, `security`, `audit`,
`app`) persists and reads through these repositories. Owned by `./lib`.

## API Surface

- `client.ts` — `resolveDatabaseUrl()` and the `prisma` `PrismaClient` **singleton** (also default-exported).
  Cached on `globalThis` so Next.js HMR does not open a new connection pool per reload. Constructed with an
  explicit `datasources.db.url` fallback so it works without `.env`. Right after construction it best-effort
  applies the SQLite pragmas `journal_mode = WAL` + `busy_timeout = 10000` (fire-and-forget, never throws at
  import time) so concurrent `$transaction` writers WAIT on the write lock instead of failing with `SQLITE_BUSY`
  — required by the atomic transfer-limit claim in `security/security-gateway.ts`. `tests/helpers/db.ts` sets
  the same pragmas for the test DB.
  **URL resolution (important for isolated-DB setups):** `resolveDatabaseUrl()` returns
  `process.env.DATABASE_URL` **verbatim** when set, else `'file:' + path.join(process.cwd(), 'prisma', 'dev.db')`.
  There is **no `dotenv` anywhere in `lib`** (nor in the repo) — the only implicit `.env` loading is done by
  Next.js's own env loader at dev/build start (and by the Prisma CLI for its own commands). The cwd-based
  fallback means any process (e.g. the e2e `next dev` child, or `tsx prisma/seed.ts`) reaches the shared
  `prisma/dev.db` only when run with cwd = repo root **and** `DATABASE_URL` unset; setting `DATABASE_URL`
  (absolute `file:` URL) in a child process's env is what redirects BOTH the Prisma CLI and the runtime client
  to an isolated DB — proven by `tests/setup.ts` redirecting `prisma db push` to `prisma/test.db`.
- `repositories/` — one module per aggregate, each exporting typed async finders / creators / updaters /
  aggregates (see `repositories/CONTEXT.md`).
  Also carries the concurrency-safety primitives: the `PendingAction` → (`taskId`,`nodeId`) plan link persisted at creation, per-action / plan-level revocation helpers, per-plan / per-node live-execution claim + release CAS helpers keyed by `executionToken`/`executionClaimedAt`, and the `nodeExecutionKey` idempotency key for node side effects.
  **Transaction composability**: every function in `repositories/pendingAction.ts` takes an optional trailing
  `client: Prisma.TransactionClient = prisma` (default = the `client.ts` singleton) and routes ALL of its DB
  access through it, so a caller can compose its readers / CAS transitions / bulk plan-cancel into ONE
  `prisma.$transaction` (the cancel/authorize flow depends on this so a plan-cancel and a concurrent
  authorization CAS cannot interleave). All other aggregates take no `client` and use the singleton.

## Constraints

- Repositories are the sole Prisma touchpoint — never import `prisma` elsewhere.
- Repository reads return Prisma model rows; JSON-text columns remain `string | null` (parse with `lib/json`).
  Writes that accept structured payloads serialize via `toJson`.
- Money columns are `Float` CNY; never do raw float arithmetic here beyond simple persistence.
- No business rules (permissions, limits, risk) live here — those belong to `security/` / `banking-sdk/`.
- The optional `client: Prisma.TransactionClient` parameter is allowed **only** in `repositories/pendingAction.ts`;
  its default must remain the `../client` singleton. Do not convert its single-statement `claim*`/`revoke*`
  CAS primitives into read-modify-write logic.
- Keep files ≲ ~1000 lines.

## Routing Table

- `./lib/db/repositories` → per-aggregate repositories + `index.ts` namespace barrel.

## Notes for Agents

- All repository bodies are implemented (real Prisma data access; no stubs remain).
- `npx prisma generate` must run before any code using `prisma` is executed or type-checked.
- Issue PRAGMAs with `$queryRawUnsafe`, never `$executeRawUnsafe`: a PRAGMA returns a result row and Prisma's
  SQLite driver rejects an `execute` that returns rows (`Execute returned results, which is not allowed in
  SQLite`), so the statement would silently do nothing.
- `journal_mode = WAL` is persistent on the DB file; `busy_timeout` is **per-connection**, so on a pooled
  SQLite datasource a single PRAGMA only raises it for the connection that ran it (Prisma's own default is 5s;
  `?connection_limit=1` makes it pool-wide).
- The SQLite schema (17 models) lives in `prisma/schema.prisma` and is frozen; enum-like fields are `String`,
  money is `Float`, JSON payloads are JSON text in `String`.
- The `pendingAction` claim/ownership spec lives at `tests/unit/lib/pendingAction.claim.test.ts` (root-owned)
  and is auto-discovered by the root `vitest.config.ts` (`include: ['tests/**/*.{test,spec}.ts']`) via `npm run test`.
  There is no in-tree `lib/db` test runner, config, or `__tests__/` directory.
