# scripts — deployment entrypoints

## Intent

Small, tsx-run Node scripts that back the SUPPORTED `package.json` deployment commands. They exist so
the documented deploy path runs with the right process environment rather than relying on the caller's
shell — most importantly the Prisma **schema-engine log level**, whose ambient value silently changes
Prisma's error reporting.

## API Surface

- `db-push.ts` — backs `npm run db:push` (and `npm run db:reset`). Runs `prisma db push` through the
  project-local Prisma CLI with `RUST_LOG=info` + `RUST_BACKTRACE=1` pinned for the schema-engine child
  (shared pinning logic, in the non-test module `../lib/prisma-cli-env.ts#SCHEMA_ENGINE_RUST_LOG` /
  `pinSchemaEngineLogging`). Resolves the local Prisma CLI (falling back to `npx` only when the local
  binary is absent), forwards every extra CLI arg (`process.argv.slice(2)`), inherits stdio and exits
  with the child's exit code. On a MISSING SQLite file it self-provisions the database — no manual DB
  creation, no readiness marker, no skip flag.

## Commands

- `npm run db:push` → `tsx scripts/db-push.ts` — create/apply the schema to `DATABASE_URL`.
- `npm run db:reset` → `tsx scripts/db-push.ts --force-reset && tsx prisma/seed.ts` — wipe + reseed.
- `npm run db:seed` → `tsx prisma/seed.ts` — seed the demo data.

## Deployment ordering (REQUIRED)

`db push` → `db:seed` → `build`.

`next build` PRERENDERS routes that query SQLite, so a READY, SEEDED database must exist BEFORE the
build. Running `build` against a missing/empty dev DB fails during prerender. A from-scratch deploy is
therefore:

1. `npm install`
2. `npm run db:push` (creates `prisma/dev.db` when absent) — add `npm run db:seed` for demo data
3. `npm run build`
4. `npm run start`

## Constraints

- Node built-ins only in these scripts (plus the shared `../lib/prisma-cli-env` helper); no `@/` alias,
  no business logic. They are process-deployment glue, not app code.
- NEVER spawn the Prisma CLI without the pinned schema-engine log level — an ambient `RUST_LOG` at/above
  `warn` makes a cold `db push` fail with an opaque EMPTY `Error: Schema engine error:`.
- Reuse `lib/prisma-cli-env.ts` (pinning policy + binary resolution); never re-implement or duplicate it.
- Keep the `db push` → `db:seed` → `build` ordering in mind when adding a deployment command.
