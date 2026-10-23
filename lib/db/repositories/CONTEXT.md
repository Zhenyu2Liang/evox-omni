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

## MFA challenge 仓储原语（`pendingAction.ts`）

`createMfaChallenge`（`pendingAction.ts:314`，入参 `CreateMfaChallengeInput` `:49-55`）是本目录唯一的建行函数：必填 `actionId`、`code`，可选 `maxAttempts`、`expiresAt`、`commandDigest`。
落库兜底：`maxAttempts: input.maxAttempts ?? 3`（`:322`）、`expiresAt: input.expiresAt ?? new Date(Date.now() + 5 * 60_000)`（`:323`）；`commandDigest` 原样透传（可不传，落到模型可空列）；`attempts` 与 `status` 从不写，由 schema 默认 `0` / `'pending'`（`prisma/schema.prisma:455`/`:457`）。
默认 `expiresAt` 在函数内部设置，硬编码 5 分钟字面量，不 import `security/`（本文件不依赖业务安全层），因此 `security/mfa.ts:34` 的 `MFA_CHALLENGE_TTL_MS` 与本文件是两份独立字面量，改常量不传导到默认值。
默认 TTL 用 `Date.now()`，安全层用 `realNow()`（`lib/clock.ts`），两者是不同时钟入口。
`getMfaChallenge`（`:329`）是 `findUnique({ where: { actionId } })`：按 `actionId`（schema `@unique`，`schema.prisma:452`）查，至多一条，无状态过滤。
`incrementMfaAttempts`（`:336`）单条 `update` + `attempts: { increment: 1 }`：自增是原子的，但没有状态/代次条件（不是 CAS），返回更新后的整行。
`updateMfaChallengeStatus`（`:346`）与 `resetMfaAttempts`（`:354`）都是无条件 `update({ where: { actionId } })`，只写目标列，不改 `expiresAt`；`status` 取值为自由字符串，仓储不校验。
`renewLockedMfaChallenges`（`:362`）是唯一的续期/复活语句：单个 `updateMany`，过滤 `status: 'locked'` 且关联 `action` 满足（有 `userId` 时按 `userId`，否则按 `sessionId`）＋ `status: 'awaiting_mfa'` ＋ `requiresMfa: true`；写入 `attempts: 0`、`status: 'pending'`、`expiresAt: new Date(Date.now() + 5 * 60_000)`、`verifiedAt: null`、`consumedAt: null`，返回匹配行数 `count`。
该续期不改 `PendingAction.status`、不重签 `code`、不校验 `commandDigest`；它要求显式传入 `client`（无默认单例），只在账号解锁事务内调用（调用点 `security/circuit-breaker.ts:298-300`，仅 `prior?.locked` 为真时）。
本文件内没有任何 `prisma.mfaChallenge.*` 直接调用，全部走 `client.mfaChallenge.*`：`:318` create、`:333` findUnique、`:340`/`:351`/`:358` update、`:366` updateMany。

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
