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
本目录没有写入 `status:'locked'` 的语句；`renewLockedMfaChallenges`（`pendingAction.ts:362`）只重置 `MfaChallenge.status='locked'`，其 where 条件要求 `action.status='awaiting_mfa'`。

回执必须校验所有者、工具与输入摘要。
资金变化、审计和回执的事务边界见
[agent/CONTEXT.md](../../../agent/CONTEXT.md)。

验证使用隔离测试库，规则见
[tests/CONTEXT.md](../../../tests/CONTEXT.md)。
