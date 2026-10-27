# 确认与人工决策上下文

## Intent

人工决策（`confirm` / `verify` / `cancel`）通过安全网关授权**已持久化**的 `PendingAction` 参数，模型永不授予执行权。
本子模块是网关之上的 agent 侧门面与持久化租约记账，并独占每次拒绝的**公开投影**。
它只做投影与结算，安全策略仍在 `security/`。

## API Surface

- `../confirmation.ts`（上级门面）— 公开 `confirmAction` / `verifyAction` / `cancelAction`；`confirm`/`verify` 由 `withLiveConfirmation` 包裹。
  `authorizeAndExecute(actionId, opts, mfaCode?)` 依次解析身份、短路已取消的所属计划、调用 `gateway.authorizeAction`，`!auth.ok` 时返回 `blockedOutcome`，否则进入 `executeAuthorizedAction`。
  `cancelAction` 在报告成功前**回读**持久化行，只有确认其为 `'cancelled'` 才写入取消审计并返回成功，否则返回 `unappliedCancelOutcome`。
- `contracts.ts` — `ConfirmOptions`、`ConfirmationOutcome`、`GatedToolOutcome`、`TrustedIdentity`。
- `identity.ts` — `resolveTrustedIdentity`：持久化所有者断言，绝非授权；用户可见消息已去标识化，不含内部 id、会话 id 或状态字面量。
- `liveness.ts` — `withLiveConfirmation`：持有持久化执行租约；租约冲突 → `conflictOutcome`；`beginExecutionLease` 仅以 `isOpenActionStatus(row?.status)` 判定冲突，终态行永不被当作未决决策。
- `outcomes.ts` — `emitAll`、`effectiveTier`、`publicRefusalMessage`、`cancelledPlanOutcome`、`conflictOutcome`、`unappliedCancelOutcome`、`blockedOutcome`；内部有 `failureReasonFor`、`refusalFacts`、`CANCELLED_PLAN_REFUSAL`。
- `authorized-execution.ts` — `executeAuthorizedAction`：在叙述前落地已授权命令证据，`settlePendingAction({ status, from: ['confirmed'], … })`，CAS 落败时如实上报持久化状态。
- `gated-execution.ts` — `executeGatedTool` / `executeGatedToolOnce`（工作流执行端口，`../confirmation.ts` 再导出）；`blockedOutcome(auth)` 从 `parseBlockReason(...).failure.code` 取 `errorCode`，错误文案经 `securityNotice`/`safePublicText` 生成；`representedStatuses` 取 `ALL_ACTION_STATUSES`。
- `plan-continuation.ts` — `resumeOwningPlan`：续跑下游节点而不改写已提交的业务结果；对外错误文案经 `publicPlanError`/`safePublicText` 消毒后才产生。
- `../confirmation-recovery.ts`（位于 `agent/` 根，上级节点）— 结算落地原语与本节点使用的独立 wedge 恢复。

## 契约 (Contracts)

`ConfirmationOutcome = { ok: boolean; actionId: string; status: PendingActionStatus; tier: RiskLevel; requiresMfa: boolean; message: string; code?: ErrorCode; failure?: SecurityFailure; result?: ToolExecutionResult; events: AgentStreamEvent[] }`。

每一个 `!ok` 结果都携带类型化 `code`，安全拒绝另外携带结构化 `failure`（`code` + `reason` + 尝试事实）。
`message` 始终是公开句子：服务端编写的业务句，或经唯一出口 `lib/public-text.ts` 渲染的句子。
`message` 永不含内部状态字面量（如 `「locked」`、`cancelled`）、动作/会话 id、JSON、堆栈或 `__SECURITY_BLOCK__` 载荷；调用方只读类型化字段，绝不解析 `message`。

`PendingActionStatus`（`@/lib/contracts/security`）= `'pending' | 'awaiting_mfa' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'locked' | 'needs_reconciliation'`。
`SecurityFailure` 与 `SecurityFailureReason`（`@/lib/contracts/security`）承载拒绝的结构化事实。

`agent/action-status.ts` 是状态词汇表：`isOpenActionStatus` / `isTerminalActionStatus` / `mayPromptForDecision` / `isClaimableActionStatus` / `isLegalActionSourceStatus` 取代本目录内一切本地字面量比较。
开放集合仅 `pending`/`awaiting_mfa`；`locked` 属于终态。

网关的 `AuthorizationResult`（`@/security/security-gateway`）携带 `ok, status, actionId, tier, requiresMfa, mfaResult?, code?: ErrorCode, failure?: SecurityFailure, message, action?`；`mfaResult` 不属于 `ConfirmationOutcome`。

## 拒绝文案的单一出口

`outcomes.ts` `publicRefusalMessage(text, { code?, failure? }, fallback)` 是唯一的拒绝渲染器，分三类：
- 有完整类型化事实（`failure`）→ `securityNotice(failure, t)`，从 `reason`/`code`/尝试次数渲染，从不读文本。
- 仅有已知 `code` → `publicToolError(text, t, fallback, code)`，即目录对该 `code` 的渲染（白名单业务句仍优先）。
- 无任何类型化事实 → `safePublicText(text, t, fallback)`：白名单业务文本优先，否则用目录兜底句；`isInternalDiagnostic` 文本（`__SECURITY_BLOCK__…`、JSON 片段、堆栈、`undefined`/`null`）一律变为兜底句。

`failureReasonFor(code)` 把公开错误码映射成 `SecurityFailureReason`：`MFA_FAILED`→`mfa_code_invalid`、`MFA_LOCKED`→`mfa_attempts_exhausted`、`CIRCUIT_OPEN`→`circuit_open`，其余为 `denied`。
`refusalFacts(code, actionId)` 构造 `{ code, reason, actionId }`，使 plain 拒绝同样同时携带 `code` 与 `failure`。
拒绝文案由模块级 `createTranslator(DEFAULT_LOCALE)` 生成；本层无逐请求 locale，全部为默认语言。

`cancelledPlanOutcome` 报告模块常量 `CANCELLED_PLAN_REFUSAL`（`'该操作所属的任务计划已取消，已拒绝执行。'`），携带 `code: 'SECURITY_DENIED'` 与 `failure: { code, reason: 'denied', actionId }`；所属 `taskId` 只留在持久化计划中，绝不进入文案。
`conflictOutcome` 原样转发已恢复的 wedge 结果，对 `!ok` 的恢复补上 `code: 'CONFLICT'`（不带 `failure`，因 `'denied'` 会误述未知结果）。
plain 冲突分支（网关抛 `AppError('CONFLICT', …)`，其文案内插原始状态字面量）以 `code: error.code` + `failure` 上报，并经 `publicRefusalMessage(…, 'chat.error.stateChanged')` 收口。
`unappliedCancelOutcome` 是**未生效**的取消：`ok:false`、持久化 `status`、`code:'CONFLICT'` + `failure`、`chat.error.stateChanged` 文案。

`identity.ts` 抛出 `AppError('NOT_FOUND' | 'SECURITY_DENIED', …)`，其业务句不含 action id、会话 id 或内部 token；HTTP 错误信封渲染该 `message`。

## Constraints

- 所有权失败即封闭：`ConfirmationOutcome` 由持久化状态构造，绝不来自请求文本；`verifyAction` 仍可抛 `AppError('NOT_FOUND' | 'SECURITY_DENIED')`，以及（经网关）`'CONFLICT'`，此时转为 `conflictOutcome`。
- `blockedOutcome.events` 仅当 `view.requiresMfa && mayPromptForDecision(view.status)` 时发出 `{ type:'mfa_required', actionId, action }`；任何终态（含 `'locked'`）都得到 `events: []`，终态绝不请求新的验证码。
- `agent/` 下没有任何模块发出 `action_settled` 事件：该类型声明在 `lib/contracts/agent.ts`，全仓库唯一发出者是浏览器客户端（`components/chat/actions.ts`，针对 `confirmed` 与含 `locked` 的终态）。
- `liveness.ts`（`withLiveConfirmation`）与 `gated-execution.ts`（`executeGatedToolOnce`）都以 `isManualCardCommand` 拒绝 `manual_add_card` / `manual_delete_card`（`@/lib/contracts/card-management`），报 `SECURITY_DENIED`：制卡/删卡必须走卡片管理页，不走确认流程。
- `cancelAction` 只有在持久化行被证明确为 `cancelled` 后才写审计；`NOT_FOUND` / `SECURITY_DENIED` 继续抛出；未生效的取消不谎称成功、不重试。
- `gated-execution.ts` `blockedOutcome` 绝不放原始 `blockReason`：只发布结构化 `failure` 或封闭目录句；`blockReason` 仅留在 Pi 工具结果中给模型自纠。
- `plan-continuation.ts` 绝不发布原始错误：`publicPlanError` 只替换 `isInternalDiagnostic` 的错误，并把被转发的节点错误（同样含内部诊断）替换为 `securityNotice({ code })` 或 `t('chat.error.operationNotStarted')`；`error` 事件的 `message` 经 `safePublicText(…, 'chat.error.unknownOutcome')` 收口并携带 `AppError.from(error).code`。
- `locked` 是终态：不得作为待决策项呈现、不得重新发 `mfa_required`、不得被恢复/重试路径重新激活、不得自动执行；解除锁定后仍需用户重新发起并重新确认。
- 本目录任何路径都不解锁、不重新激活、不恢复、不自动执行已锁定或其它终态操作。

## 结算落地原语 (../confirmation-recovery.ts)

`settlePendingAction(input)` 在**一个** `prisma.$transaction` 内落地终态、持久化结果与执行审计，返回丢失 `false`（并发结算已移动行时什么都不写）。
`SettlePendingActionInput.from: PendingActionStatus[]` 为**必填**：必须显式命名期望来源状态，绝不隐式变成无条件写。
`assertSettleSources(input)` 在事务开始前校验：空 `from` 或非法来源状态一律抛 `AppError('SECURITY_DENIED', …)`，未写入任何行。
`locked` 永远不是合法来源状态（由 `isLegalActionSourceStatus` 保证），因此耗尽验证的拒绝绝不会被重新激活或降级。
所有调用方都显式给出 `from`：`authorized-execution.ts` / `gated-execution.ts` / `durable/workflow-invocations.ts` / `landStandalone` / `reconcileStandaloneAction` 与 `index.ts` 计划链接楔子分支用 `['confirmed']`；`agent/index.ts` 的幂等审计修复用 `['executed']`。
CAS 落败时回读持久化行如实报告，不重试、不重放、不伪造成功。
恢复结果的 tier/requiresMfa 一律由 `../confirmation-recovery.ts` 的 `persistedDecision(row)` 从持久化行推导（`requiresMfa = row.requiresMfa || row.riskLevel === 'RED'`，`tier = requiresMfa ? 'RED' : row.riskLevel`），`landStandalone` 的获胜 CAS 与落败 CAS 分支、`reconcileStandaloneAction` 共用同一推导，因此陈旧快照不会把已提交的 RED/需强验证决定降级为 `YELLOW`/`requiresMfa:false`。
`lib/db/repositories/pendingAction.ts` 仍导出 `updatePendingActionStatus` 及其别名 `setPendingActionStatus`，但生产代码中零调用：状态+结果的持久化已不再经过任何 repository setter（事务内直接 `claimPendingAction` + `tx.pendingAction.update({ resultJson })`），因此针对该符号的故障注入间谍观察不到任何调用。
`authorized-execution.ts` 仅在 `landed === true` 且状态为 `executed`/`failed` 时调用 `gateway.recordActionResult`（其本身就是对 `RESULT_RECORDABLE_STATUSES` 的 CAS，锁定的行保持锁定），异常被吞掉，结算事务仍是权威证据。
`gated-execution.ts` 中已处于 `confirmed` 的计划节点只结算一次；CAS 落败返回 `{ ok:false, requiresConfirmation:true, pendingActionId, error:'该计划节点已在等待人工确认，未重复受理。' }`，绝不重复执行、绝不谎报成功。

## 锁定终态 (A locked MFA outcome is terminal)

MFA 连续错误触发会话熔断（`security/mfa.ts` `verify` → `security/security-gateway.ts` `authorizeWithMfa`）时，网关返回 `status: 'locked'`、`requiresMfa: true`、`tier: 'RED'`、`code: 'CIRCUIT_OPEN'`、`mfaResult: 'failed'`、类型化 `failure` 与锁提示，并经 `persistLockedAction` 以竞态安全的 CAS 从 `['pending','awaiting_mfa']` → `'locked'` 持久化（仅从未决态；并发/终态行不被覆盖，丢失 CAS 属良性）。
`blockedOutcome` 仍发出 `events: []`（锁定行不是未决决策），既无 `mfa_required` 也无 `action_settled`。
因为行已终态，`nextPlanDecision`/`withPlanUpdate` 不再为其重发 `mfa_required`，MFA 弹窗不重现。
对该行再次尝试返回同一幂等的锁定结果（无新挑战、不消耗尝试、不重新提示），因为 `authorizeAction` 在未决守卫前短路 `'locked'` 行。
网关取消 CAS（`['pending','awaiting_mfa']` → `'cancelled'`）永不匹配锁定行，故对其 `cancelAction` 被拒：抛出的 `AppError('CONFLICT', …)` 由 `conflictOutcome` 收口，残余情况由 `unappliedCancelOutcome` 覆盖；门面绝不声称其已取消。
锁定永不构建 `ToolExecutionResult`：`authorizeAndExecute` 返回 `blockedOutcome` 并跳过 `executeAuthorizedAction`，故无 `result`，也不调用 `performAuthorizationResume`。
锁以 `status: 'locked'`、类型化 `code`/`failure`、经出口渲染的 `message` 出现在 HTTP `ActionResponse` 上。

### 锁定对外发布的内容：类型化 code 与目录句，绝无工具事件

- 锁不产生 `ToolEventView`、`tool_end` 或公开 `summary`/`errorCode`：`publishAuthorizedToolOutcome`（`agent/turns/buffer.ts`）从 confirm/verify 不可达。
- 两种锁形态按类型化事实渲染：尝试上限锁（`failure.reason === 'mfa_attempts_exhausted'`）→ `chat.error.actionLocked`；会话熔断锁（`code`/`reason` 为 `CIRCUIT_OPEN` / `circuit_open`）→ `chat.error.securityLocked`。
- 错误但可重试的验证码（`reason: 'mfa_code_invalid'`）→ `chat.error.verificationRemaining`，携带真实剩余次数，状态仍 `awaiting_mfa` 并重发 `mfa_required`。
- 唯一由 agent 发出、`kind: 'locked'` 的公开事件是 `agent/turns/events.ts` 的 `security_event`，仅由模型侧 `beforeToolCall` 拒绝抵达，从不由 confirm/verify 抵达（其归属见 `agent/turns/`）。
- `components/chat/cards/MfaCard.tsx` 仅在 `terminal === 'failed'` 时渲染原因行；`locked` 卡片显示 `cards.terminal.locked`，开发者模式才暴露 message。
- HTTP 边缘（`app/api/actions/[id]/verify/route.ts`）对锁定验证报告 `status: 'locked'`、`requiresMfa: true`、`mfaResult: 'failed'`。

## Known Issues

`../confirmation.ts` `authorizeAndExecute` 在 `!auth.ok` 时**提前返回** `blockedOutcome`，因此在 `executeAuthorizedAction` 之前结束，锁定或拒绝的人工决策不产生 `ToolExecutionResult`、不产生工具事件、也不产生 `action_settled`（该事件全仓库无服务端发出者）。
这是当前边界，不是缺陷修复项：拒绝只以类型化 `code`/`failure`、出口渲染的 `message` 和 HTTP 响应体现。

`gated-execution.ts` `blockedOutcome` 把 `auth.blockReason` 复制进 `GatedToolOutcome.error` 承载的内容仍可能沿 `plan-continuation.ts` 进入计划续跑；`publicPlanError` 会在其成为持久化节点错误前替换其中的内部诊断，故原始标记不落为对外文本。

## Routing Table

本节点为扁平目录，无子目录；按文件划分：上表 API Surface 即各模块职责。
跨节点只读引用（写须上抛父节点）：
- `../action-status.ts` — 状态词汇表（上级节点，只读）。
- `../confirmation-recovery.ts` — 结算落地原语、租约时钟、独立 wedge 恢复（上级节点，只读）。
- `../turns/events.ts` — `security_event` 投影与 `blocked` 分类（上级节点，只读）。

## Notes for Agents

- 一切拒绝文案必须经 `lib/public-text.ts`（`safePublicText`/`securityNotice`/`isInternalDiagnostic`）或 `publicRefusalMessage` 产出，拒绝同时携带类型化 `code`/`failure`；不要把网关句、状态字面量、载荷、JSON、堆栈塞进 `message`。
- 新增状态判断请使用 `agent/action-status.ts` 的谓词，勿写本地字面量比较。
- 本层不做任何金额运算：没有费率/手续费/费用字段、没有金额格式化，也没有 `fee`/`feeAmount`/`REDEMPTION_FEE_RULE` 之类的目录；`ToolExecutionResult`/`GatedToolOutcome` 的 `data` 只是透传，金额计算与费用口径都在 `banking-sdk/`。改动金额语义时不必在此目录寻找。
- 不要新增 `action_settled` 的服务端发出者；它由浏览器客户端发出。
- 修改结算来源时，`from` 必须显式且合法，`locked` 永不作来源；CAS 落败只如实上报持久化状态。
