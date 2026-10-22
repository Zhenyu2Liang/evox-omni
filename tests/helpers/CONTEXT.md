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
| `locked-action.ts` | 终止锁定用例的 RED/YELLOW 计划动作播种、网关验证码阶梯与只读探针 |

### locked-action.ts

`locked-action.ts` 为「MFA 三码锁定」的终止锁定用例提供共享基础设施：经生产 `submit_plan` 播种到计划节点的 RED（¥5000，`awaiting_mfa`）与 YELLOW（¥500 及以下，`pending`、`requiresMfa:false`）待处理动作，
经网关 `authorizeAction` 驱动的错误验证码阶梯（第 1/2 次非终止、第 3 次 `status:'locked'` 并落库），
以及 `pendingActionRow`/`mfaChallengesFor`/`checkingBalance`/`zhangweiTransfers`/`auditLogCount`/`securityEventsOfKind`/`transactionsCount` 等只读探针。
它不含 `describe`/`it`，也只用于播种失败时给出诊断，不清库也不播种：每个用例仍须在 `beforeEach` 自行 `resetDatabase()`（熔断按 owner 持久化，残留锁定会串场）。
错误验证码一律经 `securityGateway.authorizeAction` 提交，不得改用 `security/mfa.ts#verify`（只锁挑战、不落终端状态）。

## 入口与证据

`faux-agent` 和 `scenario` 验证网关、工具与 SDK。
它们不经过生产的声明、运行准入与展示流程。
辅助函数生成的结果说明不是模型稳定性证据。
`buildFauxAgent` 的 `FauxAgentOptions.registerModel`（`faux-agent.ts:64`）是无人读取的死选项：构造函数总是注册 faux provider。

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
`cancelAction(agent, actionId)`（`scenario.ts:591`）、`newSessionId(prefix = 'sess')`（`scenario.ts:619`）、
`collectEvents(agent)`（`scenario.ts:624`）、`toolEventsOf(res, toolName)`（`scenario.ts:631`）、
`cardsOfType(res, type)`（`scenario.ts:635`），以及类型 `ScenarioResult`（`scenario.ts:57`）、`RunTurnInput`（`scenario.ts:77`）。
`ScenarioResult` 字段：`sessionId`/`events`/`text`/`toolEvents`/`cards`，可选 `confirmation`/`mfa`/`plan`/`error`。
决策面直接调 `security.gateway.securityGateway.authorizeAction`（`scenario.ts:522`/`:523`），非 ok（`awaiting_mfa`/`locked`）时返回
`{events: [], text: auth.message, ...}` 且不执行（`scenario.ts:528`）；决策失败因此没有事件，只有 `text`。
`runTurn` 强制 `agent.sessionId === input.sessionId`，否则抛 `AppError('SECURITY_DENIED')`（`scenario.ts:424`）。
时限用 `demoNow()`（`lib/clock.ts:14`，钉死 `DEMO_NOW`）只作事件时间戳，没有定时器与时钟推进。

`confirmAction`/`verifyAction` 共用 `decideAndContinue`（`scenario.ts:514`）：
网关授权 ok 时用 `registry.executeDirect` 执行**原始校验参数**（不重新过闸门，避免重复 `PendingAction`）、写审计、
把真实结果作为 toolResult 追加进 `agent.state.messages`，再 `agent.continue()`；
若 faux 脚本已耗尽，先补一条事实叙述（`narrationFor`，`scenario.ts:503`），否则续接会因空队列报错。
所以脚本不必为决策后的叙述预留步骤。

### 独立进程恢复探针（restart-process / standalone-restart-process）

两者都是 `fork` 入口（被 fork 的脚本，不是 Vitest 用例），父进程传 `execArgv: ['--import','tsx']` 与 `LLM_MODE=mock`，子进程靠 IPC `process.send` 报告进度。
`tests/integration/process-restart.test.ts:11`/`:24` fork `restart-process.ts`，argv 为 `[mode, scenario, runId, sessionId]`（`process.argv[2..5]`）；
`tests/integration/standalone-workflow-restart.test.ts:22` fork `standalone-restart-process.ts`，argv 只有 `[mode, scenario]`。
`restart-process.ts` 的 mode：`start`（`runTurn` 跑到崩溃屏障）、`recover`（`recoverOwnedRun(runId, {userId, sessionId})`）、`worker`（`tickAgentRecovery({ports:{discover:listRecoverableAgentRuns, recover}})`），其它值抛 `Unsupported restart test process mode.`（`:144`）。
scenario：`model_result`（在 `tool_execution_start` 拦住）、`read_intent`（`tool_start`）、`committed_write`（成功 `tool_end`）、`authorization`（`confirmation_required`）、`dag_progress`（budget 节点成功而 read 未成功）、`authorization_result`（`llmMode` 降为 `mock`，先跑一轮闲聊再在 `checkpoint('input')` 拦住 `confirmAction`）、`partial_model`（`streamFn` 只推 `start`/`text_delta` 后拦住）。
`start` 拦住时发 `barrier{point, runId, sessionId}` 并永久挂起（`hold()`；另有 1s `setInterval` 冒充在线句柄）；每次模型调用先发 `model_call{count}`。
`recover` 发 `recovered{response, modelCalls}`，`worker` 发 `worker_finished{result, modelCalls, message?}`，`start` 未被拦住而走完则发 `unexpected_completion{runId, modelCalls}`，顶层 catch 发 `fatal{message}` 并置 `process.exitCode = 1`。
生产入口：`runTurn`/`confirmAction`（`@/agent`，`:2`）、`recoverOwnedRun`（`@/agent/durable/service`，`:3`）、`tickAgentRecovery`（`@/agent/recovery-worker`，`:4`）、`listRecoverableAgentRuns`（`@/lib/db/repositories/agentRun`，`:9`）、`AgentRunJournal`（`@/agent/durable/journal`，`:10`；`:31`/`:40` 猴补 `recordAgentEvent`/`checkpoint` 制造屏障）、`prisma`（`@/lib/db/client`，`:8`）。
`standalone-restart-process.ts` 的 mode：`start`（`getOrCreateSession` + `createTaskGraph` + `resumeTask`），其它值一律按 worker 走 `tickAgentRecovery()`（不传 ports，用真实默认端口）；scenario 只有 `graph`（建图后立即 `barrier`）与 `authorization`（单 `transfer` 节点）。
worker 发 `worker_finished{result}`，`fatal{message}` 兜底；`start` 跑完仍未到屏障则抛 `The standalone workflow did not reach its requested crash barrier`（`:40`）。
生产入口：`getOrCreateSession`（`@/agent/session`，`:1`）、`resumeTask`（`@/agent/task-control`，`:2`）、`executeGatedTool`（`@/agent/confirmation/gated-execution`，`:3`）、`tickAgentRecovery`（`@/agent/recovery-worker`，`:4`）、`createTaskGraph`（`@/lib/db/repositories/task`，`:5`）、`prisma`（`@/lib/db/client`，`:6`）。
崩溃由父进程 `SIGKILL` 后改写租约制造过期，脚本本身不碰租约。

`./index.ts` 只再导出 `getTestPrisma`/`truncateAll`/`resetDatabase`/`useFreshDatabase`/`disconnectTestPrisma`，
`ensureTestPragmas` 不在桶里（需直接 `from './db'`）；`fixtures` 整个星号再导出。

HTTP 路由层不在本目录：进程内真实路由客户端是 `tests/app/harness.ts`
（`tests/app/harness.ts`，201 行：`BASE_URL`、`RouteHandler`、`HttpOptions`、`HttpResult`、`sessionCookie`、`chatUrl`、`actionUrl`、`taskUrl`、`tasksUrl`、`idCtx`、`postJson`、`postRaw`、`getJson`、`readSseFrames`、`readSse`）。

## 熔断 owner 与会话身份

`runTurn` 会把 `sessionId` upsert 成 `DEMO_USER_ID` 的 `AgentSession` 行（`scenario.ts:429`），
因此 `security/circuit-breaker.ts#resolveBreakerOwner` 解析出的是 `user:user_liming`——
所有 scenario 测试**共享同一个熔断 owner**。
`newSessionId()` 不隔离熔断，`scenario.ts:615` 关于「in-process keyed by sessionId」的注释是过时说法。
隔离只靠 `useFreshDatabase()` 清 `CircuitBreakerState`；同理，`getState(sessionId)`/`isLocked(sessionId)` 读的是那个 owner 的行，
不是 `session:<id>`。真正按 `session:<actor>` 计键的只有既无 `AgentSession` 又无 `User` 行的裸 actor。

## 被阻断 / 锁定的结果如何表示

网关 block reason 是 `__SECURITY_BLOCK__` + JSON（`security/security-gateway.ts:78`、`:704`）；
熔断 deny 与计划已取消分支都是 `__SECURITY_BLOCK__{"decisionKind":"deny"}`，**没有 actionId**
（`security/security-gateway.ts:1182`、`:1214`），因此 `parseBlockReason` 返回 `null`（`:708`），只能靠前缀判定。
`scenario.ts:304`（镜像生产的 `agent/turns/events.ts:92`）把 block reason 解析成**结构化**字段发布：
`security_event{kind:'locked'}` + 可选 `code`/`reason`/`actionId`/`attemptsLeft`/`maxAttempts`，**不带** `message`（`lib/contracts/agent.ts:102`–`:110`），且 blocked 的 `ToolEventView` **不带 `summary`**。
原始 block reason 因此到不了用户（`tests/unit/agent/turn-security-event.test.ts:66` 断言 `event.message` 为 `undefined`）；用户可见文案只能经
`lib/tool-feedback.ts` 的 `publicToolError`（默认回退 `chat.error.toolFailed`，`:11`/`:37`）与
`publicToolSummary`（blocked 且无 actionId → `chat.error.operationNotStarted`，`:56`）投影，
或 `components/chat/cards/MfaCard.tsx:66`（`publicToolError(statusMessage, t)`，未知消息即回退 `chat.error.toolFailed`）。
`localizeChatError`（`lib/i18n/display.ts:7`）对未知字符串原样透传——渲染它就会泄漏原始载荷。

三码锁定有两条可参照的既有路径：
`tests/scenarios/test-10-circuit-breaker.test.ts:44`+`:61`（`buildFauxAgent` + `runTurn` + 三次 `verifyAction`，断 `attempts`/`securityEvent`/`text` 含「锁定」），
`tests/app/mfa-terminal-lock-http.test.ts:273`（真实 verify 路由：`status:'locked'`、`mfaResult:'failed'`、行持久化、`GET /api/actions` 不再 surface）。

## 数据库与事务

`getTestPrisma` 延迟获取测试客户端。
`resetDatabase` 清空记录后加载夹具。
`useFreshDatabase` 注册测试生命周期。
`ensureTestPragmas` 设置测试连接的 WAL 与等待参数。
客户端连接机制见
[lib/db/CONTEXT.md](../../lib/db/CONTEXT.md)。
不得用旧连接池参数解释当前原生适配器行为。

本目录没有时钟注入、租约过期或恢复次数上限的助手：唯一的 `now` 注入点是 `fixtures.ts` 的 `Options.now`（`fixtures.ts:255`）与全部 `build*(now: Date = demoNow())` 构建器。
运行/租约过期与恢复计数由 spec 内联改写数据库列（`tests/integration/agent-durability.test.ts:35`–`:36`/`:295`–`:296`、`model-checkpoint-boundaries.test.ts:27`–`:28`/`:54`、`process-restart.test.ts:86`–`:87`、`standalone-workflow-restart.test.ts:74`），`maxRecoveryAttempts` 无任何测试引用。

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
