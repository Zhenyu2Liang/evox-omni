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
  `createTask(input)`, `getTask(id)`, `listTasksBySession(sessionId)`, `updateTaskStatus(id, status)`,
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
- `pendingAction.ts` (`PendingAction`, `MfaChallenge`) — `PendingActionWithMfa = PendingAction & { mfa }`;
  `CreatePendingActionInput {sessionId, userId, toolName, args, tier, requiresMfa, summary, status?}`,
  `CreateMfaChallengeInput {actionId, code, maxAttempts?, expiresAt?}`;
  `createPendingAction(input)`, `getPendingAction(id)` (`mfa` included), `listPendingActions({sessionId?, status?, limit?})`,
  `updatePendingActionStatus(id, status)`, `createMfaChallenge(input)` (`maxAttempts` default 3),
  `getMfaChallenge(actionId)`, `incrementMfaAttempts(actionId)`, `updateMfaChallengeStatus(actionId, status)`,
  `resetMfaAttempts(actionId)` (sets `attempts` 0).
- `index.ts` — namespace barrel: `users, accounts, transactions, contacts, cards, subscriptions, investments, budgets, tasks, scheduledTasks, auditLogs, securityEvents, sessions, pendingActions`.

## JSON-text columns (serialize with `toJson` / parse with `safeParse`)

`AgentTaskNode.args|condition|dependencies|output`, `ScheduledTask.payload`,
`PendingAction.argsJson|summaryJson`, `AgentSession.stateJson`, `AuditLog.toolResult`.

## Constraints

- Import `prisma` **only** from `../client`. Never instantiate `new PrismaClient()` here.
- Input DTOs live in the module that owns them; reuse `lib/contracts` types (`RiskLevel`,
  `PendingActionSummary`, `TaskCondition`, `AuditEntry`, `SecurityEvent`) instead of redefining them.
- No risk/permission logic — repositories are dumb persistence only.
- Keep one aggregate per file; ≲ ~1000 lines.

## Routing Table

- `./user.ts` → User
- `./account.ts` → Account (balances)
- `./transaction.ts` → Transaction (ledger + aggregates)
- `./contact.ts` → Contact
- `./card.ts` → Card + CardLimit
- `./subscription.ts` → Subscription
- `./investment.ts` → InvestmentProduct + InvestmentHolding
- `./budget.ts` → Budget
- `./task.ts` → AgentTask + AgentTaskNode
- `./scheduledTask.ts` → ScheduledTask
- `./auditLog.ts` → AuditLog
- `./securityEvent.ts` → SecurityEvent
- `./session.ts` → AgentSession
- `./pendingAction.ts` → PendingAction + MfaChallenge
- `./index.ts` → namespace barrel

## Notes for Agents

- `npx prisma generate` must run before this code is executed or type-checked.
- Date/time ranges are half-open `[from, to)`. Time-series lists (transactions, audit logs, security
  events, pending actions, sessions) return newest-first; list `limit`s default to 100 where optional.
- `AgentTaskNode.(taskId,nodeId)` is not a DB unique constraint — `getTaskNode`/`updateTaskNode` route
  through the first row (ordered by `order`) matching the pair.
