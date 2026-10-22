# 测试辅助模块

## 模块选择

| 模块 | 用途 |
| --- | --- |
| `db.ts` | 连接、清空、重建夹具与断开测试库 |
| `db-truncate.test.ts` | 逐 model 校验 `truncateAll` 的清空覆盖 |
| `fixtures.ts` | 独立维护的测试数据 |
| `faux-agent.ts` | 原始 Pi Agent 与脚本模型 |
| `scenario.ts` | 网关和工具层的两阶段场景 |
| `scripted-provider.ts` | 注入生产运行入口的模型响应 |
| `prisma-cli.ts` | 客户端准备、隔离库清理与命令诊断 |
| `restart-process.ts`、`standalone-restart-process.ts` | 独立进程恢复探针 |
| `write-failure.ts` | 保留真实事务的写入失败注入 |

## 入口与证据

`faux-agent` 和 `scenario` 验证网关、工具与 SDK。
它们不经过生产的声明、运行准入与展示流程。
辅助函数生成的结果说明不是模型稳定性证据。

验证生产入口时，使用 `scriptedProvider` 注入模型。
它通过真实 `describe_turn` 声明当前目的与业务序列。
声明不提供用户授权。
未声明或声明不完整的拒绝测试需保留该输入条件。

### 脚本化模型驱动生产 `runTurn`

`scriptedProvider(declaration, steps)` 返回 `{ provider, calls() }`；`provider` 即 `RunTurnDeps.provider`
（`{ model, streamFn }`，类型见 `agent/providers/types.ts`），与网关、SQLite、执行器全部保持真实。
首条响应固定是 `turnDeclaration(declaration)` 的 `describe_turn` 工具调用，`steps` 是**其后**的响应序列。
一次模型调用消费一条响应，脚本全部消费时 `calls() === 1 + steps.length`。
调用形如 `runTurn({ sessionId?, message }, { config, provider })`：首轮省略 `sessionId` 由 `getOrCreateSession` 建行，不要传 `requestId`。
返回值只有 `{ sessionId, events }`：助手文本取 `events` 中最后一条 `message_end` 的 `message.content`，
工具与闸门信号取 `tool_end`、`confirmation_required`、`mfa_required` 事件。
`config.llmMode` 决定生产分支：声明写操作却未发出受控工具调用时的一次有界续接
（`agent/write-continuation.ts#pendingDeclaredWrites`）只在 `llmMode === 'live'` 生效；
`tests/setup.ts` 把 `LLM_MODE` 固定为 `mock`，需要续接的用例必须显式传 `llmMode: 'live'`。
指引信封（`{"guidance":{"code":...}}`）的渲染不受 `llmMode` 限制，`groundMessage` 用服务端模板改写最终助手文本。
最完整骨架见 `tests/integration/write-continuation.test.ts`（续接与 `declared_unsubmitted`）
与 `tests/integration/decision-guidance.test.ts`（声明、指引信封、授权后续读）。

## scenario.ts 的导出面

`scenario.ts` 只导出这些符号（没有 `chat`/`post`/`getActions`/`verify` 之类的方法对象，也没有可控假时钟）：
`runTurn({sessionId, message, agent})` → `ScenarioResult`（`scenario.ts:422`）、
`confirmAction(agent, actionId)`（`scenario.ts:577`）、`verifyAction(agent, actionId, code)`（`scenario.ts:582`）、
`cancelAction(agent, actionId)`（`scenario.ts:591`）、`newSessionId(prefix)`（`scenario.ts:619`）、
`collectEvents(agent)`（`scenario.ts:624`）、`toolEventsOf(res, toolName)`（`scenario.ts:631`）、
`cardsOfType(res, type)`（`scenario.ts:635`），以及类型 `ScenarioResult`（`scenario.ts:57`）、`RunTurnInput`（`scenario.ts:77`）。
`ScenarioResult` 字段：`sessionId`/`events`/`text`/`toolEvents`/`cards`，可选 `confirmation`/`mfa`/`plan`/`error`。
决策面直接调 `security.gateway.securityGateway.authorizeAction`（`scenario.ts:522`），非 ok（`awaiting_mfa`/`locked`）时返回
`{events: [], text: auth.message, ...}` 且不执行（`scenario.ts:528`）；决策失败因此没有事件，只有 `text`。
时限用 `demoNow()`（`lib/clock.ts:14`，钉死 `DEMO_NOW`）只作事件时间戳，没有定时器与时钟推进。

HTTP 路由层不在本目录：进程内真实路由客户端是 `tests/app/harness.ts`
（`postJson`/`postRaw`/`getJson`/`readSse`/`readSseFrames`/`actionUrl`/`chatUrl`/`idCtx`）。

## 被阻断 / 锁定的结果如何表示

网关 block reason 是 `__SECURITY_BLOCK__` 前缀 + JSON（前缀定义 `security/security-gateway.ts:80`，序列化 `:725`）。
熔断 deny（`:1245`，`code:'CIRCUIT_OPEN'`/`reason:'circuit_open'`）与计划已取消（`:1277`，`code:'SECURITY_DENIED'`/`reason:'denied'`）都是 `{decisionKind:'deny',failure:{…}}` 且**没有 actionId**，
但前缀与 JSON 都合法：`parseBlockReason`（`:762`）对它们返回**非 null** 的 `{decisionKind:'deny',failure}`，只有前缀缺失、JSON 解析失败或 `decisionKind` 不在四种取值内才返回 `null`。
所以 `scenario.ts:263` 的 `parsed !== null || message.startsWith(BLOCK_REASON_PREFIX)` 里，`deny` 走「解析成功但无 actionId」路径，前缀判定只兜住不可解析载荷。
`SecurityFailure`（`lib/contracts/security.ts:21-28`）只有 `code`/`reason`/`actionId?`/`attemptsUsed?`/`attemptsLeft?`/`maxAttempts?`——**没有 `message`**。
`scenario.ts:304-308`（与生产 `agent/turns/events.ts:92-96` 逐字段一致，类型见 `lib/contracts/agent.ts:102-111`）只发 `kind:'locked'` + `code`/`reason`/`actionId`/`attemptsLeft`/`maxAttempts`，**不发 `message`、不发原始载荷**，blocked 的 `ToolEventView` **不带 `summary`**。
`kind` 恒为 `'locked'`（计划取消的 `SECURITY_DENIED` 也是 `locked`，靠 `code`/`reason` 区分）；`errorParams` 是同一失败的另一半投影：`scenario.ts:87-94#failureParams`（字段集与生产 `agent/turns/events.ts:19-26#errorParamsFrom` 相同）取 `attemptsLeft`/`attemptsUsed`/`maxAttempts`，`code` 单独映射为 `errorCode`（`scenario.ts:278`）。
非 ok 授权的 `AuthorizationResult.message` 由 `scenario.ts:528` 直接放进 `ScenarioResult.text`（没有事件）；用户可见状态文案仍只能经
`lib/tool-feedback.ts#publicToolSummary`（`:65-72`：blocked 且带 `errorCode` → `publicToolError(…, 'chat.error.operationNotStarted', errorCode, errorParams)`）与
`publicToolError`（`:44`：精确业务文案 → `errorCode` 目录 → 回退 `chat.error.toolFailed`）投影，
或 `components/chat/cards/MfaCard.tsx:76-79`（locked 走 `securityNotice(LOCKED_NOTICE, t)`；`publicToolError(p.statusMessage, t)` 只服务 `failed` 分支 `:75`）。
`localizeChatError`（`lib/i18n/display.ts:11`）对未知字符串原样透传——渲染它就会泄漏原始载荷。
无前缀的拒绝（歧义收款人 `clarify` `security/security-gateway.ts:1266`、pending 创建失败的 VALIDATION `:1255`）被 `scenario.ts:266-272` 当普通失败：`status:'error'` + 原始消息作 `summary` + `errorCard`，**不发 `security_event`**。

三码锁定有两条可参照的既有路径：
`tests/scenarios/test-10-circuit-breaker.test.ts:44`+`:61`（`buildFauxAgent` + `runTurn` + 三次 `verifyAction`，断 `attempts`/`securityEvent`/`text` 含「锁定」），
`tests/app/mfa-terminal-lock-http.test.ts:273`（真实 verify 路由：`status:'locked'`、`mfaResult:'failed'`、行持久化、`GET /api/actions` 不再 surface）。

### 本目录自带的中文文案（非 i18n key）

`scenario.ts` 不做本地化，以下字面量直接进入 `ScenarioResult.text` 或卡片，断言它们即绑定本目录原文：
`MFA_HINT`『请输入 6 位短信验证码。』（`:97`）、`TOOL_FAILURE_FALLBACK`『工具执行失败』（`:99`）、pending 摘要兜底标题『待处理操作』（`:215`）、
工具结果『操作完成』（`:489`）、旁白『操作已完成。』（`:506`）、取消结果『操作已取消。』（`:610`）。
本目录没有任何 `expect`：安全失败与锁定的文案断言都在 `tests/scenarios/`、`tests/app/`、`tests/unit/` 侧。

## 数据库与事务

`getTestPrisma` 延迟获取测试客户端。
`resetDatabase` 清空记录后加载夹具。
`useFreshDatabase` 注册测试生命周期。
`ensureTestPragmas` 设置测试连接的 WAL 与等待参数。
客户端连接机制见
[lib/db/CONTEXT.md](../../lib/db/CONTEXT.md)。
不得用旧连接池参数解释当前原生适配器行为。

### 清空语义（`truncateAll`）

`truncateAll` 删除 `prisma/schema.prisma` 中**每一个** model 的全部记录，
顺序按外键子表→父表，且**不**重新播种；`resetDatabase` 在其后加载夹具。
清空完成后整个库为空：任何 delegate 的 `count()` 都是 0。
除夹具外没有“合法残留”，测试与相邻运行之间不共享业务记录。

省略一张表就是缺陷，`onDelete: Cascade` 不能替代显式删除。
无关系表（`ExecutionReceipt`、`CircuitBreakerState`、`AuthorizationDecision`、
`RiskSignal`、`CardConsumption`）没有任何外键驱动删除，必须显式列出。
`CardConsumption` 只带索引与唯一 `executionKey`：
漏删会让消费行与重放身份跨 `resetDatabase` 存活，
既污染卡家族当月消费，又让重复运行以旧卡 id 重放而报 `CONFLICT`。
`ScheduledNotification` 与 `ModelRequest` 同属易漏项，已与其父表一并显式删除。

`db-truncate.test.ts` 逐 model 校验覆盖率：
每个 schema model 必须在 `db.ts` 中出现 `prisma.<delegate>.deleteMany(`；
清空列表中不得出现不存在的 delegate；
残留行在 `truncateAll` 后必须为 0；
带唯一 `executionKey` 的消费行不得跨 `resetDatabase` 存活。
新增 model 时必须同时补 `truncateAll`，否则该用例失败。

因此各套件**不需要**在 `useFreshDatabase()`/`resetDatabase()` 之后再手工
`cardConsumption.deleteMany()`，重复的清空钩子是多余的。

Prisma 准备失败时必须保留完整命令诊断。
失败注入必须保留真实事务的回滚行为。
共享库的隔离和执行规则见 [../CONTEXT.md](../CONTEXT.md)。
