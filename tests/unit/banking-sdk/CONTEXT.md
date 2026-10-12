# tests/unit/banking-sdk — domain-invariant unit specs

## Intent

Prove the Banking SDK enforces its **domain invariants** (independent of the security policy): fund
sufficiency, product `minAmount`, recipient resolution & ambiguity, legal state transitions,
**money-movement atomicity** (a failed second write rolls the first back; concurrent money moves
cannot overspend or double-credit) and **at-most-once (idempotent) CREATE** replay.
These run against the test SQLite via `../../helpers/db` + `../../helpers/fixtures`.

## API Surface

Spec files (implemented — real assertions against the test SQLite), targeting `@/banking-sdk` (`banking.<domain>.*`):

- `transfer.test.ts` — `banking.transfer.createTransfer(input)`: funds invariant (¥200, 23580→23380),
  recipient resolution by `contactId`/`phone`/`name`, ambiguous name → `CONFLICT` (`detail.candidates`),
  unknown → `NOT_FOUND`, short funds → `INSUFFICIENT_FUNDS`, bad amount → `VALIDATION`,
  remark/amount fidelity, `sourceAccountId` default.
- `subscription.test.ts` — `banking.subscription.listSubscriptions/cancelSubscription/setSubscriptionReminder`:
  ACTIVE→CANCELLED transition, reminder toggle, unknown id → `NOT_FOUND`.
- `investment.test.ts` — `banking.investment.listProducts/compareInvestments/listHoldings/subscribeInvestment/redeemInvestment`:
  `minAmount` enforcement, ¥5000 into 稳健理财A succeeds + debits, `NOT_FOUND`/`INSUFFICIENT_FUNDS`,
  HOLDING→REDEEMED, `highestRateId`/`lowestRiskId`.
- `atomicity.test.ts` — money-movement atomicity / concurrency regression, all through the MAIN
  production path (no private config): (a) **ledger-write failure ROLLBACK** — `withInjectedWriteFailure`
  wraps the real interactive tx's client in a Proxy that throws on one `model.method`
  (`transaction.create`, `investmentHolding.create`), then asserts the earlier debit is rolled back
  (balance unchanged, ledger/holding count unchanged) and the failure is surfaced; a bare injected
  failure and a typed `AppError('INTERNAL')` are both covered (the typed code crosses the boundary
  intact). (b) **concurrent overspend** — two racing `createTransfer` calls against a balance funding
  one → exactly one succeeds, the loser is `INSUFFICIENT_FUNDS`, balance never negative, exactly one
  ledger row. (c) **concurrent double-redeem** — two racing `redeemInvestment` calls on one holding →
  one credits, the other is `CONFLICT`, credited exactly once.
- `idempotent.test.ts` — the shared **at-most-once CREATE helper** (`banking-sdk/idempotent.ts`):
  pure `isUniqueViolation` (structural `P2002` only) + `normalizeIdempotencyKey` (trim / absent);
  `createIdempotent` driven directly against the real `Budget` table (first call inserts, a replay
  with the SAME key returns the SAME row and does NOT call `create` again, a lost `P2002` race
  re-reads the winner's committed row, any other error propagates and writes nothing); and through
  the SDK barrel `banking.budget.reserveBudget` / `banking.task.createScheduledTask` — repeated key
  → same `id` + exactly ONE row (`count({ where: { idempotencyKey } })`), absent/empty/whitespace
  key and two different keys → two rows (legacy behavior preserved).
- `transfer-receipt.test.ts` — COMMITTED-FACT (execution-receipt) semantics of `banking.transfer.createTransfer`, driven DIRECTLY through the SDK: same `idempotencyKey` + same request replays the ORIGINAL result (no second debit / one ledger row / one `ExecutionReceipt`); same key + different request → `CONFLICT`; a LEGACY ledger row with no receipt replays even when the contact was renamed/deleted (`idempotentTransferTxId` identity); a fresh unknown recipient still → `NOT_FOUND`; a fresh transfer writes a receipt whose `resultJson` == the returned `TransferResult`. DB-backed via `../../helpers/db`, `lib/ledger` + the real `ExecutionReceipt` table.
- `anomaly.test.ts` — `banking.transaction.detectAnomaly` is **DEBIT-only**: it reports a row when it is explicitly flagged (`isAnomaly`) OR it is a DEBIT whose magnitude exceeds `ANOMALY_AMOUNT_THRESHOLD` (¥5,000) and is not an `INVESTMENT_FLOW_CATEGORY` row, so large INCOME (工资 +¥11,000) / refund CREDITs and >¥5,000 投资 debits are never misreported as 大额消费, while the Apple Store ¥6,999 sample stays the ONLY automatic finding.
  Probe rows are inserted TEST-LOCALLY (never in the shared fixtures) so the fixture world's anomaly count (asserted by `tests/scenarios/test-07-anomaly.test.ts`) stays exactly 1; `listAnomalies` (persisted `isAnomaly` rows) reports only the Apple Store row.
- `investment-flow.test.ts` — the subscribe/redeem account-flow `Transaction` row: a subscribe writes its flow row (`category = INVESTMENT_FLOW_CATEGORY='投资'`, DEBIT, `-amount`, merchant `认购<product>`, `channel:'APP'`) in the SAME transaction as the funding-account debit + new holding, and a redeem writes the mirrored CREDIT row (`+marketValue`, merchant `赎回`) with the credit + HOLDING→REDEEMED flip.
  The flow row is classification-neutral (never in `analyzeSpending`, never `大额消费`, not counted toward the ¥1,000 daily-transfer limit) and AT-MOST-ONCE (a repeat and two CONCURRENT calls with the SAME key debit/credit exactly once; a distinct/absent key on an already-redeemed holding → `CONFLICT`); a forced flow-row insert failure rolls the balance + holding back with it (bare error + typed `AppError`).

## Status

All eight specs are implemented with real assertions and pass offline against `prisma/test.db`
(`npx vitest run tests/unit/banking-sdk`).
The transfer spec seeds the duplicate 王芳 via `truncateAll()` +
`seedDemoData({ withAmbiguousContact: true })` inside the ambiguity case.

## Constraints

- The SDK is **execute-only**: assert invariants here; permission/confirmation/MFA are NOT SDK concerns
  (they live in the gateway and are covered elsewhere).
- Use `useFreshDatabase()` / `resetDatabase()` so each case starts from the canonical fixtures.
- Assert thrown `AppError.code` (and `detail` where relevant), never a silent sentinel.
- Import DTO types from `@/banking-sdk` (view models) — Prisma model types must never appear.
- Never weaken an atomicity assertion (no fake timers / shared DB state) — fix the seam instead.

## Routing Table

- `./transfer.test.ts` · `./transfer-receipt.test.ts` · `./subscription.test.ts` · `./investment.test.ts` · `./investment-flow.test.ts` · `./anomaly.test.ts` · `./atomicity.test.ts` · `./idempotent.test.ts` (SDK-direct, gateway-independent)
- `../../helpers` → test-DB lifecycle + fixtures (sibling — this node)

## Notes for Agents

- Every spec here calls the Banking SDK directly (`banking.transfer.createTransfer`, `banking.investment.*`, `banking.subscription.*`, `banking.budget.*`, `banking.task.*`, `banking.transaction.*`, `banking.account.*`) and imports NOTHING from `security/`; `banking-sdk/index.ts` has no `security` dependency. So a change confined to `security/security-gateway.ts` (server-side recipient resolution at park time, park-time arg canonicalization, confirmation-summary fields) does NOT affect these specs — the recipient resolution tested here is the SDK's own `createTransfer` behavior, exercised in isolation without the gateway.
- Helpers are reached via `../../helpers/{db,fixtures}` from this node (not `../helpers/*`).
- `useFreshDatabase()` is called once per file; each test starts from `resetDatabase()` (truncate + canonical seed).
- The atomicity spec lives in THIS node and is auto-discovered by the root `vitest.config.ts`
  (`include: ['tests/**/*.{test,spec}.ts']`) — a plain `npm run test` runs it; no scoped config exists.
- Failure injection MUST keep the real `$transaction`: patch `$transaction` via `Object.defineProperty`
  (not `vi.spyOn`/`restoreAllMocks`, which does not round-trip Prisma's method) and forward every
  non-injected call to the real `tx`, so the earlier debit genuinely rolls back.
