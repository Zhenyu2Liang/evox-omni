# HTTP 路由集成测试

## 范围与工具

测试直接调用真实 Next.js 路由处理器。
请求使用 `NextRequest`，动态参数使用异步上下文。
这是进程内集成测试，不启动真实浏览器。

`harness.ts` 提供请求构造、结果读取与 SSE 解析。
`postJson`、`postRaw`、`getJson` 接收实际处理器。
动态路由使用 `idCtx(id)`。
`readSse` 返回结构化流事件。
辅助模块复用生产权限判断。

`harness.ts` 导出：`BASE_URL`（`:26`）、`sessionCookie(sessionId)`（`:62`）、`chatUrl({stream})`（`:78`）、`actionUrl(id, verb)`（`:85`，verb = `confirm|verify|cancel|recover`）、`taskUrl`/`tasksUrl`（`:90`/`:95`）、`idCtx(id)`（`:100`）、`postJson`（`:107`）、`postRaw`（`:126`）、`getJson`（`:145`）、`readSseFrames`（`:185`）、`readSse`（`:197`）。
每个用例文件自建局部的 `payload(res)`、`chatTurn`、`verifyAction`、`checkingBalance` 等薄封装，未抽到 `harness.ts`。

`harness.ts` 不 import 任何路由模块：每个用例自行 import 路由的 `GET`/`POST` 并把 handler 传给 invoker（如 `mfa-terminal-lock-http.test.ts:28-29`、`actions-http.test.ts:27-30`）。
`invoke`（`harness.ts:163-180`）用 `new NextRequest((opts.base ?? BASE_URL) + path, { ...init, headers })`（`:174`）构造真实请求，再 `await handler(req, opts.ctx ?? idCtx(''))`（`:175`）直接调用，不启动 Next 服务器、不经过 `fetch`。
响应只有 `content-type` 含 `application/json` 时才 `await res.json()`（`:178`），SSE body 保持未消费交给 `readSse`。
`/…/[id]` 路由必须显式传 `ctx: idCtx(id)`，默认值是 `idCtx('')`。
其余导出类型：`RouteHandler`（`:32`）、`HttpOptions`（`:40`，`sessionId`/`cookie` 只是被服务端忽略的身份提示）、`HttpResult`（`:51`，含 `status`/`ok`/`data`/`headers`/`res`）。

## 身份与断言

Web 路由固定使用配置的演示用户与会话。
Cookie 或查询参数不能选择其他工作区。
辅助模块保留 Cookie 参数，用于验证身份伪造不生效。
不能因没有认证 Cookie 就断言请求必为 403。
跨用户或会话资源仍需验证所有权拒绝（403 + `SECURITY_DENIED`）。

核心断言包含输入校验、封装格式、SSE 和持久化结果。
HTTP 200 不等于业务成功；锁定的写操作也是 200 + `data.ok:false`。
错误验证码与终态拒绝需检查 `data.ok`、`data.status`、`data.mfaResult` 与数据库行。

## 锁定与熔断的 HTTP 形状

`/api/actions/[id]/{confirm,verify}` 从不返回 423：MFA 次数耗尽与已开熔断都是 200 域结果。
本目录没有 `code:'CIRCUIT_OPEN'` 断言落在这些路由上。
`423 CIRCUIT_OPEN` 只来自 `/api/security/reset`（`security-workflow-http.test.ts:979,988,995,1046,1084,1101`）。
`manual-card-management.test.ts:79` 的 `CIRCUIT_OPEN` 是服务层 `rejects.toMatchObject`，不经 HTTP。
`actions-http.test.ts:461-472` 用注释固化“动作路由的 423 不可达”这一事实，不是断言。

锁定入口（终态）：
`actions-http.test.ts:473`（3 次错码 → 200/`status:'locked'`/`mfaResult:'failed'`，随后同会话 verify 与 confirm 均 locked）。
`mfa-terminal-lock-http.test.ts:240`（锁定持久化到 `PendingAction`、从 `GET /api/actions` 消失、不再重发 `mfa_required`）、`:311`（所有者熔断闸门对第二个未决动作同样持久化锁定）。
`security-workflow-http.test.ts:955`（it 9，伪造 cookie/query 不能解锁）、`:1080`/`:1095`/`:1111`/`:1142`（重置闸门 423/423/200/200）。
`manual-card-management.test.ts:73` 是唯一在服务层断言终止锁定的用例：`locked:true`、`listCardChanges` 全部 `status:'locked'`、下一次验证 `code:'CIRCUIT_OPEN'`、`resetDemoSession` 后回到 `pending`。

单次错误码（非终态，`status:'awaiting_mfa'`）：`actions-http.test.ts:285`、`security-workflow-http.test.ts:346`、`mfa-escalation-http.test.ts:277`、`mfa-escalation-upgrade-http.test.ts:379`、`ledger-consistency-http.test.ts:292`、`malicious-input-http.test.ts:236`、`card-freeze-audit-http.test.ts:52`（只断言 `ok:false`，不断言状态）。
`actions-http.test.ts:511-515` 固化 confirm 的锁定 `mfaResult` 是 `'not_required'`（confirm 不提交验证码）。

`GET /api/actions` 去曝光断言只在 `mfa-terminal-lock-http.test.ts:291,301,338-340`（本地 `surfaced()`，`:118`）。
`mfa_required` 缺失断言只有 `mfa-terminal-lock-http.test.ts`（`mfaEventsFor`，`:97`）与 `plan-parking-http.test.ts:209`（YELLOW 不发 MFA）。
`SecurityEvent` 断言按 `kind` 计数：`CIRCUIT_BREAKER_TRIPPED`/`high`（`actions-http.test.ts:497-500`）、`MFA_FAILURE`（`actions-http.test.ts:305`、`mfa-escalation-http.test.ts:303`）、`SECURITY_RESET`（`security-workflow-http.test.ts:1024-1027,1134-1137`、`developer-security-http.test.ts:28,43-46`）。

## 解锁入口

解锁入口必须区分：
- `/api/security/reset` 使用验证码或冷却策略；锁定中缺码或错码均为 423 `CIRCUIT_OPEN`，正确码 200 + `{locked:false,failures:0}`，每次成功恰好 1 条 `SECURITY_RESET`（`security-workflow-http.test.ts:1079-1154`）。
- `/api/developer/security/reset` 使用开发者模式重置策略：非开发者模式恒 403，成功路径 200 且**不改写** `PendingAction.status`（`developer-security-http.test.ts:42` 行仍为 `awaiting_mfa`），审计写入失败时 500 且锁保持。

`POST /api/security/reset` 的调用面固定为三处：`identity-http.test.ts:122`（`{}` → 200，无其他断言）、`security-workflow-http.test.ts:936`（it 7，`{}` + 伪造 query → 200 + `data.sessionId`）、同文件 it 9–13（见 423/200 形状）。
响应字段断言只到 `data.sessionId`/`data.locked`/`data.failures`（`:1125-1127`、`:938`、`:1150-1151`）。

解锁路径的断言缺口（本目录）：
- `data.lockedActionsReopened`（`app/api/security/reset/route.ts:52` 恒 `false`）、`data.max` 与 `data.message` 全仓零断言。
- 「已 `locked` 的 `PendingAction` 解锁后仍为 `locked`、从不写回 `pending`/`awaiting_mfa`」无断言：it 12 只断言 breaker 状态、恰好 1 条 `SECURITY_RESET` 与响应体，从不读 `pendingAction.status`。
  `manual-card-management.test.ts:73-83` 走 `resetDemoSession`（开发者门面）且只断言 `listCardChanges` 投影——`security/manual-card-management.ts:98-103` 在 breaker 锁定期间把状态覆盖成 `locked`，解锁后回落到真实行状态——因此既不能证明也不能否证该终态性。
- 「锁 + 解锁后新请求产生新 `PendingAction`（新 id，旧 locked id 不复用）」无断言；`mfa-terminal-lock-http.test.ts:315` 的 `not.toBe` 比较的是**锁之前**两个不同计划的 actionId。
- it 9 的解锁成功路径调用的是 `security.circuitBreaker.resetSession`（`:1019`）而非 HTTP 路由；HTTP 成功路径只有 it 12/it 13。

## 卡片虚拟卡消费

`card-consume-http.test.ts` 覆盖虚拟卡消费入口：
`POST /api/cards/[id]/consume`（成功 200 与错误码→HTTP 状态映射）与
`GET /api/cards/[id]/consumptions`（服务端用户范围内的消费记录，含 `?limit=` 校验）。

消费入账时间由服务端决定：请求体没有时间参数，命中 `occurredAt` 键即返回 `400 VALIDATION`
（伪造值表格、余额/流水/消费行前后一致、伪造时间不消耗 `executionKey`、月限额不可回溯绕过）。
入账瞬间固定为 `demoNow()`，`CardConsumption.createdAt` 仅秒级精度，
故排序与 `?limit=` 用例用 `seedConsumption` 直接写入不同 `occurredAt`；
真实 POST→GET 链路另有用例覆盖。

## 覆盖与缺口

面板、`confirmation_required`、`mfa_required` 断言只来自真实工具调用被网关拦截并持久化 `PendingAction`。
`nl-entry-http.test.ts` 是唯一读取助手散文文本的用例（`assistantText`，`:386`/`:407` 只断言缺参追问）。
没有任何用例断言“散文声称需确认/等待确认，但未发出工具调用”的回合。
关键词 `panel`、`prose`、`hallucinat` 在本目录无匹配。
`waiting` 多指 `waiting_confirmation` 状态；`claim` 指 DB 执行 claim。

终态锁定（`status:'locked'`）的响应字段无断言。
`ActionResponse` 真实带 `code`、`attemptsLeft`、`maxAttempts`、`failure`（含 `failure.reason`），
但 `mfa-terminal-lock-http.test.ts` 与 `actions-http.test.ts` 只断言 `status`/`mfaResult`/`ok`，从未断言这四个字段。
`POST /api/actions/[id]/{cancel,recover}` 对 `locked` 行的早退守卫生效于 `app/api/_lib/locked-action.ts#lockedActionRefusal`（`code:'CIRCUIT_OPEN'`、`failure.reason:'mfa_session_locked'`、`events: []`），
但没有任何用例取消或恢复过 `locked` 行；`cancel-safety-http.test.ts`、`cancel-during-authorization-http.test.ts` 的可执行状态集合都不含 `'locked'`。
`GET /api/security` 在本目录没有任何用例；其真实形状为 `{status,events,circuitBreaker:{failures,max,locked},lock?,lockedActions}`，`lock` 仅在 breaker 已锁时出现。
`GET /api/tasks`(`/[id]`) 的 `pendingActionStatus` 字段无断言（`tasks-http.test.ts` 只核对 `waiting_confirmation` 与 `pendingActionId`）。
`chat-history-http.test.ts` 只断言 `mfa` 卡的 `executed` 状态，没有 `locked`，也没有 `confirmation` 卡的状态断言。
锁定用例从不核对 `MfaChallenge` 行。
`/security` 页面渲染只有 `tests/e2e/acceptance.e2e.ts#j-circuit-breaker-lock` 覆盖（`已熔断`、`失败 N / N 次`、`CIRCUIT_BREAKER_TRIPPED` 行、刷新后保持、开发者重置）；
`UnlockPanel` 的运行时解锁流程与 `data-lock-reason`/`data-unlock-*`/`data-locked-actions` 标记、以及「内部标记/JSON/堆栈/演示验证码不进 DOM」都无用例。

用户可见文案断言极少：`chat-http.test.ts:409` 的 `toContain('验证码')`（RED 回合提示存在且不泄露 `MFA_CODE`）、`manual-review-http.test.ts:277` 的 `toContain('manual review')`、`card-consume-http.test.ts` 的 `occurredAt` 校验错误文案。
锁定的用户可见文案（`securityLocked`、`toolFailed`、「验证码错误次数过多」）在本目录零断言，也没有 `MfaCard`/`publicToolError` 渲染用例。

`__SECURITY_BLOCK__`、`chat.error.toolFailed`、`publicToolError`、`publicToolSummary`、`securityLocked` 在 `*.ts` 内零匹配。
`security_event` 只出现在 `chat-http.test.ts`（`:55,158-159,291-299`，`project()` 于 `:125` 把事件映射为 `security_event:${kind}`）与 `malicious-input-http.test.ts`（`:206-208`），且只断言 `kind === 'injection'`；没有任何 `security_event.message` 或 block-reason 文本断言，也没有 `kind:'locked'` 的 `security_event` 断言。
`'locked'` 作为 `PendingAction.status` 数据行只出现在 `developer-chat-http.test.ts:68` 的 `it.each`（reset 返回 409 且 revision 与 transcript 不变）。

锁定的 verify/confirm 只断言「该 actionId 不再有 `mfa_required` 事件」（`mfa-terminal-lock-http.test.ts:287,299,335`）与「`auditLog` 会话计数为 0」（`:306,345`、`actions-http.test.ts:520`）；
本目录没有「锁定调用不新增 `MfaChallenge` 行」「`pendingAction` 行数不增」「无新 `SecurityEvent`」的断言（`mfaChallenge` 在 `mfa-terminal-lock-http.test.ts`、`actions-http.test.ts` 内零匹配）。

本目录没有任何「用户可见文本/事件 message 不含内部标记」的断言：`__SECURITY_BLOCK__` 在 `tests/app/*.ts` 零匹配（只出现在本文件）、`decisionKind` 零匹配、无堆栈/原始 JSON「不含」断言；`not.toContain` 只用于 MFA 码、隐私字段与「已不 surfaced 的 actionId」。
内部标记的不含断言在 `tests/unit/`（`lib/public-text.test.ts`、`security/mfa-failure-contract.test.ts`、`agent/turn-security-event.test.ts`，见 `tests/unit/CONTEXT.md`）。

## 常用命令

`pnpm exec vitest run tests/app`

数据库隔离与顺序执行见 [../CONTEXT.md](../CONTEXT.md)。
