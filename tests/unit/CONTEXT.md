# tests/unit — pure & logic unit specs

## Intent

Fast, focused unit tests for the deterministic cores of the system — the parts that decide risk,
order a plan, or enforce a domain invariant. These run **without the LLM** and, where possible,
**without a DB**, so they are the tightest, most reliable correctness net.

Current status: **fully implemented** — real assertions throughout; no `it.todo` remains.
DB-backed cases use the test SQLite via `../helpers/db`; the rest need no DB or LLM.
Specs stay load-safe (no top-level Prisma construction outside DB-backed cases).

## API Surface

Grouped by the source module under test (mirrors the source tree). Every spec is auto-discovered by
the root `vitest.config.ts` (`include: ['tests/**/*.{test,spec}.ts']`), so a plain `npm run test`
runs them all — no scoped config is required for any of them.

- `security/` (16 specs) — `permission-engine`, `risk-engine`, `risk-engine-rerisk`, `gateway`,
  `gateway-audit-trail`, `authorize-hardening`, `authorize-concurrency`, `recipient-resolution`, `injection-guard`,
  `circuit-breaker`, `circuit-breaker-audit`, `circuit-breaker-reset`, `mfa`, `mfa-audit`,
  `risk-engine-dedup` (pure, DB-free: dedups the in-flight transfer total via `computeInFlightTransferTotal`,
  excluding parked transfers whose ledger `Transaction` row already exists), `transfer-limits-concurrency`.
  `authorize-concurrency` proves the concurrent-confirm exactly-once claim **and** execution-time
  re-risk of a stale parked transfer end-to-end through the REAL `@/agent` `confirmAction`/
  `verifyAction` façade (needs a persisted session).
- `planner/` (5 specs) — `dag` (validate / topological order / readiness / conditions / `buildPlan`),
  `executor` (`runPlan` node-state machine + `PlanControls`), `executor-claim-scope` (DB-backed: exactly-once node-executor
  claim by the stable `(taskId,nodeId)` identity via `claimNodeExecution`/`releaseNodeExecution`; a
  second separate `runPlan` of the same node loses the claim, writes nothing, and halts - NO in-process
  Map), `executor-execution-right` (DB-backed: a rotated plan token makes the superseded "zombie" run perform ZERO tool calls/writes and publish no stale settlement, while a committed node success survives), `lifecycle` (durable persisted-plan
  `pausePlan`/`cancelPlan`/`retryPlan`/`resumePlan`).
- `banking-sdk/` (6 specs) — `transfer`, `subscription`, `investment` (domain invariants), and
  `atomicity` (ledger-write rollback + concurrent overspend / double-redeem through the real tx), and
  `idempotent` (the shared at-most-once CREATE helper: same key replays exactly ONE row for both
  `reserveBudget` and `createScheduledTask`; absent key keeps legacy create-a-row behavior), and
  `transfer-receipt` (COMMITTED-FACT / execution-receipt replay: same key+request replays the ORIGINAL
  result, a different request → `CONFLICT`, a legacy receipt-less ledger row is recognized, a fresh miss
  → `NOT_FOUND`).
- `agent/` (6 specs + `providers/` 4 specs) — end-to-end confirmation-flow audit specs against the real DB +
  gateway + `@/agent`: `confirmation-idempotency`, `confirmation`, `message-normalize` (`withRealToolResult` restores the REAL result over a stale parked `等待确认`), `task-control`, `task-cancel-revokes`, `run-turn-failure` (continuation failure never rephrased as success);
  `providers/provider-mock.test.ts` is the DB-free `mock-responder` spec (incl. honest failure /
  not-yet-executed narration); `providers/provider-live.test.ts` is the pure model-resolution spec and
  `providers/provider-runtime.test.ts` the explicit-provider runtime spec.
  `providers/plan-limit-park.test.ts` pins the mock `submit_plan` gated conditional plan
  (analyze -> check -> setlimit) that PARKS in `waiting_confirmation`, then confirms.
- `lib/` (5 specs) — `pendingAction.claim.test.ts` — `lib/db/repositories/pendingAction`: the atomic,
  ownership-aware persistence primitives (`claimPendingAction` exactly-once `pending → confirmed`,
  the `from`-set match, `userId`/`sessionId` scoping, `setPendingActionStatus` +
  `getPendingActionOwnership`). DB-backed. Plus `ledger-keys.test.ts` - pure: `lib/ledger` de-dup-scope
  identity keys (`nodeExecutionKey` = `nxe:<taskId>:<nodeId>`, plan/node-scoped so two DIFFERENT plans
  never merge while the SAME (task,node) always dedupes; `idempotentTransferTxId` = `txidem_` + first 32
  hex of sha256 over `<userId>` + NUL + key). Plus `execution-receipt.test.ts` (pure: `executionReceiptId` + canonical `requestDigest`), `prisma-cli-env.test.ts` (pure: schema-engine `RUST_LOG` pin policy), and `contact.search.test.ts` (DB-backed: `contact#searchContacts` masked phone/name resolution).

Each spec imports the module under test directly from its `@/…` façade path
(e.g. `@/security`, `@/planner`, `@/banking-sdk`, `@/agent`, `@/lib/db/repositories/pendingAction`)
— no commented-out placeholders remain.

## Constraints

- Pure where possible: no network, no real clock (`now` is injected), no LLM. DB-backed cases
  (`computeDailyTransferTotal`, gateway persistence, MFA challenges, SDK invariants, PendingAction
  claims) use the test SQLite via `../helpers/db` and are annotated as such in their file header.
- EXCEPTION to "no real clock": the SECURITY-only cooldown gate (`security/circuit-breaker.ts`) uses the
  REAL wall clock (`realNow()`), so its specs (`security/circuit-breaker-reset` / `-persistence`) derive
  the boundary from the persisted `lockedAt` and also exercise the DEFAULT server clock — never the demo clock.
- **Unique `sessionId`** for any breaker-related case.
- Import frozen types from `@/lib/contracts/*`; never redeclare. Assert through public facades
  (`@/security`, `@/planner`, `@/banking-sdk`, `@/agent`).
- Do not weaken determinism (fake timers, shared state) to pass — use the injected seams.

## Routing Table

- `./security` → permission/risk/gateway/authorization/injection/circuit-breaker/MFA unit specs
- `./planner` → DAG + executor + durable lifecycle unit specs (incl. `executor-claim-scope` → exactly-once node claim)
- `./banking-sdk` → transfer/subscription/investment domain invariants + money-movement atomicity + idempotent-CREATE replay
- `./agent` → end-to-end confirmation-flow / task-control / provider specs (real DB + gateway + `@/agent`)
- `./lib` → `PendingAction` atomic-claim persistence primitives + pure `lib/ledger` de-dup-scope identity keys
- `../helpers` → shared utilities (db/fixtures) used by DB-backed unit cases (sibling — this node)
