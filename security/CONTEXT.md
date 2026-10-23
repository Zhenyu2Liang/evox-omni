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
`authorizeAction` 与 `lib/db/repositories/pendingAction.ts#assertActionMayStart` 在人工复核接管时抛 `AppError('MANUAL_REVIEW_HOLD', …)`（HTTP 409），而不是通用的 `CONFLICT`：拒绝条件本身不变（`row.taskId` 加未关闭的 `manualReview`），但原因以结构化错误码对外表达，最终文案由 `lib/public-text.ts` 收口为 `chat.error.manualReviewHold`。
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
`mfa.ts#verify` 对 `status==='locked'` 的行返回 `{ ok: false, attemptsLeft: 0, locked: true }`，位置在熔断判定（`isLocked` / `challenge.status==='locked'`）与任何写操作之前，故不消费尝试、不写挑战、不发事件、不动熔断。
挑战级的 `consumed`/`expired`/`command_changed` 判定更早（见下表），因此对 `locked` 行提交已失效挑战时 `verify` 先返回 `ChallengeInvalidError`；网关在 `cancelled` 认领落空后重读该行，仍回落为 `lockedOutcome(…, 'mfa_session_locked')` 的终态拒绝。
`mfa.ts#issueChallenge` 对 `status==='locked'` 的行抛 `AppError('MFA_LOCKED', …)` 并携带 `SecurityFailure`，不铸码、不写库；对 `MfaChallenge.status==='locked'` 的既有挑战只回读视图，不重置为 `pending`。
`cancelAction` 只从 `pending`/`awaiting_mfa` 认领，`locked` 行返回 `CONFLICT`。
`recordActionResult` 经 `claimPendingAction({ from: RESULT_RECORDABLE_STATUSES })` 写入，该集合刻意不含 `locked`，迟到的 `executed`/`failed` 通知既不改写锁定行也不伪造执行证据。
`recovery-authorization.ts` 以同一事务内 `status:'confirmed'` 的认领为前置写，`locked` 行在认领处即为 `CONFLICT`。

## 解锁（SECURITY_RESET）只解除熔断

`circuit-breaker.ts#resetSession` 是唯一解锁入口：锁定态需要验证码或冷却期（真实墙钟）才能清除，裸会话 cookie 被拒绝。
网页入口是 `POST /api/security/reset`（可选 body `{ verificationCode? }`）：锁定态缺码且未过冷却时 `resetSession` 抛 `CIRCUIT_OPEN` → HTTP 423 且锁保持；成功返回 `{ locked, failures, max, lockedActionsReopened: false, message }`，从不写 `PendingAction`。
解锁成功后用户恢复操作的唯一方式是**重新发起并重新确认**新操作；`resetDemoSession` 是仅开发者可用的维护入口。
解锁只清熔断状态与连续失败计数（`failures`→0、`locked`=false、`lockedAt` 清空），并在同一事务内以 `renewLockedMfaChallenges` 续期**仅限** `PendingAction.status='awaiting_mfa'` 的已耗尽挑战。
解锁**不**恢复已锁定（`status='locked'`）的操作：它们保持锁定，用户必须重新发起并重新确认，本层不会自动执行旧操作。
状态清除与 `SECURITY_RESET` 审计在同一事务内提交（`strict: true`），CAS 建立在读取时的快照上，因此并发解锁或更新的重新锁定让旧请求变成良性空操作且不产生重复事件。
`SECURITY_RESET` 文案与 `detail` 一致表达上述语义；`detail` 含 `actor`/`reason`/`wasLocked`/`previousFailures`/`mode`/`renewedMfaChallenges`，曾经锁定过时另有 `priorLockedAt`。
`recordFailure` 的审计粒度不变：每次 trip 恰好一条 `CIRCUIT_BREAKER_TRIPPED`（`severity:'high'`，`detail` 含 `failures`/`max`/`result`），锁定期间不再重复计数或重复发事件。

## reason 的权威判定表（mfa.ts + security-gateway.ts）

`mfa.attemptState(actionId)`（`MfaAttemptState { attempts, maxAttempts, exhausted }`）是「本操作是否用尽尝试」的唯一权威来源：`exhausted = attempts >= maxAttempts || challenge.status === 'locked'`，**只看该操作自己的挑战行**，不看账户熔断。
`mfa.challengeInvalidation(error)` 是「挑战为何不可用」的唯一权威来源：服务端判别 `'consumed' | 'expired' | 'command_changed'`，`null` 表示不是挑战级拒绝。
`verify` 的挑战级拒绝抛 `ChallengeInvalidError extends AppError`：`code` 仍为 `'MFA_FAILED'`、英文 message 逐字不变（`lib/tool-feedback.ts` 精确白名单），判别只经 `SecurityFailure` 与 `invalidation` 字段承载（`consumed` → `{code:'CONFLICT', reason:'denied'}`，`expired`/`command_changed` → `{code:'MFA_FAILED', reason:'denied'}`）。

| 情况 | 顶层 `code` | `failure.code` | `failure.reason` | `status` | 行写入 |
| --- | --- | --- | --- | --- | --- |
| 验证码错误、未锁定 | `MFA_FAILED` | `MFA_FAILED` | `mfa_code_invalid` | `awaiting_mfa` | 无（`attemptsUsed`/`attemptsLeft`/`maxAttempts` 来自 `attemptState`） |
| 本操作自己的尝试用尽 | `CIRCUIT_OPEN` | `MFA_LOCKED` | `mfa_attempts_exhausted` | `locked` | `persistLockedAction` |
| 账户级熔断（由**其它**操作触发） | `CIRCUIT_OPEN` | `CIRCUIT_OPEN` | `circuit_open` | `locked` | `persistLockedAction` |
| 重试已 `locked` 的操作 | `CIRCUIT_OPEN` | `CIRCUIT_OPEN` | `mfa_session_locked` | `locked` | 无（幂等，`lockedOutcome` 不带 `attemptsUsed`） |
| 挑战已消费（`consumedAt`） | `CONFLICT` | `CONFLICT` | `denied` | `cancelled` | CAS `from:['pending','awaiting_mfa']` → `cancelled` |
| 挑战过期 / 命令摘要变化 | 无 | 无 | 无 | `awaiting_mfa` | 先 `issueChallenge` 重签，提示态不带 `failure` |
| 无法归类的挑战级拒绝 | 抛 `AppError('CONFLICT', …)` | — | — | — | 不写业务副作用（fail-closed） |

`mfa_attempts_exhausted` 只描述**该操作自己**的尝试记录，账户熔断一律 `circuit_open`：因此 `attemptsUsed` 恒等于本操作已消费次数，绝不出现 0 或负数冒充「用尽」。
判定表使用的 reason 全部是既有 `SecurityFailureReason` 成员，`FAILURE_REASONS` 白名单无需扩展。
`consumedAt` 已写表示决定已结算：该行只能进入终态 `cancelled`（CAS 落空时重读，`locked` 走 `lockedOutcome(…, 'mfa_session_locked')`，否则抛 `AppError('CONFLICT', …)`），绝不执行、不消耗尝试、不重新签发验证码。
`expired`/`command_changed` 是唯一允许出现「继续验证」语义的情形（服务端确实签发了全新挑战）。
`locked` 终态与 `from` CAS 约束不变：`locked` 永不作为 `from` 来源，也永不写回 `pending`/`awaiting_mfa`/`confirmed`/`executed`/`failed`；解锁（`circuit-breaker.ts#resetSession`）只清熔断与失败计数，不复活任何 `locked` 操作。

`security/` 下的回归测试与局部 vitest 配置：`security/vitest.security-contract.config.ts`（`root` 固定为仓库根、`include: ['security/**/*.test.ts']`）配合 `security/mfa-lock-reason-authority.test.ts`（A–E 五条，DB 支撑），运行 `pnpm exec vitest run --config security/vitest.security-contract.config.ts`。

## 结构化失败契约

`lib/contracts/security.ts` 的 `SecurityFailure { code; reason: 'mfa_code_invalid'|'mfa_attempts_exhausted'|'mfa_session_locked'|'circuit_open'|'denied'; actionId?; attemptsUsed?; attemptsLeft?; maxAttempts? }` 是拒绝的唯一机器可读形态；`lib/errors.ts` 的 `'MFA_LOCKED'` 是它的领域错误码。
网关每个拒绝点都填 `failure`：`lockedOutcome`（`reason` 区分 `circuit_open`/`mfa_session_locked`，`attemptsLeft` 恒为 `0`）、`authorizeWithMfa` 的 `mfa_code_invalid` 与 `mfa_attempts_exhausted`（后者 `code` 为 `MFA_LOCKED`，`attemptsUsed`/`attemptsLeft`/`maxAttempts` 完整）、`planCancelledOutcome`、`authorizeTransfer` 的 `LIMIT_EXCEEDED` 升级分支。
`authorizeWithMfa` 的「尚未提交验证码／需要输入」分支是流程提示态而非拒绝，不带 `failure`。
`mfa.verify` 的挑战级拒绝在 `SecurityFailureReason` 中没有专门成员，`ChallengeInvalidError` 借既有成员承载（`consumed` → `{code:'CONFLICT', reason:'denied'}`，`expired`/`command_changed` → `{code:'MFA_FAILED', reason:'denied'}`），判别只看 `invalidation`；网关按它分流，**不**把三者塌缩成 `mfa_code_invalid`，也不渲染 `res.error.message`：
`consumed` 表示决定已结算——CAS `from:['pending','awaiting_mfa']` → `cancelled`，返回 `status:'cancelled'`、顶层 `code:'CONFLICT'`、`failure {code:'CONFLICT', reason:'denied', actionId}`、`message: CONSUMED_CHALLENGE_MESSAGE`（逐字命中 `lib/tool-feedback.ts#PUBLIC_BUSINESS_ERRORS` → `chat.error.verificationConsumed`，`security-gateway.ts:1179-1201`）；认领落空时重读该行，`locked` 走 `lockedOutcome(…, 'mfa_session_locked')`，否则抛 `CONFLICT`（`:1181-1188`）。
`expired`/`command_changed` 先 `issueChallenge` 重签，再返回不带 `code`/`failure` 的 `awaiting_mfa` 提示态，文案取 `security/messages/mfa.zh-CN.json#renewedChallenge`（`:1202-1215`）。
无法归类者抛 `AppError('CONFLICT', …)` 并带 `{code:'CONFLICT', reason:'denied'}`，不写业务副作用（fail-closed，`:1216-1217`）。
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
`mfa.ts#verify` 返回 `Result` 而非抛错；抛 `CIRCUIT_OPEN` 的只有 `circuit-breaker.resetSession`、`execution-policy.assertSessionMayWrite` 与 `manual-card-management.ts#breakerLockedError`（熔断开启时在签发挑战与验证之前拒绝，`manual-card-management.ts:60-63`、`:161`）。
成功验证码重置连续失败计数，但不解除已触发的熔断（「locked 优先」）；仅 `resetSession` 以验证码或冷却解除。
`issueChallenge` 只对未决行签发，并对已结算的 `executed`/`cancelled` 行返回 `CONFLICT`；`confirmed`/`failed`/`needs_reconciliation` 仍可签发（恢复授权与回滚重验路径依赖）。
`mfa.ts` 把 5 分钟墙钟挑战绑定到命令（`commandDigest`），保留有效尝试并记录消费。
`step-up-authenticator.ts` 是明确的演示适配器，不发送短信。
不支持的模式必须失败。
真实短信供应商与已认证的员工或用户身份属于独立的生产工作。

## MfaChallenge 行的创建点与 expiresAt

本层唯一的 `MfaChallenge` 行创建点：`mfa.ts#issueChallenge` → `createMfaChallenge`（`mfa.ts:195-201`），`maxAttempts` 取 `MFA_MAX_ATTEMPTS`，`expiresAt` 取 `MFA_CHALLENGE_TTL_MS`。
已存在挑战的续期走 `prisma.mfaChallenge.update`（`mfa.ts:187-191`），TTL 同源。
`MFA_CHALLENGE_TTL_MS = 5 * 60_000`（`mfa.ts:34`）在本层仅被 `mfa.ts:189`、`mfa.ts:199` 引用，不从 `index.ts` 导出。
`authorizeWithMfa` 不建行，只按 `expiresAt`/`commandDigest` 判断是否调用 `issueChallenge` 重签（`security-gateway.ts:1148-1154`）。
`expiresAt` 的其余读取点均为过期判定：`mfa.ts:184`、`mfa.ts:229`、`security-gateway.ts:1151-1152`、`recovery-authorization.ts:61-62`、`manual-card-management.ts:193-194`。
本层对挑战的其它写操作只改 `status`/`verifiedAt`/`consumedAt`（`mfa.ts:267` 置 `verified`、`mfa.ts:299` 置 `locked`、`manual-card-management.ts:201`、`:222`），不触碰 `expiresAt`。
`circuit-breaker.ts:298-300` 的解锁续期 `renewLockedMfaChallenges` 在仓储层，自带硬编码 5 分钟 TTL，不读 `MFA_CHALLENGE_TTL_MS`；仓储层 `createMfaChallenge` 的默认值同样硬编码，因此改常量不会自动传导。

RED 工具调用被挂起时**立即**铸造挑战：`security-gateway.ts:1007` 在 `PendingAction` 落库（`status='awaiting_mfa'`，`:965`，事务内 `:969-1002`）之后执行 `if (ev.requiresMfa) await issueChallenge(created.row.id)`。
不建挑战的挂起分支：`clarify`（`:853-857` 卡片目标、`:879-882` 转账收款人，两者都不落库）、`plan_cancelled`（`:1004`）、复用同一计划节点的既有行（`:897-898`，沿用原挑战）。
首次提交验证码时挑战通常已存在且有效，`authorizeWithMfa` 只在 `expiresAt` 缺失/已过或 `commandDigest` 变化时才 `issueChallenge` 重签（`:1148-1154`）；因此当次提交不被 `verify`，而是返回 `awaiting_mfa` 的提示态（`:1156-1169`）。
`manual-card-management.ts` 同样在 `proposeCardChange`（`:134`）与 `verifyCardChange`（`:162`）调用 `issueChallenge`，不自行写 `expiresAt`。
本层不导出除 `issueChallenge` 之外的挑战创建入口：`mfa.ts` 仅导出 `MFA_CHALLENGE_TTL_MS`、`issueChallenge`、`verify`、`getChallenge`（视图类型另计）。
`step-up-authenticator.ts#issue` 只返回演示验证码，不写库。
`PendingAction` 无 `expiresAt` 列（只有执行租约 `executionLeaseExpiresAt`）；验证码有效期唯一来源是 `MfaChallenge.expiresAt`，测试构造过期即直接改该行。

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
它还可能返回 `{ kind: 'clarify' }`（转账收款人或卡片目标无法唯一解析，不落库）或 `{ kind: 'plan_cancelled' }`（所属计划已取消，不落库）。
计划节点（`submit_plan` 之后）经 `agent/confirmation/gated-execution.ts` 以 `taskId`/`nodeId` 复用同一 `handleToolCall` 路径。
独立路径：`manual-card-management.ts#proposeCardChange`（`POST /api/cards`）直接 `pendingAction.create`，工具名 `manual_add_card`/`manual_delete_card`，被 `app/api/actions/route.ts` 显式过滤，不出现在主确认面板。
`addDemoCardSchema` 另接受可选 `linkedAccountId`（VIRTUAL 卡的结算账户绑定），`toChange` 将其透传到 `CardChange`；该绑定的账户归属与类型由 SDK 在服务端校验。

## 收款人与卡片的身份解析

`recipient-resolution.ts` 与 `card-resolution.ts` 在 park 阶段只读调用者本人的数据，把选择器解析为唯一 id。
`resolveTransferRecipient` 接受 `contactId`、`name` 与 `phone`：先用 `phoneIdentityMatches` 做身份判定，脱敏 `phone` 只做候选唯一化；成功时 `canonicalizeTransferArgs` 写入 `contactId` 并删除 `phone` 与 `name`。
`resolveCardTarget` 接受 `cardId`、`cardType`、`cardTail` 与 `cardNumber`：每个字段只匹配自己的面，成功后 `canonicalizeCardArgs` 写入 `cardId` 并删除其余 3 个选择器。
两者都返回 `resolved`、`not_found`、`ambiguous` 或 `invalid`，都不抛错、不写库。
`gatewayCreatePendingAction` 在进入参数归一化之前解析卡片目标，`CARD_TARGET_TOOLS` 的 6 个写工具都走这条路径。
把尾号或完整卡号写进 `cardId` 返回 `invalid`，不退化为按尾号查询。
澄清文本由 `buildRecipientClarifyMessage` 与 `buildCardClarifyMessage` 生成，只含脱敏值。
`Contact.phoneFull` 与 `Card.numberFull` 不离开存储层。
规则见 `docs/cn/identity-resolution.md`。

### 精确答案：手机号、近似号码、尾号与 cardId

完整手机号只与 `Contact.phoneFull` 逐字相等才算身份（`lib/phone.ts#phoneIdentityMatches`，`COMPLETE_PHONE = /^1[3-9]\d{9}$/`）：前 3 位与后 4 位相同、中间 4 位不同的近似号码得到 0 个身份匹配。
近似号码**不是** `ambiguous` 也不抛错：候选收窄只对 `isMaskedPhone` 为真的选择器执行（`recipient-resolution.ts:126`，`MASKED_PHONE = /^1[3-9]\d\*{4}\d{4}$/`），因此完整号的近似值直接返回 `{ status: 'not_found', kind: 'phone', supplied }`。
`ambiguous` 只在同一字段值命中多于一个联系人时出现，并列脱敏候选 `{ name, phone }`。
`cardTail` 接受 `6688`、`尾号6688`、`****6688`、`...6688`（`toCardTail` 去掉非数字后必须恰好 4 位），匹配 `Card.numberMasked` 末 4 位或 `numberFull` 末 4 位。
`cardNumber` 必须是不含空格/连字符的 12-19 位数字，且与 `Card.numberFull` 全等；`numberFull` 为 NULL 的行永不命中。
同一尾号命中多张卡 ⇒ `ambiguous` 加脱敏候选 `{ id, type, numberMasked }`。
澄清路径不落库：`handleToolCall` 把 `{ kind: 'clarify' }` 变成 `decision.kind: 'deny'` 与**纯文本** `blockReason`（不带 `__SECURITY_BLOCK__` 前缀），既不创建 `PendingAction` 也不铸 MFA 挑战。

### 确认摘要里可断言的号码字段

`buildPendingActionSummary`（`security-gateway.ts:1693-1745`）对 `transfer_money` 依次产出 `收款人`（姓名）、`收款手机号`（`maskPhone(recipient.phone)`，如 `139****0002`）、`Amount`（标签逐字是英文 `Amount`，**不是**「金额」）、`账户`、`风险等级`。
卡片工具由 `gatewayCreatePendingAction` 追加一条 `卡片` 字段，值为 `${cardTypeLabel(card.type)} ${card.numberMasked}`（如「信用卡 ****6688」，`security-gateway.ts:901-904`）。
非转账分支用 `操作`、`金额`（仅金额存在时）与 `风险等级`。
`金额` 行只来自 `args.amount`（`resolveAmount`，`:339-342`）：赎回的 SHARES/ALL 口径没有该行，AMOUNT 口径下它显示请求金额，而 `summary.amount` 随后被改写成预计到账金额（`:922`）。
两个投资写操作由 `gatewayCreatePendingAction` 把身份行 `unshift` 到 `操作` 之前：赎回以 `持仓`（值 `${product.name}（${holding.id}）`，`:909-911`）开头，申购以 `产品`（值 `${product.name}（${product.code}）`，`:905-907`）开头。
两者随后都追加 `入账账户`（赎回）/`付款账户`（申购），值为该用户 CHECKING 账户名，缺失时为「账户待核对」（`:952-955`）。
`security/messages/` 只有 `mfa.zh-CN.json`；澄清与摘要文案都是 TS 字面量，不在文案资源里。

## 赎回报价

`gatewayCreatePendingAction` 在挂起时用服务端决定铸造赎回报价。
赎回口径必须显式给出：`mode` 取 `SHARES`、`AMOUNT` 或 `ALL`，没有默认口径。
缺少口径、沿用已废止的 `redeemAmount`、或口径与参数混用时抛 `VALIDATION`，并在落库前拒绝。
`SHARES` 用请求份额，`AMOUNT` 用 SDK 的 `sharesFromAmount` 折算份额，`ALL` 用持仓全部份额。
到账金额用 SDK 的 `settlementFromShares` 结算，与 `banking-sdk/investment.ts` 同源，报价与结算不会分歧。
金额口径超过持仓市值时同样拒绝，并提示改用全额或按份额赎回。
持仓未记录份额时抛 `CONFLICT`，产品未发布净值时抛 `VALIDATION`，两者都不铸造报价。
确认摘要按序追加 7 行（`security-gateway.ts:923-931`）：`赎回口径`、`赎回份额`、`成交净值`、`净值日期`、`预计到账金额`、`费用口径`、`金额变化`；`持仓` 行在此之前已 `unshift` 到首位（`:911`）。
`RedemptionQuote`（`security-gateway.ts:705-719`）带 `feeAmount` 与 `feeRule` 两个纯展示字段：`feeAmount` 是字面量 `'0.00'`（`:767`），`feeRule` 取自 SDK 常量 `REDEMPTION_FEE_RULE`（`banking-sdk/net-value.ts:37`，即 `SIMULATED_NONE`）（`:768`）。
费用在本层不参与任何计算：到账金额直接取 `settlementFromShares(shares, netValue)`（`:766`），没有 `settlement − fee` 之类扣减，也不回读执行结果的费用字段。
`费用口径` 行是字面量模板（`:929`）`赎回费 ${formatCNY(feeAmount)}（${feeRule}：模拟规则免收）`，因此 UI 显示「费用口径 / `赎回费 ¥0.00（SIMULATED_NONE：模拟规则免收）`」；`formatCNY` 带 `¥` 与千分位（`lib/money.ts:79-84`）。
费用字段不进 `redemptionSnapshot`（`:773-780`），故不属于请求身份、不进命令指纹，执行时也不校验，也不落库为执行证据。
`PendingActionSummary`（`lib/contracts/security.ts:115-124`）没有费用字段，费用只以 `fields` 里的一行文本出现。
摘要金额（`summary.amount`，`:922`）是预计到账金额，不是本金。
快照字段为 `expectedShares`、`expectedNetValue`、`expectedNetValueDate`、`expectedSettlementAmount`。
快照字段属于服务端报价，重复挂起时不计入请求身份（`requestArgs`）。
快照字段同时进入命令指纹，口径或金额变化会作废旧授权。
执行时快照与当前净值、份额或重算金额不一致即抛 `CONFLICT`（`净值或持仓已变化，请重新确认`）。
该次执行零写入，`PendingAction` 置为 `failed`，用户必须重新确认。
同身份重放不重新报价，返回原始回执与原净值。
本层只快照报价，不改变余额。

## 结果通知（recordActionResult）

`security-gateway.ts#recordActionResult(actionId, 'executed'|'failed')` 只做一次 `claimPendingAction({ actionId, from: RESULT_RECORDABLE_STATUSES, to: status })`，即只写 `PendingAction.status`。
它不写 `resultJson`、不写 `AuditLog`、不写 `AuthorizationDecision` 或 `SecurityEvent`；行不存在时抛 `NOT_FOUND`，落在不可覆盖状态（`locked`）时静默返回。
真正的执行证据由 `agent/confirmation-recovery.ts#settlePendingAction` 落地（同一事务内 `claimPendingAction` 加 `resultJson`），本函数只是其后的尽力通知。
它以方法形式挂在 `securityGateway` 对象字面量上（`security-gateway.ts:1580` 定义、`:1678` 挂载），没有独立的命名导出，只能从对象上取用或以属性形式打桩。
唯一生产调用方是 `agent/confirmation/authorized-execution.ts`：`:32` 在无法解析所属会话时提前上报 `'failed'`；`:76` 在副作用提交且结算落定之后上报，条件为 `landed && status ∈ {'executed','failed'}`，并被 try/catch 吞掉失败。
该文件写的是 `gateway.recordActionResult(...)`，其中 `gateway = security.gateway.securityGateway` 在模块加载时绑定；属性在调用时才查，因此对**同一对象**上该属性的 `vi.spyOn` 会被命中，替换整个 `securityGateway` 对象则不会。

## 逐次错误验证码的响应事实（文案口径与计数）

`MFA_MAX_ATTEMPTS = 3`（`lib/constants.ts:10`）；熔断在 `failures >= max` 的当次触发（`lib/db/repositories/circuitBreaker.ts:78`），因此**第 3 次**错误即锁定，不是第 4 次。
第 1/2 次错误走 `security-gateway.ts:1230-1242`：`status:'awaiting_mfa'`、`code:'MFA_FAILED'`、`mfaResult:'failed'`、`failure {code:'MFA_FAILED', reason:'mfa_code_invalid', actionId, attemptsUsed:1|2, attemptsLeft:2|1, maxAttempts:3}`，`message` 由 `:1239` 内插为「验证码错误，请重试。剩余尝试次数：2|1。」；`PendingAction` 状态不变，但 `MfaChallenge.attempts` 自增（`mfa.ts:277`）、熔断 `failures` 自增并写一条 `MFA_FAILURE`。
第 3 次错误：`attemptState` 的 `exhausted`（`mfa.ts:119`）为真，走 `security-gateway.ts:1243-1256`：`status:'locked'`、`code:'CIRCUIT_OPEN'`、`mfaResult:'failed'`、`failure {code:'MFA_LOCKED', reason:'mfa_attempts_exhausted', actionId, attemptsUsed:3, attemptsLeft:0, maxAttempts:3}`、`message: ATTEMPTS_EXHAUSTED_MESSAGE`（`:277`），并经 `persistLockedAction`（`:1105-1108`）CAS 落库 `locked`。
文案常量：`ATTEMPTS_EXHAUSTED_MESSAGE`（`:277`）与 `lib/tool-feedback.ts:28` 的 `PUBLIC_BUSINESS_ERRORS` 键逐字相同 → `chat.error.actionLocked`；`lib/public-text.ts:68-69` 也从 `failure.code === 'MFA_LOCKED'` / `reason === 'mfa_attempts_exhausted'` 得出同一键。两条独立路径一致，故锁定文案稳定为 `chat.error.actionLocked`。
顶层 `code` 不能单独用于选文案：锁定响应的顶层 `code` 是 `CIRCUIT_OPEN`，按 `lib/tool-feedback.ts:12` 会得到 `chat.error.securityLocked`，与该响应自带的 `failure`/`message` 口径相反。渲染方必须优先用 `failure`。
`lockedOutcome`（`:1115-1132`）不带 `mfaResult`，其 `message` 是 `CIRCUIT_LOCK_MESSAGE`（`:274`，「操作已被拒绝」版）→ `chat.error.actionLocked`（`lib/tool-feedback.ts:32`）；`security-gateway.ts:516` 的「高风险操作已被锁定」熔断文案才映射 `chat.error.securityLocked`（`:33`）。
`AuthorizationResult`（`:118-137`）没有 `events` 字段：`events` 由 HTTP/agent 层合成（`app/api/actions/[id]/verify/route.ts:91`），`mfaResult` 在该路由由 `status` 推导（`:73-77`）。
每次错误另写一条 `MFA_FAILURE`（`severity:'medium'`）事件（`mfa.ts:281-296`）；锁定当次再由 `recordFailure` 写一条 `CIRCUIT_BREAKER_TRIPPED`（`severity:'high'`，`detail.result:'session_locked'`，`circuit-breaker.ts:179-188`），owner 键为 `user:<userId>`（`:121-127`）。
锁定当次三处写入同时发生：`MfaChallenge.status='locked'`（`mfa.ts:298-300`，仅当 `attempts >= maxAttempts`）、熔断 `CircuitBreakerState.locked=true` 加 `lockedAt`、`PendingAction` CAS 到 `'locked'`（`security-gateway.ts:1105-1108`）。
`attemptsUsed` 恒取 `mfa.attemptState`（`mfa.ts:113-121`）的行内 `attempts`（`security-gateway.ts:1225-1228`），因此账户级熔断（本操作 0 次尝试）报 `mfa_session_locked`/`circuit_open` 而不是 `mfa_attempts_exhausted`。
未锁定态的 1/2 次错误仍发 `mfa_required`（继续提示输入验证码）；`locked` 终态不发 `mfa_required`、也不发 `security_event`，该流事件判定在 `agent/confirmation/outcomes.ts`（见 `app/api/CONTEXT.md`）。

## 同步耗时与数据库往返（handleToolCall / park 路径）

本层没有任何 `setTimeout`/`setInterval`/`new Promise` 等待、sleep、退避或轮询：`handleToolCall` 与 `gatewayCreatePendingAction` 只等数据库。
唯二的毫秒常量都只做时间戳比较、从不被等待：`MFA_CHALLENGE_TTL_MS = 5 * 60_000`（300000 ms，`mfa.ts:34`；写入 `expiresAt` 于 `mfa.ts:189`/`:199`，比较于 `mfa.ts:184`/`:229` 与 `security-gateway.ts:1151`）和 `RESET_COOLDOWN_MS = 60_000`（`lib/constants.ts:17`，仅 `circuit-breaker.ts:237` 比较）。
`step-up-authenticator.ts#issue` 返回固定演示码、`verify` 用 `timingSafeEqual`，无 I/O、无等待。
一次 park（YELLOW/RED 写被挂起）的往返顺序：`gatewayEvaluate` 3 次读（`computeDailyTransferTotal` 1 次，`isLocked` 2 次 = `getSession` 1 + `getBreakerState` 1；会话行缺失时 `getUser` 再 1）→ `recordAuthorizationDecision` 1 次写 → 工具相关读（卡片工具：`resolveCardTarget` 的 `listCards` 1 + `resolveBankingArgs` 的 `card.findMany` 1 + 摘要 `card.findFirst` 1；转账：`listContacts` 1 + 可选 `getAccount` 1；计划节点：`listPendingActionsByTask` 1）→ 挂起事务（`BEGIN` + `runtimeFence` 2 次读 + 可选 `agentTask.findUnique` + 1 次插入 + `COMMIT`）→ RED 再 `issueChallenge` 4 次（`getPendingAction` 2 + `getMfaChallenge` 1 + `createMfaChallenge` 1）。
合计约 11 次（YELLOW 卡片写）到 15 次（RED 卡片写）往返；`clarify` 分支约 6 次（含两次授权决定写入），GREEN 允许分支 4 次（含 1 次授权决定写入）。
`computeDailyTransferTotal` 对每个工具都执行（不限转账）；`isLocked` 每次都重新解析 owner。
所有语句共用 `lib/db/serialized-connection.ts` 的 FIFO 锁，交互事务从 `BEGIN` 到 `COMMIT` 全程持有该锁，因此 park 事务会阻塞同进程其它请求；等待上限由 Prisma `maxWait`/`timeout` 10 000 ms 与适配器 `timeout` 10 000 ms 界定（`lib/db/database.ts:23-25`）。
本层共 10 个 `$transaction` 调用点（`security-gateway.ts:969`/`:1278`/`:1348`、`circuit-breaker.ts:171`/`:289`、`incidents.ts:20`、`manual-card-management.ts:114`/`:170`/`:218`、`recovery-authorization.ts:37`），全部 `await`、无一处 fire-and-forget，且全部不传 options，因此一律继承 `lib/db/database.ts:25` 的 `maxWait:10000`/`timeout:10000`；没有 CAS 失败重试循环，也没有 `$queryRaw`/PRAGMA。
本层经 `manual-card-management.ts:176` 的 `executeBankingCommand` 触达唯一一个 20 s 事务（`agent/command-execution.ts:67`，options 在 `:103` 为 `{ maxWait:10000, timeout:20000 }`）：该事务持锁期间，本层任何语句都会排队到它结束。
三个事务体内部**全部**语句都绑在事务 client 上，没有一条全局 `prisma` 语句：`runtimeFence(tx)` → `agent/durable/journal.ts:206-210` → `repositories/agentRun.ts:82-90` 只用 `client.agentRun`/`client.agentSession`；`repositories/pendingAction.ts#createPendingAction`/`claimPendingAction`/`assertActionMayStart`（含其中的 `manualReview.findFirst`）与 `risk-engine.ts#computeEffectiveTransferTotalWith` 都把同一 client 透传到每条语句。
`manual-card-management.ts:114`/`:170`/`:218` 与 `circuit-breaker.ts:171`/`:289` 同样全 client 绑定：`:114` 用 `withinTransaction(client, …)` 把事务发布进 ALS，`assertDemoCardDeletable` → `banking-sdk/tx.ts:31-32` 因此直接复用该事务而不新开 `$transaction`；`:176` 的 `executeBankingCommand` 与 :170/:218 的审计事务各自独立开事务（互不嵌套）；`auditChange` 的 `{client, strict}` 与 `recordSecurityEvent` 的 `{client, strict}` 一直穿透到唯一的 `auditLog.create`/`securityEvent.create`，`'failed'` 审计不带 dedupeKey 因而没有全局回读。

### confirm / verify 路径的往返（authorizeAction / authorizeWithMfa / verify）

`authorizeAction`（`security-gateway.ts:1458`）顺序读：`getPendingAction` 1 → `assertOwnership` 的 `getSession` 1（`:390`）→ 静态策略升级分支 `pendingAction.updateMany` 1 + 重读 `getPendingAction` 1（`:1487-1493`，仅当持久化档位低于当前 RED）→ `manualReview.findFirst` 1（`:1497`）→ `isLocked` 2 读（`:1504`）；熔断分支再 `persistLockedAction` 1 次 CAS 写（`:1105-1108`）。
静态 YELLOW 确认：`claimPendingAction({from:['pending'],to:'confirmed'})`（`:1520`）因 `to==='confirmed'` 且未传 client 而**自开一个** `$transaction`（`lib/db/repositories/pendingAction.ts:260`），内含无副作用 `updateMany` + `findUnique(taskId)` + `manualReview.findFirst` + CAS 约 4 条语句：一次确认会在 park 事务之外再叠加一个独立事务。
RED：`authorizeWithMfa`（`:1139`）先 `getMfaChallenge` 1；挑战缺失/过期/摘要变化时 `issueChallenge` 3–4 条写（`mfa.ts:155`）；未提交验证码或刚重签即返回 `awaiting_mfa` 提示态，不再产生语句。
带正确码：`mfa.verify`（`mfa.ts:215`）约 10 条（`getMfaChallenge` 1 + `getPendingAction` 1 + `isLocked` 2 + `mfaChallenge.update` 1 + `recordSuccess` 的 owner 解析 2 加写 1 + 再 `isLocked` 2），随后 `prisma.$transaction`（`:1278`）内 `assertActionMayStart` 3 + CAS 1 + 可选 `agentTask.findUnique` ≈ 4–5。
带错误码额外约 8–9 条：`incrementMfaAttempts` 1 + `recordFailure` 事务（owner 解析 2 + upsert 1 + 首次 trip 的事件 1）+ 再次 `resolveBreakerOwner` 2 + `MFA_FAILURE` 事件 1 + 条件性 `updateMfaChallengeStatus` 1 + `attemptState` 1。
合计一次正确码 verify ≈ 20 条往返、一次错误码 ≈ 24–26 条；其中只有 claim 那 4–5 条属于本层的交互事务，其余每条各自单独获取 `lib/db/serialized-connection.ts` 的 FIFO 锁。
MFA 尝试梯度是**跨请求**的：3 次错误码等于 3 个独立 `POST /api/actions/[id]/verify`，单次请求内不重试、不 sleep、不轮询；`RESET_COOLDOWN_MS = 60_000`（`lib/constants.ts:17`）只在 `circuit-breaker.ts:237` 比较，未到冷却期立即抛 `CIRCUIT_OPEN`（HTTP 423），从不等待。
`execution-policy.ts#assertSessionMayWrite`（`:13`）读 `agentSession.findUnique` 1 + `isLocked` 2：在 SDK 写事务内必须传入该事务 client，否则这 3 条读会排到自持唯一连接的事务后面，直到 `timeout: 10000` 才失败。
`recovery-authorization.ts` 不在 confirm/verify 路由上；其 `expiresAt` 判定（`:61-62`，`Date.now()` 真实时钟）只比较不等待，`:37` 的事务先以 `confirmed` 认领作为写入序列化点，`:73` 的 `issueChallenge` 在提交之后。
`incidents.ts` 的 `SIGNAL_POLICY` 窗口（`:8-11`，600000/300000 ms）只是 `riskSignal.count` 的 `createdAt >= now - windowMs` 过滤条件，不是定时器。
本层每条语句的硬上限来自下游而非本层：适配器 `timeout: 10000` 与 Prisma `maxWait`/`timeout: 10000`（`lib/db/database.ts:23-25`）；本层不引入任何额外的等待、重试或轮询，因此延迟完全等于「语句条数 × 单条耗时 + FIFO 队列等待」，后者无上限。

## 已知边界

`lib/db/repositories/pendingAction.ts#setPendingActionStatus` 仍是无条件状态写入原语，本层与 `agent/` 都不再调用它（别名 `updatePendingActionStatus` 同样无人使用），只剩测试引用；状态写入一律走 `claimPendingAction`。
`agent/` 中未传 `from` 的 `settlePendingAction` 结算路径当前不可达 `locked`（`confirmed` 无法变成 `locked`），属纵深防御缺口，需在该层加 CAS。
带 `__SECURITY_BLOCK__` 前缀的 deny 载荷仍是模型可见文本，其最终文案取决于 `agent/` 与 `lib/tool-feedback.ts` 是否消费 `parseBlockReason` 的 `failure`；本层不再向用户文案内插内部字面量。
`lockedOutcome` 的顶层 `code` 固定为 `CIRCUIT_OPEN`（`MFA` 尝试耗尽时 `failure.code` 为 `MFA_LOCKED`）；若改为按 `reason` 返回 `MFA_LOCKED`，需同步 `tests/unit/security/mfa-failure-contract.test.ts` 中 `retry.code` 与 `toMatchObject` 两处断言。
