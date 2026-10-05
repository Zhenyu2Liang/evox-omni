# lib/db/repositories — typed data access

## Intent

One module per aggregate. Each exports narrow, typed async functions over the shared `prisma` singleton
(`../client`). This is the single data-access surface for the whole app; all reads/writes funnel through here.

## API Surface

Model return types come from `@prisma/client`. JSON-text columns are stored/parsed with `lib/json`.
All functions below are implemented (real Prisma data access).

- `user.ts` (`User`) — `getUser(id)`, `getUserByPhone(phone)`, `listUsers()`,
  `createUser({id?, name, phone, avatarEmoji?})`, `updateUser(id, {name?, avatarEmoji?})`.
- `account.ts` (`Account`) — `listAccounts(userId)`, `getAccount(id)`, `getCheckingAccount(userId)`,
  `getTotalBalance(userId): number`, `createAccount({userId, type, name, number, balance, currency?})`,
  `setBalance(id, balance)`, `incrementBalance(id, delta)`.
- `transaction.ts` (`Transaction`) — `TransactionQuery {userId, from?, to?, category?, channel?, direction?, limit?}`,
  `CategoryTotal {category, total, count}`;
  `listTransactions(query)` (newest-first by `occurredAt`),
  `getTransaction(id)`, `createTransaction({...})`,
  `sumDebitsInRange(userId, from, to): number` (absolute DEBIT total in `[from,to)`),
  `sumOutgoingTransfersSince(userId, sinceMs): number` (absolute total of outgoing TRANSFER debits —
  `direction='DEBIT' AND channel='TRANSFER'`, `occurredAt >= sinceMs`; consumed by `security/risk-engine.ts`),
  `listByCategory(userId, from, to): CategoryTotal[]` (per-category absolute debit total + count, sorted by
  total desc), `listAnomalies(userId, limit?)`,
  `searchTransactions(userId, keyword, limit?)` (contains on merchant/remark/category),
  `countTransactionsSince(userId, since)`.
- `contact.ts` (`Contact`) — `listContacts(userId)`, `getContact(id)`, `getContactByName(userId, name)`,
  `searchContacts(userId, keyword)`, `createContact({userId, name, phone, bank?, remark?})`.
- `card.ts` (`Card`, `CardLimit`) — `listCards(userId)`, `getCard(id)`, `getCardByIdForUser(userId, id)`,
  `createCard({...})`, `updateCardStatus(id, status)`, `updateCardLimits(id, {creditLimit?, availableLimit?, monthlyLimit?})`,
  `listCardLimits(cardId)`, `setCardCategoryLimit({cardId, category, amount})`,
  `deleteCardCategoryLimits(cardId, category): number`.
- `subscription.ts` (`Subscription`) — `listSubscriptions(userId, status?)`, `getSubscription(id)`,
  `createSubscription({userId, name, amount, cycle?, nextChargeAt, status?, remind?})`,
  `updateSubscriptionStatus(id, status)`, `setSubscriptionReminder(id, remind)`.
- `investment.ts` (`InvestmentProduct`, `InvestmentHolding`) — `HoldingWithProduct = InvestmentHolding & { product }`;
  `listProducts()`, `getProduct(id)`, `getProductByCode(code)`, `listProductsByRisk(riskLevel)`,
  `createProduct({...})`, `listHoldings(userId, status?): HoldingWithProduct[]` (newest-first by `boughtAt`, `product` included),
  `getHolding(id)`, `createHolding({...})`, `updateHoldingStatus(id, status)`, `sumActiveHoldings(userId): number`.
- `budget.ts` (`Budget`) — `listBudgets(userId, status?)`, `getBudget(id)`,
  `createBudget({userId, name, amount, purpose?, status?, dueDate?})`, `updateBudgetStatus(id, status)`.
- `task.ts` (`AgentTask`, `AgentTaskNode`) — `AgentTaskWithNodes = AgentTask & { nodes }` (`getTask` includes `nodes` by `order`);
  `CreateTaskInput {sessionId, userId, goal, status?}`, `CreateTaskNodeInput {taskId, nodeId, name, kind, order, tool?, args?, condition?, dependencies?, status?}`,
  `UpdateTaskNodeInput {status?, output?, error?, startedAt?, endedAt?}`;
  `createTask(input)`, `getTask(id)` (task row incl. current `status`), `listTasksBySession(sessionId)`,
  `updateTaskStatus(id, status)` (blind unconditional set),
  `claimTaskStatus(taskId, fromStatuses: TaskPlanStatus[], toStatus: TaskPlanStatus): Promise<boolean>` — the
  ATOMIC concurrency guard: a SINGLE `updateMany` CAS moving `status` from any of `fromStatuses` to `toStatus`,
  returning `true` iff exactly one row transitioned (a second/concurrent resume/retry returns `false`; a
  terminal/cancelled status not in `fromStatuses` matches 0 rows),
  `claimTaskExecution(taskId, token, {staleBefore?}?): Promise<boolean>` — the exactly-once PLAN-executor claim:
  a SINGLE `updateMany` stamping `executionToken = token` / `executionClaimedAt = now` WHERE the token is NULL
  (or, when `staleBefore` is supplied, `executionClaimedAt < staleBefore`); `true` iff one row was claimed,
  `releaseTaskExecution(taskId, token): Promise<void>` — clears `executionToken`/`executionClaimedAt` ONLY where
  the token still equals this caller's `token`,
  `claimNodeExecution(taskId, nodeId, token, {staleBefore?}?): Promise<boolean>` /
  `releaseNodeExecution(taskId, nodeId, token): Promise<void>` — the NODE-level analogues addressed by the
  logical `(taskId, nodeId)` pair,
  `createTaskNode(input)`, `getTaskNode(taskId, nodeId)`, `updateTaskNode(taskId, nodeId, update)`,
  `updateTaskNodeStatus(taskId, nodeId, status)`, `deleteTask(id)` (nodes cascade).
- `scheduledTask.ts` (`ScheduledTask`) — `CreateScheduledTaskInput {userId, name, kind, runAt, payload?, requiresConfirmation?, status?}`;
  `listScheduledTasks(userId, status?)`, `getScheduledTask(id)`, `createScheduledTask(input)`,
  `updateScheduledTaskStatus(id, status)`, `deleteScheduledTask(id)`.
- `auditLog.ts` (`AuditLog`) — `AuditLogInput {sessionId, userId?, userRequest, intent?, toolName, riskLevel, confirmationRequired?, confirmed?, mfaRequired?, mfaResult?, toolResult?, status, detail?, timestamp?}`,
  `AuditLogQuery {userId?, sessionId?, from?, to?, limit?}`;
  `createAuditLog(input)`, `getAuditLog(id)`, `listAuditLogs(query?)` (newest-first by `timestamp`, limit default 100),
  `countAuditLogs(query?)`; plus contract-mapping helpers consumed by `audit/`:
  `insertAuditLog(entry: AuditEntry): Promise<AuditEntry>`, `findAuditLogs(filter): Promise<AuditEntry[]>`,
  `aggregateAuditLogs(): Promise<{ total; byRisk; byStatus }>`.
- `securityEvent.ts` (`SecurityEvent`) — `SecurityEventInput {sessionId, userId?, kind, severity, message, detail?, timestamp?}`,
  `SecurityEventQuery {userId?, sessionId?, kind?, limit?}`;
  `createSecurityEvent(input)`, `listSecurityEvents(query?)`, `countSecurityEvents(query?)`; plus
  `insertSecurityEvent(event): Promise<SecurityEvent>`, `findSecurityEvents(filter): Promise<SecurityEvent[]>`
  (consumed by `audit/`).
- `session.ts` (`AgentSession`) — `listSessions(userId)`, `getSession(id)`, `createSession({userId, stateJson, status?, locked?})`,
  `updateSessionState(id, stateJson)`, `setSessionLocked(id, locked)`, `updateSessionStatus(id, status)`, `deleteSession(id)`.
- `pendingAction.ts` (`PendingAction`, `MfaChallenge`) — `PendingActionWithMfa = PendingAction & { mfa }`,
  `PendingActionOwnership {id, userId, sessionId, status}`, `PendingActionPlanLink {id, taskId, nodeId}`;
  `CreatePendingActionInput {sessionId, userId, toolName, args, tier, requiresMfa, summary, status?, userRequest?, intent?, taskId?, nodeId?}`
  (`taskId`/`nodeId` are the owning plan (`AgentTask.id`) / node (`AgentTaskNode.nodeId`), persisted AT CREATION as
  `null` when absent),
  `CreateMfaChallengeInput {actionId, code, maxAttempts?, expiresAt?}`,
  `ClaimPendingActionInput {actionId, from: PendingActionStatus[], to: PendingActionStatus, userId?, sessionId?}`;
  `createPendingAction(input)`, `getPendingAction(id)` (`mfa` included), `listPendingActions({sessionId?, status?, limit?})`,
  `updatePendingActionStatus(id, status)` (unconditional setter),
  `setPendingActionStatus(actionId, status)` (alias of `updatePendingActionStatus` — persist a terminal state
  `'executed'`/`'failed'` after a claim),
  `claimPendingAction(input): Promise<boolean>` — the ATOMIC exactly-once claim gate: a SINGLE
  `updateMany` CAS moving `status` from any of `from` to `to`, optionally scoped to the row's `userId`/`sessionId`;
  returns `true` iff exactly one row transitioned (a second/concurrent claim returns `false`),
  `getPendingActionOwnership(actionId): Promise<PendingActionOwnership | null>` (id/userId/sessionId/status
  projection for authorizing a caller; `null` when the action is absent),
  `getPendingActionPlanLink(actionId): Promise<PendingActionPlanLink | null>` (id/taskId/nodeId projection — the
  owning plan/node the action was created under; `null` when the action is absent; a sibling of
  `getPendingActionOwnership`, whose minimal projection is kept unchanged),
  `listPendingActionsByTask(taskId, {statuses?}?): Promise<PendingAction[]>` — plan-scoped enumeration of EVERY
  action belonging to a plan, optionally narrowed by status, ordered oldest-first by `createdAt` (no `take` limit),
  `revokePendingActionsByTask(taskId, fromStatuses: string[]): Promise<number>` — bulk plan-level revocation: a
  SINGLE atomic `updateMany` cancelling EVERY action of the plan whose current status is in `fromStatuses`,
  returning the number of rows transitioned,
  `createMfaChallenge(input)` (`maxAttempts` default 3),
  `getMfaChallenge(actionId)`, `incrementMfaAttempts(actionId)`, `updateMfaChallengeStatus(actionId, status)`,
  `resetMfaAttempts(actionId)` (sets `attempts` 0).
- `index.ts` — namespace barrel: `users, accounts, transactions, contacts, cards, subscriptions, investments, budgets, tasks, scheduledTasks, auditLogs, securityEvents, sessions, pendingActions`.

## JSON-text columns (serialize with `toJson` / parse with `safeParse`)

`AgentTaskNode.args|condition|dependencies|output`, `ScheduledTask.payload`,
`PendingAction.argsJson|summaryJson`, `AgentSession.stateJson`, `AuditLog.toolResult`.

## Constraints

- Import `prisma` **only** from `../client`. Never instantiate `new PrismaClient()` here.
- Input DTOs live in the module that owns them; reuse `lib/contracts` types (`RiskLevel`,
  `PendingActionSummary`, `PendingActionStatus`, `TaskCondition`, `AuditEntry`, `SecurityEvent`) instead of redefining them.
- No risk/permission logic — repositories are dumb persistence only.
- Keep one aggregate per file; ≲ ~1000 lines.

## Known Issues

- **Missing `AgentTaskNode.pendingActionId` column.** `prisma/schema.prisma` model `AgentTaskNode`
  has no `pendingActionId` field (`./prisma` is a sibling, out of scope for this node). The plan↔operation
  link is instead persisted on `PendingAction.taskId`/`nodeId` and read back via `getPendingActionPlanLink` /
  `listPendingActionsByTask`, so no repository code references `AgentTaskNode.pendingActionId`.

## Routing Table

- `./user.ts` → User
- `./account.ts` → Account (balances)
- `./transaction.ts` → Transaction (ledger + aggregates)
- `./contact.ts` → Contact
- `./card.ts` → Card + CardLimit
- `./subscription.ts` → Subscription
- `./investment.ts` → InvestmentProduct + InvestmentHolding
- `./budget.ts` → Budget
- `./task.ts` → AgentTask + AgentTaskNode (+ concurrency-safe `claimTaskStatus` status CAS and the `claimTaskExecution`/`claimNodeExecution` exactly-once execution claims + matching `release*`)
- `./scheduledTask.ts` → ScheduledTask
- `./auditLog.ts` → AuditLog
- `./securityEvent.ts` → SecurityEvent
- `./session.ts` → AgentSession
- `./pendingAction.ts` → PendingAction + MfaChallenge (+ plan-scoped `listPendingActionsByTask` / `revokePendingActionsByTask` and the `getPendingActionPlanLink` reader)
- `./index.ts` → namespace barrel

## Notes for Agents

- `npx prisma generate` must run before this code is executed or type-checked.
- Date/time ranges are half-open `[from, to)`. Time-series lists (transactions, audit logs, security
  events, pending actions, sessions) return newest-first; list `limit`s default to 100 where optional.
  Plan-scoped lists (`listPendingActionsByTask`) are the exception: oldest-first, no default limit.
- `AgentTaskNode.(taskId,nodeId)` is not a DB unique constraint — `getTaskNode`/`updateTaskNode` route
  through the first row (ordered by `order`) matching the pair, and `claimNodeExecution`/`releaseNodeExecution`
  address the pair with an `updateMany` that therefore targets ALL rows for it (normally exactly one).
- Concurrency guards are CAS-only and convention-enforced — there is NO DB-level enum or terminal-state
  constraint. The atomic gates are the `claim*` / `revoke*` primitives: `claimTaskStatus` (AgentTask status),
  `claimPendingAction` (PendingAction status), `claimTaskExecution`/`releaseTaskExecution` (plan executor slot),
  `claimNodeExecution`/`releaseNodeExecution` (node executor slot) and `revokePendingActionsByTask` (bulk
  plan-level cancel). The plain setters `updateTaskStatus` / `updateTaskNodeStatus` / `updatePendingActionStatus`
  are blind unconditional `update`s that would happily regress a terminal (`cancelled`/`success`) row.
  Never use a plain setter for a transition that must respect terminal state — use the `claim*` CAS with a
  non-terminal `from` (a status not in `from` matches 0 rows → returns `false`).
- Node execution claims ARE supported (`claimNodeExecution`/`releaseNodeExecution`) in addition to the PARENT
  `AgentTask` claim (`claimTaskStatus`/`claimTaskExecution`); the stale-takeover path (`staleBefore`) only
  matches rows whose `executionClaimedAt` is non-NULL and older, so a set token with a NULL `executionClaimedAt`
  is not reclaimable (fail-safe). Node writes (`updateTaskNode`/`updateTaskNodeStatus`) resolve `firstNodeId`
  and THROW if the node is absent.
- Every `status` column is a plain `String` (SQLite). The `prisma/schema.prisma` field comments list
  DIFFERENT status values than the frozen contract enums (`TaskPlanStatus`/`TaskNodeStatus`/`PendingActionStatus`
  in `lib/contracts`) — the contract enums are authoritative; the schema comments are non-normative.
- A `PendingAction` is revoked (superseded/cancelled) either per-action by claiming `to: 'cancelled'`
  (`claimPendingAction`) / via the blind `setPendingActionStatus`/`updatePendingActionStatus`, or in bulk for a
  whole plan via `revokePendingActionsByTask(taskId, fromStatuses)` (single atomic `updateMany`).
