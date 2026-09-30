# lib/db — Prisma data access

## Intent

The Prisma client singleton and the repository layer. This is the **only** subtree allowed to import
`@prisma/client` / `prisma`. Every other module (`banking-sdk`, `agent`, `planner`, `security`, `audit`,
`app`) persists and reads through these repositories. Owned by `./lib`.

## API Surface

- `client.ts` — `resolveDatabaseUrl()` and the `prisma` `PrismaClient` **singleton** (also default-exported).
  Cached on `globalThis` so Next.js HMR does not open a new connection pool per reload. Constructed with an
  explicit `datasources.db.url` fallback so it works without `.env`.
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

- Stubs currently `throw new Error('not implemented')` — implementation is delegated in Phase 2.
- `npx prisma generate` must run before any code using `prisma` is executed or type-checked.
- The SQLite schema (17 models) lives in `prisma/schema.prisma` and is frozen; enum-like fields are `String`,
  money is `Float`, JSON payloads are JSON text in `String`.
