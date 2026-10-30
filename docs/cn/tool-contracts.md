# 银行工具契约

[English](../en/tool-contracts.md) | **简体中文**

银行工具只接受明确参数，返回结构化事实或错误。
模型理解对话，安全网关决定是否可以办理。
工具结果不能用自然语言成功声明代替。

## 执行入口

工具名称和权限定义来自 [工具目录](../../lib/contracts/tool-catalog.ts)。
[注册表](../../agent/tools/index.ts)绑定服务器提供的用户身份。
模型不能提供用户身份、执行租约或幂等键。
卡片删除只在卡片管理页面，模型没有删除工具。
虚拟卡可由卡片页或智能体申请。
系统没有密码凭证，也没有密码修改工具。

每次模型调用依次经过以下检查：

1. 同一模型回复中的调用 ID 非空且不重复。
2. 原始参数符合公开 schema，无隐式类型转换。
3. 本轮声明允许提出该能力。
4. 网关检查所属用户、风险等级和授权状态。
5. 写入事务检查执行权，保存业务结果和回执。

不同模型回复可以复用调用 ID。
运行 ID、模型请求 ID 和调用 ID 共同标识调用。
工作流节点使用服务器生成的执行身份。

## 本轮声明与信息完整性

模型通过 `describe_turn` 声明用途、能力序列和 `needsInput`。
办理用途未提供 `needsInput` 时，服务端按 `true` 处理。
`true` 表示仍需补充办理对象、金额或其他必需选择。
该状态允许前置查询，但拒绝写工具和 `submit_plan`。
服务端保留澄清，不追加请求替用户选择卡片。

前置查询确定对象后，可继续声明原请求的完整写入序列。
写入序列绑定后，不能改变用途、序列或信息完整性。
`needsInput:false` 仅说明模型认为信息完整，不代表用户授权。
确认、验证码、所属用户和事务检查继续独立执行。
单次续写的触发与恢复规则见[持久化与恢复](agent-durability.md#声明写入的单次续写)。

## 参数与错误

缺少必填参数、未知字段和错误类型均报 `VALIDATION`。
金额参数是不含符号和指数的十进制文本，最多 2 位小数。
份额参数最多 6 位小数，净值参数最多 4 位小数。
除消费限额外的金额参数必须大于 0。
消费限额允许为 0。
原始参数在 Pi 类型转换前校验。
计划提交前校验所有节点，不先执行再补参数。

不存在或不属于当前用户的资源均报 `NOT_FOUND`。
选中资源必须使用真实业务 ID。
卡片工具共用 `cardId`、`cardType`、`cardTail` 和 `cardNumber` 选择器。
把尾号或完整卡号写进 `cardId` 会被拒绝，不会当作 id 查询。
选择器不能唯一解析时报 `VALIDATION` 并返回脱敏澄清。
搜索词用于返回候选，不能证明执行身份。
模糊联系人匹配报 `CONFLICT`，返回安全候选。

| 错误代码 | 模型后续处理 |
| --- | --- |
| `VALIDATION` | 修正参数或询问缺失信息。 |
| `NOT_FOUND` | 查询可用对象，请用户重新选择。 |
| `INSUFFICIENT_FUNDS` | 说明资金不足，不能自行更换账户或降低金额。 |
| `LIMIT_EXCEEDED` | 说明限额，不能拆单规避限制。 |
| `SECURITY_DENIED` | 说明能力或权限限制，不能绕过网关。 |
| `MFA_FAILED` | 使用现有验证界面，不能在聊天中索取凭证。 |
| `MFA_LOCKED` | 说明该操作已锁定，不再重试或重新验证。 |
| `CIRCUIT_OPEN` | 通过安全界面处理锁定。 |
| `MANUAL_REVIEW_HOLD` | 说明本次未执行，请用户从人工核对入口恢复或等待核对结束。 |
| `CONFLICT` | 先核对当前对象或已保存的办理状态。 |
| `TOOL_FAILED`、`INTERNAL` | 先核对执行记录，不能直接重提写入或宣称成功。 |

锁定拒绝的顶层 `code` 均为 `CIRCUIT_OPEN`。
本操作验证码用尽时，`failure.code` 报 `MFA_LOCKED`。
对应原因是 `mfa_attempts_exhausted`。
账户熔断在别处触发时，`failure.reason` 是 `circuit_open`。
再次提交已锁定操作时，`failure.reason` 是 `mfa_session_locked`。
人工接管拒绝的 `code` 是 `MANUAL_REVIEW_HOLD`。
其 `failure.reason` 是 `manual_review_hold`。
该拒绝只渲染 `chat.error.manualReviewHold`。
该拒绝表示本次未执行，需从人工核对恢复或等待核对结束。
结构化失败字段与文案归属见[权限、认证与审计](security.md)。
内部标记由 [`isInternalDiagnostic`](../../lib/internal-text.ts) 识别。
公开文本只经[对外文案收口](../../lib/public-text.ts)输出。
错误代码来自业务契约，不从错误文字中提取。
内部 SQL、文件路径和原始基础设施异常不交给模型。
模型的下一步提示不授予重试权限。
自动恢复仍需核对回执、执行权和重试预算。

## 查询工具

查询得到空集合是成功，不等于工具失败。
错误筛选条件不能被忽略后扩大查询范围。

| 工具 | 输入边界与结果含义 |
| --- | --- |
| `get_balance` | 返回所属用户的存款账户及查询余额；账号脱敏。 |
| `get_transactions` | 时间戳为整数，范围采用 `[from, to)`；要求 `from < to`。`category` 取精确消费分类。默认返回最近 50 条，最多 200 条。收入与支出合计只覆盖返回记录。 |
| `search_contact` | 查询文字必须为合法文本；返回候选联系人及业务 ID。 |
| `search_conversation_history` | 查询当前会话的原始文字；`query` 长 1 至 256 字，`limit` 取 1 至 20，`beforeIndex` 不小于 0。缺少可信会话身份报 `SECURITY_DENIED`。历史文字不代表当前授权。 |
| `analyze_spending` | `month` 采用合法 `YYYY-MM`，缺省为当前银行业务月份；返回完整月份的消费统计。 |
| `detect_anomaly` | 返回筛查标记及对应交易，不能证明盗刷或退款资格。 |
| `get_cards` | 返回所属用户的卡片、状态、分类限额和月限额；卡号一律脱敏。关联状态与可用余额的字段口径见[卡片管理](card-management.md)。 |
| `list_subscriptions` | 黄色查询，确认后返回生效订阅；查询确认不能代替取消确认。 |
| `list_investments` | 风险等级只接受 `R1` 至 `R5`；未匹配产品返回空集合。 |
| `compare_investments` | 产品集合不能为空；任一 ID 不存在则报错，不只比较剩余项。重复 ID 去重。 |
| `get_investment_holdings` | 返回所属用户的持仓；份额保留 6 位小数，净值保留 4 位小数。剩余成本单列，市值按份额 × 最新净值推导且不取整。持仓另含净值日期、收益、累计收益、最近申购时间和购买记录；份额或净值缺失时保留有效历史估值并标“待核对”；没有历史估值才回退成本。 |
| `get_dashboard_summary` | 返回资产、消费和交易快照；信用卡可用额度不计入存款资产。 |
| `list_scheduled_tasks` | 返回所属用户的任务状态和计划参数；内部派发诊断不进入模型数据。 |

月份使用银行业务时区。
金融日历保留实际年份，不将 0 至 99 年映射为 1900 至 1999 年。
跨页或受条数限制的查询不能冒充完整月度统计。

## 写入工具

| 工具 | 授权与执行边界 |
| --- | --- |
| `transfer_money` | 按金额和日累计决定黄色或红色：两项都不超过 1000 元为黄色，超出即红色。`amount` 必填，收款人用 `contactId`、`phone` 或 `name` 之一指定，付款账户可给 `sourceAccountId`。余额不足、额度不足、错误账户和无效金额报错。 |
| `set_card_limit` | 黄色；必填 `category` 和 `amount`。分类来自正式目录，只处理正常或已冻结卡片。同一卡片同一分类只保留一条限额。挂失卡报冲突。 |
| `freeze_card`、`unfreeze_card` | 红色；事务内重读状态。相同状态可幂等返回，冲突状态不能被旧快照覆盖。 |
| `report_lost_card` | 红色；校验所属用户、当前状态和挂失原因。挂失是终态，重复挂失报 `CONFLICT`。 |
| `apply_virtual_card` | 红色；申请虚拟卡，可选设置月限额。月限额为分精度，不得为负。同一执行键重放返回原卡片。 |
| `consume_virtual_card` | 红色；从虚拟卡绑定的活期账户扣款，入账时刻由服务端业务时钟决定。不接受调用方 `occurredAt`、`bookedAt` 等时间字段，出现即报 `VALIDATION` 且不扣款。可花金额是账户可用现金与剩余月限额的较小值，月限额按补办前后各卡合并。卡非正常状态、关联状态为 `MISSING` 或 `UNTRUSTED` 时报 `CONFLICT`。超月限额报 `LIMIT_EXCEEDED`，余额不足报 `INSUFFICIENT_FUNDS`。同一执行键重放返回原消费记录。 |
| `replace_card` | 红色；只补办已挂失卡片，原卡保持 `LOST`。其他状态报 `CONFLICT`。 |
| `cancel_subscription` | 黄色；按 `subscriptionId` 取消，取消后关闭提醒，相同已取消状态可幂等返回。 |
| `set_subscription_reminder` | 黄色；按 `subscriptionId` 设置布尔 `remind`，已取消的订阅不能修改提醒。 |
| `reserve_budget` | 绿色；必填 `name` 和 `amount`，可选 `purpose` 与 `dueDate`。只创建记账预算，不冻结、扣减或转移账户资金。 |
| `create_scheduled_task` | 黄色；必填 `name` 与 `kind`，`kind` 取 `REMINDER`、`PAYMENT` 或 `TRANSFER`。时间用整数 `runAt` 或本地时间 `runAtLocal`，如 `2026-10-15T09:00`。提醒载荷只含文本，付款载荷必须有唯一收款选择及正数金额。 |
| `subscribe_investment` | 红色；校验产品、起投金额、付款账户及余额。服务端按最新净值把申购金额折算为份额，向下取整到 6 位小数。已持有该产品时并入原持仓：剩余成本增加本次金额，份额增加折算所得份额。产品未发布净值或低于起投金额报 `VALIDATION`，余额不足报 `INSUFFICIENT_FUNDS`，持仓缺少可用份额报 `CONFLICT`。 |
| `redeem_investment` | 红色；必须显式给出 `mode`，取值为 `SHARES`、`AMOUNT` 或 `ALL`，没有默认口径。`SHARES` 需给 `shares`，`AMOUNT` 需给 `amount`，`ALL` 不接受份额或金额。缺失、未知、混用口径或出现 `redeemAmount` 均按澄清报 `VALIDATION`。确认快照与最新持仓或净值不一致时以 `CONFLICT` 失败且零写入；同一身份重放仍返回原回执。 |

投资申赎的公开结果包含操作后余额。
申购返回 `subscribedShares`、`totalShares` 和 `lastPurchaseAt`。
追加申购另含 `addedToExisting`，表示已并入原持仓。
赎回返回 `mode`、`redeemedShares` 和成交净值 `netValuePerUnit`、`netValueDate`。
赎回另含 `redemptionValuation` 与 `settlementRounding`。
`partial` 为 `true` 时，结果另含 `remainingShares`、`remainingCost`、`remainingMarketValue` 和 `remainingProfit`。
`realizedProfit` 是到账金额减去本次消耗的成本，可以为负。
`redeemedPrincipal` 是本次赎回消耗的成本，不是赎回本金。
`remainingPrincipal` 与剩余成本 `remainingCost` 同值。
`feeAmount` 恒为 `0.00`，`feeRule` 恒为 `SIMULATED_NONE`。
精度与费用口径见[理财净值与份额](investments.md)。
投资写入完成后，结果附带提交后重读的持仓投影 `holdings`。
重读不可用时省略该字段，不回滚已提交的写入。

写入的幂等键只来自服务器执行选项。
同一键必须匹配同一用户、工具和参数摘要。
已有回执先返回原结果，不能再次修改资金。
状态相同不代表不同命令可以共用回执。

定时提醒的到期投递无需银行办理确认。
定时付款和转账在到期时仍需确认或强验证。
`requiresConfirmation` 由服务器生成，模型不能设置。
创建定时任务不能提前批准未来的付款。

`submit_plan` 先校验任务图，再登记全部节点。
依赖、条件、输出引用和声明的写入序列必须一致。
节点 ID 必须是单个路径段，不含点、括号、空白或控制字符。
`__proto__`、`constructor` 和 `toString` 可作为普通节点名称引用。
执行结果表使用无原型对象，不通过原型属性读取结果。
每个敏感节点分别授权，前一个节点的确认不能授权后一个节点。
计划失败仍保留已经成功的节点结果。
计划不是跨业务的全局原子事务。

## 模型与界面的保存信息

Pi 将 `content` 发给模型。
`details` 和 `structuredContent` 供界面及程序使用。
只把数据放入 `details` 会使模型看不到完整业务事实。

[结果适配器](../../agent/tools/result.ts)统一生成工具结果：

- 成功内容含摘要和 `{ ok: true, data }` 两段文本。
- 失败使用 Pi 原生 `isError: true`。
- 失败内容含 `bankingError`，其中有 `code`、`message` 和 `nextAction`。
- `bankingError.retryable` 恒为 `false`。
- 失败计划保留节点结果，不能显示为整项成功。
- 业务 ID、金融数值和归档原文保持完整。
- 用户内部身份、执行键、租约及派发诊断不发给模型。
- 手机号和凭证在模型数据中脱敏。

界面使用独立的卡片投影，只展示真实业务结果。
开发者模式可以查看调用参数和执行记录。
确认后的查询也使用同一个模型结果适配器。
模型能承接原问题，并读取完成查询中的对象 ID。

日志保存完整工具内容、结构化结果及可用的耗时和用量。
恢复不能只重建第一段摘要。
未完成参数片段可以含凭证，因此片段只保留脱敏事件。
完成后的调用参数仍按字段保存和脱敏。
恢复规则见[持久化与恢复](agent-durability.md)。

## 代码与验证入口

- [工具参数校验](../../agent/tools/plan-parameters.ts)。
- [模型结果契约测试](../../tests/unit/planner/model-tool-result.test.ts)。
- [写入边界测试](../../tests/integration/write-domain-boundaries.test.ts)。
- [重复调用身份测试](../../tests/integration/tool-call-identity-boundary.test.ts)。
- [工具模块维护说明](../../agent/tools/CONTEXT.md)。
