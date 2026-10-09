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
- e2e/: separate real Chrome acceptance, not collected by Vitest. Also holds the LIVE DeepSeek
  acceptance harness (live-acceptance.e2e.ts, run via `npx tsx`) and its current-state findings
  (LIVE-ACCEPTANCE-REPORT.md); evidence PNGs under e2e/screenshots/live/ (dir `.gitignore` is `*`,
  force-add). Live runs need `.env.local` (gitignored) + an isolated prisma/live-acceptance.db.

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

## Notes for Agents — hallucination-guard / narration-grounding coverage

- Assertions that constrain the assistant's NARRATION text (grounding / "no invented success or
  balance") are scattered, not centralized:
  - MODEL-GENERATED (mock/scripted model text): `scenarios/mock-integration.test.ts` (real mock
    model), `scenarios/test-01-balance.test.ts`, `unit/agent/providers/provider-mock.test.ts`
    (failure + blocked-gated narration, `not.toMatch(/已成功|已完成|已执行|转账成功/)`),
    `unit/agent/providers/plan-limit-park.test.ts` (`¥1,500.00`), `e2e/acceptance.e2e.ts`
    (scripted success-lead literal `转账处理结果：`, positive + wrong-MFA negative).
  - SERVER-SIDE outcome text (NOT model prose): `unit/agent/run-turn-failure.test.ts`
    (`outcome.message`), `integration/recovery-authorization.test.ts` (`data.message`).
  - Injected tool-result text: `unit/agent/run-turn-failure.test.ts` (`text === FAILURE_TEXT`,
    `not.toContain('成功'/'操作完成')`), `unit/agent/message-normalize.test.ts`.
- A SERVER-AUTHORED grounding guard now exists: `agent/grounding.ts#groundAssistantText` structurally
  compares the assistant's terminal text against the turn's REAL tool results
  (`agent/grounding-facts.ts#buildFinancialFacts`) and REPLACES an inconsistent message with a
  server-authored correction; `agent/run-turn.ts#TurnBuffer` buffers until `message_end` so a wrong
  fact is never streamed before the correction. `integration/grounding-regression.test.ts` pins it
  through the REAL `runTurn`/`resumeTurn` pipeline (faux provider via `RunTurnDeps.provider`): no-tool
  false success, checking/savings balance mismatch, budget-vs-transfer conflation, wrong
  recipient/amount, unknown-outcome wording (待核对), mixed + English false-success phrasings, a
  model-forged `（系统校正）` tag (informational only — NOT a skip key), and streamed/final/persisted
  consistency. Anti-fabrication is ALSO enforced structurally (a gated tool cannot execute ⇒ no DB
  write / `tool_end:blocked`), which alone does NOT constrain narration wording — the guard does.
  `unit/agent/run-turn-failure.test.ts` guards the injected tool-result text; `scenarios/test-05` +
  `mock-integration` guard the failing-transfer success-phrase regexp (`/已向.*转账|转账成功|已成功转出/`).
  cross-checks financial figures against the ledger/tool result. Anti-fabrication is enforced
  structurally (a gated tool cannot execute ⇒ no DB write / `tool_end:blocked`), which does NOT
  constrain narration wording. `unit/agent/run-turn-failure.test.ts` guards only the injected
  tool-result text; `scenarios/test-05` + `mock-integration` guard only the failing-transfer
  success-phrase regexp (`/已向.*转账|转账成功|已成功转出/`).
- NUANCE: many `decision.text` / `res.text` assertions in `scenarios/` are satisfied by the
  helper-seeded factual fallback `narrationFor(result)` in `helpers/scenario.ts` (echoes the real
  tool result when the faux script queue is dry), NOT by model output — they cannot detect a
  hallucinating model. See `scenarios/CONTEXT.md`.
- `agent/system-prompt.ts#HALLUCINATION_RULE` / `buildSystemPrompt` has NO test anywhere; the only
  test-tree reference is `helpers/faux-agent.ts` (builds the agent; never asserted).
- `unit` has a spec for provider/mock narration but no spec for `agent/system-prompt.ts`.
