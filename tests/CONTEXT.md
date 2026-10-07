# tests — Demo acceptance and regression suite

## Intent

Keep the competition Demo reproducible and its important safety guarantees executable.
Only the model is scripted (LLM_MODE=mock); app routes, gateway, planner, SDK and SQLite are real.
These tests do not prove live-model quality, real MFA or production-bank readiness.

## Layout

- unit/: security policy, risk, MFA, breaker, planner, SDK and agent primitives.
- scenarios/: the 12 Demo scenarios plus mock-mode integration.
- app/: real Next.js route-handler integration, including manual handoff; in-process, not browser E2E.
- integration/: maintained cross-module regressions grouped by feature; see integration/CONTEXT.md.
- deploy-db-push.test.ts: the real isolated-database deployment entrypoint.
- helpers/: shared fixtures, DB reset and Prisma CLI helpers.
- setup.ts: generated-client readiness and isolated database provisioning.
- e2e/: separate real Chrome acceptance, not collected by Vitest.

Historical duplicate review probes are removed; maintained suites cover their invariants.
Do not recreate round/commit-specific copies or commit generated test logs.

## Commands

    npm run test
    npm run test -- tests/unit
    npm run test -- tests/scenarios
    npm run test -- tests/app tests/integration
    npx tsc --noEmit
    npx tsx tests/e2e/acceptance.e2e.ts

## Constraints

- DB suites use prisma/test.db and helpers/db.resetDatabase(). Browser acceptance uses prisma/e2e.db.
  Never reset or seed a developer's existing DB.
- fileParallelism: false is required: suites share a test DB and must not race resets.
  Run browser acceptance separately; deployment isolation tests inspect shared DB files.
- Use a unique session per test to isolate the process-local breaker and confirmation registry.
- Use real assertions through public facades/routes. Do not weaken them, skip failures or duplicate
  business logic to pass. Shared contracts come from lib/contracts.
- Use explicit barriers and bounded timeouts for concurrency. The Demo business clock is fixed;
  execution leases deliberately use real time.
- Only DB-free suites may use VITEST_SKIP_DB_SETUP=1; many security/SDK unit tests require SQLite.
- Test helpers depend on lib/prisma-cli-env.ts, never the reverse.
- Label browser validation separately from route integration and report actual results.

## Provisioning

setup.ts checks a usable generated Prisma Client before DB access. The schema-hash marker in
prisma/.test-db-provisioned prevents stale schema reuse; provisioning errors fail loudly.
helpers/prisma-cli.ts owns isolated SQLite cleanup and the provisioning ladder, sharing RUST_LOG=info
with scripts/db-push.ts. WAL and connection limits are infrastructure, not authorization guarantees.

## Known boundaries

The model, bank and MFA are simulated. Concurrency uses one process and SQLite; multi-instance
contention and real bank integrations are unverified. Browser acceptance is local Chrome, not a
cross-browser, accessibility or performance matrix.
