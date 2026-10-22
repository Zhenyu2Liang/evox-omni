# 工作流控制模块上下文

本目录是叶子节点：没有子目录，路由表按职责映射到文件。

## Intent

拥有 planner 的持久化工作流控制：暂停、恢复、重试、取消，人工决策后的续跑，节点/计划执行租约与带提交校验的持久化。
模块与具体工具无关：所有工具都经泛型 `TaskRunTool(toolName, args, context)` 透传，本目录不出现任何具体银行工具名。
本目录不存在刷卡/消费/支付/扣款能力、辅助函数、类型或场景。
`parked-actions.ts` 拥有「计划停靠的待确认操作已经结清」的唯一守卫：停靠节点把 `{ pendingActionId }` 存在 `AgentTaskNode.output` 里（没有独立列），计划快照本身无法区分开放决策与已结清操作，因此守卫先于任何控制重新激活计划读取持久化的 `PendingAction.status`。

## API Surface

- `contracts.ts`：`TaskNodeOutput`、`readPendingActionId`、`TaskRunTool`、`TaskControlDeps`、`TaskControlOptions`、`TaskPersistence`、`TaskPersistenceOptions`、`TaskPersistenceMode`。
- `ports.ts`：`buildPlanDeps`、`defaultPollControls`、`UNUSED_RUN_TOOL`、`PAUSE_NOW_CONTROLS`。
- `controls.ts`：`pauseTask`、`resumeTask`、`retryTask`，状态门控见 `PAUSABLE`、`RESUMABLE`、`RETRYABLE`。
- `parked-actions.ts`：`parkedActionIds(plan)`、`assertParkedActionsNotTerminal(plan)`；`PARKED_NODE_STATUSES`（`waiting_confirmation`、`waiting_verification`）是模块内常量，不导出。
- `cancellation.ts`：`cancelTask`、`sweepCancelledPlan`、`RevokeSummary`、`REVOCABLE_ACTION_STATUSES`。
- `action-continuation.ts`：`findTaskByPendingAction`、`resumeTaskForAction`。
- `ownership.ts`：`loadOwnedTask`、`loadOwnedTaskWithOwner`、`getTaskPlan`。
- `claims.ts`：`buildNodeClaimPorts`、`planExecutionClaimHeld`、`clearStaleNodeClaims`、`TERMINAL_NODE_STATUSES`、`staleExecutionClaimBefore`。
- `persistence.ts`：`toTaskPlan`、`createTaskPersistence`。
- `execution-context.ts`：`withWorkflowExecutionClaim`、`currentWorkflowExecutionClaim`、`WorkflowExecutionClaim`。

本目录没有 `index.ts`；对外公开面是同层门面 `agent/task-control.ts`，它再被 `agent/index.ts` 转出。

## Routing Table

- 控制面（暂停/恢复/重试）：`./controls.ts`。
- 终态守卫与它的用例：`./parked-actions.ts`、`./parked-actions.test.ts`。
- 取消与撤销：`./cancellation.ts`。
- 人工决策后的节点/计划续跑：`./action-continuation.ts`。
- 归属读取：`./ownership.ts`。
- 租约、陈旧判定与节点占用：`./claims.ts`。
- 持久化、端口装配与提交校验上下文：`./persistence.ts`、`./ports.ts`、`./execution-context.ts`、`./contracts.ts`。
- 共享状态词表：`../action-status.ts`（同层只读，改动需上报父节点）。
- 对外门面：`../task-control.ts`（同层只读，改动需上报父节点）。

## 三套状态词表：不得混用

- **计划**（`TaskPlanStatus`）：`PAUSABLE`（`pending`/`running`/`paused`/`waiting_confirmation`）、`RESUMABLE`（另含 `failed`）、`RETRYABLE`（`pending`/`paused`/`waiting_confirmation`/`failed`）都在 `controls.ts`；`NON_CANCELLED_PLAN_STATUSES` 在 `persistence.ts`。`waiting_confirmation` 同时属于三个控制集合，所以停靠中的计划本身可暂停、可恢复、可重试 —— 但必须通过下面的停靠决策守卫。
- **节点**（`TaskNodeStatus`）：`TERMINAL_NODE_STATUSES` = `success|failed|skipped|cancelled`。这些是节点状态，绝不是 `PendingAction` 状态。`waiting_confirmation`/`waiting_verification` 故意不在其中，`clearStaleNodeClaims`/`claimNode` 才能重新驱动停靠节点。
- **操作**（`PendingActionStatus`）：共享词表是 `../action-status.ts`：`OPEN_ACTION_STATUSES`（`pending`/`awaiting_mfa`）、`TERMINAL_ACTION_STATUSES`（`executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`）、`CLAIMABLE_ACTION_STATUSES`（开放状态 + `confirmed`）、`ALL_ACTION_STATUSES`，以及 `isOpenActionStatus`、`isTerminalActionStatus`、`isClaimableActionStatus`、`isLegalActionSourceStatus`、`mayPromptForDecision`。本目录的导入方只有 `parked-actions.ts`（`isTerminalActionStatus`）和 `cancellation.ts`（`OPEN_ACTION_STATUSES` → `REVOCABLE_ACTION_STATUSES`）；本目录不定义私有操作状态集合，也不出现 `blockReason`/`__SECURITY_BLOCK__` 处理。

## 终态收口：`locked` 与其它已结清决策

`locked` 是终态：MFA 尝试次数耗尽后，网关把该 `PendingAction` 从 `pending`/`awaiting_mfa` 结清为 `locked`，这是一次已生效的拒绝。
`locked` 不得被重新激活为 `pending`/`awaiting_mfa`，不得重新弹验证码入口，不得自动执行，也不得被恢复或重试复活。
共享词表把这条规则写死：`isLegalActionSourceStatus` 对 `locked` 恒为 false（任何方向都不合法），`isClaimableActionStatus` 不含 `locked`，`mayPromptForDecision` 只对开放状态返回 true。
工作流执行端口也不会为同一节点再铸新动作：`agent/confirmation/gated-execution.ts` `findRepresentedAction` 按 `ALL_ACTION_STATUSES` 查同一 `(taskId, nodeId)` 的既有操作，`executed`/`needs_reconciliation` 直接复用留痕结果，其余任何状态（含 `locked`）返回 `requiresConfirmation` 与该 `pendingActionId` 而不调用网关。
安全中心解锁只重置 MFA 挑战行（`lib/db/repositories/pendingAction.ts` `renewLockedMfaChallenges` 只匹配 `action.status = 'awaiting_mfa'`），不写操作状态，所以 `locked` 动作仍然是终态。
解锁后旧操作不会自动执行：用户重新发起请求并重新确认，得到的是一个新操作。

## 拒绝契约：结构化、只读、不回显

`resumeTask` 与 `retryTask` 的执行顺序是 `loadOwnedTask` → `assertNoOpenManualReview` → `toTaskPlan` → `assertParkedActionsNotTerminal(plan)` → `claimTaskStatus` → `claimTaskExecution`；行只映射一次。
停靠决策检查必须先于第一次状态占用：拒绝时持久化计划状态原样保留（不翻 `running`、不走执行器、不重驱已结清节点、不取租约、不跑工具）。
`assertParkedActionsNotTerminal` 遍历 `parkedActionIds(plan)`（去重、按节点顺序），对每个 id 读 `getPendingActionOwnership`；行缺失或不属终态时跳过，遇到终态立即抛结构化 `AppError`。
拒绝映射：`locked` → code `MFA_LOCKED` + `chat.error.actionLocked`；`needs_reconciliation` → code `CONFLICT` + `chat.error.unknownOutcome`；其它终态（`executed`/`failed`/`cancelled`）→ code `CONFLICT` + `chat.error.stateChanged`。
公开 `message` 永远是干净的业务句，`{ taskId, actionId, status }` 只进 `detail`，作为内部诊断。
文案来自既有目录（`createTranslator(DEFAULT_LOCALE)`），本目录不新增 i18n 键。
非 `INTERNAL` 的 code 按 `app/api/_lib/http.ts#mapAppError` 原样出网（`MFA_LOCKED` → 423，`CONFLICT` → 409），`detail` 永不进入响应体。
守卫是只读的：不写状态、不占用、不执行、不重放、不创建任何授权。
拒绝先于 `agent/index.ts` 的 `synchronizeScheduledWorkflow` 发生，因此被拒绝的控制不会拿过期计划去重新同步定时工作流。

## 定位停靠节点：复用既有读取

`parkedActionIds` 用 `readPendingActionId`（`./contracts` 里唯一的 `{ pendingActionId }` 读取器，`agent/turns/authorization-view.ts` 用的也是它）读节点输出，不要另写解析。
`findTaskByPendingAction` 经 `getPendingActionPlanLink`（`lib/db/repositories/pendingAction.ts:304-312`，投影为 `{ id, taskId, nodeId }`）解析，不返回 `status`，所以 `locked`/`executed` 的 actionId 仍能解析到它的计划。
`resumeTaskForAction` 只读任务行（`status === 'cancelled'` 时提前返回），不读操作行；它没有停靠决策守卫，只在网关授权成功后被调用 —— `agent/confirmation.ts` 在 `!auth.ok` 时先行返回，所以 `locked` 走不到这里。
仓储读取：`getPendingAction(id)`（`pendingAction.ts:110-118`）返回含 `status` 的完整行；`getPendingActionOwnership`（`pendingAction.ts:288-296`）返回 `{ id, userId, sessionId, status }`，即守卫使用的投影。
`listPendingActionsByTask(taskId, { statuses })`（`pendingAction.ts:144-156`）返回含 `status`/`nodeId` 的行；省略 `statuses` 会连终态行一起返回。
`revokePendingActionsByTask(taskId, fromStatuses)`（`pendingAction.ts:169-179`）是盲目的 `updateMany`：传入终态会把终态改写（`locked` → `cancelled`），因此只允许传开放状态 —— 这就是 `REVOCABLE_ACTION_STATUSES`。

## 公开文案

用户可见文本一律经 `lib/public-text.ts` 收口，禁止把内部状态字面量（例如 `locked`）、blockReason 载荷、JSON 片段或堆栈放进用户可见文本。
`RevokeSummary.failed[].message` 只在是普通业务句时保留 `AppError.from(error).message`；`revokeFailureText`（`cancellation.ts:41`）用 `isInternalDiagnostic` 把内部诊断（`__SECURITY_BLOCK__` 前缀、JSON 片段、堆栈、`undefined`/`null` 占位）替换为 `chat.error.toolFailed`，机器可读分类由类型化 `code` 承担（`cancellation.ts:54`）。
这条约束是必需的：该摘要被写进 `recordSecurityEvent` 的 `detail`（`cancellation.ts:61-65`），而 `GET /api/security` 原样返回审计记录，审计文本在本产品中对浏览器可见。
`UNUSED_RUN_TOOL` 的 `INTERNAL` 文案（`ports.ts:10-12`）被 `app/api/_lib/http.ts#mapAppError` 掩码（它只重写 `INTERNAL`，其它 code 的文案原样出网）。
`ownership.ts:9,10,12` 把 `taskId` 插进 `NOT_FOUND`/`SECURITY_DENIED`；这些文案在 HTTP 上不可达，因为 `POST /api/tasks/[id]` 在调用控制前先拒绝不匹配的归属。

## Constraints

租约与陈旧判定使用真实时钟（`Date.now()`）；固定演示时钟无法衡量所有权存活。
执行器模式的写入一律通过计划/节点 token 提交校验证明所有权；只有显式的 `control` 模式意图可以在没有租约时写入。
取消与取消后的撤销不可分割：撤销停靠的开放操作与状态变更一起提交，已提交的资金保持结清。
接管只清除非终态的子节点占用，同时持有父级。
守卫必须保持 READ-ONLY，并且必须先于第一次状态占用；两者任一条被破坏，已结清决策就会被重新驱动。

只对停靠节点设闸：没有停靠节点的计划（普通 `pending`/`success` DAG）不受影响，`pause` → `resume` 控制流照常。
有意保持的边界：
- 开放操作（`pending` / `awaiting_mfa`）不拒绝，恢复/重试走既有的占用 + 网关路径。
- 操作行缺失（`null`）不拒绝：缺失证据不能证明失败，网关仍是唯一权威。
- `confirmed`（既非开放也非终态，已授权续跑进行中）不拒绝，节点已提交结果的卡死恢复因此仍可用。
- `ALREADY_SETTLED_CODES`（`cancellation.ts:19`）把网关对已终态行的 `CONFLICT`/`NOT_FOUND` 折进 `alreadySettled`，所以撤销一个 `locked` 操作报「已结清」而不是「已锁定」。

## Notes for Agents

`runTool` 接缝由调用方（入口点/路由）提供，它们传入具体的银行工具调度器；本目录从不定义工具名。
纯控制路径使用 `UNUSED_RUN_TOOL`，一旦尝试执行工具就抛错。
租约语义在 `claims.ts`；卡与 `PendingAction` 的状态策略属于 `../action-status.ts`，不在本目录。
恢复/重试的可达路径：用户触发的 `POST /api/tasks/[id]`（经 `agent/index.ts` 的 `resumeTask`/`retryTask`）、`agent/durable/workflow-resumption.ts`（`resumeOriginalRunTask` 对非 `paused`/`cancelled`/`success` 的计划调用 `resumeTask`）、独立图谱驱动，以及 `agent/confirmation/plan-continuation.ts` 的 `resumeOwningPlan`（走 `resumeTaskForAction`，不由守卫拦下，只接受网关已授权的结局）。
读取路径 `GET /api/tasks/[id]` 附加暴露每个停靠节点的 `pendingActionStatus`（只读、不写状态），客户端据此区分开放决策与 `locked`。

## Test Strategy

`parked-actions.test.ts` 是同目录的纯单元用例（仓储与归属读取器被打桩，不碰数据库、不碰银行工具），共 8 个用例。
它固定住：`parkedActionIds` 只收集停靠节点的 action id 且去重；每个状态分支（`pending`/`awaiting_mfa`/`null`/`confirmed` 放行，`locked`/`needs_reconciliation`/`executed`/`failed`/`cancelled` 拒绝）；结构化 code + 目录文案 + 仅存在于 `detail` 的内部事实（公开文案不含状态字面量、action id、`__SECURITY_BLOCK__`）；`resumeTask`/`retryTask` 在 `claimTaskStatus`/`claimTaskExecution` 之前拒绝且不跑工具，而开放状态照常占用；以及三个目录键在默认语言下均可解析。
取消撤销与并发竞争由本目录之外的 `tests/unit/agent/task-cancel-revokes.test.ts` 与 `tests/integration/cancellation-result-race.test.ts` 覆盖。
