# 数据仓储

## 职责与入口

仓储负责查询、持久化和条件更新。
权限策略由 `security/` 判断。
业务事务由执行层组合。

| 模块 | 数据职责 |
| --- | --- |
| `account.ts`、`transaction.ts` | 余额、流水与聚合 |
| `contact.ts`、`card.ts` | 联系人、卡片与分类限额 |
| `investment.ts` | 产品、持仓与赎回结果 |
| `budget.ts`、`subscription.ts` | 预算与订阅 |
| `session.ts` | 会话与持久化状态 |
| `task.ts` | 完整任务图、节点与执行认领 |
| `pendingAction.ts` | 待处理操作、验证码挑战与计划关联 |
| `executionReceipt.ts` | 原始执行回执 |
| `auditLog.ts`、`securityEvent.ts` | 审计与安全事件 |
| `manualReview.ts`、`circuitBreaker.ts` | 人工接管与持久化熔断 |
| `scheduledTask.ts` | 定时记录与通知 |
| `agentRun.ts` | 运行、模型请求、事件与工具调用 |
| `workflowRun.ts`、`workflowInvocation.ts` | 独立任务图的运行与调用 |

`index.ts` 导出业务仓储命名空间。
运行与任务图仓储也可通过模块路径导入。

## 事务与状态

- 客户端与事务规则见 [../CONTEXT.md](../CONTEXT.md)。
- 组合原子操作时，必须使用同一事务客户端。
- 必须保留认领与撤销语句中的状态和身份条件。
- 执行权更新必须保留令牌与代次校验。
- 普通状态赋值不能代替条件认领。
- JSON 文本列由调用方解析，结构化写入使用 `toJson`。

`createTaskGraph` 在事务中保存完整任务图，本身不做计划校验（校验由调用层完成）。
其幂等性依赖 `AgentTask @@unique([runId, parentInvocationId])` 与 `AgentTaskNode @@unique([taskId, nodeId])`；节点 `order` 取入参数组下标，`runId` 为空时创建独立运行。
`claimTaskExecution` 与 `claimNodeExecution` 认领执行权。
释放与节点写入必须匹配持有的令牌。

## 串行连接、事务与等待成本

整个 `lib/db/` 只有一条原生 SQLite 连接，`lib/db/serialized-connection.ts` 的 `ConnectionMutex` 是一条 FIFO promise 链：`acquire()` 里 `await previous` **没有任何超时**，`startTransaction` 在拿到锁之前一直挂着。因此本目录的等待上限由「锁何时释放」决定；`maxWait`/`timeout` 是否会打断互斥锁的排队**未经验证，不要假设它们能**。适配器与 Prisma 选项写死在 `lib/db/database.ts`：`new BankingSqliteAdapter({ url, timeout: 10000 })`（better-sqlite3 busy timeout）与 `transactionOptions: { maxWait: 10000, timeout: 10000 }`。
本目录**没有任何** `$transaction` 传 `maxWait`/`timeout`/`isolationLevel`：全部只传回调，全部走默认 10 s / 10 s。
数据库「周期入口」不统一：`account.ts`/`transaction.ts`/`card.ts`/`budget.ts`/`subscription.ts`/`investment.ts`/`scheduledTask.ts`/`contact.ts` 与 `executionReceipt.ts` 的默认参数走 `dbClient()`（即 `lib/db/unit-of-work.ts` 的 `currentTransaction()`，能加入当前事务），而 `agentRun.ts`/`task.ts`/`session.ts`/`workflowInvocation.ts`/`workflowRun.ts`/`auditLog.ts`/`securityEvent.ts`/`user.ts` 直连全局 `prisma`，`pendingAction.ts` 与 `circuitBreaker.ts` 的默认参数是 `prisma` 而非 `dbClient()`：在 `withinTransaction` 作用域内不显式传 client 就不会加入该事务，会去排队等同一把互斥锁。

`$transaction` 分布（全部无选项）：`agentRun.ts` 19 处 —— `:39` `beginAgentRun`、`:93` `renewAgentRunLease`、`:118` `appendRuntimeEvent`、`:140` `startInvocationWithEvent`、`:162` `finishInvocationWithEvent`、`:181` `updateInvocationAuthorization`、`:191` `finishAgentRun`、`:251` `synchronizeRunActionInvocations`、`:260` `finalizeReceiptedAgentRun`、`:313` `saveRunCheckpoint`、`:322` `startModelRequest`、`:341` `completeModelRequest`、`:355` `commitRunSession`、`:381` `settlePlanInvocation`、`:392` `scheduleRunRecovery`、`:407` `stopObsoleteRun`、`:429` `restoreInvocationFromReceipt`（仅 `if (!client)`）、`:445` `claimInvocationRetry`、`:456` `settleRecoveredInvocation`；`workflowInvocation.ts` 3 处 —— `:34`/`:93`/`:109`；`circuitBreaker.ts` 2 处 —— `:92` `return client ? apply(client) : prisma.$transaction(apply)`、`:162` `return opts?.client ? run(opts.client) : prisma.$transaction(run)`；`task.ts` 2 处 —— `:226` `releaseTaskExecution` 用全局 `prisma.$transaction`，`:90` `createTaskGraph` 是 `return '$transaction' in client ? client.$transaction(persist) : persist(client)`；`session.ts` `:78`；`pendingAction.ts` `:260`；`workflowRun.ts` `:43` 同为 `'$transaction' in client ? client.$transaction(synchronize) : synchronize(client)`。
`'$transaction' in client` 是鸭子类型判别：全局 `PrismaClient` 命中 → 新开交互事务（排队等互斥锁），`Prisma.TransactionClient` 句柄（Prisma 从 `TransactionClient` 上去掉了 `$transaction`）→ 内联沿用调用方事务；因此同一个函数有两条代价不同的路径。

单函数内多次串行 await（不在事务中时每次都要排一次互斥锁）：`agentRun.ts:295 listRecoverableAgentRuns` 2 次（`agentTask.findMany` → `agentRun.findMany`，非原子）；`agentRun.ts:285 listPresentationEvents` 2 次；`agentRun.ts:82 assertAgentRunLease` 2 次读取，且被每个写事务各调用一次；`agentRun.ts:240 settleRunActionInvocations` 2 次 + 每个已结算动作 5 次（`settleInvocationFromAction` 的 2 读 + 1 写 + 事件 update+create）；`agentRun.ts:259 finalizeReceiptedAgentRun` 约 5 + 5N；`agentRun.ts:36 beginAgentRun` 8–11 条同事务语句；`workflowInvocation.ts:33 beginWorkflowInvocation` 10–14 条同事务语句（另加 `runtimeFence` 自身）；`task.ts:192 claimTaskExecutionWithGeneration` 2 次（`updateMany` → `findUnique`，非原子）；`task.ts:321 updateTaskNode`（带 `fenceToken`）2 次非原子；`session.ts:45 updateSessionState` 2 次非原子（CAS 后 `findUniqueOrThrow`）；`account.ts:52 incrementBalance` 2 次非原子（靠 `where: { id, balanceMinor: row.balanceMinor }` 做值栅栏）；`pendingAction.ts:276 assertActionMayStart` 3 条；`circuitBreaker.ts:68`/`:140` 各 2 条（`findUnique` + `upsert`，未传 client 时自己包一个事务）。

显式「空写抢锁」语句（只为取得 SQLite 写者，不做业务变更，锁持有到事务结束）：`pendingAction.ts:277 await client.pendingAction.updateMany({ where: { id: actionId }, data: { id: actionId } });`、`contact.ts:28 const locked = await dbClient().user.updateMany({ where: { id: userId }, data: { id: userId } });`（`lockContactOwner`）、`workflowInvocation.ts:37 await tx.agentTask.updateMany({ where: { id: input.taskId }, data: { generation: { increment: 0 } } });`。

## 计划节点的读取与写入原语

节点行只由 `createTaskGraph`（`task.ts:55`）的嵌套 create 建立；`createTaskNode`（`task.ts:235`）当前无调用方。
`updateTaskNode`（重载 `task.ts:284`/`:289`/`:295`）是唯一的节点结果写入原语：
无令牌时 `update`，`where: { taskId_nodeId: { taskId, nodeId } }`，Prisma `P2025` 转 `NOT_FOUND`；
传 `opts.fenceToken` 时单条 `updateMany`，`where: { taskId, nodeId, executionToken: fenceToken }`，匹配 0 行返回 `null`（执行权已丢失，不是"节点不存在"）。
它只写 `status`、`output`（`toJson` 文本）、`error`（原样字符串）、`startedAt`、`endedAt`；`UpdateTaskNodeInput` 没有 `name`/`tool`/`summary`。
`AgentTaskNode` 无 `summary` 列，`TaskNodeResult` 也无 `summary` 字段：执行器的 summary 只能通过 `output`（如 `{ summary }`）落库。
`updateTaskNodeStatus`（`task.ts:333`）是无条件 `update`（`where: { taskId_nodeId: ... }`, `data: { status }`），当前无调用方。
`updateTaskStatus`（`task.ts:112`）同样是无条件赋值；`AgentTask` 的条件状态迁移统一走 `claimTaskStatus`（`task.ts:140`，单条 CAS）。
`error` 与 `output` 没有长度上限或截断：SQLite TEXT 原样保存，仓储层不做校验。
本目录没有"整份计划快照 + 全部节点"的整体回写函数：`createTaskGraph` 只 create，快照写入端口（`persistPlan`/`persistNode`/`loadPlan`）在 `agent/workflows/persistence.ts`。
读回形状由 `agent/workflows/persistence.ts:12 toTaskPlan` 与 `app/api/_lib/task-plans.ts:92 toTaskPlan` 提供，两者都用 `safeParse` 解码 JSON 文本列。
释放与节点写入必须匹配持有的令牌。

`PendingAction.taskId/nodeId` 在创建时保存计划关联。
`revokePendingActionsByTask` 撤销指定状态的关联操作。
待处理操作的批量读取只有两条路径，且默认都不按状态过滤：`listPendingActions`（`pendingAction.ts:121-137`，可选 `sessionId`、`status`（单值等值，不是 `in` 列表）、`limit`，缺省 `DEFAULT_LIMIT = 100`（`:85`），`orderBy: { createdAt: 'desc' }`）与 `listPendingActionsByTask`（`:145-157`，按 `taskId`，可选 `statuses` 用 `in`，`createdAt: 'asc'`，无 `take`）。
因此 `listPendingActions({ sessionId })` 会把 `locked`/`executed` 等终态行一并返回：把 `locked` 排除出「待决策」列表是调用方的责任（`app/api/actions/route.ts#attentionFor` 让 `locked` 走兜底 `return undefined`），不要把它下沉成仓储默认行为。
关联不依赖节点输出中的临时字段。
`claimPendingAction`（`pendingAction.ts:255-273`）是唯一的待处理操作状态 CAS：单条 `updateMany`，`where` 为 `id` + `status IN input.from`，可选 `userId`/`sessionId`，`data: { status: input.to }`；**返回 `boolean`（`result.count === 1`），返回行数而非行**。
`to === 'confirmed'` 时先经过 `assertActionMayStart`（人工接管栅栏，`manualReview status='open'` 抛 `CONFLICT`），且此时若 `client === prisma` 会自行 `prisma.$transaction(tx => claimPendingAction(input, tx))` 重入；其它 `to` 值（含 `'locked'`）不走该分支。
`from`/`to` 取值由调用方给定，函数本身不限制（`to` 只受 `PendingActionStatus` 类型约束，运行时任意字符串可写入）。
无版本号、无时间戳、无租约守卫：CAS 条件只有 `id` + `status IN from`（+ 可选身份）。
不显式写 `updatedAt`：`PendingAction.updatedAt` 是 schema `@updatedAt`（`prisma/schema.prisma:463`），Prisma 在每条 `update`/`updateMany` 时自动刷新，因此任何状态迁移（含 `claimPendingAction`）都会 bump `updatedAt`。
`claimPendingActionLease`（`pendingAction.ts:206`）的租约 CAS 前置条件用 `OPEN_PENDING_ACTION_STATUSES`：`locked` 及任何终态都拿不到执行租约。
`PendingAction.status` 是 Prisma 无枚举的 `String @default("pending")`（`prisma/schema.prisma:426`），合法取值由 `contracts/security.ts` 的 `PendingActionStatus` 与状态词表常量约束（`OPEN_PENDING_ACTION_STATUSES` / `TERMINAL_PENDING_ACTION_STATUSES` / `SETTLED_PENDING_ACTION_STATUSES` / `RUN_BLOCKING_PENDING_ACTION_STATUSES`，含 `locked`、`needs_reconciliation`）。
本目录没有写入 `status:'locked'` 的语句（`locked` 由 `security/security-gateway.ts` 经 `claimPendingAction` 的 CAS 与 `persistLockedAction` 写入）；`renewLockedMfaChallenges`（`pendingAction.ts:363`）只重置 `MfaChallenge.status='locked'`，其 where 条件要求 `action.status='awaiting_mfa'`，且只写 `MfaChallenge`，从不改 `PendingAction.status`。
本目录内能写入 `PendingAction.status` 的语句只有四处：`createPendingAction`（`:87`，`status: input.status ?? 'pending'`，`:100`，仅新建行）、`claimPendingAction`（`:255`，CAS）、`updatePendingActionStatus`/`setPendingActionStatus`（`:182`/`:195`，无条件 `update`，可把 `locked` 改成任意值，包括 `pending`/`awaiting_mfa`；两者当前无任何生产调用方，唯一调用点是 `tests/unit/lib/pendingAction.claim.test.ts:132`）、`revokePendingActionsByTask`（`:170`，只写 `cancelled`）。
本目录之外仍有直接写 `PendingAction.status` 的语句（绕过上述四个函数）：`security/security-gateway.ts`（`:1296`/`:1370` 计划取消回滚 `cancelled`、`:1385` 升级 `awaiting_mfa`、`:1487` 升级 `updateMany`）、`security/recovery-authorization.ts`（`:39` 写者槽、`:64` 升级 `awaiting_mfa`）、`security/manual-card-management.ts`（`:197` CAS 后 `:202` 写 `executed`+`resultJson`、`:220` `cancelled`）、`agent/manual-review.ts:210`、`agent/cancellation-evidence.ts:49`、`agent/execution-fence.ts:227`（所有权栅栏），因此 `claimPendingAction` 不是唯一的 `PendingAction.status` 写入路径。
写入侧因此仍缺一道围栏：通用 setter 不校验来源状态，状态词表只约束读取与认领路径（`claimPendingActionLease`、`resetConversation`、run 结算）。
两个租约写入函数只写租约列，不改状态；`clearPendingActionLease`（`:231`）在给定 `opts.owner` 时按持有者条件清除。
`assertActionMayStart`（`pendingAction.ts:276`）不改状态：它先对 `id` 发一条空写 `updateMany({ where: { id: actionId }, data: { id: actionId } })` 取得 SQLite 行锁，再读 `taskId`，存在 `manualReview status='open'` 时抛 `CONFLICT`。

## 每次调用的数据库往返次数

一条 Prisma 语句记一次往返；`prisma.$transaction` 另加 BEGIN 与 COMMIT，且整段持有连接互斥锁（见 [../CONTEXT.md](../CONTEXT.md)）。
`createPendingAction`（`pendingAction.ts:91`）1 条 create；`getPendingAction`（`:115`）2 条（`findUnique` + `include: { mfa: true }`：仓库未启用 `relationJoins`，走默认 `query` 关系加载策略，关联查询是独立的一次 SELECT）；`listPendingActionsByTask`（`:150`）1 条 findMany。
`getMfaChallenge`（`:334`）、`createMfaChallenge`（`:319`）、`incrementMfaAttempts`（`:341`）、`updateMfaChallengeStatus`（`:352`）、`resetMfaAttempts`（`:359`）各 1 条，无事务、无二次读。
`assertActionMayStart`（`:276`）最多 3 条：空写 `updateMany`（先取 SQLite 行锁）、`findUnique` 读 `taskId`、仅 `taskId` 非空时再 `manualReview.findFirst`；`client` 必传（无缺省单例）。
`claimPendingAction`（`:255`）：`to !== 'confirmed'` 时 1 条 updateMany（自动提交）；`to === 'confirmed'` 且 `client === prisma` 时自开 `prisma.$transaction`（`:260`）→ BEGIN + 上述 2–3 条 + CAS updateMany + COMMIT，合计 5–6 次往返；显式传 client 时不开新事务，复用调用方事务里的 3–4 条。
`getSession`（`session.ts:26`）、`getUser`（`user.ts:5`）、`getBreakerState`（`circuitBreaker.ts:49`）各 1 条 findUnique，都接受可选 client 以改走已有事务。
`upsertFailure`（`circuitBreaker.ts:68`）未传 client 时自开 `prisma.$transaction`（`:92`），事务内 `findUnique` + `upsert` 共 2 条；传 client 时同样 2 条但复用调用方事务。
本目录的 `$transaction` 调用都不传选项对象：`maxWait: 10000` / `timeout: 10000` 来自 `../database.ts:25` 的 `transactionOptions`，没有逐调用覆盖；本目录也没有 P2034/P1008 重试循环。
chat 同步路径上的运行仓储往返次数（`appendInTransaction`（`agentRun.ts:111`）= 2 条：`agentRun.update` 递增 `nextSequence` + `agentRunEvent.create`；`assertAgentRunLease`（`:82`）固定 2 条 `findUnique`；每个自开的 `$transaction` 另加 BEGIN/COMMIT 两次往返，且整段持有单连接互斥锁）：
`beginAgentRun`（`:36`）新建路径 6 条 → 8 次往返（会话 `findUnique`、按 `sessionId_requestId` 的 `agentRun.findUnique`、`agentRun.create`、会话租约 CAS `updateMany`、`appendInTransaction` 2 条）；复用路径 +2（`markInterruptedInvocations` 的 2 条 `updateMany`，仅当 `existing` 存在）；接管过期旧运行的最坏路径 11 条 → 13 次往返（多出 `agentRun.updateMany` 置 `interrupted` + 2 条 `markInterruptedInvocations`）；`requestId` 与 `existingRunId` 都缺失时少 1 条读。
`appendRuntimeEvent`（`:117`）4 条 → 6 次往返；`commitRunSession`（`:354`）5 条 → 7 次往返（2 条 assert + 会话 `updateMany` CAS + `modelRequest.findFirst` + `agentRun.update`，**不**追加事件）。
`startInvocationWithEvent`（`:139`）5 条、`finishInvocationWithEvent`（`:161`）5–6 条、`updateInvocationAuthorization`（`:180`）3 条、`finishAgentRun`（`:190`）7–10 条，各自再 +2 次 BEGIN/COMMIT。
`settleRunActionInvocations`（`:240`）是唯一的按行循环：`for (const action of actions) await settleInvocationFromAction(action.id, client)`（`:246`），每轮 2–3 条语句且全部在调用方同一事务内，因此 k 个已结算关联动作 = 2 + 3k 条往返，并让该事务与互斥锁持有时间随 k 线性增长。
本目录没有任何等待型租约：租约与 CAS 冲突一律 fail-fast（`beginAgentRun:66-70` 的 `claimed.count !== 1` 抛 `CONFLICT`、`claimPendingAction:263-272` 返回 `false`），没有 `while` / `for(;;)` / 重试计数 / 轮询 `leaseExpiresAt` 的循环；`scheduleRunRecovery:397` 的 `new Date(Date.now() + 1000 * 2 ** run.recoveryAttempts)` 与 `finishAgentRun:200` 的 `Date.now() + 2000` 只是写入 `nextRecoveryAt` 供 `listRecoverableAgentRuns:304` 比较，从不 `sleep`。
`claimPendingAction`（`pendingAction.ts:255`）在 `to === 'confirmed'` 且 `client === prisma` 时自开 `prisma.$transaction`（`:260`）：它既不读 `unit-of-work.ts#currentTransaction()`，默认参数也是单例，因此在已有 ALS 事务内部不传 `client` 调用它会试图在单连接上再开一个事务（第二个 `startTransaction` 排在互斥锁队尾），这是调用方必须避免的组合。
`session.ts` 无 `loadSession`：读取入口是 `getSession`（`:26`，1 条 `findUnique`）；`ensureDemoSession`（`:30`）是 `update: {}` 的单条 upsert；`updateSessionState`（`:45`）先一条带可选 `revision` 条件的 `updateMany`，`count !== 1` 立即抛 `CONFLICT`（`:54`），随后用另一次不在同一事务里的 `findUniqueOrThrow`（`:55`）回读——回读可能已看到更高 revision，且两语句之间不持事务。

## MFA challenge 仓储原语（`pendingAction.ts`）

`createMfaChallenge`（`pendingAction.ts:315-328`，入参 `CreateMfaChallengeInput` `:50-56`）是本目录唯一的建行函数：必填 `actionId`、`code`，可选 `maxAttempts`、`expiresAt`、`commandDigest`。
落库兜底：`maxAttempts: input.maxAttempts ?? 3`（`:323`）、`expiresAt: input.expiresAt ?? new Date(Date.now() + 5 * 60_000)`（`:324`）；`commandDigest` 原样透传（可不传，落到模型可空列）；`attempts` 与 `status` 从不写，由 schema 默认 `0` / `'pending'`（`prisma/schema.prisma:476`/`:478`，`maxAttempts` 默认 `3` 在 `:477`）。
默认 `expiresAt` 在函数内部设置，硬编码 5 分钟字面量，不 import `security/`（本文件不依赖业务安全层），因此 `security/mfa.ts:34` 的 `MFA_CHALLENGE_TTL_MS` 与本文件是两份独立字面量，改常量不传导到默认值。
默认 TTL 用 `Date.now()`，安全层用 `realNow()`（`lib/clock.ts`），两者是不同时钟入口。
`getMfaChallenge`（`:330-335`）是 `findUnique({ where: { actionId } })`：按 `actionId`（schema `@unique` 且 `onDelete: Cascade`，`schema.prisma:473`/`:474`）查，至多一条，无状态过滤，不与 action 联查。
`incrementMfaAttempts`（`:337-345`）单条 `update` + `attempts: { increment: 1 }`：自增是原子的，但没有状态/代次/`expiresAt` 条件（不是 CAS），返回更新后的整行（可直接用于 `attemptsLeft = maxAttempts - attempts`，无需二次读）。
`updateMfaChallengeStatus`（`:347-353`）与 `resetMfaAttempts`（`:355-360`）都是无条件 `update({ where: { actionId } })`，只写目标列，不改 `expiresAt`/`code`/`commandDigest`/`verifiedAt`/`consumedAt`，也不改 `PendingAction.status`；`status` 取值为自由字符串，仓储不校验。
`renewLockedMfaChallenges`（`:363-379`）是唯一的续期/复活语句：单个 `updateMany`，过滤 `status: 'locked'` 且关联 `action` 满足（有 `userId` 时按 `userId`，否则按 `sessionId`）＋ `status: 'awaiting_mfa'` ＋ `requiresMfa: true`；写入 `attempts: 0`、`status: 'pending'`、`expiresAt: new Date(Date.now() + 5 * 60_000)`、`verifiedAt: null`、`consumedAt: null`，返回匹配行数 `count`。
该续期不改 `PendingAction.status`、不重签 `code`、不校验 `commandDigest`；它要求显式传入 `client`（无默认单例），只在账号解锁事务内调用（调用点 `security/circuit-breaker.ts:298-300`，仅 `prior?.locked` 为真时）；其 where 要求父 action 仍为 `awaiting_mfa`，因此已被 CAS 成 `locked` 的 `PendingAction` 不会被它复活。
本文件内没有任何 `prisma.mfaChallenge.*` 直接调用，全部走 `client.mfaChallenge.*`：`:319` create、`:334` findUnique、`:341`/`:352`/`:359` update、`:367` updateMany。

## 重试、退避与租约常量（本目录内）

本目录**没有任何进程内重试、`sleep`、`setTimeout`、`setInterval`、抖动、轮询或 `waitFor*`/`awaitUntil`/看门狗**：这些标识符在这些文件里一次都不出现。唯一的循环是 `agentRun.ts:246 for (const action of actions) await settleInvocationFromAction(action.id, client);`（串行结算，无上限常量、无延迟）与 `auditLog.ts:181`/`transaction.ts:80` 的纯内存 `for (const row of rows)`。
重试是**持久化**的（外部 worker 读时间戳再次进入），不是本目录里循环：`agentRun.ts:329 if (previous.attempt >= previous.maxAttempts) throw new AppError('CONFLICT', 'Model request retry limit reached');`、`agentRun.ts:447` CAS `attempt: expectedAttempt` + `maxAttempts: { gt: expectedAttempt }` + `status: { in: ['interrupted', 'failed'] }`、`workflowInvocation.ts:96 where: { id, attempt: claim.invocation.attempt, status: claim.invocation.status }`。
退避字面量：`agentRun.ts:200 nextRecoveryAt: new Date(Date.now() + 2000)`（`finishAgentRun` 把 `MODEL_TRANSIENT` 失败降级为 `interrupted` 的固定 2 s）；`agentRun.ts:397 nextRecoveryAt: retryable ? new Date(Date.now() + 1000 * 2 ** run.recoveryAttempts) : null`（`scheduleRunRecovery` 的指数退避：底数 1000 ms、倍数 2^`recoveryAttempts`，**无上限、无抖动**）；到期判定在 `agentRun.ts:304 { OR: [{ nextRecoveryAt: null }, { nextRecoveryAt: { lte: now } }] }`，`now` 默认 `new Date()`。
租约/到期常量：`agentRun.ts:11 const DEFAULT_LEASE_MS = 120_000;`（`beginAgentRun` 可被 `input.leaseMs` 覆盖，`renewAgentRunLease` 默认用它）；`agentRun.ts:8` 导入的 `WORKFLOW_EXECUTION_LEASE_MS` 值为 `600_000`（`lib/contracts/runtime.ts:2`），用于 `agentRun.ts:299 executionClaimedAt: { lt: new Date(now.getTime() - WORKFLOW_EXECUTION_LEASE_MS) }`。
租约到期的写入用 `agentRun.ts:61 new Date(now.getTime() + leaseMs)` 与 `:95 new Date(Date.now() + leaseMs)`（即 `Date.now()`/入参 `now`，不经过 `lib/clock.ts`）；到期读取是 `agentRun.ts:85-86 (!allowExpired && run.leaseExpiresAt <= now)` 与 `(!allowExpired && session.runLeaseExpiresAt <= now)`，`allowExpired = true` 只在 `finishAgentRun`（`:192`）出现；占用判定是 `agentRun.ts:52 session.runLeaseExpiresAt > now`。
`pendingAction.ts:206 claimPendingActionLease` 自身不含 TTL：`expiresAt` 与 `now` 都由调用方传入，过期条件是 `executionLeaseExpiresAt: { lte: lease.now }`（注释指向 agent 层的 `EXECUTION_LEASE_TTL_MS`）；`clearPendingActionLease`（`:231`）无条件清空两列。`task.ts:179 claimTaskExecution` 与 `:353 claimNodeExecution` 的 `opts.staleBefore` 同样由调用方给定，本目录无默认陈旧窗口。
`circuitBreaker.ts` 只持久化 `lockedAt`，不含冷却时长（`RESET_COOLDOWN_MS` 在 `lib/constants.ts`，由 `security/circuit-breaker.ts` 施加）。
分页/扫描上限常量：`pendingAction.ts:85`、`auditLog.ts:53`、`securityEvent.ts:33` 的 `DEFAULT_LIMIT = 100`；`agentRun.ts:287 take: Math.min(Math.max(limit, 1), 501)`；`agentRun.ts:295 listRecoverableAgentRuns(now = new Date(), limit = 100)`。
错误码嗅探只有一处：`task.ts:314 error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025'` → `NOT_FOUND`。本目录**没有**任何 `SQLITE_BUSY` / `database is locked` / `P2034` / `Transaction already closed` 的字符串匹配或 catch-重试；`executionReceipt.ts:38` 的注释说明 `P2002` 故意不在此处捕获（由调用方识别为「已commit 的同 key 胜者」并重放）。

## Agent 运行租约与恢复（`agentRun.ts`）

- 默认租约时长 `DEFAULT_LEASE_MS = 120_000`（`agentRun.ts:11`）。
- `beginAgentRun(input)`（`:36`）在一个事务内准入请求并夺取会话执行租约：校验会话归属、`status='active'`、`expectedRevision`，按 `sessionId_requestId` 或 `existingRunId` 找到已有运行（`requestDigest` 不同即 `CONFLICT`，`recover` 需 `baseRevision` 与 `recoveryAttempts` 均满足），再用 `agentSession.updateMany` 以 `{ id, userId, activeRunId: session.activeRunId, runLeaseToken: session.runLeaseToken, runLeaseExpiresAt: session.runLeaseExpiresAt }` 为条件 CAS 写入新 `randomUUID()` 令牌，`count !== 1` 抛 `CONFLICT`。
- 复用分支（`:63`）以 `where: { id: existing.id }` 无条件写 `status:'running'` 与新令牌；其状态闸门在前面的 `:51`：只有 `running`/`interrupted`（或 `recover` 且 `failed`）能进入，其余直接 `reused` 返回。`recover` 时 `recoveryAttempts` 自增。
- 已过期的旧运行时在 `:57` 被置为 `interrupted` 并清空 `leaseToken`/`leaseExpiresAt`；未过期且指向别处时抛 `CONFLICT`。
- `assertAgentRunLease(lease, client, now = new Date(), allowExpired = false)`（`:82`）是唯一令牌栅栏：要求 `run.status==='running'`、`run.leaseToken===lease.token`、`leaseExpiresAt` 未过期，且会话 `revision===run.baseRevision`、`activeRunId`/`runLeaseToken`/`runLeaseExpiresAt` 与租约一致，否则抛 `CONFLICT`。事件、调用、模型请求、检查点与会话提交的写函数都先经过它，被接管的旧持有者因此无法追加。
- `renewAgentRunLease(lease, leaseMs = DEFAULT_LEASE_MS)`（`:92`）心跳同时刷新 `AgentRun.leaseExpiresAt` 与 `AgentSession.runLeaseExpiresAt`；`verifyAgentRunLease`（`:101`）只校验。
- `finishAgentRun(lease, status, errorCode?)`（`:190`）以 `allowExpired = true` 收尾（只认令牌），写终态、清空 `leaseToken`/`leaseExpiresAt`，并按 `{ id, activeRunId: lease.runId, runLeaseToken: lease.token }` 释放会话租约。`MODEL_TRANSIENT` 且未达 `maxAttempts` 时把 `failed` 降级为 `interrupted` 并写 `nextRecoveryAt`。
- `listRecoverableAgentRuns(now = new Date(), limit = 100)`（`:295`）只返回：`checkpointStage` 为 null 或非 `workflow_only`（`workflow_only` 还需其外层 `AgentTask` 满足 `status in (pending, running)`、`parentInvocationId: null`、无 `open` 人工接管、执行认领为空或早于 `WORKFLOW_EXECUTION_LEASE_MS`）、`nextRecoveryAt` 为空或已到期、`recoveryAttempts < maxRecoveryAttempts`（字段级比较）、`recoveryErrorCode` 不为 `RECONCILIATION_REQUIRED`/`WORKFLOW_REQUIRES_ATTENTION`/`CHECKPOINT_MISSING`，且状态为 `interrupted` 或（`running` 且租约缺失/已过期）；按 `startedAt` 升序取 `limit`。
- `scheduleRunRecovery`（`:391`）、`parkRunRecovery`（`:401`）、`stopObsoleteRun`（`:406`）、`finalizeReceiptedAgentRun`（`:259`）都跳过 `running`、终态与 `waiting_*` 运行，不做抢占。
本文件对 `PendingAction` 只读、从不写状态：`findMany`、`count`、`findUnique` 三类查询；动作状态由 `settleInvocationFromAction` 单向反向同步到 `ToolInvocation`。
`settleInvocationFromAction(actionId, client)`（`agentRun.ts:466`）的映射：`executed`（且 `catalogEntry(toolName).effect === 'read'`，结果必须 `{ok:true}`）→ `completed`；`cancelled` → `cancelled`；`failed` → `failed` + `TOOL_FAILED`；`locked` → `failed` + `MFA_LOCKED`（明确的拒绝，不是"结果未知"，因此绝不用 `needs_reconciliation`）；`needs_reconciliation` → `needs_reconciliation` + `COMMIT_STATE_UNKNOWN`。
它先校验身份（`invocation.run.sessionId/userId` 与 `action.sessionId/userId` 一致、`toolName` 一致，否则 `CONFLICT`），`invocation.status === 'completed'` 时早退，写入用 `status: { not: 'completed' }` 的 CAS，只有 `count === 1` 才追加 `invocation_settled_from_action` 事件。
私有 helper `settleRunActionInvocations(runId, sessionId, userId, client)`（`:240`）按 run 取 invocation，再取 `sessionId + userId + invocationId ∈ … + status ∈ SETTLED_PENDING_ACTION_STATUSES`（含 `locked`）的 action，逐个调用 `settleInvocationFromAction`；`synchronizeRunActionInvocations`（`:250`）与 `finalizeReceiptedAgentRun`（`:259`）共用它。
`finalizeReceiptedAgentRun` 在「所有 invocation 已终态」这条守卫**之前**先结算 linked 终态 action（含 `locked`），因此「唯一未决动作被锁定」的 run 能收尾为 `failed` / `errorCode = MFA_LOCKED`，而不会永久挂住。
它的 `outstanding` 统计用 `RUN_BLOCKING_PENDING_ACTION_STATUSES`（`locked` 按构造不阻塞）；其余守卫未放宽：跳过 `running`/`completed`/`checkpointStage === 'workflow_only'`，`checkpointJson` 存在且 `checkpointStage !== 'session_committed'` 时返回，`invocations.length === 0` 或仍有非终态 invocation 时返回，`completed` 但 `resultJson === null` 时返回。

锁定的结算路径由 `tests/unit/lib/agentRun.locked-settlement.test.ts` 覆盖（`locked` → invocation `failed` + `MFA_LOCKED`，run 收尾 `failed`）。
回执必须校验所有者、工具与输入摘要。
资金变化、审计和回执的事务边界见
[agent/CONTEXT.md](../../../agent/CONTEXT.md)。

验证使用隔离测试库，规则见
[tests/CONTEXT.md](../../../tests/CONTEXT.md)。
