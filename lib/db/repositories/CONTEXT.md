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

`PendingAction.taskId/nodeId` 在创建时保存计划关联。
`revokePendingActionsByTask` 撤销指定状态的关联操作。
关联不依赖节点输出中的临时字段。
`claimPendingAction`（`pendingAction.ts:254`）是唯一的待处理操作状态 CAS：单条 `updateMany`，条件为 `id` + `status IN from`，可选 `userId`/`sessionId`；`to === 'confirmed'` 时先经过 `assertActionMayStart`（人工接管栅栏，`manualReview status='open'` 抛 `CONFLICT`）。`from`/`to` 取值由调用方给定，函数本身不限制。
`PendingAction.status` 是 Prisma 无枚举的 `String @default("pending")`（`prisma/schema.prisma:426`），合法取值由 `contracts/security.ts` 的 `PendingActionStatus` 约束（含 `locked`、`needs_reconciliation`）。
本目录没有写入 `status:'locked'` 的语句；`renewLockedMfaChallenges`（`pendingAction.ts:362`）只重置 `MfaChallenge.status='locked'`，其 where 条件要求 `action.status='awaiting_mfa'`，且只写 `MfaChallenge`，从不改 `PendingAction.status`。
能写入 `PendingAction.status` 的语句只有四处：`createPendingAction`（`:86`，`status: input.status ?? 'pending'`，`:99`，仅新建行）、`claimPendingAction`（`:254`，CAS）、`updatePendingActionStatus`/`setPendingActionStatus`（`:181`/`:194`，无条件 `update`，可把 `locked` 改成任意值，包括 `pending`/`awaiting_mfa`）、`revokePendingActionsByTask`（`:169`，只写 `cancelled`）。
`claimPendingActionLease`（`:205`）与 `clearPendingActionLease`（`:230`）只写租约列，不改状态。
`assertActionMayStart`（`pendingAction.ts:275`）不改状态：它先对 `id` 发一条空写 `updateMany({ where: { id: actionId }, data: { id: actionId } })` 取得 SQLite 行锁，再读 `taskId`，存在 `manualReview status='open'` 时抛 `CONFLICT`。

## Agent 运行租约与恢复（`agentRun.ts`）

- 默认租约时长 `DEFAULT_LEASE_MS = 120_000`（`agentRun.ts:10`）。
- `beginAgentRun(input)`（`:35`）在一个事务内准入请求并夺取会话执行租约：校验会话归属、`status='active'`、`expectedRevision`，按 `sessionId_requestId` 或 `existingRunId` 找到已有运行（`requestDigest` 不同即 `CONFLICT`，`recover` 需 `baseRevision` 与 `recoveryAttempts` 均满足），再用 `agentSession.updateMany` 以 `{ id, userId, activeRunId: session.activeRunId, runLeaseToken: session.runLeaseToken, runLeaseExpiresAt: session.runLeaseExpiresAt }` 为条件 CAS 写入新 `randomUUID()` 令牌，`count !== 1` 抛 `CONFLICT`。
- 复用分支（`:61`）以 `where: { id: existing.id }` 无条件写 `status:'running'` 与新令牌；其状态闸门在前面的 `:50`：只有 `running`/`interrupted`（或 `recover` 且 `failed`）能进入，其余直接 `reused` 返回。`recover` 时 `recoveryAttempts` 自增。
- 已过期的旧运行时在 `:56` 被置为 `interrupted` 并清空 `leaseToken`/`leaseExpiresAt`；未过期且指向别处时抛 `CONFLICT`。
- `assertAgentRunLease(lease, client, now = new Date(), allowExpired = false)`（`:81`）是唯一令牌栅栏：要求 `run.status==='running'`、`run.leaseToken===lease.token`、`leaseExpiresAt` 未过期，且会话 `revision===run.baseRevision`、`activeRunId`/`runLeaseToken`/`runLeaseExpiresAt` 与租约一致，否则抛 `CONFLICT`。事件、调用、模型请求、检查点与会话提交的写函数都先经过它，被接管的旧持有者因此无法追加。
- `renewAgentRunLease(lease, leaseMs = DEFAULT_LEASE_MS)`（`:91`）心跳同时刷新 `AgentRun.leaseExpiresAt` 与 `AgentSession.runLeaseExpiresAt`；`verifyAgentRunLease`（`:100`）只校验。
- `finishAgentRun(lease, status, errorCode?)`（`:189`）以 `allowExpired = true` 收尾（只认令牌），写终态、清空 `leaseToken`/`leaseExpiresAt`，并按 `{ id, activeRunId: lease.runId, runLeaseToken: lease.token }` 释放会话租约。`MODEL_TRANSIENT` 且未达 `maxAttempts` 时把 `failed` 降级为 `interrupted` 并写 `nextRecoveryAt`。
- `listRecoverableAgentRuns(now = new Date(), limit = 100)`（`:281`）只返回：`checkpointStage` 为 null 或非 `workflow_only`（`workflow_only` 还需其外层 `AgentTask` 满足 `status in (pending, running)`、`parentInvocationId: null`、无 `open` 人工接管、执行认领为空或早于 `WORKFLOW_EXECUTION_LEASE_MS`）、`nextRecoveryAt` 为空或已到期、`recoveryAttempts < maxRecoveryAttempts`（字段级比较）、`recoveryErrorCode` 不为 `RECONCILIATION_REQUIRED`/`WORKFLOW_REQUIRES_ATTENTION`/`CHECKPOINT_MISSING`，且状态为 `interrupted` 或（`running` 且租约缺失/已过期）；按 `startedAt` 升序取 `limit`。
- `scheduleRunRecovery`（`:377`）、`parkRunRecovery`（`:387`）、`stopObsoleteRun`（`:392`）、`finalizeReceiptedAgentRun`（`:249`）都跳过 `running`、终态与 `waiting_*` 运行，不做抢占。
- 本文件不写 `PendingAction`：只有 `findMany`（`:240`）、`count`（`:258`）、`findUnique`（`:453`）读取；动作状态由 `settleInvocationFromAction`（`:452`）单向反向同步到 `ToolInvocation`。

回执必须校验所有者、工具与输入摘要。
资金变化、审计和回执的事务边界见
[agent/CONTEXT.md](../../../agent/CONTEXT.md)。

验证使用隔离测试库，规则见
[tests/CONTEXT.md](../../../tests/CONTEXT.md)。
