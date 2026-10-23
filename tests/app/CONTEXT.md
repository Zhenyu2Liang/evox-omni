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
这些路由上的 `code:'CIRCUIT_OPEN'` 只出现在**锁定后**的拒绝中：`mfa-lock-http-contract.test.ts` 的重试组与 `cancel`/`recover` 组、`mfa-lock-refresh-unlock-http.test.ts` 的重复提交组，HTTP 状态仍是 `200`。
`423 CIRCUIT_OPEN` 只来自 `/api/security/reset`（`security-workflow-http.test.ts:979,988,995,1046,1084,1101`）。
`manual-card-management.test.ts:79` 的 `CIRCUIT_OPEN` 是服务层 `rejects.toMatchObject`，不经 HTTP。
`actions-http.test.ts:461-472` 用注释固化“动作路由的 423 不可达”这一事实，不是断言。

锁定入口（终态）：
`mfa-lock-http-contract.test.ts`（三次错码的逐次阶梯、锁定后的冻结拒绝、`cancel`/`recover` 守卫、`GET /api/security` 读模型）。
`mfa-lock-refresh-unlock-http.test.ts`（刷新一致性与审计解锁）。
`actions-http.test.ts:473`（3 次错码 → 200/`status:'locked'`/`mfaResult:'failed'`，随后同会话 verify 与 confirm 均 locked）。
`mfa-terminal-lock-http.test.ts:240`（锁定持久化到 `PendingAction`、从 `GET /api/actions` 消失、不再重发 `mfa_required`）、`:311`（所有者熔断闸门对第二个未决动作同样持久化锁定）。
`security-workflow-http.test.ts:955`（it 9，伪造 cookie/query 不能解锁）、`:1080`/`:1095`/`:1111`/`:1142`（重置闸门 423/423/200/200）。
`manual-card-management.test.ts:73` 是服务层断言终止锁定的用例：`locked:true`、`listCardChanges` 全部 `status:'locked'`、下一次验证 `code:'CIRCUIT_OPEN'`、`resetDemoSession` 后回到 `pending`。

单次错误码（非终态，`status:'awaiting_mfa'`）：`actions-http.test.ts:285`、`security-workflow-http.test.ts:346`、`mfa-escalation-http.test.ts:277`、`mfa-escalation-upgrade-http.test.ts:379`、`ledger-consistency-http.test.ts:292`、`malicious-input-http.test.ts:236`、`card-freeze-audit-http.test.ts:52`（只断言 `ok:false`，不断言状态）。
逐次的完整字段矩阵（`code`/`failure.code`/`failure.reason`/`attemptsUsed`/`attemptsLeft`/`maxAttempts`）只在 `mfa-lock-http-contract.test.ts` 的阶梯组。
`actions-http.test.ts:511-515` 固化 confirm 的锁定 `mfaResult` 是 `'not_required'`（confirm 不提交验证码）；`mfa-lock-refresh-unlock-http.test.ts` 的 3 次 confirm 同样断言 `'not_required'`。

`GET /api/actions` 去曝光断言：`mfa-terminal-lock-http.test.ts:291,301,338-340`（本地 `surfaced()`，`:118`）、`mfa-lock-http-contract.test.ts`（`surfacedActions`）、`mfa-lock-refresh-unlock-http.test.ts`（`surfaced`）。
`mfa_required` 缺失断言：`mfa-terminal-lock-http.test.ts`（`mfaEventsFor`，`:97`）、`plan-parking-http.test.ts:209`（YELLOW 不发 MFA）、`mfa-lock-refresh-unlock-http.test.ts`（过滤响应的 `data.events`）。
`SecurityEventKind`（`lib/contracts/audit.ts`）没有 `mfa_required` 成员，故「锁定后不再写 `mfa_required` 事件」的 `SecurityEvent` 断言是空断言；有意义的保证是冻结的 `SecurityEvent` 总数。
`SecurityEvent` 断言按 `kind` 计数：`CIRCUIT_BREAKER_TRIPPED`/`high`（`actions-http.test.ts:497-500`）、`MFA_FAILURE`（`actions-http.test.ts:305`、`mfa-escalation-http.test.ts:303`）、`SECURITY_RESET`（`security-workflow-http.test.ts:1024-1027,1134-1137`、`developer-security-http.test.ts:28,43-46`）。
锁定后的冻结一律用总数快照：`mfa-lock-http-contract.test.ts#sideEffects`/`expectFrozen`、`mfa-lock-refresh-unlock-http.test.ts#ledgerSnapshot`。

## 解锁入口

解锁入口必须区分：
- `/api/security/reset` 使用验证码或冷却策略；锁定中缺码或错码均为 423 `CIRCUIT_OPEN`，正确码 200 + `{locked:false,failures:0}`，每次成功恰好 1 条 `SECURITY_RESET`（`security-workflow-http.test.ts:1079-1154`）；`mfa-lock-refresh-unlock-http.test.ts` 用 `verificationCode` 走同一成功路径并断言增量。
- `/api/developer/security/reset` 使用开发者模式重置策略：非开发者模式恒 403，成功路径 200 且**不改写** `PendingAction.status`（`developer-security-http.test.ts:42` 行仍为 `awaiting_mfa`），审计写入失败时 500 且锁保持。

`POST /api/security/reset` 的调用面：`identity-http.test.ts:122`（`{}` → 200，无其他断言）、`security-workflow-http.test.ts:936`（it 7，`{}` + 伪造 query → 200 + `data.sessionId`）、同文件 it 9–13（见 423/200 形状）、`mfa-lock-refresh-unlock-http.test.ts`（带 `verificationCode` 的审计解锁）。
响应字段断言覆盖 `data.sessionId`/`data.locked`/`data.failures`（`:1125-1127`、`:938`、`:1150-1151`）与 `data.max`/`data.lockedActionsReopened`（`mfa-lock-refresh-unlock-http.test.ts` 的解锁组）。
`data.message` 仍零断言。

解锁后的终态性由 `mfa-lock-refresh-unlock-http.test.ts` 的解锁组固定：
- 旧 `locked` 行解锁后仍为 `locked`、`updatedAt` 不变，从不写回 `pending`/`awaiting_mfa`。
  `manual-card-management.test.ts:73-83` 走 `resetDemoSession`（开发者门面）且只断言 `listCardChanges` 投影——`security/manual-card-management.ts:98-103` 在 breaker 锁定期间把状态覆盖成 `locked`，解锁后回落到真实行状态——因此既不能证明也不能否证该终态性。
- 同一业务意图的新请求铸造新 `PendingAction`（新 id、新 taskId）并停在 `awaiting_mfa`，旧 id 不复用；`mfa-terminal-lock-http.test.ts:315` 的 `not.toBe` 比较的是**锁之前**两个不同计划的 actionId。
- 解锁审计是 `SecurityEvent`（`SECURITY_RESET` 增量 1），不是 `AuditLog` 行（增量 0）。
- it 9 的解锁成功路径调用的是 `security.circuitBreaker.resetSession`（`:1019`）而非 HTTP 路由。

## 锁定读模型与解锁的形状

`GET /api/security` 的 `lock` 是账户级常量 `{code:'CIRCUIT_OPEN',reason:'circuit_open'}`（`app/api/security/route.ts:72-77`），刻意不带 `attemptsUsed`/`attemptsLeft`/`maxAttempts`（按「键不存在」断言）。
逐 action 的 `mfa_attempts_exhausted` + 3/0/3 只出现在第 3 次错码的写响应里，任何读模型都不报告。
`lock` 键只在 breaker 已锁时出现；解锁后键缺失而非 `null`（`'lock' in data === false`）。
`lockedActions` 恒为数组：只含状态恰为 `'locked'` 的 `PendingAction`，按最后一次写入（锁定瞬间）倒序，人工专属发卡/删卡命令被排除（`isManualCardCommand`）。
`lockedActions` 条目字段固定为 `actionId`/`toolName`/`tier`/`requiresMfa`/`updatedAt`，其中 `updatedAt` 是行自身的 `updatedAt`。
两次错码（低于阈值）时 `circuitBreaker` 为 `{failures:2,max:3,locked:false}`、无 `lock` 键、`lockedActions` 为 `[]`，动作仍被 `GET /api/actions` 曝光。
锁定时 `circuitBreaker` 为 `{failures:3,max:3,locked:true}`。

任务读模型：`GET /api/tasks` 与 `GET /api/tasks/[id]` 的节点带 `pendingActionStatus?: PendingActionStatus`（`app/api/_lib/task-pending-actions.ts`），锁定后报 `'locked'`。
节点的 `status` 保持 `waiting_confirmation`/`waiting_*`、`pendingActionId` 仍在：锁定只改 action 状态，不改计划节点。
未提交的对照动作仍报 `awaiting_mfa`，读模型区分两者。

`GET /api/chat/history` 两种卡形都带持久化状态：`mfa` 卡为顶层 `status`，`confirmation` 卡在 `action.status`；锁定后均为 `'locked'`。

刷新一致性：连续两次读取 `/api/actions`、`/api/security`、`/api/tasks`、`/api/tasks/[id]`、`/api/chat/history` 必须 `toEqual`。
读取是纯操作：不改 `updatedAt`，不写审计/安全事件/回执/流水，不动余额，不新增 `AgentRunEvent` 与 `MfaChallenge`。

解锁：`POST /api/security/reset` 带验证码 → 200 + `{locked:false,failures:0}`，记录恰好 1 条 `SECURITY_RESET`。
`SECURITY_RESET` 是 `SecurityEvent`（`security/circuit-breaker.ts#commitAuditedReset`），不是 `AuditLog` 行（`AuditStatus` 无重置值），故 `AuditLog` 增量为 0。
`lockedActionsReopened` 恒 `false`（`app/api/security/reset/route.ts:52`）。
解锁后安全中心报 `locked:false` 且无 `lock` 键，但仍把旧行列入 `lockedActions`；`GET /api/actions` 仍不把旧 id 当作待决策项曝光。

## 卡片虚拟卡消费

`card-consume-http.test.ts` 覆盖虚拟卡消费入口：
`POST /api/cards/[id]/consume`（成功 200 与错误码→HTTP 状态映射）与
`GET /api/cards/[id]/consumptions`（服务端用户范围内的消费记录，含 `?limit=` 校验）。

消费入账时间由服务端决定：请求体没有时间参数，命中 `occurredAt` 键即返回 `400 VALIDATION`
（伪造值表格、余额/流水/消费行前后一致、伪造时间不消耗 `executionKey`、月限额不可回溯绕过）。
入账瞬间固定为 `demoNow()`，`CardConsumption.createdAt` 仅秒级精度，
故排序与 `?limit=` 用例用 `seedConsumption` 直接写入不同 `occurredAt`；
真实 POST→GET 链路另有用例覆盖。

## 卡片结算账户投影

`card-links-http.test.ts` 覆盖 `GET /api/cards` 的公开 JSON 边界（`CardView`）：
`LINKED` 卡只给出脱敏账户号（`Account.number` 原样）、账户名、账户余额与
`payableAmount = min(账户余额, 家庭本月剩余限额)`；
`UNTRUSTED`（他人账户）与 `MISSING`（`linkedAccountId: null`）**没有任何余额字段**，
既不泄漏他人余额/账号/户名，也不伪造 `"0.00"` 或 `null`；
`FROZEN`/`LOST` 仍返回真实余额，只用 `usable: false` 区分「不可用」与「没钱」；
`CREDIT` 恒 `NOT_APPLICABLE`，不查账户、保留 `creditLimit`/`availableLimit`。
断言同时作用于解析后的行与 `JSON.stringify` 的整段报文，因为 `undefined` 键在报文里必须缺席。
`GET /api/cards` 固定读演示用户，因此「他人视角」方向经路由调用的同一投影
（`banking.card.getCards`）断言。

执行命令：`pnpm exec vitest run tests/app`。

## 覆盖与缺口

面板、`confirmation_required`、`mfa_required` 断言只来自真实工具调用被网关拦截并持久化 `PendingAction`。
`nl-entry-http.test.ts` 是唯一读取助手散文文本的用例（`assistantText`，`:386`/`:407` 只断言缺参追问）。
没有任何用例断言“散文声称需确认/等待确认，但未发出工具调用”的回合。
关键词 `panel`、`prose`、`hallucinat` 在本目录无匹配。
`waiting` 多指 `waiting_confirmation` 状态；`claim` 指 DB 执行 claim。

终态锁定的响应字段由 `mfa-lock-http-contract.test.ts` 逐字段固定：`code`、`failure.code`、`failure.reason`，以及 `attemptsUsed`/`attemptsLeft`/`maxAttempts` 的存在与缺席（按路线分别断言）。
锁值的真值只在两处逐字段断言：第 3 次错码 = 顶层 `code:'CIRCUIT_OPEN'` + `failure.code:'MFA_LOCKED'` + `failure.reason:'mfa_attempts_exhausted'` + 3/0/3（`mfa-lock-http-contract.test.ts:277-286` 的 `LADDER` 与 `:304-326`，`mfa-lock-refresh-unlock-http.test.ts:467-471`）。
`MFA_LOCKED` 从不作顶层 `code`：`LadderStep.code` 只允许 `'MFA_FAILED' | 'CIRCUIT_OPEN'`（`mfa-lock-http-contract.test.ts:236`），顶层锁信号一律是 `CIRCUIT_OPEN`。
锁后 verify 的 `failure` 装配很精确——既有 `attemptsLeft:0`、又**没有** `attemptsUsed` 键、且顶层同时带 `attemptsLeft:0`/`maxAttempts`：`mfa-lock-refresh-unlock-http.test.ts:488-490` 与 `mfa-lock-http-contract.test.ts:404-407` 必须同时成立；改网关/路由的 failure 形状要同时满足这两处，顶层计数的「缺失」只对 `cancel`/`recover` 守卫断言（`mfa-lock-http-contract.test.ts:477-480`）。
`mfa-terminal-lock-http.test.ts` 与 `actions-http.test.ts` 仍只断言 `status`/`mfaResult`/`ok`。
`POST /api/actions/[id]/{cancel,recover}` 对 `locked` 行的早退守卫生效于 `app/api/_lib/locked-action.ts#lockedActionRefusal`（`code:'CIRCUIT_OPEN'`、`failure.reason:'mfa_session_locked'`、`events: []`、固定文案），由 `mfa-lock-http-contract.test.ts` 的 `cancel`/`recover` 组覆盖；`cancel-safety-http.test.ts`、`cancel-during-authorization-http.test.ts` 的可执行状态集合仍不含 `'locked'`。
`GET /api/security` 的读模型由 `mfa-lock-http-contract.test.ts` 的 4 个用例与 `mfa-lock-refresh-unlock-http.test.ts` 的刷新组固定，形状见「锁定读模型与解锁的形状」。
`GET /api/tasks`(`/[id]`) 的 `pendingActionStatus` 由 `mfa-lock-refresh-unlock-http.test.ts` 断言；`tasks-http.test.ts` 仍只核对 `waiting_confirmation` 与 `pendingActionId`。
`chat-history-http.test.ts` 只断言 `mfa` 卡的 `executed` 状态；`locked` 与 `confirmation` 卡的状态断言在 `mfa-lock-refresh-unlock-http.test.ts`。
`MfaChallenge` 行由 `mfa-lock-http-contract.test.ts`（逐次 `attempts`/`maxAttempts`/`status`）与 `mfa-lock-refresh-unlock-http.test.ts`（状态列冻结、行数恒 1）核对。
`/security` 页面渲染只有 `tests/e2e/acceptance.e2e.ts#j-circuit-breaker-lock` 覆盖（`已熔断`、`失败 N / N 次`、`CIRCUIT_BREAKER_TRIPPED` 行、刷新后保持、开发者重置）；
`UnlockPanel` 的运行时解锁流程与 `data-lock-reason`/`data-unlock-*`/`data-locked-actions` 标记、以及「内部标记/JSON/堆栈/演示验证码不进 DOM」都无用例。

用户可见文案断言极少：`chat-http.test.ts:409` 的 `toContain('验证码')`（RED 回合提示存在且不泄露 `MFA_CODE`）、`manual-review-http.test.ts:277` 的 `toContain('manual review')`、`card-consume-http.test.ts` 的 `occurredAt` 校验错误文案、`mfa-lock-http-contract.test.ts` 对锁定守卫固定句的全等断言。
锁定的用户可见文案（`securityLocked`、`toolFailed`、「验证码错误次数过多」）在本目录零断言，也没有 `MfaCard`/`publicToolError` 渲染用例。

`__SECURITY_BLOCK__`、`chat.error.toolFailed`、`publicToolError`、`publicToolSummary`、`securityLocked` 在 `*.ts` 内零匹配。
`security_event` 只出现在 `chat-http.test.ts`（`:55,158-159,291-299`，`project()` 于 `:125` 把事件映射为 `security_event:${kind}`）与 `malicious-input-http.test.ts`（`:206-208`），且只断言 `kind === 'injection'`；没有任何 `security_event.message` 或 block-reason 文本断言，也没有 `kind:'locked'` 的 `security_event` 断言。
`developer-chat-http.test.ts:68` 的 `it.each` 也把 `'locked'` 当作 `PendingAction.status` 数据行（reset 返回 409 且 revision 与 transcript 不变）。

锁定的 verify/confirm 在 `mfa-terminal-lock-http.test.ts` 里只断言「该 actionId 不再有 `mfa_required` 事件」（`:287,299,335`）与「`auditLog` 会话计数为 0」（`:306,345`、`actions-http.test.ts:520`）；
「锁定调用不新增 `MfaChallenge` 行」「`pendingAction` 行不增」「无新 `SecurityEvent`」「无新回执」由 `mfa-lock-http-contract.test.ts` 的冻结快照与 `mfa-lock-refresh-unlock-http.test.ts` 的增量断言覆盖（`mfaChallenge` 在 `mfa-terminal-lock-http.test.ts`、`actions-http.test.ts` 内仍零匹配）。

本目录没有任何「用户可见文本/事件 message 不含内部标记」的断言：`__SECURITY_BLOCK__` 在 `tests/app/*.ts` 零匹配（只出现在本文件）、`decisionKind` 零匹配、无堆栈/原始 JSON「不含」断言；`not.toContain` 只用于 MFA 码、隐私字段与「已不 surfaced 的 actionId」。
内部标记的不含断言在 `tests/unit/`（`lib/public-text.test.ts`、`security/mfa-failure-contract.test.ts`、`agent/turn-security-event.test.ts`，见 `tests/unit/CONTEXT.md`）。

## 金额与货币文本的断言形态

本目录零 `formatCNY(`、零 `formatDecimalCNY(`：没有任何用例断言渲染后的货币字符串。
`¥`（U+00A5）在本目录只出现在三种非断言位置：JSDoc/行注释里的夹具金额（如 `¥23,580`、`¥5,050`）、`it(...)`/`describe(...)` 标题、以及 `expect(actual, '...¥...')` 的第二参数失败消息（`actions-http.test.ts:317`、`cancel-during-authorization-http.test.ts:226`/`:289`、`cancel-safety-http.test.ts:235`/`:433`、`ledger-consistency-http.test.ts:379`、`mfa-escalation-upgrade-http.test.ts:212`/`:225`/`:248`、`mfa-lock-http-contract.test.ts:306`、`security-workflow-http.test.ts:218`/`:231`/`:1061`）。
金额一律按十进制文本（`'2000.00'`、`'5050.51'`、`'1200.12'`）或 `BigInt` 最小单位（`2358000n`、`200050n`、`2356000n`）断言，从不经展示格式化器往返。
`currency: 'CNY'` 在本目录只是数据字段值（`card-consume-http.test.ts`、`card-links-http.test.ts`），不是渲染输出。
真正的渲染货币字面量锚点只在 `tests/integration/handoff-*` 之外三处（`frontend-followup-fixes.test.ts:44`/`:91`/`:116`、`frontend-review-fixes.test.ts:90`、`task-feature-hardening.test.ts:122`），格式化器自身的字面量夹在 `tests/unit/financial-values.test.ts`、`tests/unit/planner/decimal-format.test.ts`、`tests/unit/planner/chart-presentation.test.ts`。
浏览器文本断言（Playwright 等）应从后两类文件取字面量，不要从本目录推导。

## 规格文件清单

| 文件 | 覆盖 |
| --- | --- |
| `actions-http.test.ts` | 决策路由真值：GREEN 不停放、YELLOW confirm 与重复 confirm、RED verify、错码 `200`/`awaiting_mfa`、资金不足诚实失败、cancel、所有权 403/404、MFA 码不泄露、3 次错码锁定 |
| `actions-recovery-http.test.ts` | `/api/actions` 发现面 + `POST /api/actions/[id]/recover`：独立楔子 `recoverable`→`executed`（副作用一次）、计划节点楔子由 recover 恢复计划到 `success` |
| `activity-http.test.ts` | `GET /api/activity` 域时间线、`GET /api/audit` 原始审计拒绝、技术流量过滤、交易确认只出现一次 |
| `cancel-safety-http.test.ts` | 计划取消两个窗口：取消落在停放中（未链接节点的动作被撤销）与同一停放动作上 cancel/confirm 竞争只结算一次 |
| `cancel-during-authorization-http.test.ts` | 授权期间 cancel：cancel 先到则后续 confirm 被拒；confirm 先到则 cancel 被拒且账本/日累计不回滚 |
| `card-consume-http.test.ts` | 虚拟卡消费 `POST /api/cards/[id]/consume` 与 `GET …/consumptions`，服务端入账时间与 `occurredAt` 拒绝矩阵 |
| `card-freeze-audit-http.test.ts` | 卡片状态动作的独立验证、持久化档位降级重判、执行审计失败回滚、`recover` 落到 `needs_reconciliation`、审计归属过滤 |
| `chat-http.test.ts` | `POST /api/chat` 真值：GREEN 读、YELLOW/RED 停放、注入事件、分析与异常读、SSE 与 JSON 投影一致、传输失败 `400`、MFA 码保密 |
| `chat-history-http.test.ts` | `GET /api/chat-history` 分页锚点、所有者/会话隔离、清空会话拒绝、授权卡状态刷新（直插 `pendingAction`） |
| `concurrent-execution-http.test.ts` | 会合点并发：控制请求落在副作用之后/结果持久化之前、confirm 续行与 `resume`/`retry` 竞争，副作用的 `Budget` 行恰好一条 |
| `confirm-continuation-fencing.test.ts` | confirm 续行丢失计划执行 claim（活动所有者）：不改写 owner 行、不推进计划、仍用 fence 记录已决策节点，owner 释放后计划可完成 |
| `confirm-continuation-no-owner-fencing.test.ts` | 无所有者 CAS 分支：记录已决策节点并结算计划；写窗口内被接管则跳过写入 |
| `contacts-http.test.ts` | `POST /api/contacts` 保存/掩码视图/双审计、重复与畸形拒绝、删除决策、并行去重、审计失败回滚 |
| `cumulative-risk-http.test.ts` | 日累计风险：in-flight 转账只计一次、两个并发 ¥600 中一个升级 RED、¥1000 与 ¥1000.01 边界 |
| `dag-recovery-http.test.ts` | `POST /api/tasks/[id]` pause→resume（不重跑成功节点）、cancel 终态、retry 只重跑失败节点、`GET /api/tasks/[id]` 与 `GET /api/actions` 刷新恢复 |
| `developer-chat-http.test.ts` | `POST /api/developer/chat` 重置会话上下文：模式与确认门、非终态动作/运行/计划/租约/人工复核全部保留、revision 冲突 |
| `developer-security-http.test.ts` | `POST /api/developer/security/reset`：非开发模式 403、成功路径不改 `PendingAction.status`、审计失败保持锁定 |
| `identity-http.test.ts` | 单用户演示身份：唯一会话、无登录恢复动作与计划、MFA 仍需验证、伪造 cookie/query 不能选中他主资源 |
| `ledger-consistency-http.test.ts` | 已确认转账的余额/流水一致、被拒动作不动钱、诚实失败、多次确认累计 |
| `malicious-input-http.test.ts` | 提示注入后转账仍被闸门拦截、已停放参数不被请求体/查询串覆盖、身份提示被忽略 |
| `manual-card-management.test.ts` | 人工专属发卡/删卡：独立挑战、重放、所有者锁定与开发者重置、删除债务/未决操作拒绝、通用决策路由拒绝人工提案 |
| `manual-review-http.test.ts` | 人工复核：接管闸门与模式、开案时禁止 resume/retry、保留已确认扣款、运营者 stop/resume、并发只产生一个活动案 |
| `mfa-escalation-http.test.ts` | confirm 时 YELLOW→RED 升级（日累计）、verify 完成升级转账、升级后错码正常 `200` |
| `mfa-escalation-upgrade-http.test.ts` | 执行时档位升级：第二个 ¥600 confirm 升级为 RED/`awaiting_mfa` 并发 `mfa_required`，verify 后审计与升级决策一致 |
| `mfa-lock-http-contract.test.ts` | 三次错码的 HTTP 阶梯（逐次 `status`/`code`/`failure.code`/`failure.reason`/`attemptsUsed`/`attemptsLeft`/`maxAttempts` 与两个持久化标记）、锁定后正确码与错码的冻结拒绝、`cancel`/`recover` 的守卫形状、`GET /api/security` 的锁定/解锁/低于阈值读模型 |
| `mfa-lock-refresh-unlock-http.test.ts` | 刷新一致性：五个读模型两遍 `toEqual`、`lock`/`lockedActions` 稳定、任务节点 `pendingActionStatus`、两种历史卡状态且读取为纯；锁定后 3×verify+3×confirm 惰性；审计解锁的 `SECURITY_RESET` 增量、旧行保持 `locked`、新请求铸造新 id |
| `mfa-terminal-lock-http.test.ts` | MFA 次数耗尽的终态锁定：`status:'locked'` 持久化、从 `GET /api/actions` 去曝光、不再发 `mfa_required`、后续（含正确码）仍拒绝 |
| `nl-entry-http.test.ts` | 自然语言入口→`set_card_limit`/`subscribe_investment`/`cancel_subscription` 停放与决策、缺参只澄清不调工具 |
| `plan-linkage-http.test.ts` | 停放动作的计划/节点链接（`taskId`/`nodeId`）、`resume` 复用同一动作、同参不同计划不合并 |
| `plan-parking-http.test.ts` | `submit_plan` 条件 DAG 在闸门节点停放：SSE 走 analyze→check→setlimit、只发 YELLOW、confirm 恢复计划 |
| `plan-pause-terminal-http.test.ts` | 暂停计划里确认已停放节点只结算节点不推进计划、取消/完成计划后 resume/retry/pause 是 no-op |
| `scheduled-dispatch-http.test.ts` | 定时派发：提醒只投递一次、到期支付重新过闸、拒绝客户端时钟、审计失败回滚、停放审批不饿死提醒 |
| `security-workflow-http.test.ts` | 两笔 ¥600 的 confirm 升级、错码、计划取消/已完成终态、运行中 pause 停住下一节点、伪造身份不能验证/取消/控制、`/api/security/reset` 423/200 解锁闸门 |
| `session-takeover-http.test.ts` | 共享会话 HTTP 入口：无/未知/外来 cookie 落到同一持久会话、外来 body 断言被拒、`requestId` 去重 |
| `task-resume-retry-http.test.ts` | 两个重叠 `resume`/`retry` 请求：未完成节点只执行一次、持久状态与读模型一致 |
| `tasks-http.test.ts` | `POST /api/tasks/[id]` pause/cancel/retry、confirm/verify 恢复停放计划、`GET /api/tasks`(`/[id]`) 刷新恢复与所有权 |

两个 `mfa-lock-*.test.ts` 各有约 600 行，这是刻意的：逐次阶梯矩阵、逐读模型矩阵与冻结快照都按事实展开，便于逐条定位；不要为长度把它们拆成多个文件。

## 停放、锁定与并发窗口的构造手法

`PendingAction` 在本目录全部由生产路径产生（决策本身从不被 mock），共有五种构造法：
1. `POST /api/chat` 停放回合（mock 模型驱动），如 `actions-http.test.ts:199`、`security-workflow-http.test.ts:207`。
2. `executeGatedTool`（独立动作，无计划链接），如 `actions-recovery-http.test.ts:152`、`card-freeze-audit-http.test.ts:98`、`manual-card-management.test.ts:172`。
3. `runSubmitPlan` + 转发 `ctx.taskId`/`ctx.nodeId` 的 `runTool`（计划链接），如 `mfa-terminal-lock-http.test.ts:193-207`、`task-resume-retry-http.test.ts:149`、`dag-recovery-http.test.ts:156`。
4. `security` 网关门面 `gateway.handleToolCall`，仅 `cumulative-risk-http.test.ts:93-104`。
5. 直接 `prisma.pendingAction.create`，只用于历史/投影类用例：`chat-history-http.test.ts:102`、`developer-chat-http.test.ts:73`、`developer-security-http.test.ts:34`、`manual-review-http.test.ts:164`。

锁定类用例的规范路径是共享辅助 `tests/helpers/locked-action.ts`：`parkRedTransferPlan`/`parkConfirmOnlyTransfer` 是第 3 种的封装（生产 `runSubmitPlan` + 转发 `ctx` 的 `executeGatedTool`，条件不满足直接抛断言），`lockAction` 走网关阶梯，探针 `pendingActionRow`/`mfaChallengesFor`/`checkingBalance`/`zhangweiTransfers`/`auditLogCount`/`securityEventsOfKind`/`transactionsCount` 提供冻结快照。
它从不 reset 也不 seed：两个 `mfa-lock-*.test.ts` 仍在 `beforeEach` 调 `resetDatabase()`，因为熔断按所有者持久化，上一条用例的锁会漏进下一条。

锁定一律用 `MFA_MAX_ATTEMPTS` 次错码循环构造：`lockAction`（内部 `exhaustMfaAttempts` 逐次 `securityGateway#authorizeAction`，**绝不**直接调 `security/mfa.ts#verify`——它只锁 challenge，不落 `PendingAction` 终态）用于 `mfa-lock-http-contract.test.ts` 与 `mfa-lock-refresh-unlock-http.test.ts`；手写的等价循环仍在 `mfa-terminal-lock-http.test.ts:260`（非终态循环）与 `:319`（触发 owner 熔断）、`actions-http.test.ts:477-486`、`security-workflow-http.test.ts:965`、`:1065`。
断言面固定为 `data.status`/`data.code`/`data.mfaResult`/`data.failure`、`pendingAction.status`、`MfaChallenge.status`、`GET /api/actions` 是否再 surface，以及 `auditLog`/`SecurityEvent`/回执/流水/余额的计数冻结。

并发窗口一律用有界会合点（`makeBarrier`，超时 `BARRIER_TIMEOUT_MS = 3000`）而不是时钟：`task-resume-retry-http.test.ts:200-215`、`concurrent-execution-http.test.ts:286-300`、`cancel-safety-http.test.ts:343-357`、`scheduled-dispatch-http.test.ts:149-154`、`manual-review-http.test.ts:293-313`。

计划执行 claim 的「活动所有者」直接写持久化字段伪造，不靠计时：把 `agentTask.executionClaimedAt` 写成当前时刻让续行的 `claimTaskExecution(..., { staleBefore })` 匹配 0 行（`confirm-continuation-fencing.test.ts:273-278`，随后断言 owner 行未被改写 `:295`），再清空 `executionToken`/`executionClaimedAt` 让同一计划恢复（`:333`）；无所有者分支见 `confirm-continuation-no-owner-fencing.test.ts:195-197`、接管写入 `:264-268`；`manual-review-http.test.ts:243` 用同样方式伪造活动执行者。`tasks-http.test.ts:467-471` 只伪造 `createdAt` 用于排序。

本目录没有 `leaseExpiresAt` 或 `maxRecoveryAttempts` 用例，也没有 `vi.useFakeTimers`：经 HTTP 入口的租约过期与恢复次数上限完全未覆盖。
唯一注入时钟的是调度器 `tickScheduledTasks(identity, { now: NOW })`（`scheduled-dispatch-http.test.ts:37` 起），以及 `developer-chat-http.test.ts:109` 直接写 `agentSession.activeRunId` 表示活动租约。

## 驱动 chat turn 的用例的超时预算

`CHAT_DRIVEN_TEST_TIMEOUT_MS = 60_000`（本文件顶部常量区）是 body 会驱动真实 `POST /api/chat` 的用例的显式预算，作为 `it(...)` 的第三个参数传入。
带该预算的用例：it 1、it 2、it 3（经 `parkTwoTransfers()` 调两次 `chatTurn()`）与 it 9、it 10、it 11、it 12（it 9 直接调 `chatTurn()`，it 10–12 经 `lockOwner()` 调一次）。
不驱动 chat 的 it 4–8、it 13（`runSubmitPlan`/`executeGatedTool`/纯路由）沿用全局 `testTimeout: 20000`。
新写驱动 chat 的用例时必须同样套用该常量：其成本由串行语句数决定，与断言数量无关。

依据：一次 chat turn 约 1.4s、落库约 101 行 `agentRunEvent`；每个 Pi 事件各开一个交互式事务（`agent/durable/journal.ts:120-123` → `lib/db/repositories/agentRun.ts:118-122`），全部串行排在同一条 native SQLite 连接上（`lib/db/serialized-connection.ts`）。
`parkTwoTransfers()` 调两次 `chatTurn()`，故 it 1–3 的 body ≈ 200 次串行交互式事务。
mock 路径没有任何内部 deadline 或 sleep/重试：`agent/durable/journal.ts:223-228` 的 20 000ms 心跳已 `.unref()`，live 专属的 `AbortSignal.timeout` 不生效。
所以 body 墙钟 ≈ 语句条数 × 单语句延迟，随宿主 I/O 延迟线性放大，`testTimeout: 20000` 是唯一边界。

实测（同一用例 it 2）：单独跑 1919ms、完整 `pnpm test` 1622ms、`tests/app`+`tests/integration` 111 文件批次 2639ms、`tests/app`+`tests/unit` 批次 1431ms。
宿主争用下同一文件单跑 it 1 7081ms / it 2 6710ms / it 3 2397ms（相对 1.9s 约 3.7–4.4 倍）；该文件曾出现 `Error: Test timed out in 20000ms.`（用例起始行 `:294`，实际 24316ms），当时整套只慢 1.29×。

已排除的成因：无第二个进程写同一 `prisma/test.db`（无锁竞争，也没有 >1s 的可复现单步停顿）；`prisma/test.db` 与 WAL 规模均在正常区间波动；`tests/setup.ts` 的 schema 哈希标记匹配，跑批中途不重建库；子进程只有四处 spawn 点且都在各自用例内 `await` + `kill`，`deploy-db-push` 用自己的库。
唯一能同时解释「整套只慢 1.29×、单用例却慢 12.7×」的是宿主争用（同类 agent 的多个 worktree 在同机并发跑 node 进程）。

残余风险：真实的 ~12× I/O 争用仍可能让更重的组合用例（多个 chat turn 叠加阶梯式 verify 循环）超过 60s。该预算抬高的是下限而非保证——超时是环境放大信号，不得据此断言业务缺陷或放宽断言。

## 常用命令

`pnpm exec vitest run tests/app`

数据库隔离与顺序执行见 [../CONTEXT.md](../CONTEXT.md)。
