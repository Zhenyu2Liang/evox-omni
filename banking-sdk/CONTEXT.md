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

## API Surface

Facade (`index.ts`): `banking = { account, transaction, transfer, contact, card, subscription,
investment, budget, task, dashboard }`. Type re-exports: `export * from './types'`.

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
  refuses with **`CONFLICT`** when a name matches multiple contacts (`detail.candidates`), **`INSUFFICIENT_FUNDS`**
  when the funding account is short, then writes the DEBIT `Transaction` and returns the new balance.
- `card.setCardLimit(SetCardLimitInput): CardView` · `card.freezeCard(id)` · `card.unfreezeCard(id)` ·
  `card.reportLostCard(id, { reason? })` · `card.applyVirtualCard(ApplyVirtualCardInput)` → `CardView`
- `subscription.cancelSubscription(id)` · `subscription.setSubscriptionReminder(id, remind)` → `SubscriptionView`
- `investment.subscribeInvestment(SubscribeInvestmentInput): InvestResult` (enforces `minAmount`) ·
  `investment.redeemInvestment(RedeemInvestmentInput): InvestResult`
- `budget.reserveBudget(ReserveBudgetInput)` · `budget.releaseBudget(id)` → `BudgetView`
- `task.createScheduledTask(CreateScheduledTaskInput)` · `task.cancelScheduledTask(id)` → `ScheduledTaskView`

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
- **Persist only via `lib/db/repositories/*`** (`user`, `account`, `transaction`, `contact`, `card`,
  `subscription`, `investment`, `budget`, `task`, `scheduledTask`, `auditLog`, `securityEvent`, `session`,
  `pendingAction`). No raw `prisma.*` calls, no direct SQL. The SDK does not write `AuditLog`/`SecurityEvent`
  (that is `audit/`).
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

## Routing Table

- `./banking-sdk/types.ts` → all public DTOs / view models
- `./banking-sdk/account.ts` → balance & account reads
- `./banking-sdk/transaction.ts` → transaction reads, spending analysis, anomaly detection
- `./banking-sdk/contact.ts` → contact lookup (supports transfer recipient resolution)
- `./banking-sdk/transfer.ts` → money movement (execute-only)
- `./banking-sdk/card.ts` → card reads & mutations (limits, freeze/unfreeze, lost, virtual)
- `./banking-sdk/subscription.ts` → subscription reads & mutations
- `./banking-sdk/investment.ts` → products, holdings, subscribe/redeem
- `./banking-sdk/budget.ts` → budget reservations
- `./banking-sdk/task.ts` → scheduled tasks
- `./banking-sdk/dashboard.ts` → aggregated dashboard read model
- `./banking-sdk/index.ts` → `banking` facade + DTO re-exports
- `../tests` → SDK unit tests live under the repo-root test suite (sibling — read-only, escalate writes to root)
- `../lib/db/repositories` → the typed repositories the SDK reads/writes through (dependency — read-only)
