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
- `repositories/` — one module per aggregate, each exporting typed async finders / creators / updaters /
  aggregates (see `repositories/CONTEXT.md`).

## Constraints

- Repositories are the sole Prisma touchpoint — never import `prisma` elsewhere.
- Repository reads return Prisma model rows; JSON-text columns remain `string | null` (parse with `lib/json`).
  Writes that accept structured payloads serialize via `toJson`.
- Money columns are `Float` CNY; never do raw float arithmetic here beyond simple persistence.
- No business rules (permissions, limits, risk) live here — those belong to `security/` / `banking-sdk/`.
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
