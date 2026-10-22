# 安全层

本层用代码决定权限、确认、验证、风险与锁定状态。
本层不执行业务操作。

## 模块边界

`lib/contracts/tool-catalog.ts` 是名称、效果、默认档位与重放要求的共享来源。
`permission-engine.ts` 推导静态策略。
`risk-engine.ts` 使用精确 bigint 运算并输出十进制字符串。
转账始终需要人工决定。
已入账金额加上在途未入账金额超过 `1000.00` 时需要强验证。
订阅查询为 YELLOW。
`set_card_limit` 只调整分类消费限额，意图标签为「调整卡片分类消费限额」。
`replace_card`、`apply_virtual_card` 与 `consume_virtual_card` 属于 RED 写操作，均要求确认、强验证与幂等重放。

`security-gateway.ts` 校验归属资源、记录确定性授权决定并创建待确认操作。
确认采用原子认领，并重新评估累计风险。
开放的人工接管阻断新的执行认领；已授权的在途命令仍可落地。
`authorization-record.ts` 记录策略版本、命令指纹、原因与脱敏输入。

## 卡片生命周期与 replace_card 前提

`replace_card` 的前提只有两条：源卡属于当前用户，且状态为 `LOST`。
`banking-sdk/card.ts#requireCard` 对不存在的卡片抛 `NOT_FOUND`、对他人卡片抛 `SECURITY_DENIED`；`#replaceCard` 对非 `LOST` 源卡抛 `CONFLICT`「只有已挂失的卡片可以补办，请先办理挂失。」。
本层与 `agent/tools/card.ts` 都没有 CREDIT / DEBIT / VIRTUAL 的类型禁区；RED 档位只来自 `lib/contracts/tool-catalog.ts` 的目录项。
唯一的类型分支在 SDK：VIRTUAL 补办必须重新校验并继承结算账户绑定，CREDIT 补办原样继承 `creditLimitMinor` 与 `availableLimitMinor`，因此代理可以补办挂失的信用卡。
`gatewayCreatePendingAction` 在挂起时只把卡片类型与掩码写进确认摘要（`security-gateway.ts` 的 `summary.fields.unshift`），不做归属或类型裁决。
手工路径只暴露两个工具名：`manual_add_card`（新增 DEBIT/CREDIT/VIRTUAL 记录）与 `manual_delete_card`（删除记录）；没有补办、冻结、解冻或限额操作。
卡片页也没有补办入口，补办只能由代理发起（见 `docs/cn/card-management.md`）。
`agentEnabled === false` 的拒绝分支存在于 `permission-engine.ts`、`agent/confirmation/gated-execution.ts`、`security-gateway.ts`（确认与取消）与 `agent/tools/index.ts`，但当前没有任何目录项设为 `false`；物理卡的创建/删除只能手工，是因为目录里不存在这类工具名，而不是被该开关拦住。
模型对「实体卡只能手工办理」的措辞来自 `agent/system-prompt.ts:38`，服务端无此规则。

## 待处理操作（PendingAction）的创建路径

`PendingAction` 行只由两个创建点产生。
主路径：模型的工具调用 → agent `beforeToolCall`（`agent/banking-agent.ts`）→ `securityGateway.handleToolCall`（`security-gateway.ts`）→ `gatewayCreatePendingAction` → 仓储 `createPendingAction`（`lib/db/repositories/pendingAction.ts#createPendingAction` → `client.pendingAction.create`）。
纯文本回复不经过 `beforeToolCall`，因此不会创建任何 `PendingAction`，也不会出现确认/MFA 面板。
`gatewayCreatePendingAction` 落库状态：`ev.requiresMfa ? 'awaiting_mfa' : 'pending'`；RED 同时铸造 MFA 挑战。
它还可能返回 `{ kind: 'clarify' }`（转账收款人无法唯一解析，不落库）或 `{ kind: 'plan_cancelled' }`（所属计划已取消，不落库）。
计划节点（`submit_plan` 之后）经 `agent/confirmation/gated-execution.ts` 以 `taskId`/`nodeId` 复用同一 `handleToolCall` 路径。
独立路径：`manual-card-management.ts#proposeCardChange`（`POST /api/cards`）直接 `pendingAction.create`，工具名 `manual_add_card`/`manual_delete_card`，被 `app/api/actions/route.ts` 显式过滤，不出现在主确认面板。`addDemoCardSchema` 另接受可选 `linkedAccountId`（VIRTUAL 卡的结算账户绑定），`toChange` 将其透传到 `CardChange`；该绑定的账户归属与类型由 SDK 在服务端校验。

## PendingAction 状态写入点与 CAS 过滤

创建：`security-gateway.ts#gatewayCreatePendingAction` 经 `repoCreatePending`（`:691-712`）写入 `status: ev.requiresMfa ? 'awaiting_mfa' : 'pending'`（`:677`），无 CAS，落库默认值在仓储 `createPendingAction` 的 `input.status ?? 'pending'`。
`security-gateway.ts#persistLockedAction`（`:817-820`）`claimPendingAction({ from: ['pending','awaiting_mfa'], to: 'locked' })`，由 MFA 耗尽（`:914`）与会话熔断（`:1148`）两个分支共用。
`authorizeWithMfa` 的确认事务（`:922-945`）：`claimPendingAction({ from: ['awaiting_mfa','pending'], to: 'confirmed', userId, sessionId })`；计划已取消则在同一 tx 内 `update where {id}` → `'cancelled'`（`:940`，只撤销本次 claim，不看状态）。
`authorizeTransfer`（`:992-1038`）：`updateMany where {id, status in ['pending'], userId, sessionId}` → `'confirmed'`（`:994-1002`）；计划取消 → `'cancelled'`（`:1014`）；确认时升级 RED → `'awaiting_mfa'`（`:1029-1034`）。
`authorizeAction` 静态 RED 重新加严（`:1131-1134`）：`updateMany where {id, userId, sessionId, status in ['pending','awaiting_mfa']}` → `riskLevel 'RED'` + `requiresMfa true` + `status 'awaiting_mfa'`，`count !== 1` 抛 `CONFLICT`。
`authorizeAction` 静态 YELLOW 认领（`:1162-1168`）：`claimPendingAction({ from: ['pending'], to: 'confirmed', userId, sessionId })`。
`cancelAction`（`:1197-1203`）：`claimPendingAction({ from: ['pending','awaiting_mfa'], to: 'cancelled', userId, sessionId })` —— 认领源不含 `'locked'`，已锁定行取消得到 `CONFLICT`。
`recordActionResult`（`:1218-1220`）→ 仓储 `setPendingActionStatus`（= `updatePendingActionStatus`）`update where {id}` → `'executed' | 'failed'`，无 CAS（调用前已完成 exactly-once 认领）。
`recovery-authorization.ts#authorizeRecoveryAction`：writer claim `updateMany where {id, userId, sessionId, status: 'confirmed'}` 写回同值 `'confirmed'` 只为取写锁（`:39-42`，`count !== 1` 抛 `CONFLICT`）；需 MFA 时 `update where {id}` → `'awaiting_mfa'` + RED（`:64-66`）。
`manual-card-management.ts`：`proposeCardChange` `create` 写 `'awaiting_mfa'`（`:88-90`）；`verifyCardChange` 执行栅栏 `updateMany where {id, userId, sessionId, status: current.status, argsJson}` → `'confirmed'`（`:143-145`），`onCommit` `update where {id}` → `'executed'`（`:148`）；`cancelCardChange` `updateMany where {id, ...identity, status in ['pending','awaiting_mfa','locked']}` → `'cancelled'`（`:159`）。
手工卡路径是唯一把 `'locked'` 当作可继续/可取消状态的地方（`:51`、`:100`、`:111`、`:138`、`:159`），但它自己从不落库 `'locked'`（`:102` 的 `'locked'` 只是会话熔断的展示映射），且 `:71`/`:112` 以 `isLocked` 抛 `CIRCUIT_OPEN`。
本层从不写 `executionLeaseOwner` / `executionLeaseExpiresAt`；租约只由 `agent/confirmation/liveness.ts` 经仓储 `claimPendingActionLease` / `clearPendingActionLease` 维护。

## 阻断原因（block reason）标记与锁定的可见性

`security-gateway.ts:80` 导出 `BLOCK_REASON_PREFIX = '__SECURITY_BLOCK__'`；全仓只有 `security-gateway.ts` 内三处拼接它。
`serializeBlockReason`（`:725-735`）只用于已落库的 gated 调用，载荷是 `{"actionId","decisionKind", failure?}`，`actionId` 无条件存在。
`handleToolCall` 的锁定会话 deny 分支（`:1241-1247`）产出 `{"decisionKind":"deny","failure":{"code":"CIRCUIT_OPEN","reason":"circuit_open"}}`。
`handleToolCall` 的 `plan_cancelled` 分支（`:1272-1279`）产出 `{"decisionKind":"deny","failure":{"code":"SECURITY_DENIED","reason":"denied"}}`。
这两条 deny 串都**没有 `actionId`**，而 `parseBlockReason`（`:762-782`）把 `actionId` 当作**可选**（`:778`），因此它们照常解析为 `{ decisionKind:'deny', failure }`，不是 `null`。
`parseFailure`（`:738-759`）只接受 `FAILURE_REASONS`（`mfa_code_invalid`/`mfa_attempts_exhausted`/`mfa_session_locked`/`circuit_open`/`denied`）里的 reason，未知 reason 丢弃整个 `failure`。
校验失败（`VALIDATION`，`:1255`）与转账收款人不唯一（`clarify`，`:1266`）两种 deny 的 `blockReason` 是**纯中文消息**，不带前缀，因此按普通工具错误展示。
消费方只要看到该前缀就判定 blocked（`agent/turns/events.ts:59-70`），原始串不会成为 `ToolEventView.summary`；解析成功的 blocked 调用只发布类型化字段（`security_event` 的 `kind:'locked'`/`code`/`reason`/`actionId`/`attemptsLeft`/`maxAttempts`，**无 `message`**），由 `tests/unit/agent/turn-security-event.test.ts` 断言。
原始串仍会原样落进 `agent/confirmation/gated-execution.ts:66` 的 `GatedToolOutcome.error`，再经 `planner/` 的 `TaskNodeResult.error` 到前端，由 `lib/public-text.ts#isInternalDiagnostic` 兜底成 `chat.error.toolFailed`，不会展示给用户。
锁定会话中的新写入由 `execution-policy.ts#assertSessionMayWrite` 抛 `CIRCUIT_OPEN`，作为普通工具错误（无前缀）抵达模型。
MFA 超限锁定不走上述路径：`authorizeAction` 返回 `status:'locked'` 的 `AuthorizationResult`，由 `/api/actions/[id]/verify` 以 200 `ActionResponse`（`mfaResult:'failed'`）交给客户端，不进入模型上下文。

## 赎回报价

`gatewayCreatePendingAction` 在确认前用服务端决定铸造赎回报价。
请求本金 `redeemAmount` 缺省或等于持仓本金时，按全部赎回报价。
`redeemAmount` 小于持仓本金时，按部分赎回报价。
`redeemAmount` 大于持仓本金时抛出 `VALIDATION`，并在落库前拒绝。
两类赎回复用 SDK 的 `settledRedemptionAmount` 与 `valuationToMinor`。
报价与结算同源，金额不会分歧。
`redeemAmount` 属于请求身份，重复挂起时参与去重。
`expectedRedemptionAmount` 属于服务端报价，重复挂起时沿用原报价。
本层只快照报价，不改变余额。

`mfa.ts` 把 5 分钟墙钟挑战绑定到命令，保留有效尝试并记录消费。
`step-up-authenticator.ts` 是明确的演示适配器，不发送短信。
不支持的模式必须失败。
真实短信供应商与已认证的员工或用户身份属于独立的生产工作。

## MFA 尝试限制

`MFA_MAX_ATTEMPTS`（`lib/constants.ts`）= 3，熔断在「第 3 次」失败即触发（`failures >= max`，非第 4 次）。
`security-gateway.ts` 的 MFA 分支以领域结果返回状态（不抛出）：
未达上限 → `status: 'awaiting_mfa'`、消息「验证码错误，请重试。剩余尝试次数：N。」；
达到上限 → `status: 'locked'`、`code: 'CIRCUIT_OPEN'`、消息「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」；
已锁定后的再次提交走提前熔断分支 → `status: 'locked'`、消息「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」。
锁定态返回值仍带 `requiresMfa: true`，但 HTTP 路由由 `status` 推导出的 `mfaResult` 变为 `failed`，且不发出 `mfa_required` 流事件。
真正的终态锁定会以「仅从 `pending`/`awaiting_mfa` 出发」的 CAS 把 `PendingAction.status` 落库为 `'locked'`；该行因此不再作为待决策项返回，也不再发出 `mfa_required`，MFA 弹窗不会重现；对已是 `'locked'` 的行再次授权幂等返回同一拒绝。
`mfa.ts#verify` 返回 `Result` 而非抛错；抛 `CIRCUIT_OPEN` 的只有 `circuit-breaker.resetSession` 与 `execution-policy.assertSessionMayWrite`。
成功验证码重置连续失败计数，但不解除已触发的熔断（「locked 优先」）；仅 `resetSession` 以验证码或 60 秒冷却解除。

## 确认/验证的返回契约（返回，不抛出）

`authorizeAction` 对验证码错误、尝试耗尽、会话熔断一律**返回** `AuthorizationResult`（`ok: false`，`status` 为 `'awaiting_mfa'` 或 `'locked'`），不抛 `AppError`。
抛出的只有这几类：`NOT_FOUND`（`:1107`）、`SECURITY_DENIED`（手工卡命令 `:1108`、`assertOwnership`）、`CONFLICT`（已结算 `:1124`、人工接管 `:1142`、认领失败 `:1170`）。
因此 `app/api/_lib/http.ts#mapAppError` 的 `CIRCUIT_OPEN`/`MFA_LOCKED → 423` 只对**抛出**生效；`/api/actions/[id]/verify|confirm` 恒以 200 `ActionResponse` 返回锁定结果。
验证码错误但仍有次数（`:895-915`，`locked=false`）：`status:'awaiting_mfa'`、`code:'MFA_FAILED'`、`failure:{ code:'MFA_FAILED', reason:'mfa_code_invalid', actionId, attemptsUsed, attemptsLeft, maxAttempts:3 }`，`message`「验证码错误，请重试。剩余尝试次数：N。」。
第 3 次（最后一次允许的）错误：`status:'locked'`、顶层 `code:'CIRCUIT_OPEN'`，但 `failure.code` 是 `'MFA_LOCKED'`、`reason:'mfa_attempts_exhausted'`、`attemptsLeft:0`、`attemptsUsed:3`，并把该行 CAS 落库为 `'locked'`。
已是 `'locked'` 的行再次授权（`:1116-1119`，早于未决状态校验）：`lockedOutcome(..., 'mfa_session_locked')` → `failure:{ code:'CIRCUIT_OPEN', reason:'mfa_session_locked', actionId, attemptsLeft:0, maxAttempts:3 }`，没有 `attemptsUsed`。
会话熔断但行仍未决（`:1146-1149`）：`lockedOutcome(..., 'circuit_open')` 并把行落库为 `'locked'`，其余字段同上。
`lockedOutcome`（`:827-844`）的 `message` 恒为「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」，`tier` 与 `requiresMfa` 取行的生效值。
顶层 `code` 与 `failure.code` 可能不同：耗尽路径顶层 `CIRCUIT_OPEN`、`failure.code` `MFA_LOCKED`；消费方必须按 `failure.reason` 区分「尝试耗尽」与「会话已锁定/熔断」。
`mfa.verify` 自身以 `err(AppError(...))` 表示挑战已消费/过期/命令变更/不存在，`authorizeWithMfa`（`:881-894`）把它折成 `status:'awaiting_mfa'`、`code:'MFA_FAILED'`、`failure:{ code:'MFA_FAILED', reason:'mfa_code_invalid', actionId }`（无尝试计数），`message` 沿用 SDK 的英文字符串。
全仓没有任何 `throw new AppError('MFA_LOCKED', …)`：`MFA_LOCKED` 只作为 `failure.code` 出现（`:906`），所以 `http.ts` 的 `MFA_LOCKED → 423` 映射不可达。

四条授权结果的 `message` 都是 `security-gateway.ts` 内的内联字面量，一律不含 `BLOCK_REASON_PREFIX` 等内部分隔标记：
可重试的错误码（`:912`）是模板串 `` `验证码错误，请重试。剩余尝试次数：${attemptsLeft}。` ``（`attemptsLeft` 为 0–2 的裸数字，没有「还可尝试」等措辞）；
尝试耗尽（`:911`）与 `lockedOutcome`（`:841`）是常量；
`security/messages/mfa.zh-CN.json` 只有 `renewedChallenge`/`newChallenge` 两个键，仅服务于 `authorizeWithMfa` 的挑战重发/新建提示（`:868-877`）；`MFA_CODE_PROMPT`（`:242`）是「请输入 6 位短信验证码以完成安全验证。」。
`gatewayDecide` 的熔断 deny 消息（`:446`「当前会话已触发安全熔断，高风险操作已被锁定。请前往安全中心解除限制后再试。」）与 `lockedOutcome`（`:841`「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」）措辞不同，且都不含 `actionId`。
`lockedOutcome` 的两个调用点是已锁行重试（`:1118`，`mfa_session_locked`）与会话熔断（`:1148`，`circuit_open`），共享 `:841` 的同一句 message。

## 锁定拒绝语的可展示性

本层三句锁定拒绝语分别位于 `gatewayDecide`（`:446`，熔断 deny）、`lockedOutcome`（`:841`）与 `authorizeWithMfa`（`:911`，尝试耗尽）。
只有第三句被 `lib/tool-feedback.ts` 的 `PUBLIC_BUSINESS_ERRORS` 精确登记（→ `chat.error.securityLocked`）。
另两句只能靠 `errorCode` 走 `PUBLIC_ERROR_CODES`（`CIRCUIT_OPEN` → `chat.error.securityLocked`）；没有 `errorCode` 时落到 `chat.error.toolFailed` 兜底。
MFA 三次错误路径的 `message` 只有中文提示，不含前缀；该路径不产出 block reason 串。

`injection-guard.ts` 检测可疑指令。
`incidents.ts` 在一个事务中持久化去重信号、相关安全事件与账户级锁定。
`circuit-breaker.ts` 应用验证失败锁定与已审计的冷却重置。
锁定由该用户的各会话共享。

`execution-policy.ts` 在真实事务客户端上检查写权限。
`recovery-authorization.ts` 只授予当前允许的新恢复效果。
已验证的收据绕过新写入，并在锁定期间保持可恢复。
未知结果不等于失败，不得盲目重试。

模型工具不包含任意代码、SQL、shell、文件与外部 HTTP。
公开日志读取器不包含原始思维与凭据。
资金结论由银行智能体根据 SDK 与收据事实渲染。
见 `docs/cn/security.md` 与 `docs/cn/known-risks.md`。
