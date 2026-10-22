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

## 阻断原因标记与锁定的可见性

`security-gateway.ts:80` 导出 `BLOCK_REASON_PREFIX = '__SECURITY_BLOCK__'`，全仓只有该文件拼接该前缀。
`serializeBlockReason`（`:725-735`，由 `:1286` 调用）产出 `${PREFIX}${JSON.stringify({ actionId, decisionKind, failure? })}`；park 路径不传 `failure`，故已落库 gated 调用的载荷只有 `actionId` + `decisionKind`。
`parseBlockReason`（`:762-782`）只强制前缀 + 合法 `decisionKind`；`actionId` 与 `failure` 都是可选的（`:778-781`），带与不带 `actionId` 的串都能解析出类型化结果；两者只经 `securityGateway` 对象暴露（`security.gateway.securityGateway.parseBlockReason`、`security.gateway.BLOCK_REASON_PREFIX`）。
两条无 `actionId` 的 deny 载荷仍带 `failure`：锁定会话（`:1241-1247`，`{code:'CIRCUIT_OPEN',reason:'circuit_open'}`）与计划已取消（`:1272-1279`，`{code:'SECURITY_DENIED',reason:'denied'}`）。
MFA 超限锁定不走上述路径：`authorizeAction` 返回 `status:'locked'` 的 `AuthorizationResult`，由 `/api/actions/[id]/verify` 以 200 `ActionResponse`（`mfaResult:'failed'`）交给客户端，不进入模型上下文。
锁定会话中的新写入由 `execution-policy.ts#assertSessionMayWrite` 抛 `CIRCUIT_OPEN`（`:19-21`），作为普通工具错误（无前缀）抵达模型。

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
未达上限 → `status: 'awaiting_mfa'`、`code: 'MFA_FAILED'`、消息「验证码错误，请重试。剩余尝试次数：N。」；
达到上限 → `status: 'locked'`、顶层 `code: 'CIRCUIT_OPEN'`、`failure.code: 'MFA_LOCKED'` + `reason: 'mfa_attempts_exhausted'` + `attemptsLeft: 0`，消息「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」，并用 CAS 落库 `locked`（`security-gateway.ts:895-915`）；
已锁定后的再次提交走 `authorizeAction` 的两个门之一：行已 `locked` → `lockedOutcome(...,'mfa_session_locked')`（`:1116-1119`），熔断器仍开 → `persistLockedAction` + `lockedOutcome(...,'circuit_open')`（`:1146-1149`）；两者都不新建挑战、不消费尝试、`message` 同为「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」。
锁定态返回值仍带 `requiresMfa: true`，但 HTTP 路由由 `status` 推导出的 `mfaResult` 变为 `failed`，且不发出 `mfa_required` 流事件。
真正的终态锁定会以「仅从 `pending`/`awaiting_mfa` 出发」的 CAS 把 `PendingAction.status` 落库为 `'locked'`；该行因此不再作为待决策项返回，也不再发出 `mfa_required`，MFA 弹窗不会重现；对已是 `'locked'` 的行再次授权幂等返回同一拒绝。
`mfa.ts#verify` 返回 `Result` 而非抛错；抛 `CIRCUIT_OPEN` 的只有 `circuit-breaker.resetSession` 与 `execution-policy.assertSessionMayWrite`。
成功验证码重置连续失败计数，但不解除已触发的熔断（「locked 优先」）；仅 `resetSession` 以验证码或 60 秒冷却解除。

## 结构化失败契约（SecurityFailure）

`SecurityFailure` 与 `SecurityFailureReason` 定义在 `lib/contracts/security.ts:21-28` / `:9-14`，本层在 `security-gateway.ts:30-31` 导入。
`FAILURE_REASONS`（`:225-231`）与 `parseFailure`（`:738-759`）要求 `code` 非空、`reason` 属于五个字面量；未知 reason 丢弃整个 failure。
`AuthorizationResult`（`:104-123`）的 `failure?: SecurityFailure`（`:118`）只由本文件的产出函数填充：成功分支（`:953-962`、`:1084-1093`、`:1172-1181`）不填 `code`/`failure`。
仅索取验证码（`:868-878`）只返回 `status:'awaiting_mfa'` + `message`，不填 `failure`。
验证器报错（过期/已消费/无挑战，`:880-894`）填 `{code:'MFA_FAILED', reason:'mfa_code_invalid', actionId}`，不带次数。
计次失败（`:895-915`）另带 `attemptsUsed`/`attemptsLeft`/`maxAttempts`（`attemptsUsed = MFA_MAX_ATTEMPTS - attemptsLeft`）。
锁定分支的 `failure.code` 是 `'MFA_LOCKED'`（`:906`）而同结果的顶层 `code` 是 `'CIRCUIT_OPEN'`（`:904`）——本层唯一一处分歧，`lib/public-text.ts#securityNotice` 先判 `MFA_LOCKED`（`:73`）再判 `CIRCUIT_OPEN`（`:79`）才渲染正确文案。
`lockedOutcome`（`:827-844`）固定 `{code:'CIRCUIT_OPEN', reason, actionId, attemptsLeft:0, maxAttempts:MFA_MAX_ATTEMPTS}`（不填 `attemptsUsed`），`reason` 由调用点决定：已锁定行重试 `'mfa_session_locked'`（`:1118`）、熔断闸门 `'circuit_open'`（`:1148`）。
`planCancelledOutcome`（`:791-806`）填 `{code:'SECURITY_DENIED', reason:'denied', actionId}`；转账执行期升级（`:1069-1081`）填 `{code:'LIMIT_EXCEEDED', reason:'denied', actionId}`（升级语义也用 `denied`）。
`recovery-authorization.ts#authorizeRecoveryAction`（`:25`）是本层另一处 `AuthorizationResult` 产出点，其返回（`:79-84`）不填 `code` 与 `failure`。
本目录没有一处读 `failure` 来决定文案：用户可见文案都是本文件内的硬编码中文字符串（`:446`、`:841`、`:803`、`:911-912`、`:1077` 等）；`failure` 由本层之外的调用方渲染（`app/api/actions/[id]/verify/route.ts:89-91` → `lib/public-text.ts#securityNotice`）。
校验失败（`VALIDATION`，`:1252-1256`）与转账收款人不唯一（`clarify`，`:1261-1268`）的 `blockReason` 是纯中文消息，不带前缀、不带 `failure`。
无 `actionId` 的 deny 串仍是可直接展示的内部标记：`agent/confirmation/gated-execution.ts:66` 放进 `GatedToolOutcome.error`、`agent/turns/buffer.ts:118` 复制进 `ToolEventView.summary`，`lib/tool-feedback.ts#publicToolSummary` 认不出就落到 `chat.error.toolFailed` 兜底。
本层三句锁定拒绝语里只有 `:911` 被 `PUBLIC_BUSINESS_ERRORS` 精确登记（→ `chat.error.securityLocked`）；`:446`（`gatewayDecide` deny）与 `:841`（`lockedOutcome`）未登记，同样落到 `chat.error.toolFailed`。

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
