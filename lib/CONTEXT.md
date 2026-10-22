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
| `tool-feedback.ts` | 拒绝/失败结果的公开文本投影（唯一出口） |
| `public-text.ts` | 内部诊断判定（`isInternalDiagnostic`）与结构化安全拒绝渲染（`securityNotice`） |
| `errors.ts` | `ErrorCode`、`AppError` 与 `Result` |
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
`PUBLIC_BUSINESS_ERRORS`（17–28 行）只有 10 条精确字符串；其中唯一的安全网关句子是 `security/security-gateway.ts:911`「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」→ `chat.error.securityLocked`（`chat.zh-CN.json:220`）。
同文件另两句网关拒绝语未登记，因此映射到 fallback `chat.error.toolFailed`（`chat.zh-CN.json:208`「操作未完成。请核对原操作卡片和账户记录。」）：`security-gateway.ts:424`（`gatewayDecide` 的 deny）「当前会话已触发安全熔断，高风险操作已被锁定。请前往安全中心解除限制后再试。」与 `security-gateway.ts:785`（`lockedOutcome`）「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」。
`PUBLIC_ERROR_CODES` 只在调用方显式传入 `errorCode` 时生效；网关的 `AuthorizationResult.code`（定义在 `security/security-gateway.ts:102`，不在本目录）不会自动出现在 `ToolEventView.errorCode` 上。
`publicToolSummary(event, t)` 按状态分流：`search_conversation_history` + `success` → `chat.activity.historyRead`；`blocked` 且无 `actionId` → `publicToolError(summary, t, 'chat.error.operationNotStarted')`（该分支不传 `errorCode`）；`error` → `publicToolError(summary, t, 'chat.error.toolFailed', errorCode)`；`needs_reconciliation` → `chat.error.unknownOutcome`；其余状态（`started`/`success`/`updated`/`cancelled` 及带 `actionId` 的 `blocked`）走 `localizeChatError`，未命中时**原样返回 `event.summary`**。
因此本目录不剥离任何内部摘要标记（如 `__SECURITY_BLOCK__{...}`）：这类字符串走 `error` 分支时被替换为 `chat.error.toolFailed`，走其它状态分支时会被当作合法文本透出，去重/剥离责任在写入事件的一侧。
`ToolEventView`（`contracts/agent.ts`）没有 `resultSummary` 字段：公开文本只来自 `summary` 与 `errorCode`，`debugDetail`/`debugArguments` 仅供开发者面板。
`ChatCard {type:'error', message, code?}` 与 `AgentStreamEvent {type:'security_event', kind, message}` 的 `message` 同样是无目录约束的自由字符串。

## 公开文本漏斗（`public-text.ts`）

`isInternalDiagnostic(text)` 是唯一的内部诊断判定：含 `__SECURITY_BLOCK__` 标记（`public-text.ts:22` 重复声明该前缀，跨层不 import 以避免循环）、`undefined`/`null`/`[object Object]`、JSON 片段或栈帧即返回 `true`。
`safePublicText(text, t, fallback)` 只做分流：缺失或内部诊断取 `t(fallback)`，否则委托 `publicToolError`。
`securityNotice(failure, t)` 完全按 TYPED 字段判定，顺序为 `code==='MFA_LOCKED' || reason==='mfa_attempts_exhausted'` → `chat.error.actionLocked`；`reason==='mfa_code_invalid' || code==='MFA_FAILED'` → `chat.error.verificationRemaining {count: attemptsLeft ?? 0}`；`code==='CIRCUIT_OPEN' || reason==='circuit_open' || reason==='mfa_session_locked'` → `chat.error.securityLocked`；其余一律 `chat.error.securityDenied`。
`SecurityNoticeInput` 的 `kind` 与 `maxAttempts` 只声明、从不读取（`kind` 仅由调用方用于分流），依赖它们产生新文案前必须先改 `securityNotice` 本体。
`mfa_code_invalid`/`MFA_FAILED` 若未带 `attemptsLeft` 会渲染成「剩余 0 次」，因此调用方应始终转发 `attemptsLeft`。
`public-text.ts` 与 `tool-feedback.ts` 互为 import，但只交换函数声明（求值期不调用），因此该循环是安全的。
`securityNotice` 消费方：`app/security/UnlockPanel.tsx:122`（只传 `{code}`，且仅 `MFA_LOCKED`/`MFA_FAILED`/`CIRCUIT_OPEN` 三种码走此分支）、`components/chat/cards/MfaCard.tsx:77` 与 `components/chat/cards/ApprovalRecord.tsx:71`（常量 `{code:'MFA_LOCKED', reason:'mfa_attempts_exhausted'}`）、`components/chat/agent-stream-reducer.ts:500`（整条 `security_event`，任何 `kind` 都会渲染）、`channels/weixin/banking-client.ts:138`（唯一透传 `code`/`reason`/`attemptsLeft`/`maxAttempts` 的调用点，仅 `kind==='locked'`）、`channels/weixin/bridge.ts:87`（`outcome.failure ?? {code: outcome.code}`）与 `channels/weixin/bridge.ts:94`（`outcome.failure`，仅 `mfa_code_invalid`/`mfa_session_locked`）。
`safePublicText` 消费方：`app/security/UnlockPanel.tsx:123`、`components/chat/MessageBubble.tsx:51`（历史恢复的 `system` 消息）、`channels/weixin/presentation.ts:35`（`channelText` 内，仅 `chat.` 前缀的文本进入漏斗）。
结构化拒绝的上游装配：`security/security-gateway.ts:890`（`MFA_FAILED`/`mfa_code_invalid`，无 `attemptsLeft`）与 `:905-909`（`MFA_LOCKED`/`mfa_attempts_exhausted` 与 `mfa_code_invalid`，含 `attemptsUsed`/`attemptsLeft`/`maxAttempts`）；`security/security-gateway.ts:840`（`lockedOutcome`，`attemptsLeft: 0`）；`app/api/_lib/locked-action.ts:66`（`{code:'CIRCUIT_OPEN', reason:'mfa_session_locked'}`，无计数）；`app/api/actions/[id]/verify/route.ts:89-90`（把 `failure` 与 `attemptsLeft`/`maxAttempts` 摊到 `ActionResponse`）；`agent/turns/events.ts:92-96`（`security_event` 只带 TYPED 字段）。
单元测试：`tests/unit/lib/public-text.test.ts`（覆盖诊断分类、`attemptsLeft` 渲染、四种锁定/拒绝文案）。

## 修改约束

- 修改共享类型时，必须更新 `contracts/` 的原定义。
- 金融单位规则见 [financial-values.md](../docs/cn/financial-values.md)。
- 数据访问规则见 [db/CONTEXT.md](db/CONTEXT.md)。
- `index.ts` 不得导出数据库客户端。
- 本目录不得依赖业务执行层或界面层。
- 意图声明与计划校验入口见 [agent/CONTEXT.md](../agent/CONTEXT.md)。

开发命令见 [development.md](../docs/cn/development.md)。
