# 安全层

本层用代码决定权限、确认、验证、风险与锁定状态。
本层不执行业务操作。
见 `docs/cn/security.md` 与 `docs/cn/known-risks.md`。

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

`injection-guard.ts` 检测可疑指令。
`incidents.ts` 在一个事务中持久化去重信号、相关安全事件与账户级锁定。
`circuit-breaker.ts` 应用验证失败锁定与已审计的冷却重置；锁定由该用户的各会话共享。
`mfa.ts` 管理持久化验证挑战并把失败喂给熔断。
`manual-card-management.ts` 是手工卡片变更（`manual_add_card`/`manual_delete_card`）的确认、验证与执行入口。

`execution-policy.ts` 在真实事务客户端上检查写权限。
`recovery-authorization.ts` 只授予当前允许的新恢复效果。
已验证的收据绕过新写入，并在锁定期间保持可恢复。
未知结果不等于失败，不得盲目重试。

模型工具不包含任意代码、SQL、shell、文件与外部 HTTP。
公开日志读取器不包含原始思维与凭据。
资金结论由银行智能体根据 SDK 与收据事实渲染。

## 锁定是终态

MFA 连续 `MFA_MAX_ATTEMPTS`（`lib/constants.ts` = 3）次错误产生三重结论：`MfaChallenge.status='locked'`、`CircuitBreakerState.locked=true`、`PendingAction.status='locked'`。
`PendingAction` 的锁定落库唯一入口是 `security-gateway.ts#persistLockedAction`：`claimPendingAction({ from: ['pending','awaiting_mfa'], to: 'locked' })`，因此 `locked` 只能从这两个状态进入，丢失的 CAS 是良性空操作。
`locked` 是终态：不得作为待决策项、不得重新验证、不得重新签发验证码、不得被取消、不得自动执行，任何路径都不能把它写回 `pending`/`awaiting_mfa`/`confirmed`/`executed`/`failed`。

`authorizeAction` 在未决状态守卫**之前**对 `status==='locked'` 早退，返回幂等的 `lockedOutcome`（不新发挑战、不消费尝试、不重新提示）。
熔断开启时 `authorizeAction` 先 `persistLockedAction` 再返回 `lockedOutcome`，使锁定对行持久化，待决策列表不会再出现该项。
`mfa.ts#verify` 对 `status==='locked'` 的行返回 `{ ok: false, attemptsLeft: 0, locked: true }`，位置在熔断/挑战判定与任何写操作之前，故不消费尝试、不写挑战、不发事件、不动熔断。
`mfa.ts#issueChallenge` 对 `status==='locked'` 的行抛 `AppError('MFA_LOCKED', …)` 并携带 `SecurityFailure`，不铸码、不写库；对 `MfaChallenge.status==='locked'` 的既有挑战只回读视图，不重置为 `pending`。
`cancelAction` 只从 `pending`/`awaiting_mfa` 认领，`locked` 行返回 `CONFLICT`。
`recordActionResult` 经 `claimPendingAction({ from: RESULT_RECORDABLE_STATUSES })` 写入，该集合刻意不含 `locked`，迟到的 `executed`/`failed` 通知既不改写锁定行也不伪造执行证据。
`recovery-authorization.ts` 以同一事务内 `status:'confirmed'` 的认领为前置写，`locked` 行在认领处即为 `CONFLICT`。

## 解锁（SECURITY_RESET）只解除熔断

`circuit-breaker.ts#resetSession` 是唯一解锁入口：锁定态需要验证码或冷却期（真实墙钟）才能清除，裸会话 cookie 被拒绝。
解锁只清熔断状态与连续失败计数（`failures`→0、`locked`=false、`lockedAt` 清空），并在同一事务内以 `renewLockedMfaChallenges` 续期**仅限** `PendingAction.status='awaiting_mfa'` 的已耗尽挑战。
解锁**不**恢复已锁定（`status='locked'`）的操作：它们保持锁定，用户必须重新发起并重新确认，本层不会自动执行旧操作。
状态清除与 `SECURITY_RESET` 审计在同一事务内提交（`strict: true`），CAS 建立在读取时的快照上，因此并发解锁或更新的重新锁定让旧请求变成良性空操作且不产生重复事件。
`SECURITY_RESET` 文案与 `detail` 一致表达上述语义；`detail` 含 `actor`/`reason`/`wasLocked`/`previousFailures`/`mode`/`renewedMfaChallenges`，曾经锁定过时另有 `priorLockedAt`。
`recordFailure` 的审计粒度不变：每次 trip 恰好一条 `CIRCUIT_BREAKER_TRIPPED`（`severity:'high'`，`detail` 含 `failures`/`max`/`result`），锁定期间不再重复计数或重复发事件。

## 结构化失败契约

`lib/contracts/security.ts` 的 `SecurityFailure { code; reason: 'mfa_code_invalid'|'mfa_attempts_exhausted'|'mfa_session_locked'|'circuit_open'|'denied'; actionId?; attemptsUsed?; attemptsLeft?; maxAttempts? }` 是拒绝的唯一机器可读形态；`lib/errors.ts` 的 `'MFA_LOCKED'` 是它的领域错误码。
网关每个拒绝点都填 `failure`：`lockedOutcome`（`reason` 区分 `circuit_open`/`mfa_session_locked`，`attemptsLeft` 恒为 `0`）、`authorizeWithMfa` 的 `mfa_code_invalid` 与 `mfa_attempts_exhausted`（后者 `code` 为 `MFA_LOCKED`，`attemptsUsed`/`attemptsLeft`/`maxAttempts` 完整）、`planCancelledOutcome`、`authorizeTransfer` 的 `LIMIT_EXCEEDED` 升级分支。
`authorizeWithMfa` 的「尚未提交验证码／需要输入」分支是流程提示态而非拒绝，不带 `failure`。
`mfa.verify` 的挑战已消费/已过期/摘要变化在 `SecurityFailureReason` 中没有成员，网关回退到 `mfa_code_invalid`，用户文案取 `res.error.message` 并经 `lib/tool-feedback.ts` 的公开文案表渲染。
`manual-card-management.ts` 的终态锁定拒绝抛 `AppError('MFA_LOCKED', …)` + `{ code:'MFA_LOCKED', reason:'mfa_session_locked', actionId }`，熔断拒绝抛 `AppError('CIRCUIT_OPEN', …)` + `{ code:'CIRCUIT_OPEN', reason:'circuit_open', actionId }`。
用户可见文案不内插内部状态字面量：`PENDING_ACTION_STATUS_LABEL` 覆盖全部 `PendingActionStatus` 的中文标签，`statusLabel` 对未知值降级为「状态已变更」。

`blockReason` 载荷是结构化 JSON：`serializeBlockReason` 产出 `__SECURITY_BLOCK__` + `{ actionId, decisionKind, failure? }`（`actionId` 无条件是必填的真实行 id）。
`handleToolCall` 的熔断 deny 与 `plan_cancelled` deny 产出同名前缀 + `{ decisionKind:'deny', failure:{ … } }` 且**不含** `actionId`。
`parseBlockReason` 接受省略 `actionId` 的载荷并保留其 `failure`；返回 `null` 只表示「不是本层载荷」。
`VALIDATION` 与转账收款人不唯一的 `clarify` 的 `blockReason` 是纯中文消息，不带前缀。
`message` 永不等于序列化后的 block reason 标记串，也不把状态字面量当文案；消费方应使用 `parseBlockReason` 的 `failure` 渲染拒绝，不得直接展示原始串。

## MFA 尝试限制

熔断在「第 3 次」失败即触发（`failures >= max`，非第 4 次）。
`security-gateway.ts` 的 MFA 分支以领域结果返回状态（不抛出）：
未达上限 → `status: 'awaiting_mfa'`、消息「验证码错误，请重试。剩余尝试次数：N。」；
达到上限 → `status: 'locked'`、`code: 'CIRCUIT_OPEN'`、`failure.reason: 'mfa_attempts_exhausted'`；
已锁定后的再次提交走提前熔断分支或 `status==='locked'` 早退，返回 `failure.reason: 'mfa_session_locked'`。
锁定态返回值仍带 `requiresMfa: true`，但 HTTP 路由由 `status` 推导出的 `mfaResult` 变为 `failed`，且不发出 `mfa_required` 流事件。
真正的终态锁定以「仅从 `pending`/`awaiting_mfa` 出发」的 CAS 把 `PendingAction.status` 落库为 `'locked'`；该行因此不再作为待决策项返回，也不再发出 `mfa_required`，MFA 弹窗不会重现；对已是 `'locked'` 的行再次授权幂等返回同一拒绝。
`mfa.ts#verify` 返回 `Result` 而非抛错；抛 `CIRCUIT_OPEN` 的只有 `circuit-breaker.resetSession` 与 `execution-policy.assertSessionMayWrite`。
成功验证码重置连续失败计数，但不解除已触发的熔断（「locked 优先」）；仅 `resetSession` 以验证码或冷却解除。
`issueChallenge` 只对未决行签发，并对已结算的 `executed`/`cancelled` 行返回 `CONFLICT`；`confirmed`/`failed`/`needs_reconciliation` 仍可签发（恢复授权与回滚重验路径依赖）。
`mfa.ts` 把 5 分钟墙钟挑战绑定到命令（`commandDigest`），保留有效尝试并记录消费。
`step-up-authenticator.ts` 是明确的演示适配器，不发送短信。
不支持的模式必须失败。
真实短信供应商与已认证的员工或用户身份属于独立的生产工作。

## MfaChallenge 行的创建点与 expiresAt

本层唯一的 `MfaChallenge` 行创建点：`mfa.ts#issueChallenge` → `createMfaChallenge`（`mfa.ts:134-140`），`maxAttempts` 取 `MFA_MAX_ATTEMPTS`，`expiresAt` 取 `MFA_CHALLENGE_TTL_MS`。
已存在挑战的续期走 `prisma.mfaChallenge.update`（`mfa.ts:126-130`），TTL 同源。
`MFA_CHALLENGE_TTL_MS = 5 * 60_000`（`mfa.ts:34`）在本层仅被 `mfa.ts:128`、`mfa.ts:138` 引用，不从 `index.ts` 导出。
`authorizeWithMfa` 不建行，只按 `expiresAt`/`commandDigest` 判断是否调用 `issueChallenge` 重签（`security-gateway.ts:899-905`）。
`expiresAt` 的其余读取点均为过期判定：`mfa.ts:123`、`mfa.ts:166`、`security-gateway.ts:902-903`、`recovery-authorization.ts:61-62`、`manual-card-management.ts:193-194`。
本层对挑战的其它写操作只改 `status`/`consumedAt`（`mfa.ts:202`、`mfa.ts:234`、`manual-card-management.ts:201`、`:222`），不触碰 `expiresAt`。
`circuit-breaker.ts:298-300` 的解锁续期 `renewLockedMfaChallenges` 在仓储层，自带硬编码 5 分钟 TTL，不读 `MFA_CHALLENGE_TTL_MS`；仓储层 `createMfaChallenge` 的默认值同样硬编码，因此改常量不会自动传导。

## 手工卡片管理（manual-card-management.ts）

`locked` 一律终态拒绝：`verifyCardChange` 与 `cancelCardChange` 先调 `assertNotTerminallyLocked`，在读取收据、签发挑战、消费尝试或写库之前抛出带 `SecurityFailure` 的 `MFA_LOCKED`。
可认领状态集合是 `UNDECIDED_STATUSES = ['awaiting_mfa','pending']`；执行栅栏先显式拒绝 `locked`，再要求 `current.status` 属于该集合，CAS 以 `status: current.status` 作期望来源。
`proposeCardChange` 对 `executed`/`cancelled`/`locked` 的行不签发挑战，也不刷新既有挑战。
`listCardChanges` 把 `locked` 作为终态记录展示（`CardChange.status` 含 `'locked'`）；熔断开启时把整批未决行显示为 `locked` 只是展示，解锁后这些未决行恢复可操作。
手工路径只暴露两个工具名：`manual_add_card`（新增 DEBIT/CREDIT/VIRTUAL 记录）与 `manual_delete_card`（删除记录）；没有补办、冻结、解冻或限额操作。

## 卡片生命周期与 replace_card 前提

`replace_card` 的前提只有两条：源卡属于当前用户，且状态为 `LOST`。
`banking-sdk/card.ts#requireCard` 对不存在的卡片抛 `NOT_FOUND`、对他人卡片抛 `SECURITY_DENIED`；`#replaceCard` 对非 `LOST` 源卡抛 `CONFLICT`「只有已挂失的卡片可以补办，请先办理挂失。」。
本层与 `agent/tools/card.ts` 都没有 CREDIT / DEBIT / VIRTUAL 的类型禁区；RED 档位只来自 `lib/contracts/tool-catalog.ts` 的目录项。
唯一的类型分支在 SDK：VIRTUAL 补办必须重新校验并继承结算账户绑定，CREDIT 补办原样继承 `creditLimitMinor` 与 `availableLimitMinor`，因此代理可以补办挂失的信用卡。
`gatewayCreatePendingAction` 在挂起时只把卡片类型与掩码写进确认摘要，不做归属或类型裁决。
卡片页也没有补办入口，补办只能由代理发起（见 `docs/cn/card-management.md`）。
`agentEnabled === false` 的拒绝分支存在于 `permission-engine.ts`、`agent/confirmation/gated-execution.ts`、`security-gateway.ts`（确认与取消）与 `agent/tools/index.ts`，但当前没有任何目录项设为 `false`；物理卡的创建/删除只能手工，是因为目录里不存在这类工具名，而不是被该开关拦住。
模型对「实体卡只能手工办理」的措辞来自 `agent/system-prompt.ts`，服务端无此规则。

## 待处理操作（PendingAction）的创建路径

`PendingAction` 行只由两个创建点产生。
主路径：模型的工具调用 → agent `beforeToolCall`（`agent/banking-agent.ts`）→ `securityGateway.handleToolCall` → `gatewayCreatePendingAction` → 仓储 `createPendingAction`。
纯文本回复不经过 `beforeToolCall`，因此不会创建任何 `PendingAction`，也不会出现确认/MFA 面板。
`gatewayCreatePendingAction` 落库状态：`ev.requiresMfa ? 'awaiting_mfa' : 'pending'`；RED 同时铸造 MFA 挑战。
它还可能返回 `{ kind: 'clarify' }`（转账收款人无法唯一解析，不落库）或 `{ kind: 'plan_cancelled' }`（所属计划已取消，不落库）。
计划节点（`submit_plan` 之后）经 `agent/confirmation/gated-execution.ts` 以 `taskId`/`nodeId` 复用同一 `handleToolCall` 路径。
独立路径：`manual-card-management.ts#proposeCardChange`（`POST /api/cards`）直接 `pendingAction.create`，工具名 `manual_add_card`/`manual_delete_card`，被 `app/api/actions/route.ts` 显式过滤，不出现在主确认面板。
`addDemoCardSchema` 另接受可选 `linkedAccountId`（VIRTUAL 卡的结算账户绑定），`toChange` 将其透传到 `CardChange`；该绑定的账户归属与类型由 SDK 在服务端校验。

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

## 已知边界

`lib/db/repositories/pendingAction.ts#setPendingActionStatus` 仍是无条件状态写入原语，本层已全部改用 `claimPendingAction`，其唯一调用方在 `agent/`。
`agent/` 中未传 `from` 的 `settlePendingAction` 结算路径当前不可达 `locked`（`confirmed` 无法变成 `locked`），属纵深防御缺口，需在该层加 CAS。
带 `__SECURITY_BLOCK__` 前缀的 deny 载荷仍是模型可见文本，其最终文案取决于 `agent/` 与 `lib/tool-feedback.ts` 是否消费 `parseBlockReason` 的 `failure`；本层不再向用户文案内插内部字面量。
`lockedOutcome` 的顶层 `code` 固定为 `CIRCUIT_OPEN`（`MFA` 尝试耗尽时 `failure.code` 为 `MFA_LOCKED`）；若改为按 `reason` 返回 `MFA_LOCKED`，需同步 `tests/unit/security/mfa-failure-contract.test.ts` 中 `retry.code` 与 `toMatchObject` 两处断言。
