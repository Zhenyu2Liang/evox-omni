# 演示场景测试

## 测试入口

`test-01` 至 `test-12` 覆盖最初的演示场景。
包括余额、转账、账单、异常、限额、理财与条件计划。
`test-13` 至 `test-15` 覆盖补办换卡、虚拟卡申请与类别限额约束。
`test-16` 覆盖虚拟卡补办家族生命周期、限额语义与重放幂等。
`test-17` 覆盖伪造消费入账时间在工具、计划与重放层被拒。
`test-18` 覆盖卡片能力的咨询、歧义澄清与能力指引契约。
`test-19` 覆盖 LOST 信用卡补办在生产运行时端到端可达。
`mock-integration.test.ts` 使用应用的离线模型。

`test-01` 至 `test-17` 使用 `tests/helpers/faux-agent.ts`（裸 Pi Agent + 直连网关钩子）。
`test-18`/`test-19` 走生产入口 `@/agent#runTurn` + `tests/helpers/scripted-provider`。
`describe_turn` 声明、准入与租约、`groundMessage` 渲染、写续接只存在于生产入口，裸 Pi 夹具无法替代。
两阶段调用由 `tests/helpers/scenario.ts` 驱动，只服务裸 Pi 夹具。
它们证明网关、工具和 SDK 的业务边界。
不能据此声明生产运行的全部流程均被覆盖。
生产入口的声明、准入与展示另有集成测试。

## 卡片能力契约（test-18 / test-19）

咨询类提问（「补办怎么办理」「需要什么材料」）只产生解释或 `card_management_required` 指引：不产生 `PendingAction`、不新增卡片行、余额不变。
目标歧义（多张卡时只说「帮我把卡补办一下」）只产生澄清：结构化 `missing_details`（`fields:['card']`）由服务端渲染为「请补充卡片类型或尾号，再继续处理；未创建操作授权。」，纯文本追问等价。
两种澄清都不得产生动作，也不需要它们是「面板」。
能力指引与系统提示不得否认真实能力：`replace_card` 与 `apply_virtual_card` 都是目录内的 RED 写工具。
把手动专有操作（新建/删除卡片）指向卡片页面是允许的；声称助手不能创建/申请卡片、或把已挂失卡片的补办说成只能人工，则违反契约。
正向可达：LOST 信用卡经 `replace_card` 进入 RED MFA，验证前不制卡；验证后恰好多一张 ACTIVE 信用卡，源卡保持 `LOST` 且 `replacedByCardId` 指向新卡。
`test-18` case 3 用共享句子判定器 `../unit/agent/capability-guidance-markers.ts#overbroadManualOnlyCardProhibitions` 逐句检查系统提示：把卡片发放整体说成 manual-only 即为违规，而限于「新建实体卡 + 注销卡片」、声明页面专属集合封闭、或明确排除补办的句子都合规。
同一用例还结构性核对人工专属规则的两项内容与封闭表述、`replace_card` 覆盖任意类型的已挂失卡，以及 `replace_card` 不被说成页面专属；断言绑定契约而不绑定某一句原文。
断言卡片身份与增量（前后快照、指定 id），不断言整库卡片总数。

## 生产运行时事实（test-18 / test-19 依赖）

RED 闸门结束本轮：`script.calls()` 为「声明 + 被拦截调用」，尾部叙述步不会被消费。
被拦截的一轮不发布助手文本，末条 assistant `content` 为空串。
验证后的 `PendingAction.status` 为 `executed`；`confirmed` 只是离开 `awaiting_mfa` 的中间态。
写续接仅在 `config.llmMode === 'live'` 运行（`tests/setup.ts` 默认 `mock`），指引渲染不受该开关限制。
`describe_turn` 不出现在 `tool_start`/`tool_end` 事件里，但有 `status='completed'` 的 `toolInvocation` 行。

## 断言方法

业务测试核对操作状态、余额、流水与审计。
用户决定前不能发生未授权资金变化。
注入文本不能降低权限要求。
条件计划必须按实际节点结果决定后续执行。

结果文字可能由测试辅助函数补充。
这类断言不能证明模型不会编造事实。
离线模型也不能代替 live 模型验收。

GREEN 只表示执行策略，不表示没有副作用。
预算等写操作仍需强制审计。
纯读取与写操作的记录方式以执行层为准。

测试数据使用独立夹具，不等同演示库的全部记录。
熔断隔离规则见 [../CONTEXT.md](../CONTEXT.md)。

运行：`pnpm exec vitest run tests/scenarios`。
共享 SQLite 必须单进程串行执行；shell 输出在本环境不稳定，用 `logs/` 下的 UTF-8 重定向再读文件。

## 确认与待决面板

确认/MFA 面板只来自被网关拦截的真实工具调用。
`test-02`（YELLOW）与 `test-03`/`test-09`/`test-13`/`test-14`/`test-16`（RED）核对 `PendingAction` 行、`confirmation_required`/`mfa_required` 事件与确认/MFA 卡片。
`test-11`/`test-12` 核对被拦截的计划节点 parked 为 `waiting_confirmation` 并暴露 `pendingActionId`。
`mock-integration.test.ts` 对真实离线模型核对 `pendingAction.status`。

每个被断言的确认/MFA 面板都对应一条真实 `PendingAction`。
`test-18` 的咨询与歧义轮没有工具调用，因此既无面板也无 `PendingAction`，构成「模型只用文字声称」情形的负向对照。
`test-04` 只证明注入文本不改变权限等级，不核对模型文字与实际工具调用/待决行是否一致。

## 熔断锁定路径

`test-10-circuit-breaker.test.ts` 是本目录唯一覆盖「MFA 次数耗尽 → 熔断锁定」的场景（`test-03`/`test-09`/`test-13`/`test-14`/`test-16`/`test-19` 只走 `blocked` + `awaiting_mfa`，同名 `locked` 匹配多来自 `blocked`/`unlocked` 子串）。
它只断言服务端事实：`MfaChallenge.status='locked'` 且 `attempts===maxAttempts===3`、`CircuitBreakerState.locked`/`failures`/`lockedAt`、`CIRCUIT_BREAKER_TRIPPED`（severity `high`）恰 1 条、`MFA_FAILURE` 恰 3 条、`authorizeAction` 返回 `ok:false`/`status:'locked'`、后续 RED 工具调用 `evaluation.blocked` + `decision.kind='deny'` 且不再建 `PendingAction`、余额与持仓不变。
人类可见文案只按片段断言：`text` 含「验证码错误」与「锁定」，`auth.message` 含「熔断」。
本目录与 `../helpers` 都不匹配 `chat.error.securityLocked`/`chat.error.toolFailed`、完整锁定语（「验证码错误次数过多……安全中心……」）、`__SECURITY_BLOCK__`、`CIRCUIT_OPEN` 或 HTTP 423；那些只出现在 `../app` 的 HTTP 用例与 `../integration`、`../e2e` 目录。
`../helpers/scenario.ts#handleToolExecutionEnd` 会把 `deny` 阻塞理由发布为 `security_event{kind:'locked'}`，但本目录没有用例断言该事件。
`MfaCard`/`publicToolError` 的 LOCKED 渲染不属于本目录覆盖范围。

### 锁定路径的可观测面与逐条断言位置

`ScenarioResult` 只有 `text`/`events`/`toolEvents`/`cards`，没有 `status`/`mfaResult`/`code`；
`../helpers/scenario.ts#decideAndContinue` 在 `auth.ok===false` 时返回 `{events:[], cards:[], text: auth.message}`，
所以「错码仍有剩余次数」「第三次错码刚锁定」「已锁定后再试」三者只能靠 `text` 字符串区分。

| 断言 | 位置 |
| --- | --- |
| 第 1 次错码文案含「验证码错误」 | `test-10-circuit-breaker.test.ts:93` |
| 第 3 次错码文案含「锁定」 | `test-10-circuit-breaker.test.ts:111`（本目录唯一的锁定人话断言） |
| `MfaChallenge.status='locked'` 且 `attempts`/`maxAttempts` 为 3 | `test-10-circuit-breaker.test.ts:105-107` |
| 熔断状态 `locked`/`failures`/`lockedAt` | `test-10-circuit-breaker.test.ts:123-127` |
| `CIRCUIT_BREAKER_TRIPPED` severity `high`、message 含「锁定」，`MFA_FAILURE` 恰 3 条 | `test-10-circuit-breaker.test.ts:140-151` |
| `authorizeAction` 返回 `ok:false`/`status:'locked'`/`message` 含「熔断」 | `test-10-circuit-breaker.test.ts:172-174` |
| 锁定后 `handleToolCall` 返回 `evaluation.blocked` + `decision.kind='deny'` + 无 `action` + 不新增 `PendingAction` | `test-10-circuit-breaker.test.ts:185-188` |
| 无码确认/验证的文案含「验证码」 | `test-03-transfer-mfa.test.ts:142`、`test-09-investment-mfa.test.ts:157` |
| 工具错误卡片文本（时间守卫拒绝理由） | `test-17-consumption-time-guard.test.ts:206-210`、`:241-242`、`:324-327` |

本目录没有任何断言涉及 `PendingAction.status='locked'`、`code:'CIRCUIT_OPEN'`、`security_event`（`kind` 或 `message`）、
`__SECURITY_BLOCK__` 原文、`chat.error.toolFailed`、`chat.error.securityLocked`；`it.each` 仅 `test-17:227` 一处。
`mock-integration.test.ts:98-105#expectHealthyTurn` 是唯一的「每轮无 `error` 事件且 assistant 文本非空」全局守卫，
只查非空与无错误，因此错误文案被换成通用兜底、或原始阻塞载荷出现在文本里，都不会被发现。
渲染层人话与 `__SECURITY_BLOCK__` 泄漏由 `../unit/planner/tool-feedback.test.ts` 与 `../e2e` 覆盖，不在此目录。

## 虚拟卡家族与消费入账时间

`test-16` 以一次会话走完「申请 → 消费到限额 → 挂失 → 补办 → 继续消费」的 MFA 闸门路径。
补办卡与原卡共用同一结算账户与同一月限额，已入账的 `CardConsumption` 仍归原卡。
限额跨家族连续：限额 100、补办前已花 30，则补办后仍可花 70，再花 71 被 `LIMIT_EXCEEDED` 拒绝且余额、流水、消费记录均不变。
绑定账户现金不足时报 `INSUFFICIENT_FUNDS`，不产生部分扣款。
月限额 0 拒绝任何消费；未设月限额时 `payableAmount` 等于账户可用现金。
重放同一执行身份只扣一次；同一身份换卡消费为 `CONFLICT`。
模型重新发起补办仍会再次进入 MFA 闸门，这是网关既定行为；幂等只对已授权的执行路径成立。

`test-17` 证明任何调用方时间字段（`occurredAt`、`bookedAt`、`timestamp`、`time`、`date`）都以「消费入账时间由服务端决定」被拒。
首拒层是工具注册表安装的 `prepareArguments` 参数校验，因此不会持久化 `PendingAction`、也不产生 `AuthorizationDecision`。
已持久化动作与计划节点的重放同样被拒；不带时间字段的对照计划可正常提交。
拒绝时不产生扣款、`channel='CARD'` 流水或 `CardConsumption` 记录。

## 已知问题

`test-18` case 3 只覆盖 `agent/system-prompt.ts` 渲染出的英文提示句与 `card_management_required` 中文指引；其他语言的目录条目不在此判定。
