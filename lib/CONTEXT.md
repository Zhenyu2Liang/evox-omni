# 共享基础模块

## 职责与入口

本目录提供契约、金融单位、时间、配置和数据访问。
业务执行与权限判断由调用层负责。

| 入口 | 职责 |
| --- | --- |
| `contracts/tool-catalog.ts` | 工具名称、副作用、权限与恢复策略 |
| `contracts/tool-output.ts` | 工具结果的结构校验 |
| `contracts/` | 对话、授权、任务、审计与运行契约 |
| `money.ts`、`decimal.ts` | 金额、比例与估值计算 |
| `date.ts`、`clock.ts` | 业务日历与时钟 |
| `config.ts`、`constants.ts` | 运行配置与演示常量 |
| `ledger.ts` | 执行身份、流水身份与输入摘要 |
| `chat-history.ts`、`chat-plan-history.ts` | 历史分页与计划归属 |
| `chat-cards.ts`、`action-summary.ts` | 业务卡片与授权摘要 |
| `sensitive.ts`、`tool-diagnostics.ts` | 敏感字段过滤与诊断投影 |
| `mask.ts` | 展示脱敏的唯一实现（手机号、账号、卡号） |
| `tool-feedback.ts` | 拒绝/失败结果的公开文本投影（唯一出口），含结构化安全拒绝 `publicSecurityError` |
| `public-text.ts` | 公开文本漏斗：`safePublicText`、`publicErrorMessage`、`securityNotice` / `securityNoticeKey` / `securityNoticeParams` |
| `internal-text.ts` | 纯文本形状判定 `isInternalDiagnostic` 与 `publicSafeMessage` |
| `errors.ts` | `ErrorCode`、`AppError`（含构造期净化的 `publicMessage`）与 `Result` |
| `prisma-cli-env.ts` | Prisma 命令环境与可执行文件解析 |
| `db/` | 客户端、事务上下文与仓储 |

## 运行配置（`config.ts`）

`getConfig()` 在每次调用时读取 `process.env`（不缓存、不在模块加载时求值），因此测试可以随时切换 `LLM_MODE`。
`AppConfig.llmMode` 的类型是字面量联合 `'live' | 'mock'`。
取值表达式为 `process.env.LLM_MODE === 'live' ? 'live' : 'mock'`：未设置或任何其他值（含大小写变体）都得到 `'mock'`，不存在 env 默认值兜底。
`llmProvider` 回退默认 `'openai'`，`llmModel` 回退默认 `'gpt-4o-mini'`（`LLM_PROVIDER` / `LLM_MODEL`，仅 live 模式使用）。
`demoUserId` 回退默认 `'user_liming'`（`DEMO_USER_ID`）。
`contextCompaction` 四项来自 `AGENT_COMPACTION_*`；`tokenSetting` 只接受 `[128, 1000000]` 内的安全整数，否则为 `undefined`。
`config.ts` 不读取 `LLM_REQUEST_TIMEOUT_MS`，也不含 provider base URL 或 API key 字段（凭据由运行环境提供）。
`GET /api/health` 的 `llmMode` 直接取自 `getConfig().llmMode`，永不写死。
测试环境三处都强制 `LLM_MODE=mock`：`vitest.config.ts` 的 `test.env`、`agent/vitest.agent.config.ts` 的 `test.env`、`tests/setup.ts`；`tests/e2e/acceptance.e2e.ts` 在入口设 `mock`/`faux`，`tests/e2e/live-acceptance.e2e.ts` 设 `live` 与 `deepseek`。
`tests/unit` 下目前没有专门覆盖 `getConfig()` 的单元测试文件。

## 金融与时间约定

已入账金额使用 `BigInt` 分，字段以 `Minor` 结尾。
JSON 金额使用十进制字符串。
`moneyToCents` 校验小数位与有符号 64 位范围。
比例、数量与未结算估值使用 `decimal.ts`。
`moneyToChartNumber` 只用于图形坐标。
`formatDecimalCNY` 在展示边界把金额按 HALF_UP 舍入到两位小数，并保留符号与千分位。
命令金额字段（`contracts/command.ts` 的 `MONETARY_FIELDS`）在入参归一化时转为十进制字符串：`amount`、`creditLimit`、`monthlyLimit`、`expectedRedemptionAmount`、`redeemAmount`。

`date.ts` 按北京时间构造和格式化日期。
`demoNow()` 提供固定演示业务时间。
安全冷却、执行租约和定时任务调度使用真实时间。
日期范围通常为半开区间；以调用接口为准。

## 展示脱敏（`mask.ts`）

`lib/mask.ts` 是展示脱敏的唯一实现，零依赖，任何层都直接复用它。
`maskPhone` 保留前 3 位与末 4 位：长度 ≤ 3 全掩码为 `****`，长度 4–7 为前 3 位加 `****`，长度 > 7 为前 3 位 + `****` + 末 4 位；`null` / `undefined` / 非字符串 / 空串返回空串，缺省值不会渲染成星号，且不做 trim。
`maskAccountNumber` 与 `maskCardNumber` 共用同一内部算法，只保留末 4 位且输出长度与输入一致：长度 ≤ 4 原样返回，对已脱敏串（`****8821` → `****8821`）幂等，不校验是否纯数字、不 trim、不抛错。
`lib/phone.ts` 区分两类问题并分别导出：身份判定 `phoneIdentityMatches` 只允许两个完整号码逐字符相等（中间四位参与比较），脱敏或不完整输入永不为身份；候选筛选 `phoneCandidateMatches` 只缩小候选集，脱敏输入可凭前 3 位加末 4 位成为候选，数字片段按去星号后的子串匹配，调用方必须再要求候选唯一。`maskAwarePhoneMatch` 为严格身份判定的兼容名，`searchPhoneMatch` 为候选筛选的兼容名，二者不可互相替代；`isCompletePhone` / `isMaskedPhone` 判定形状，`export { maskPhone } from './mask'` 保持既有导入路径兼容。
`lib/tool-diagnostics.ts` 内的手机号打码属于诊断日志脱敏（正则门控、输出 `****` + 末 4 位），不是展示格式化，不复用 `mask.ts`。
完整号码只存在于服务端字段 `Contact.phoneFull` 与 `Card.numberFull`，供 `security/recipient-resolution.ts` 与 `security/card-resolution.ts` 精确匹配。
展示列 `Contact.phone` 与 `Card.numberMasked` 只存脱敏值，投影、日志、工具结果、接口响应与错误消息都只输出脱敏值。
身份判定只用完整号码严格相等，脱敏值仅作候选筛选，规则见 [identity-resolution.md](../docs/cn/identity-resolution.md)。

## 投资输出契约与标签

`contracts/tool-output.ts` 只声明可被数据引用寻址的字段路径，不强制字段存在，新增字段不破坏既有输出。
`subscribe_investment`、`redeem_investment` 结果契约含可选部分赎回字段 `partial`、`redeemedPrincipal`、`remainingPrincipal`、`remainingMarketValue`、`remainingProfit` 与加购字段 `addedToExisting`、`lastPurchaseAt`。
`get_investment_holdings` 条目含可选 `lastPurchaseAt` 与 `purchases`。
对应界面标签为 `i18n/messages/business.*.json` 的 `business.investments.lastPurchase`、`purchases`、`purchaseCount`、`addedToExisting`。

## 公开错误文本投影（`tool-feedback.ts`）

公开文本只能来自消息目录，内部诊断只进 `debugDetail` 与开发者面板。
`publicToolError(message, t, fallback = 'chat.error.toolFailed', errorCode?, params?)` 的判定顺序：`PUBLIC_BUSINESS_ERRORS` 精确 SDK 消息 → 三条固定正则（余额不足、低于起购、验证码剩余次数）→ `PUBLIC_ERROR_CODES[errorCode]` → 无 `message` 取 `fallback` → `CONVERSATION_TOOL_REJECTION` → `chat.error.` 前缀且 `isMessageKey` 命中 → `localizeChatError` 命中（`display-sources.json` 的 `errors`）→ 否则 `fallback`；`params` 只透传给最终选中的目录键。
`PUBLIC_ERROR_CODES` 是 `Record<ErrorCode, MessageKey>`，覆盖全部 11 个 `ErrorCode`；`TOOL_FAILED` 与 `INTERNAL` 都映射到 `chat.error.toolFailed`，`CIRCUIT_OPEN` 映射 `chat.error.securityLocked`，`MFA_FAILED` 映射 `chat.error.verificationFailed`，`MFA_LOCKED` 映射 `chat.error.actionLocked`，`SECURITY_DENIED` 映射 `chat.error.securityDenied`。
未识别的 `errorCode`（任意不在 `ErrorCode` 联合内的字符串）与未识别 `message` 一律落到 `chat.error.toolFailed`。
`PUBLIC_BUSINESS_ERRORS`（`tool-feedback.ts:17-33`）共有 12 条精确字符串，其中三条来自安全网关：`authorizeWithMfa`（`security/security-gateway.ts:957`）的验证码耗尽句「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」→ `chat.error.actionLocked`；`lockedOutcome()`（`:880`）的「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」→ `chat.error.actionLocked`；`gatewayDecide` 的 `HIGH_RISK_BLOCKED` 拒绝（`:485`）「当前会话已触发安全熔断，高风险操作已被锁定。请前往安全中心解除限制后再试。」→ `chat.error.securityLocked`。
这三条是 COMPATIBILITY ONLY：只服务已按文本持久化的历史拒绝与未传 typed 字段的调用方；权威路径是 `publicSecurityError` 按结构化字段渲染（见下）。
该表的中文条目以 `\uXXXX` 转义写入（`tool-feedback.ts:20-23`、`27`、`31-32`），实际文案为「账户余额不足，无法完成认购」「缺少限额分类」「限额必须是不小于 0 的金额」「该卡片已挂失，无需重复挂失」与上述三句网关文案；三条内联正则分别产出 `chat.error.insufficientFunds`（`{balance, amount}`）、`chat.error.purchaseMinimum`（`{amount}`）、`chat.error.verificationRemaining`（`{count}`）。
`publicSecurityError(failure, t, fallback = 'chat.error.securityDenied')`（`tool-feedback.ts`）是结构化安全拒绝的主路径：只按 `SecurityFailure` 的 typed 字段委托 `securityNotice`/`securityNoticeKey`，**从不读 message 文本**；`failure` 缺失时返回 `t(fallback)`。
因此 `security/` 与 `app/` 应以 `publicSecurityError(failure, t)` 渲染拒绝；把原始文案交给 `publicToolError`/`publicToolSummary` 时必须同时传 `errorCode`。
`PUBLIC_ERROR_CODES` 只在调用方显式传入 `errorCode` 时生效；网关的 `AuthorizationResult.code`（定义在 `security/security-gateway.ts:104`，不在本目录）不会自动出现在 `ToolEventView.errorCode` 上。
`publicToolSummary(event, t)` 按状态分流：`search_conversation_history` + `success` → `chat.activity.historyRead`；`blocked` 且带 `errorCode` → `publicToolError(summary, t, 'chat.error.operationNotStarted', errorCode, errorParams)`；`blocked` 且无 `actionId` → `publicToolError(summary, t, 'chat.error.operationNotStarted')`（该分支不传 `errorCode`）；`error` → `publicToolError(summary, t, 'chat.error.toolFailed', errorCode, errorParams)`；`needs_reconciliation` → `chat.error.unknownOutcome`；其余状态（`started`/`success`/`updated`/`cancelled` 及带 `actionId` 的 `blocked`）走 `localizeChatError`，未命中时**原样返回 `event.summary`**。
因此本目录不剥离任何内部摘要标记（如 `__SECURITY_BLOCK__{...}`）：这类字符串走 `error` 分支时被替换为 `chat.error.toolFailed`，走其它状态分支时会被当作合法文本透出，去重/剥离责任在写入事件的一侧。
`ToolEventView`（`contracts/agent.ts`）没有 `resultSummary` 字段：公开文本只来自 `summary` 与 `errorCode`，`debugDetail`/`debugArguments` 仅供开发者面板。
`ChatCard {type:'error', message, code?}` 与 `AgentStreamEvent {type:'security_event', kind, message}` 的 `message` 同样是无目录约束的自由字符串。

## 错误类型（`errors.ts`）

`ErrorCode`（`errors.ts:3`）为 12 个字面量联合：`VALIDATION`、`NOT_FOUND`、`INSUFFICIENT_FUNDS`、`LIMIT_EXCEEDED`、`SECURITY_DENIED`、`MFA_FAILED`、`MFA_LOCKED`、`CIRCUIT_OPEN`、`MANUAL_REVIEW_HOLD`、`CONFLICT`、`TOOL_FAILED`、`INTERNAL`。
`AppError`（`errors.ts:5-25`）只有 `readonly code: ErrorCode`、继承的 `message`（内部诊断，可进日志）、`readonly detail?: unknown`（内部用途）与 `readonly publicMessage?: string`（public-safe）；没有结构化 `failure` 字段，也没有 `toJSON` 或自定义序列化，故 `JSON.stringify` 只出现自有可枚举属性 `code`/`detail`（以及存在时的 `publicMessage`）。
`publicMessage` 在构造器里用 `internal-text.ts#publicSafeMessage` 净化：可渲染时等于 `message`，被判为内部诊断或空白时为 `undefined`，语义是「没有可公开文案，调用方用目录兜底」。
`message` 与 `detail` 语义不变：`message` 仍是内部诊断文本，`detail` 仍只供日志与开发者面板。
对外（HTTP / SSE / 微信）只能渲染 `publicMessage` 经净化漏斗（`publicErrorMessage` / `safePublicText`）的结果，绝不能把 `AppError.message` 当文案。
`errors.ts` 不可依赖 i18n 漏斗模块，因此净化谓词单独放在 `internal-text.ts`，由公开文本漏斗与 `AppError` 共用。
`AppError.from(e)` 收敛任意值：已是 `AppError` 原样返回；`Error` 包成 `INTERNAL` 并保留原对象为 `detail`；其余 `String(e)`。
三条分支都走同一个构造器，因此 `from()` 产出的 `publicMessage` 一定已净化。
`Result<T> = { ok: true; value: T } | { ok: false; error: AppError }`（`errors.ts:27`），`ok`/`err` 是纯构造器（`errors.ts:28-29`）。
结构化安全失败不复用 `AppError`：它走 `contracts/security.ts` 的 `SecurityFailure` 与 `AuthorizationResult.failure`。

## 结构化安全失败契约（`contracts/security.ts`）

`SecurityFailureReason`（`contracts/security.ts:13-19`）= `mfa_code_invalid` | `mfa_attempts_exhausted` | `mfa_session_locked` | `circuit_open` | `manual_review_hold` | `denied`；`manual_review_hold` 不是安全拒绝，而是「操作尚未执行、等人工复核释放」的留置。
`SecurityFailure`（`contracts/security.ts:26-33`）= 必填 `code: ErrorCode`、必填 `reason: SecurityFailureReason`，可选 `actionId`、`attemptsUsed`、`attemptsLeft`、`maxAttempts`；**不含**用户文案，渲染由 `public-text.ts#securityNotice` / `tool-feedback.ts#publicSecurityError` 负责。
`PendingActionStatus`（`contracts/security.ts:47-63`）含终态 `locked`（MFA 次数耗尽或熔断的 CAS 目标）与 `needs_reconciliation`（终态，需人工核对）。
同文件导出状态词表常量：`OPEN_PENDING_ACTION_STATUSES`（`pending`、`awaiting_mfa`）、`TERMINAL_PENDING_ACTION_STATUSES`（`executed`、`failed`、`cancelled`、`locked`、`needs_reconciliation`）、`SETTLED_PENDING_ACTION_STATUSES`（结算事实集合，含 `locked`，当前与 TERMINAL 同值）、`RUN_BLOCKING_PENDING_ACTION_STATUSES`（仍阻塞 run 收尾 = open + `confirmed` + `needs_reconciliation`，按构造不含 `locked`）。
`locked` 是终态：验证码次数耗尽或熔断造成的**已结算拒绝**，永不复活、永不再提示、永不作为 CAS 源。
`lib/` 不得依赖 `agent/`，因此 `agent/action-status.ts` 持有语义相同的另一份词表（`OPEN_ACTION_STATUSES` / `TERMINAL_ACTION_STATUSES` / `CLAIMABLE_ACTION_STATUSES` / `ALL_ACTION_STATUSES`）；两侧增删状态必须同步。
`AuthorizationResult` 不在本目录：定义在 `security/security-gateway.ts:104-123`，字段 `ok`、`status: PendingActionStatus`、`actionId`、`tier`、`requiresMfa`、`mfaResult?`、`code?: ErrorCode`、`failure?: SecurityFailure`、`message`、`action?`；由 `authorizeAction`（`security-gateway.ts:1102`）与 `security/recovery-authorization.ts` 产出。
网关只写不读 `failure` 的字段，逐字段读取仅发生在其 `__SECURITY_BLOCK__` 载荷解析处。
`SecurityFailure` 的消费点只用字段、不做文案匹配：`agent/turns/events.ts` 用 `failure.code` → `errorCode`、`attemptsLeft`/`attemptsUsed`/`maxAttempts` → `errorParams`，并在 `security_event` 上只带 `code`/`reason`/`actionId`/`attemptsLeft`/`maxAttempts`（不带 `message`）；`agent/confirmation/contracts.ts` 与 `app/api/_lib/types.ts` 只透传可选 `failure`；`app/api/_lib/locked-action.ts`（`code`/`reason`/`actionId`）与 `app/api/security/route.ts`（只 `code`+`reason`）自行构造；`channels/weixin/banking-client.ts` 只声明不读，由 `bridge.ts` 交给 `securityNotice`；`components/chat/actions.ts` 用局部子集（`code?: string`，无 `actionId`/`attemptsUsed`）；`tests/helpers/scenario.ts` 复现与生产相同的投影。
`lib/db/repositories/pendingAction.ts` 不对状态做枚举校验：写入 API 多声明为 `string`（`CreatePendingActionInput.status?`、`updatePendingActionStatus`），只有 `claimPendingAction` 的 `from`/`to` 用 `PendingActionStatus`、`claimPendingActionLease`（`pendingAction.ts:206`）用 `OPEN_PENDING_ACTION_STATUSES` 过滤；`locked` 因此是合法 CAS 目标，也是 `renewLockedMfaChallenges`（`:363`）里 `MfaChallenge.status === 'locked'` 的过滤值；`needs_reconciliation` 在该文件不出现，只能经通用 `setPendingActionStatus` 写入，无专门处理。

## 公开文本漏斗（`public-text.ts`）

`isInternalDiagnostic(text: string | undefined)` 定义在 `internal-text.ts`（`:33-40`）、由 `public-text.ts` 重新导出以保持既有 `@/lib/public-text` 导入路径，是唯一的内部诊断判定：非字符串或 `trim()` 后为空 → `false`；命中任一条件 → `true`：含 `__SECURITY_BLOCK__`（`:37`，常量 `:17`，跨层不 import 以避免循环）、`trim` 后精确等于 `undefined`/`null`/`[object Object]`（`:20`/`:38`）、匹配 `/\{\s*"|":/`（原始 JSON 片段，`:23`）、匹配栈帧或异常头正则 `/\n\s+at\s|[A-Za-z]*Error:/`（`:26`）；它刻意不是业务文案白名单，`Insufficient funds: …` 一类正常业务消息仍判为可渲染。
`internal-text.ts` 无任何依赖：`AppError` 需要构造期净化，而 `errors.ts` 不能依赖 i18n 漏斗模块（否则形成求值期耦合），因此纯谓词单独成模块。
`publicSafeMessage(text)`（同文件导出）给净化结果：可渲染返回原文，缺失/空白/内部诊断返回 `undefined`。
`safePublicText(text, t, fallback)` 只做分流：缺失或内部诊断取 `t(fallback)`，否则委托 `publicToolError`。
`publicErrorMessage(error, t, fallback = 'chat.error.toolFailed')` 渲染 `AppError`：走 `publicToolError(error.publicMessage, t, fallback, error.code)`；非 `AppError` 的值先 `publicSafeMessage` 再进同一漏斗。
`public-text.ts` 导出 `isInternalDiagnostic`（重新导出）、`safePublicText`、`publicErrorMessage`、`SecurityNoticeInput`、`securityNoticeKey`、`securityNoticeParams`、`securityNotice`，不经 `lib/index.ts` 再导出。
`securityNotice(failure, t)`（`public-text.ts:91-94`，签名只有 `failure` 与 `t`，无 fallback 参数）是 `securityNoticeKey(failure)` 与 `securityNoticeParams(failure)` 的组合，完全按 TYPED 字段判定，`securityNoticeKey`（`:67-82`）的分支顺序为：`code==='MFA_LOCKED' || reason==='mfa_attempts_exhausted'` → `chat.error.actionLocked`；`reason==='mfa_code_invalid' || code==='MFA_FAILED'` → `chat.error.verificationRemaining {count: attemptsLeft ?? 0}`；`code==='MANUAL_REVIEW_HOLD' || reason==='manual_review_hold'` → `chat.error.manualReviewHold`；`code==='CIRCUIT_OPEN' || reason==='circuit_open' || reason==='mfa_session_locked'` → `chat.error.securityLocked`；其余（含 `failure === undefined`、`denied`、任何未识别的 `code`/`reason` 字符串）一律 `chat.error.securityDenied`。
`SecurityNoticeInput` 的 `code`/`reason`/`kind` 声明为 `string`（不是 `ErrorCode`/`SecurityFailureReason`），未识别的取值因此静默落到 `chat.error.securityDenied`。
`securityNoticeKey`/`securityNoticeParams` 一并导出，让所有层共用同一映射；`securityNoticeParams` 只在 `chat.error.verificationRemaining` 时给出 `{count: attemptsLeft ?? 0}`，否则 `undefined`。
`SecurityNoticeInput` 是导出的接口（`code`/`reason`/`kind`/`attemptsLeft`/`maxAttempts`）；`kind` 与 `maxAttempts` 只声明、从不读取（`kind` 仅由调用方用于分流），依赖它们产生新文案前必须先改 `securityNotice` 本体。
`mfa_code_invalid`/`MFA_FAILED` 若未带 `attemptsLeft` 会渲染成「剩余 0 次」，因此调用方应始终转发 `attemptsLeft`。
`public-text.ts` 与 `tool-feedback.ts` 互为 import，但只交换函数声明（求值期不调用），因此该循环是安全的。
`securityNotice` 消费方：`app/security/UnlockPanel.tsx:122`（只传 `{code}`，且仅 `MFA_LOCKED`/`MFA_FAILED`/`CIRCUIT_OPEN` 三种码走此分支）、`components/chat/cards/MfaCard.tsx:77` 与 `components/chat/cards/ApprovalRecord.tsx:71`（常量 `{code:'MFA_LOCKED', reason:'mfa_attempts_exhausted'}`）、`components/chat/agent-stream-reducer.ts:500`（整条 `security_event`，任何 `kind` 都会渲染）、`channels/weixin/banking-client.ts:138`（唯一透传 `code`/`reason`/`attemptsLeft`/`maxAttempts` 的调用点，仅 `kind==='locked'`）、`channels/weixin/bridge.ts:87`（`outcome.failure ?? {code: outcome.code}`）与 `channels/weixin/bridge.ts:94`（`outcome.failure`，仅 `mfa_code_invalid`/`mfa_session_locked`）。
`safePublicText` 消费方：`app/security/UnlockPanel.tsx:123`、`components/chat/MessageBubble.tsx:51`（历史恢复的 `system` 消息）、`channels/weixin/presentation.ts:35`（`channelText` 内，仅 `chat.` 前缀的文本进入漏斗）。
结构化拒绝的上游装配：`security/security-gateway.ts:927-940`（`MFA_FAILED`/`mfa_code_invalid`，无 `attemptsLeft`）与 `:941-961`（`MFA_LOCKED`/`mfa_attempts_exhausted` 与 `mfa_code_invalid`，含 `attemptsUsed`/`attemptsLeft`/`maxAttempts`）；`security/security-gateway.ts:866-883`（`lockedOutcome`，`attemptsLeft: 0`）；`app/api/_lib/locked-action.ts:66`（`{code:'CIRCUIT_OPEN', reason:'mfa_session_locked'}`，无计数）；`app/api/actions/[id]/verify/route.ts:89-90`（把 `failure` 与 `attemptsLeft`/`maxAttempts` 摊到 `ActionResponse`）；`agent/turns/events.ts:92-96`（`security_event` 只带 TYPED 字段）。
单元测试：`tests/unit/lib/public-text.test.ts`（诊断分类、`attemptsLeft` 渲染、四种锁定/拒绝文案）、`tests/unit/lib/public-text.locked.test.ts`（typed 主路径与三条网关兼容句）、`tests/unit/lib/app-error-public-message.test.ts`（`AppError.publicMessage` 净化与 `publicErrorMessage` 兜底）。

## 修改约束

- 修改共享类型时，必须更新 `contracts/` 的原定义。
- 金融单位规则见 [financial-values.md](../docs/cn/financial-values.md)。
- 数据访问规则见 [db/CONTEXT.md](db/CONTEXT.md)。
- `index.ts` 不得导出数据库客户端。
- 新增展示脱敏一律使用 `lib/mask.ts`，不得在调用层重复实现。
- 本目录不得依赖业务执行层或界面层。
- 意图声明与计划校验入口见 [agent/CONTEXT.md](../agent/CONTEXT.md)。

开发命令见 [development.md](../docs/cn/development.md)。
