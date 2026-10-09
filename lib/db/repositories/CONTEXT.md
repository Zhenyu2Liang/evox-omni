# lib/db/repositories — typed data access

## Intent

One module per aggregate. Each exports narrow, typed async functions over the shared `prisma` singleton
(`../client`). This is the single data-access surface for the whole app; all reads/writes funnel through here.

`pendingAction.ts` is **transaction-composable**: EVERY function in it takes an optional trailing
`client: Prisma.TransactionClient = prisma`, so a caller can route several of its calls through ONE
`prisma.$transaction` handle. The default keeps every existing caller working unchanged. This exists so a
plan-level cancel and a concurrent authorization CAS can be composed into a single transaction and cannot
interleave. Two further aggregates accept an optional `client` for the SAME atomic-composition reason: `securityEvent.ts#insertSecurityEvent` (commit a security event in the caller's transaction) and `circuitBreaker.ts#resetBreakerState` (unlock + its `SECURITY_RESET` audit atomically together). All other repository modules use the shared singleton only.

## API Surface

Model return types come from `@prisma/client`. JSON-text columns are stored/parsed with `lib/json`.
All functions below are implemented (real Prisma data access).
The trailing optional `client?` parameter is documented for `pendingAction.ts` (every function)
that accepts one.

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
  `claimTaskStatus(taskId, fromStatuses: TaskPlanStatus[], toStatus: TaskPlanStatus, opts?: { fenceToken?: string }): Promise<boolean>` — the
  ATOMIC concurrency guard: a SINGLE `updateMany` CAS moving `status` from any of `fromStatuses` to `toStatus`,
  returning `true` iff exactly one row transitioned (a second/concurrent resume/retry returns `false`; a
  terminal/cancelled status not in `fromStatuses` matches 0 rows); when `opts.fenceToken` is supplied the SAME
  atomic `where` also requires `executionToken = opts.fenceToken`, so a stale executor that lost the plan to a
  takeover transitions 0 rows and returns `false` (the boolean return type is unchanged),
  `claimTaskExecution(taskId, token, {staleBefore?}?): Promise<boolean>` — the exactly-once PLAN-executor claim:
  a SINGLE `updateMany` stamping `executionToken = token` / `executionClaimedAt = now` WHERE the token is NULL
  (or, when `staleBefore` is supplied, `executionClaimedAt < staleBefore`); `true` iff one row was claimed,
  `releaseTaskExecution(taskId, token): Promise<void>` — clears `executionToken`/`executionClaimedAt` ONLY where
  the token still equals this caller's `token`,
  `claimNodeExecution(taskId, nodeId, token, {staleBefore?}?): Promise<boolean>` /
  `releaseNodeExecution(taskId, nodeId, token): Promise<void>` — the NODE-level analogues addressed by the
  logical `(taskId, nodeId)` pair,
  `createTaskNode(input)`, `getTaskNode(taskId, nodeId)`,
  `updateTaskNodeStatus(taskId, nodeId, status)`, `deleteTask(id)` (nodes cascade).

  **`updateTaskNode` — token-fenced node write.** Exactly two overloads:
  `updateTaskNode(taskId, nodeId, update: UpdateTaskNodeInput): Promise<AgentTaskNode>` (the UNFENCED path: resolve the first `(taskId, nodeId)` row and `update` it, returning the updated `AgentTaskNode`, or THROW when the node is absent), and
  `updateTaskNode(taskId, nodeId, update: UpdateTaskNodeInput, opts: { fenceToken?: string }): Promise<AgentTaskNode | null>` (the FENCED path).
  The fenced path (when `opts.fenceToken` is defined) writes with a SINGLE atomic `updateMany` whose `where` requires `executionToken = opts.fenceToken`, so the token check is INSIDE the same statement (never a read-then-write).
  It then re-reads the row via the `(taskId, nodeId)` first-row lookup and returns the updated `AgentTaskNode` when the token still matched.
  When the token did NOT match (0 rows) it performs NO write and returns the **"lost" sentinel `null`**.
  `null` therefore means "the write was rejected because you no longer own the node", NOT "the node is missing" (the unfenced path is the one that throws on a missing node); a fenced caller must branch on `null` and skip its follow-up work rather than treat it as an error.
  Callers pass the CURRENT executor's token (from `claimTaskExecution`/`claimNodeExecution`); the `./agent` owner must wire `persistNode`/`persistPlan` to pass that token and to skip writes (no re-persist, no narration of a result they no longer own) when they receive `null`.
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
  `insertSecurityEvent(event, opts?: { client?: DbClient }): Promise<SecurityEvent>` (the optional `client` commits the append in the caller's `$transaction`), `findSecurityEvents(filter): Promise<SecurityEvent[]>`
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
  EVERY function here also takes an optional trailing `client: Prisma.TransactionClient = prisma` (default = the
  shared singleton) that routes ALL of that call's DB access through the supplied client — the transaction-composability
  surface described in `## Intent`;
  `createPendingAction(input, client?)`, `getPendingAction(id, client?)` (`mfa` included),
  `listPendingActions({sessionId?, status?, limit?}, client?)`,
  `updatePendingActionStatus(id, status, client?)` (unconditional setter),
  `setPendingActionStatus(actionId, status, client?)` (alias of `updatePendingActionStatus` — persist a terminal
  state `'executed'`/`'failed'` after a claim),
  `claimPendingAction(input, client?): Promise<boolean>` — the ATOMIC exactly-once claim gate: a SINGLE
  `updateMany` CAS moving `status` from any of `from` to `to`, optionally scoped to the row's `userId`/`sessionId`;
  returns `true` iff exactly one row transitioned (a second/concurrent claim returns `false`). Supplying `client`
  only re-targets the statement — it stays a single `updateMany`, never a read-modify-write,
  `getPendingActionOwnership(actionId, client?): Promise<PendingActionOwnership | null>` (id/userId/sessionId/status
  projection for authorizing a caller; `null` when the action is absent),
  `getPendingActionPlanLink(actionId, client?): Promise<PendingActionPlanLink | null>` (id/taskId/nodeId projection —
  the owning plan/node the action was created under; `null` when the action is absent; a sibling of
  `getPendingActionOwnership`, whose minimal projection is kept unchanged),
  `listPendingActionsByTask(taskId, {statuses?}?, client?): Promise<PendingAction[]>` — plan-scoped enumeration of
  EVERY action belonging to a plan, optionally narrowed by status, ordered oldest-first by `createdAt` (no `take` limit),
  `revokePendingActionsByTask(taskId, fromStatuses: string[], client?): Promise<number>` — bulk plan-level revocation: a
  SINGLE atomic `updateMany` cancelling EVERY action of the plan whose current status is in `fromStatuses`,
  returning the number of rows transitioned,
  `createMfaChallenge(input, client?)` (`maxAttempts` default 3),
  `getMfaChallenge(actionId, client?)`, `incrementMfaAttempts(actionId, client?)`,
  `updateMfaChallengeStatus(actionId, status, client?)`, `resetMfaAttempts(actionId, client?)` (sets `attempts` 0).
- `index.ts` — namespace barrel: `users, accounts, transactions, contacts, cards, subscriptions, investments, budgets, tasks, scheduledTasks, auditLogs, securityEvents, sessions, pendingActions`.

## JSON-text columns (serialize with `toJson` / parse with `safeParse`)

`AgentTaskNode.args|condition|dependencies|output`, `ScheduledTask.payload`,
`PendingAction.argsJson|summaryJson`, `AgentSession.stateJson`, `AuditLog.toolResult`.

## Constraints

- Import `prisma` **only** from `../client`. Never instantiate `new PrismaClient()` here.
- Input DTOs live in the module that owns them; reuse `lib/contracts` types (`RiskLevel`,
  `PendingActionSummary`, `PendingActionStatus`, `TaskCondition`, `AuditEntry`, `SecurityEvent`) instead of redefining them.
- No risk/permission logic — repositories are dumb persistence only.
- `pendingAction.ts` is the ONE aggregate whose functions take the optional trailing
  `client: Prisma.TransactionClient = prisma`; the default must stay the `../client` singleton so existing
  callers compile and behave identically. This parameter exists purely to compose the cancel/authorize flow
  into one transaction — never replace a `claim*`/`revoke*` CAS with a read-modify-write to achieve it.
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
- `./task.ts` → AgentTask + AgentTaskNode (+ the `claimTaskStatus` status CAS with an optional `fenceToken`, the `claimTaskExecution`/`claimNodeExecution` exactly-once execution claims + matching token-checked `release*`, and the token-fenced `updateTaskNode` overload that returns a `null` "lost" sentinel)
- `./scheduledTask.ts` → ScheduledTask
- `./auditLog.ts` → AuditLog
- `./securityEvent.ts` → SecurityEvent
- `./session.ts` → AgentSession
- `./pendingAction.ts` → PendingAction + MfaChallenge (+ plan-scoped `listPendingActionsByTask` / `revokePendingActionsByTask`, the `getPendingActionPlanLink` reader, and the optional-`client` transaction-composable variants of every function)
- `./index.ts` → namespace barrel

## Notes for Agents

- `npx prisma generate` must run before this code is executed or type-checked.
- Date/time ranges are half-open `[from, to)`. Time-series lists (transactions, audit logs, security
  events, pending actions, sessions) return newest-first; list `limit`s default to 100 where optional.
  Plan-scoped lists (`listPendingActionsByTask`) are the exception: oldest-first, no default limit.
- `AgentTaskNode.(taskId,nodeId)` is not a DB unique constraint — `getTaskNode` and the UNFENCED `updateTaskNode`
  route through the first row (ordered by `order`) matching the pair, while the FENCED `updateTaskNode`,
  `claimNodeExecution` and `releaseNodeExecution` address the pair with an `updateMany` that therefore targets
  ALL rows for it (normally exactly one).
- Concurrency guards are CAS-only and convention-enforced — there is NO DB-level enum or terminal-state
  constraint. The atomic gates are the `claim*` / `revoke*` primitives: `claimTaskStatus` (AgentTask status),
  `claimPendingAction` (PendingAction status), `claimTaskExecution`/`releaseTaskExecution` (plan executor slot),
  `claimNodeExecution`/`releaseNodeExecution` (node executor slot) and `revokePendingActionsByTask` (bulk
  plan-level cancel). The plain setters `updateTaskStatus` / `updateTaskNodeStatus` / `updatePendingActionStatus`
  are blind unconditional `update`s that would happily regress a terminal (`cancelled`/`success`) row.
  Never use a plain setter for a transition that must respect terminal state — use the `claim*` CAS with a
  non-terminal `from` (a status not in `from` matches 0 rows → returns `false`).
- Transaction composability (`pendingAction.ts` only): pass `client` to the readers / setters / CAS so several
  calls become atomic together, e.g.
  `prisma.$transaction(tx => { revokePendingActionsByTask(taskId, ['pending'], tx); return claimPendingAction(input, tx); })`.
  Supplying `client` never changes any function's semantics — the CAS gates stay single-statement `updateMany`s.
- Node execution claims ARE supported (`claimNodeExecution`/`releaseNodeExecution`) in addition to the PARENT
  `AgentTask` claim (`claimTaskStatus`/`claimTaskExecution`); the stale-takeover path (`staleBefore`) only
  matches rows whose `executionClaimedAt` is non-NULL and older, so a set token with a NULL `executionClaimedAt`
  is not reclaimable (fail-safe). The UNFENCED node writes (`updateTaskNode` without `opts`, `updateTaskNodeStatus`)
  resolve `firstNodeId` and THROW if the node is absent.
- Token fencing prevents a stale "zombie" executor from overwriting a takeover's result: pass the CURRENT
  executor's token as `opts.fenceToken` to `updateTaskNode` (returns the `null` "lost" sentinel on a lost claim)
  and to `claimTaskStatus` (returns `false` on a lost claim).
- The fence condition is ALWAYS part of the SAME single `updateMany` statement as the write (never a
  read-then-write), so the check cannot be lost to a race between reading the token and writing.
- `releaseTaskExecution`/`releaseNodeExecution` are also token-checked — only the owning token clears the slot,
  so a non-owner release is a no-op.
- `./agent` owns the wiring: `persistNode`/`persistPlan` must pass the current executor's token and skip writes
  (no re-persist, no narration of a result it no longer owns) when a fenced write returns `null`.
- Every `status` column is a plain `String` (SQLite). The `prisma/schema.prisma` field comments list
  DIFFERENT status values than the frozen contract enums (`TaskPlanStatus`/`TaskNodeStatus`/`PendingActionStatus`
  in `lib/contracts`) — the contract enums are authoritative; the schema comments are non-normative.
- A `PendingAction` is revoked (superseded/cancelled) either per-action by claiming `to: 'cancelled'`
  (`claimPendingAction`) / via the blind `setPendingActionStatus`/`updatePendingActionStatus`, or in bulk for a
  whole plan via `revokePendingActionsByTask(taskId, fromStatuses)` (single atomic `updateMany`).
