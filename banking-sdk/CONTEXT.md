# banking-sdk — Banking Capabilities (execute-only)

## Intent

The **only layer that turns banking intent into Prisma writes**. Each module is a set of plain
`async` domain functions over the shared repositories (`lib/db/repositories/*`) that read/mutate
`Account`, `Transaction`, `Contact`, `Card`/`CardLimit`, `Subscription`,
`InvestmentProduct`/`InvestmentHolding`, `Budget`, `ScheduledTask`.

It is deliberately **execute-only**: it enforces *domain invariants* (sufficient funds, product
`minAmount`, recipient resolution, state transitions) and performs the read/write — but it makes
**no permission, confirmation, MFA or daily-limit decision**. Those are decided by the Security
Gateway (`security/`). The SDK is the mechanism; `security/` is the policy.

It returns **plain view models** (`./types`) — Prisma model types never leak out of the SDK.

It also **transports** (never authors) an optional, caller-supplied *execution fence*: an opaque
async check a caller attaches to a WRITE input, which the SDK `await`s INSIDE the write transaction
before committing the business row (see `./fence`). The SDK knows nothing about plans, tokens or
policy — it only awaits the callback it was handed.

**Atomicity.** Money-moving and other multi-row writes run inside a single interactive transaction
(`./tx.ts` → `runInTransaction`), so every step commits together or rolls back together — a partial
debit, holding or limit change can never survive. `transfer` / `investment.subscribeInvestment`
enforce sufficient funds with an atomic conditional decrement, so a negative balance is impossible.

**At-most-once creation.** `transfer.createTransfer`, `budget.reserveBudget`,
`task.createScheduledTask` and `investment.subscribeInvestment` accept an OPTIONAL caller-supplied
`idempotencyKey`; a repeat with the SAME key replays the already-persisted row instead of writing a
second one (see `./idempotent.ts`). `investment.redeemInvestment` takes the same optional key but
persists the redemption's execution identity (`redeemExecutionKey`) + ORIGINAL result (`redeemResult`), replaying only when the incoming key matches that identity.

## API Surface

Facade (`index.ts`): `banking = { account, transaction, transfer, contact, card, subscription,
investment, budget, task, dashboard }`. Type re-exports: `export * from './types'`.

The barrel ALSO re-exports the execution-fence carrier (`export * from './fence'`):
`ExecutionFenceCheck`, `EXECUTION_FENCE`, `attachExecutionFence(input, check): T`,
`readExecutionFence(input): ExecutionFenceCheck | undefined`.

Every function is `async`, returns a DTO (or array/none), and may **throw `AppError`** (`lib/errors`)
on failure — never returns a silent sentinel.

Reads (GREEN):

- `account.getBalance(userId): BalanceView` · `account.getAccounts(userId): AccountView[]` ·
  `account.getAccountById(id): AccountView`
- `transaction.listTransactions(userId, TransactionQuery): TransactionView[]` · 
  `transaction.analyzeSpending(userId, SpendingQuery): SpendingAnalysis` · 
  `transaction.detectAnomaly(userId): AnomalyReport` · `transaction.listAnomalies(userId): AnomalyItem[]`
- `contact.searchContacts(userId, query): ContactView[]` · `contact.getContact(userId, id): ContactView` · 
  `contact.listContacts(userId): ContactView[]`
- `card.getCards(userId): CardView[]`
- `subscription.listSubscriptions(userId): SubscriptionView[]`
- `investment.listProducts(ProductQuery): ProductView[]` · `investment.compareInvestments(ids): InvestmentComparison` ·
  `investment.listHoldings(userId): HoldingView[]`
- `budget.listBudgets(userId): BudgetView[]`
- `task.listScheduledTasks(userId): ScheduledTaskView[]`
- `dashboard.getDashboardSummary(userId): DashboardSummary`

Writes (executed only after the gateway's tier policy):

- `transfer.createTransfer(TransferInput): TransferResult` — resolves recipient (`contactId`|`phone`|`name`),
  refuses with **`CONFLICT`** when a name matches multiple contacts (`detail.candidates`), then in ONE
  transaction atomically debits the funding account (conditional `balance >= amount`, else 
  **`INSUFFICIENT_FUNDS`** carrying the current balance) and writes the DEBIT `Transaction`, returning the new balance.
  Optional `TransferInput.idempotencyKey` gives at-most-once semantics.
- `card.setCardLimit(SetCardLimitInput)` (required `userId`) · `card.freezeCard(id, userId)` · `card.unfreezeCard(id, userId)` ·
  `card.reportLostCard(id, userId, { reason? })` · `card.applyVirtualCard(ApplyVirtualCardInput)` → `CardView`
- `subscription.cancelSubscription(id, userId)` · `subscription.setSubscriptionReminder(id, remind, userId)` → `SubscriptionView`
- Card/subscription writers require a server-supplied owner, reject missing/foreign identity with
  `SECURITY_DENIED`, and constrain the actual mutation by owner. Card-limit child writes use an
  owner-filtered relation and conditional connect in one transaction, protecting lookup/write races.
- `investment.subscribeInvestment(SubscribeInvestmentInput): InvestResult` (enforces `minAmount`; atomic conditional debit + holding create;
  optional `SubscribeInvestmentInput.idempotencyKey` → at-most-once subscribe) ·
  `investment.redeemInvestment(RedeemInvestmentInput): InvestResult` (atomic HOLDING→REDEEMED + account credit;
  optional `RedeemInvestmentInput.idempotencyKey` → persists `redeemExecutionKey` + the ORIGINAL `redeemResult`; the SAME identity replays that original result, a DIFFERENT/absent identity on an already-REDEEMED holding throws `CONFLICT`)
- `budget.reserveBudget(ReserveBudgetInput)` · `budget.releaseBudget(id)` → `BudgetView`
  (optional `ReserveBudgetInput.idempotencyKey` → at-most-once reservation)
- `task.createScheduledTask(CreateScheduledTaskInput)` · `task.cancelScheduledTask(id)` → `ScheduledTaskView`
  (optional `CreateScheduledTaskInput.idempotencyKey` → at-most-once task)

DTOs (all in `./types.ts`): `AccountView`, `AccountType`, `BalanceView`, `TransactionView`,
`TransactionDirection`, `TransactionChannel`, `TransactionQuery`, `SpendingQuery`, `CategorySpend`,
`MerchantSpend`, `MonthlyTrendPoint`, `SpendingAnalysis`, `AnomalySeverity`, `AnomalyItem`, `AnomalyReport`,
`ContactView`, `TransferInput`, `TransferRecipient`, `TransferResult`, `CardType`, `CardStatus`,
`CardLimitView`, `CardView`, `SetCardLimitInput`, `ReportLostCardInput`, `ApplyVirtualCardInput`,
`SubscriptionCycle`, `SubscriptionStatus`, `SubscriptionView`, `InvestmentRiskLevel`, `HoldingStatus`,
`ProductView`, `ProductQuery`, `InvestmentComparison`, `HoldingView`, `SubscribeInvestmentInput`,
`RedeemInvestmentInput`, `InvestResult`, `BudgetStatus`, `BudgetView`, `ReserveBudgetInput`,
`ScheduledTaskKind`, `ScheduledTaskStatus`, `ScheduledTaskView`, `CreateScheduledTaskInput`,
`DashboardSummary`.

## Constraints

- **Execute-only.** No permission/confirmation/MFA/circuit-breaker/injection logic — that lives in
  `security/` and is enforced via the Agent's `beforeToolCall` hook. The SDK must never gate a call on a risk tier.
- **Execution-fence transport.** The SDK only TRANSPORTS and EXECUTES an optional fence; it never
  authors one and never learns what it checks. The carrier is a NON-enumerable `EXECUTION_FENCE`
  Symbol property (`./fence`), so it can never arrive through JSON / tool args and never serializes.
  The fence is awaited INSIDE the write transaction, immediately before the business write — a
  throwing fence rolls the transaction back with NO business row written.
- **Persist via `lib/db/repositories/*`** (`user`, `account`, `transaction`, `contact`, `card`,
  `subscription`, `investment`, `budget`, `task`, `scheduledTask`, `auditLog`, `securityEvent`, `session`,
  `pendingAction`, `executionReceipt`). Single-statement writes always go through the repositories. The ONLY direct Prisma
  usage is `./tx.ts` (`runInTransaction`), which wraps multi-statement/money-moving writes in one
  interactive transaction. `./idempotent.ts` performs its find-then-create through `runInTransaction`
  too — it never touches the client itself. No direct SQL. The SDK does not write
  `AuditLog`/`SecurityEvent` (that is `audit/`).
- **Money** via `lib/money` (`round2`/`addMoney`/`subtractMoney`, `parseAmount`) — never raw float math.
  Signed amounts: negative = expense/outflow.
- **Errors**: throw typed `AppError` (`VALIDATION`, `NOT_FOUND`, `CONFLICT`, `INSUFFICIENT_FUNDS`,
  `LIMIT_EXCEEDED`, `INTERNAL`). Never swallow, never return a raw exception. `CONFLICT` carries
  `detail.candidates` (ambiguous recipient).
- **Domain invariants enforced here**: sufficient funds; product `minAmount`; recipient resolution &
  ambiguity; legal state transitions (e.g. FREEZE→ACTIVE, ACTIVE→CANCELLED, HOLDING→REDEEMED).
- **View models only** — map Prisma rows to `./types` DTOs; import shared types from `lib/contracts`
  and import **type-only**; never fork a frozen contract type.
- **Timestamps** are epoch ms (`number`) in DTOs; **money** fields are CNY `number` (2-decimal).
- No upward imports: never import from `agent`, `planner`, `security`, `audit`, `app`, `components`.
- Files ≲ ~1000 lines, split by responsibility (one file per capability domain).

## Design Decisions

- **Demo clock.** Every default date window (本月/上月/今日, spend analysis, dashboard `month`) defaults to `lib/clock.demoNow()` (never `Date.now()`), with an optional explicit `month`/`now` argument so tests inject a fixed instant. On the WRITE path, `createTransfer` stamps its DEBIT ledger row with `occurredAt = demoNow()` (`transfer.ts:254` → written at `transfer.ts:322`), so every executed transfer lands on the pinned demo day (2026-09-25 12:00 LOCAL) and is counted by `security/risk-engine.computeDailyTransferTotal` (window `[startOfDay(demoNow), demoNow]`). The row also sets `amount: -amount` (NEGATIVE), `direction: 'DEBIT'`, `channel: 'TRANSFER'`, `category: '转账'`, `merchant: '转账给' + recipient.name`, `counterpartyId: recipient.id`, `currency: 'CNY'`.
- **Atomic money movement.** `transfer.createTransfer`, `investment.subscribeInvestment`/`redeemInvestment` and `card.setCardLimit` run their multi-row writes inside ONE interactive transaction (`./tx.ts` → `runInTransaction(fn)` = `prisma.$transaction`), so the steps commit together or roll back together — no partial write can survive. `./tx.ts` is the sole place the SDK touches the Prisma client (`../lib/db/client`) directly.
- **Concurrency & idempotency boundary.** No mutex, no explicit `$transaction` isolation option (`runInTransaction` calls `prisma.$transaction(fn)` bare, `./tx.ts:29`), no `SELECT … FOR UPDATE`. Overspend is prevented solely by the single-statement conditional decrement `tx.account.updateMany({ where: { balance: { gte: amount } } })` (in `transfer.ts` → `createTransfer`; `investment.ts` → `subscribeInvestment`) plus SQLite's database-level writer serialization. `createTransfer` writes a new ledger row per submitted call unless an `idempotencyKey` is supplied, and `subscribeInvestment` likewise creates a new holding (plus a second debit) per submitted call unless an `idempotencyKey` is supplied (see the idempotency bullets below). The SDK never checks the daily transfer limit — that is `security/` policy (`risk-engine`), and by design it is a *policy* concern, not an execute-only one.
- **In-transaction replay digest (`createTransfer`).** When `idempotencyKey` is supplied and the deterministic ledger row for `(userId, key)` is found INSIDE the business transaction, the transfer is a replay ONLY IF the persisted `ExecutionReceipt` for that identity (read with the SAME tx client via `executionReceipts.getExecutionReceipt(userId, key, tx)`) exists AND its `requestDigest` equals the current request's digest — then the ORIGINAL result snapshot (`safeParse` of `receipt.resultJson`) is returned VERBATIM (the current request's recipient/amount is never spliced onto the winner's row). A MISSING receipt, or a DIFFERING digest, throws `AppError('CONFLICT', 'same execution identity, different request', …)` with NO side effect; an unreadable snapshot throws `INTERNAL`. The concurrent PK/UNIQUE catch therefore replays ONLY through the digest-verifying `replayCommitted` — there is NO unverified ledger fallback. The SEQUENTIAL fast path (`replayCommitted`, consulted before any mutable lookup) is unchanged and still recognizes a LEGACY ledger row that has no receipt.
- **Execution fence (`./fence`).** `attachExecutionFence(input, check)` stores an `ExecutionFenceCheck` on the input as a NON-enumerable, writable, configurable `EXECUTION_FENCE` Symbol-keyed property and returns the SAME object reference (so a wrapper forwarding the original reference keeps the fence); `readExecutionFence(input)` returns it only when the carried value is a function. `transfer.createTransfer` and `budget.reserveBudget` `await` the fence INSIDE their write transaction immediately BEFORE the business write — `createTransfer` before the atomic debit; `reserveBudget` on its keyed path via `createIdempotent`'s `fence` spec and on its keyless path via `runInTransaction`, in all cases the fence and the business insert share ONE transaction, so a throwing fence rolls back with NO business row written. Absent fence → behavior identical to before.
- **`createTransfer` optional idempotency.** `TransferInput.idempotencyKey?` gives at-most-once semantics with NO schema change: the ledger row id is derived deterministically from `(userId, key)` via the SHARED helper `lib/ledger` → `idempotentTransferTxId` (called from `createTransfer`, `transfer.ts:231`; format `txidem_<sha256[:32]>`) and reused as the existing `Transaction.id` primary key. A repeat is recognized from the committed fact and returns the ORIGINAL result (same `transactionId`, no second debit); a concurrent same-key loser hits the PK unique violation (`P2002`), its transaction rolls back (no debit) and the committed row is replayed ONLY through the digest-verifying `replayCommitted`. Absent key → unchanged behavior. Defense-in-depth only — the security layer's `PendingAction` compare-and-set is the PRIMARY at-most-once guard; the agent/app layer may pass `pendingAction.id` as the key.
- **`reserveBudget` / `createScheduledTask` optional idempotency (`./idempotent.ts`).** Planner keys use
  `nodeExecutionKey(taskId, nodeId)`. Budget enforces `@@unique([userId, idempotencyKey])`; scheduled
  tasks retain their global key constraint. `createIdempotent({ key, fence, find, create })` reads or
  inserts inside `runInTransaction`, and its P2002 fallback reuses the same scoped `find` callback.
  Budget's callback always selects by owner + key. Empty/whitespace keys remain absent; NULL keys
  permit independent calls. PendingAction CAS remains the primary guard for human-gated operations.
- **`analyzeSpending` EXCLUDES anomaly rows.** Spend totals (`total`, `prevTotal`, `byCategory`, `topMerchant`, `monthlyTrend`, `largest`) count only `direction = 'DEBIT'` rows with `isAnomaly = false`. The seeded Apple Store ¥6,999 (`isAnomaly = true`, 2026-09-20 18:32) is a SEPARATE September row and MUST NOT fold into 本月消费. Because `transactions.listByCategory`/`sumDebitsInRange` include it, the window is summed by scanning `transactions.listTransactions` and filtering. Seed anchors: 本月 = ¥5,800 (娱乐 ¥2,680), 上月 = ¥6,230.
- **`transfer.createTransfer` recipient resolution.** Exactly one of `contactId`|`phone`|`name`; `phone`/`name` match by EXACT equality after `contacts.searchContacts`; >1 exact match → `AppError('CONFLICT')` with `detail.candidates` = `ContactView[]` (the agent asks the user to choose). Insufficient funds writes NOTHING: the debit is a conditional `updateMany({ where: { balance: { gte: amount } } })` inside the transaction; when it matches nothing the call throws `AppError('INSUFFICIENT_FUNDS')` with `{ balance: <current>, amount }` and nothing is persisted.
- **`investment.subscribeInvestment` / `investment.redeemInvestment`.** Below `minAmount` (or a non-positive amount) `subscribeInvestment` throws `AppError('VALIDATION')` (not `LIMIT_EXCEEDED`). The debit and the holding create run in one transaction; the funding account is debited via the conditional decrement, so an overdraft is impossible (`INSUFFICIENT_FUNDS`, `{ balance, amount }`, nothing written). With an `idempotencyKey` (the planner passes `nodeExecutionKey(taskId, nodeId)`; absent/whitespace = no key) the caller's key is stored on the created `InvestmentHolding.idempotencyKey` and replayed by the shared `./idempotent.ts` → `createIdempotent`: the idempotency RECORD, the DEBIT and the HOLDING create all happen in ONE `runInTransaction`, and a repeat (including the concurrent `P2002` loser, whose transaction rolls back unwritten) returns the ORIGINAL holding — same `holdingId`, same `amount`, current balance, no second debit. `redeemInvestment` persists the redemption's execution IDENTITY (`InvestmentHolding.redeemExecutionKey`) and ORIGINAL result payload (`redeemResult`, JSON text) in the SAME transaction as the REDEEMED status flip + credit: the conditional flip (`updateMany({ where: { status: { not: 'REDEEMED' } } })`) still guarantees exactly one credit per holding, and on the already-REDEEMED branch it re-reads the committed row and returns the ORIGINAL result ONLY when the incoming `idempotencyKey` EQUALS the stored `redeemExecutionKey` (a replayed plan node, same `nodeExecutionKey`), crediting nothing; a DIFFERENT identity (a distinct standalone action — key = the action id) or an ABSENT key throws `AppError('CONFLICT')` with `detail { holdingId, status: 'REDEEMED' }` — never a false success. `InvestmentHolding.idempotencyKey` is reserved for subscribe dedup and is never overloaded for redeem. Subscribe/redeem adjust the funding account **balance** only and write NO `Transaction` row — this preserves the 本月 ¥5,800 spend anchor.
- **Idempotency keys are CALLER-SUPPLIED — never derived inside the SDK.** No session/tool/args hash: the planner/app layer passes `nodeExecutionKey(taskId, nodeId)`, so two different plans making the identical call receive DIFFERENT keys and execute independently (each debits and creates its own holding). `normalizeIdempotencyKey` treats an empty/whitespace key as absent.
- **`subscription.listSubscriptions`** returns ACTIVE rows only (matches the `list_subscriptions` tool).
- **`card.setCardLimit`** replaces the category limit (delete-then-create, both in ONE transaction; one row per card+category). Legal state transitions are enforced: `freeze` from ACTIVE/PENDING, `unfreeze` from FROZEN, `reportLost` from any non-LOST; illegal ones throw `CONFLICT` (same-status is idempotent).
- **`task` payload** is stored as JSON text written with `lib/json.toJson` (the repository path and the idempotent path write the identical column value); read back via `lib/json.safeParse`.
- **`contact.toContactView`** is exported for reuse by `transfer.ts` (internal helper — not a DTO).

## Notes for Agents

- New transfer mutations use `normalizeTransferAmount`; fractional cents are rejected instead of
  rounded. Committed-evidence reads retain historical normalization and never create a new debit.
- Budget replay identity is `(userId, idempotencyKey)` under a compound UNIQUE index. Both the initial
  lookup and unique-conflict fallback use this same compound selector; never look up a global budget key.

- **`change_password` is NOT implemented here.** The demo has no credential store; its authority is the `AuditLog` row written by the security/agent layer (the agent tool returns a simulated success). Do NOT add a `banking-sdk` function for it.
- The at-most-once CREATE helper lives in `./banking-sdk/idempotent.ts` (`createIdempotent`, `normalizeIdempotencyKey`, `isUniqueViolation`). Reuse it for any future gated CREATE that must survive a replayed plan node — do not re-implement find-then-create + `P2002` replay per module.
- Trusted execution context is scoped by `withBankingExecution` (`AsyncLocalStorage`), installed by the server tool registry. All SDK mutations enter `runInTransaction`, which applies the context fence before business writes. The optional symbol carrier remains supported for direct transfer/budget callers. A new mutation must use this transaction boundary.
- SDK unit specs live in `../tests/unit/banking-sdk/` (root-owned sibling — the SDK unit specs) — run them with the root config: `npx vitest run tests/unit/banking-sdk`.
- The money-movement ATOMICITY regression spec lives in the root test tree at `tests/unit/banking-sdk/atomicity.test.ts`, where it is auto-discovered and run by the root `vitest.config.ts` under `npm run test`. It proves ledger/subscribe-write failure ROLLBACK and concurrent overspend / double-redeem prevention.
- `../tests` and `../lib/db/repositories` are read-only dependencies; escalate writes to root.

## Routing Table

- `./banking-sdk/types.ts` → all public DTOs / view models
- `./banking-sdk/fence.ts` → execution-fence carrier: `ExecutionFenceCheck`, `EXECUTION_FENCE`, `attachExecutionFence`, `readExecutionFence` (awaited inside the write tx)
- `./banking-sdk/account.ts` → balance & account reads
- `./banking-sdk/transaction.ts` → transaction reads, spending analysis, anomaly detection
- `./banking-sdk/contact.ts` → contact lookup (supports transfer recipient resolution)
- `./banking-sdk/transfer.ts` → money movement (execute-only; receipt-backed in-tx replay digest + fence)
- `./banking-sdk/card.ts` → card reads & mutations (limits, freeze/unfreeze, lost, virtual)
- `./banking-sdk/subscription.ts` → subscription reads & mutations
- `./banking-sdk/investment.ts` → products, holdings, subscribe/redeem (optional `idempotencyKey` — subscribe dedup via `./idempotent.ts`; redeem persists `redeemExecutionKey` + the original `redeemResult`, replaying only on an identity match)
- `./banking-sdk/budget.ts` → budget reservations (optional `idempotencyKey`; honours the execution fence)
- `./banking-sdk/task.ts` → scheduled tasks (optional `idempotencyKey`)
- `./banking-sdk/dashboard.ts` → aggregated dashboard read model
- `./banking-sdk/index.ts` → `banking` facade + DTO re-exports + fence re-exports
- `./banking-sdk/tx.ts` → `runInTransaction` — the SDK's only direct Prisma usage (interactive transaction boundary)
- `./banking-sdk/idempotent.ts` → shared at-most-once helpers: `createIdempotent` (accepts an optional `fence`) / `normalizeIdempotencyKey` / `isUniqueViolation` (used by `budget.ts` / `task.ts` / `transfer.ts` / `investment.ts`) + `idempotentCardId` (deterministic PK, used by `card.ts` → `applyVirtualCard`)
- `../tests/unit/banking-sdk` → SDK unit specs incl. the money-movement atomicity regression spec (sibling — read-only, auto-discovered by the root `npm run test`; escalate writes to root)
- `../lib/db/repositories` → the typed repositories the SDK reads/writes through (dependency — read-only)
- `../lib/ledger` → shared deterministic transfer-ledger id (`idempotentTransferTxId`) — the idempotency dedup key the SDK uses for `createTransfer`; also consumed by `security/` (dependency — read-only)

- `./banking-sdk/execution-context.ts` → request-scoped trusted fence, transfer audit callback and transaction-commit observation
