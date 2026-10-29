# 测试与验收

测试分为离线回归、浏览器验收和真实模型验收。
每次验收都记录模型来源和实际执行范围。
测试数量以当次命令输出为准。

双卡冻结验收检查独立认证、操作记录和历史计划位置。
错误验证码不能冻结卡片，首张卡片验证不能授权后续卡片。
浏览器分别检查刷新和后续对话，不以接口成功代替页面验证。
联系人验收包含并发重复提交、所属用户隔离和审计回滚。
安全中心验收检查开发者开关、解锁条件和原操作终态。
卡片页验收检查页面增删、独立验证和刷新恢复。
新实体卡和删除卡片请求只返回页面操作说明。
虚拟卡申请与挂失卡补办仍可通过 Agent 授权办理。
人工核对验收先检查普通模式拒绝，再演示后台处理。

运行环境见[开发指南](development.md)。
恢复规则见[持久化与恢复](agent-durability.md)。
业务限制见[当前限制](known-risks.md)。
名称含义见[术语表](terms.md)。

## 常用命令

账单报告的专项命令与独立测试库见[账单报告回归测试](bill-reports.md#回归测试)。

在项目根目录执行以下命令。

```sh
pnpm test
pnpm test tests/unit
pnpm test tests/scenarios
pnpm test tests/app tests/integration
pnpm test agent/durable tests/integration/process-restart.test.ts
pnpm typecheck
pnpm lint
pnpm exec tsx tests/e2e/acceptance.e2e.ts
```

`pnpm test` 使用 [Vitest 配置](../../vitest.config.ts)。
配置只收集 `tests/`、`agent/`、`security/`、`planner/` 下的 `*.test.ts` 和 `*.spec.ts`。
`*.e2e.ts` 与 `*.e2e-helper.ts` 不匹配该模式，因此浏览器与边界入口一律单独运行。
配置把 `testTimeout` 固定为 20 秒，并设置 `fileParallelism: false`。
对话驱动的用例从 [测试预算](../../tests/helpers/timeouts.ts) 取显式每测试预算。
驱动真实 `POST /api/chat` 轮次的用例传入 `CHAT_DRIVEN_TEST_TIMEOUT_MS`。
冷库自建的用例传入 `COLD_DB_PROVISION_TEST_TIMEOUT_MS`。
两者都作为 `it(...)` 的第三个参数传入。
不得改写成裸数字，也不得在用例文件内复制这两个常量。

生产构建单独执行 `pnpm build`。
构建前先生成符合当前 schema 的 Prisma Client。
页面按请求读取语言和业务数据，构建时不查询数据库。
Prisma 命令在离线环境运行，并设置三个变量。
三个变量是 `CHECKPOINT_DISABLE=1`、`PRISMA_HIDE_UPDATE_MESSAGE=1` 和 `CI=1`。
缺少时 `pnpm db:generate` 可能停在更新检查上。
需要留存的命令输出和文件日志写入 `logs/`。
仓库根目录不放 `.log` 文件。
准备步骤见[开发指南](development.md)。

## 语言切换验收

浏览器验收包含中文默认值和中英文切换。
即使浏览器首选英文，首次访问仍显示中文。
桌面侧边栏和移动端顶部均可切换语言。
刷新页面后保留选择，服务端业务页使用同一语言。
切换过程中核对草稿、消息标识和交易记录。
切换语言不得新增银行业务提交。
用例见 [i18n.e2e-helper.ts](../../tests/e2e/i18n.e2e-helper.ts)。

## 共享对话与展示验收

不同浏览器直接进入同一演示用户和会话。
问候、金额更正、模糊卡片需求和聊天确认需返回不同提示。
后续余额查询仍需得到真实工具结果。
这些对话不能因旧意图创建写操作或工作流。
模型输入与模型结果检查点恢复也需遵守同一规则。

用户文本按原文显示，助手正文使用 Markdown。
工具卡片展示实际调用、状态和结果摘要。
精确金额不能因格式渲染而改变。
用例见 [shared-demo.e2e-helper.ts](../../tests/e2e/shared-demo.e2e-helper.ts)。
真实模型验收可用 `LIVE_SCENARIOS=0` 选择这一组用例。

订阅查询还需验证完整授权过程。
确认后，原调用应显示完成，不再显示执行中。
后续问候和余额查询不得闪出上一轮调用。
刷新页面后，已完成状态仍需保留。
用例见 [tool-lifecycle.e2e-helper.ts](../../tests/e2e/tool-lifecycle.e2e-helper.ts)。
真实模型验收用 `LIVE_SCENARIOS=8` 选择这组用例。

普通交流需独立验证，不能只测试工具是否执行。
资金来源解释、闲聊和定时任务能力咨询应返回自然回答。
这些问题不能生成授权、计划或继续旧转账草稿。
刷新后保留原回答，后续明确转账仍需确认。
用例见 [正常交流验收](../../tests/e2e/conversation.e2e-helper.ts)。
离线验收用 `E2E_JOURNEYS=natural-conversation-and-financial-boundary`。
真实模型验收用 `LIVE_SCENARIOS=11`。

负数金额、历史回顾和继续分析使用同一个浏览器流程。
输入 `转给张伟-10元` 后，不查询联系人或生成授权。
后续追问和刷新后仍能回顾原句中的负号。
订阅查询完成后，继续分析需保留价格、建议和自然文字。
分析不取消订阅，也不生成新的确认入口。
离线验收用 `E2E_JOURNEYS=signed-amount-memory-and-subscription-analysis`。
真实模型验收用 `LIVE_SCENARIOS=12`。

## 历史分页与上下文压缩验收

聊天页首次只显示最近 20 条完整消息。
加载旧页时，检查消息顺序、去重和阅读位置。
单条长回复不能裁剪，输入草稿不能因分页丢失。
新回复到达时，离开底部的读者可选择查看新消息。
清空后，迟到的旧分页响应不能进入新对话。
用例见 [历史分页验收](../../tests/e2e/chat-history.e2e-helper.ts)。
离线验收用 `E2E_JOURNEYS=chat-history-pagination-and-scroll`。

压缩验收分别检查原始归档和实际模型请求。
原始负号、完整长消息和助手回复需继续保留。
实际模型请求需使用摘要和近期完整轮次。
摘要生成中断后，恢复原请求，不重复用户消息。
普通模型请求中断后，重发原压缩视图。
已经完成的摘要不能因新阈值而重新生成。
确认旧操作时，后续聊天和工具结果需完整保留。
重复工具调用标识按原模型请求归属更新。
用例见 [压缩恢复测试](../../tests/integration/conversation-compaction.test.ts)。
真实模型验收用 `LIVE_SCENARIOS=13`。
该场景将隔离服务的压缩阈值设为 `16000` token。
场景使用合成历史，检查真实摘要和负数金额回忆。
说明见 [上下文压缩](context-compaction.md)。

## 开发者模式验收

开发者模式默认为停用。
普通导航显示操作记录，隐藏运行记录和操作审计。
刷新页面和“刷新对话”都保留已有消息。
取消清空弹窗不能修改对话。
确认清空后，所有浏览器读取新的对话上下文。
账本和运行证据必须保留，待处理操作必须阻止清空。
桌面和手机均需验证开关、确认弹窗和清空结果。
用例见 [developer-mode.e2e-helper.ts](../../tests/e2e/developer-mode.e2e-helper.ts)。
可用 `E2E_JOURNEYS=developer-mode-conversation-controls` 单独验收。

## 操作记录与操作审计验收

普通用户能查看业务名称、时间、状态和验证结果。
普通页面与接口均不显示原工具名称、参数和结果。
查询工具和任务计划事件不能挤掉分页内的业务记录。
客户端身份参数不能选择其他用户或会话。
结果不明时显示待核对，历史记录不提供执行按钮。

停用开发者模式时，直接访问操作审计页不能读取技术数据。
`GET /api/audit` 在解析筛选参数前返回 HTTP 403。
启用模式后，页面显示原审计详情。
停用模式后，导航和技术页面恢复普通模式。

接口用例见 [activity-http.test.ts](../../tests/app/activity-http.test.ts)。
投影用例见 [operation-history.test.ts](../../tests/unit/audit/operation-history.test.ts)。
浏览器用例见 [activity.e2e-helper.ts](../../tests/e2e/activity.e2e-helper.ts)。
可用 `E2E_JOURNEYS=operation-history-and-developer-audit` 单独验收。

## 数据隔离与执行顺序

各测试入口使用独立数据库。

| 测试入口 | 数据库 | 模型来源 |
| --- | --- | --- |
| Vitest | `prisma/test.db` | 离线模拟或受控响应 |
| 离线浏览器验收 | `prisma/e2e.db` | 离线模拟 |
| 真实模型浏览器验收 | `prisma/live-acceptance.db` | DeepSeek |
| HTTP 边界验收 | `prisma/live-acceptance-date-tamper.db` | 离线模拟 |
| 微信通道验收 | `prisma/weixin-live-<runId>.db` | DeepSeek |

测试入口在导入应用代码前设置 `DATABASE_URL`。
测试入口生成 Prisma Client，并创建当前 schema。
使用数据库的测试自行创建种子数据。
配置中的 `LLM_MODE=mock` 使 Vitest 默认离线运行。

警告：测试入口会重建表内的隔离数据。
需要保留验收数据时，先保存数据库副本。
不得通过重置 `prisma/dev.db` 处理测试失败。

注意：全部 Vitest 文件共享同一个可重置的 `prisma/test.db`。
配置以 `fileParallelism: false` 让文件顺序执行。
不得同时运行两个会重置同一测试库的进程。
两个 `pnpm test` 会相互重置测试库，产生假失败。
浏览器入口使用表中独立数据库，不能同时运行重置同一库的入口。
开发、浏览器开发验收和生产验收分别使用 `.next`、`.next-e2e` 和 `.next-build`。
构建期间不能运行使用同一输出目录的服务。

数据库初始化失败时，查看初始化诊断。
先检查 Prisma Client、schema 和隔离库路径。
测试环境固定 schema engine 的日志级别。
初始化失败会保留 Prisma 命令输出。
代码见[测试初始化](../../tests/setup.ts)。

## 测试层次

| 目录或文件 | 检查内容 |
| --- | --- |
| `tests/unit/` | 金融值、银行事务、权限、计划和界面契约 |
| `agent/**/*.test.ts` | 持久化运行、模型传输和可信金融回复 |
| `security/**/*.test.ts` | MFA 拒绝原因与已消费挑战的判定 |
| `planner/**/*.test.ts` | 计划驱动守卫与计划失败契约 |
| `tests/scenarios/` | 受控模型驱动的银行智能体场景 |
| `tests/app/` | 实际路由处理器、固定演示身份和操作控制 |
| `tests/integration/` | 跨模块执行、持久化、恢复和并发约束 |
| `tests/deploy-db-push.test.ts` | 当前 schema 建库、显式重置和目录边界 |
| `tests/helpers/` | 隔离库、夹具、脚本模型与进程恢复探针 |
| `tests/fixtures/` | 共享的 `*.zh-CN.json` 对话与策略剧本 |
| `tests/e2e/` | 运行中应用的浏览器操作与 HTTP 边界用例 |

`tests/e2e/` 的主要入口包括 `acceptance.e2e.ts`、`live-acceptance.e2e.ts`、`date-tamper-boundary.e2e.ts` 和 `weixin-live.e2e.ts`。
`*.e2e-helper.ts` 与 `helpers.ts` 是入口共用的驱动与断言模块，自身不运行。

路由测试直接调用实际处理器。
路由测试不检查浏览器渲染和网络传输。
浏览器验收以渲染后的页面为主要证据。
只读接口和数据库用于核对资金事实。

## 核心场景

核心场景文件位于 [tests/scenarios](../../tests/scenarios)。

| 场景 | 测试文件 | 预期行为 |
| --- | --- | --- |
| 余额查询 | `test-01-balance.test.ts` | 绿色查询返回银行 SDK 的事实 |
| 小额转账 | `test-02-transfer-confirm.test.ts` | 确认后扣款，余额与流水一致 |
| 大额转账 | `test-03-transfer-mfa.test.ts` | 红色权限要求多因子认证（MFA）；错码不扣款 |
| 提示词注入 | `test-04-prompt-injection.test.ts` | 用户输入不能绕过权限和验证码 |
| 执行失败 | `test-05-failure-report.test.ts` | 回复保留失败事实，不虚构成功 |
| 消费分析 | `test-06-spending-analysis.test.ts` | 分类金额来自已入账流水 |
| 异常检测 | `test-07-anomaly.test.ts` | 异常结果来自交易数据 |
| 卡片限额 | `test-08-card-limit.test.ts` | 用户确认后修改限额 |
| 理财操作 | `test-09-investment-mfa.test.ts` | 申购经过红色权限和 MFA |
| 熔断锁定 | `test-10-circuit-breaker.test.ts` | 连续错码锁定执行，并保存审计 |
| 条件计划 | `test-11-conditional-dag.test.ts` | 依赖和条件控制后续节点 |
| 生日计划 | `test-12-birthday-plan.test.ts` | 预算和计划记录不代表实际资金冻结 |
| 补办挂失卡 | `test-13-card-replace.test.ts` | 红色权限确认后生成新卡，原卡保持 `LOST` |
| 申请虚拟卡 | `test-14-virtual-card.test.ts` | 通过 MFA 后发行绑定活期账户的虚拟卡 |
| 授信额度守卫 | `test-15-card-limit-guard.test.ts` | 智能体只能改月限额，不能改授信额度 |
| 虚拟卡生命周期 | `test-16-virtual-card-lifecycle.test.ts` | 申请、消费、挂失、补办共用同一月度额度；重放只扣一次 |
| 入账时间守卫 | `test-17-consumption-time-guard.test.ts` | 客户端时间参数在任何写入前被拒，扣款为零 |
| 卡片能力咨询 | `test-18-card-capability-consultation.test.ts` | 咨询与歧义只产生文字或澄清，不改动卡片 |
| 信用卡补办 | `test-19-card-replace-credit-runtime.test.ts` | 生产运行时 MFA 后只生成 1 张 `CREDIT` 卡，原卡保持 `LOST` |
| 卡片选择器消费 | `card-selector-consumption.test.ts` | 类型和尾号解析为 `cardId`；完整卡号在 park 前被拒 |

`mock-integration.test.ts` 检查完整离线处理流程。
离线测试不需要 API Key。

## 模型适配器回归

适配器测试使用受控请求与测试密钥。
测试检查请求格式，不证明真实模型可用。

| 测试入口 | 检查内容 |
| --- | --- |
| [运行时适配](../../tests/unit/agent/providers/provider-runtime.test.ts) | 原生服务商与 `model`、`streamFn` 配对 |
| [在线适配](../../tests/unit/agent/providers/provider-live.test.ts) | 自定义服务商地址、鉴权和注册模型 |
| [模拟适配](../../tests/unit/agent/providers/provider-mock.test.ts) | 独立脚本模型，不联网 |
| [消息配对](../../tests/unit/agent/message-normalize.test.ts) | 授权结果对应原工具调用 |

## 金融与授权回归

金融回归同时检查输入、计算、入账和执行回执。

| 检查对象 | 必须保持的结果 | 测试入口 |
| --- | --- | --- |
| 金额输入 | JSON 金融值使用十进制字符串；入账金额拒绝分以下小数 | [金融值](../../tests/unit/financial-values.test.ts) |
| 金融计算 | 入账金额使用整数分；利率和未结算估值保留 Decimal 精度 | [投资精度](../../tests/unit/banking-sdk/investment-precision.test.ts) |
| 赎回结算 | 按 HALF_UP 规则结算 1 次；报价变化要求重新授权 | [投资流程](../../tests/unit/banking-sdk/investment-flow.test.ts) |
| 重复转账 | 重复或并发确认只产生 1 笔扣款 | [转账重放](../../tests/integration/transfer-replay.test.ts) |
| 写入事务 | 业务、流水、执行回执和必需审计一起提交或回滚 | [执行审计](../../tests/integration/execution-audit.test.ts) |
| 执行回执 | 回执匹配用户、原请求和账本；身份复用但参数变化时拒绝 | [转账回执](../../tests/integration/transfer-receipts.test.ts) |
| 提交校验 | 先提交的取消阻止后续写入；先提交的交易保留事实 | [事务提交校验](../../tests/integration/sdk-transaction-fences.test.ts) |
| 授权摘要 | 累计转账升级红色权限后，摘要和验证入口一致 | [授权与澄清](../../tests/integration/decision-guidance.test.ts) |
| 卡片与持仓 | 保存月限额，拒绝歧义持仓，保留原赎回报价 | [卡片与持仓回归](../../tests/integration/frontend-followup-fixes.test.ts) |

`annualYieldRate` 是无量纲比例。
仅展示时转换为百分数。
入账金额还受有符号 64 位整数范围限制。

## 核心契约回归

净值、赎回口径、锁定、解析和消费各有专门用例。

| 契约 | 必须保持的结果 | 测试入口 |
| --- | --- | --- |
| 净值与份额 | 净值 4 位、份额 6 位，市值不取整，结算按 `HALF_UP` 舍入 1 次 | [净值模型](../../tests/unit/banking-sdk/net-value.test.ts)、[赎回模型](../../tests/unit/banking-sdk/net-value-redemption.test.ts) |
| 赎回口径 | `SHARES`、`AMOUNT`、`ALL` 各自结算；缺失、混用或 `redeemAmount` 在写入前澄清 | [口径拒绝](../../tests/unit/security/redemption-stale-authorization.test.ts)、[工具参数](../../agent/tools/redeem-investment.test.ts) |
| 确认快照 | 净值、份额或净值日期变动时返回 `CONFLICT`，资金、份额与流水都不动 | [陈旧授权](../../tests/unit/security/redemption-stale-authorization.test.ts) |
| 写入后投影 | 申购和赎回卡片显示提交后重读的持仓，不是写入前快照 | [持仓投影](../../agent/tools/redeem-investment.test.ts) |
| MFA 终态 | 用尽次数后动作置为 `locked`，正确验证码也不重开 | [终态锁定](../../tests/app/mfa-terminal-lock-http.test.ts)、[接口契约](../../tests/app/mfa-lock-http-contract.test.ts) |
| 锁定恢复 | 终态锁定不被恢复、重试或取消复活 | [锁定恢复](../../tests/integration/locked-action-recovery.test.ts) |
| 所有者熔断 | 熔断按 `user:<userId>` 生效，原因取自本操作的尝试记录 | [原因判定](../../security/mfa-lock-reason-authority.test.ts)、[持久化](../../tests/unit/security/circuit-breaker-persistence.test.ts) |
| 对外文案 | 结构化 `SecurityFailure` 决定文本，内部标记不进入公开文本 | [锁定文案](../../tests/unit/lib/public-text.locked.test.ts)、[内部诊断](../../tests/unit/lib/public-text.test.ts) |
| 号码身份 | 只有完整号码相等才确定对象，掩码只收窄候选 | [号码身份](../../tests/unit/lib/phone-identity.test.ts)、[收款人解析](../../tests/unit/security/recipient-resolution.test.ts) |
| 卡片身份 | 完整卡号精确命中，中间四位不同即未找到，共享尾号按歧义澄清 | [卡片解析](../../tests/unit/security/card-resolution.test.ts)、[选择器网关](../../tests/unit/security/card-selector-gateway.test.ts) |
| 虚拟卡消费 | 扣款、流水与 `CardConsumption` 同一事务；月限额按补办家族合并 | [消费事务](../../tests/integration/card-consume-transaction.test.ts)、[消费接口](../../tests/app/card-consume-http.test.ts) |
| 消费时刻 | 入账时刻由服务端 `demoNow()` 决定，客户端时间参数被拒 | [时刻权威](../../tests/unit/banking-sdk/card-consumption-time-authority.test.ts)、[时间守卫](../../tests/scenarios/test-17-consumption-time-guard.test.ts) |
| 消费重放 | 同一执行键只扣 1 次并返回原结果 | [生命周期](../../tests/scenarios/test-16-virtual-card-lifecycle.test.ts)、[消费接口](../../tests/app/card-consume-http.test.ts) |

净值与份额口径见[理财净值](investments.md)。
锁定与熔断的判定顺序见[安全](security.md)。
消费时刻和限额口径见[卡片管理](card-management.md)。

## 安全修复回归

修改安全机制时，按下表运行受影响的回归。
用例检查真实待确认操作、资金、终态和执行回执。

| 检查对象 | 必须保持的结果 | 测试入口 |
| --- | --- | --- |
| 办理状态与澄清 | 虚构提交不公开；缺少卡片时不猜测；纠错保留问题 | [声明与澄清](../../tests/integration/financial-claim-and-clarification.test.ts)、[回复检查](../../agent/reply-safety.test.ts) |
| 已取消状态 | 当前用户和会话的终态替换请求视图中的旧等待状态，不改归档 | [当前状态](../../tests/integration/workflow-context.test.ts) |
| 余额和持仓说明 | 使用真实余额与产品名称，内部持仓 ID 不进入公开摘要 | [财务依据](../../agent/grounding-integration.test.ts)、[持仓事实](../../agent/tools/redeem-investment.test.ts) |
| 模型调用预算 | 重试和恢复共用预留量；超时停止输出 | [总预算](../../agent/model-budget.test.ts) |
| 纠错声明 | 兼容模式只要求 `describe_turn`，不强制金融调用 | [声明约束](../../agent/providers/required-declaration.test.ts) |
| Host 与同源 | 未知域名访问页面和 API 均被拒绝，合法本机请求保留 | [共享边界](../../tests/unit/security/http-write-boundary.test.ts)、[Proxy](../../tests/app/request-host-proxy.test.ts) |
| 请求大小 | JSON 正文和聊天文本超限时拒绝，包含流式正文 | [消息长度](../../tests/app/chat-request-size.test.ts) |
| 页面消费 | 首次提案不扣款；原参数绑定验证码、账户锁和原回执 | [消费授权](../../tests/app/card-consumption-security.test.ts) |
| 分类限额与补办 | 跨次消费按月累计，补办继承限额，重放不覆盖新限额 | [分类限额](../../tests/unit/banking-sdk/card-category-limit.test.ts)、[补办重放](../../tests/integration/replace-card-replay.test.ts) |
| 跨进程竞争 | 相同执行键只扣款一次；余额和分类限额不被并发突破 | [多进程事务](../../tests/integration/sdk-multiprocess-transaction.test.ts) |
| 特殊计划节点 | 特殊名称可引用，路径分隔和控制字符被拒绝 | [节点校验](../../tests/unit/planner/dag.test.ts)、[条件执行](../../tests/unit/planner/executor.test.ts) |

例如，只运行预算和声明修复的离线回归：

```sh
pnpm exec vitest run agent/model-budget.test.ts agent/providers/required-declaration.test.ts tests/integration/financial-claim-and-clarification.test.ts
```

历史执行结果见[安全修复验证](../../tests/e2e/LIVE-ACCEPTANCE-REPORT.md#安全修复验证)。
测试数量以当次命令输出为准。

## 持久化与进程恢复回归

恢复测试检查原身份和原资金事实。
完成状态本身不能替代金融回执。

| 检查对象 | 预期行为 | 测试入口 |
| --- | --- | --- |
| Pi 事件 | 生命周期和流式事件按运行序号持久化 | [持久化集成](../../tests/integration/agent-durability.test.ts) |
| 模型检查点 | 保留原请求、次数上限和退避时间；拒绝过时 revision | [模型检查点](../../tests/integration/model-checkpoint-boundaries.test.ts) |
| 模型生成中断 | 从原请求重新生成；不执行半截工具调用 | [进程重启](../../tests/integration/process-restart.test.ts) |
| 完整模型决策 | 执行原调用标识和参数，不重建原决策 | [进程重启](../../tests/integration/process-restart.test.ts) |
| 已提交写入 | 核对原回执后恢复原结果，不重复业务和审计 | [已提交结果](../../tests/integration/committed-outcomes.test.ts) |
| 等待授权 | 保留原确认或 MFA，不替用户授权 | [恢复授权](../../tests/integration/recovery-authorization.test.ts) |
| 工作流子调用 | 保存父调用、节点和执行键；显式重试仍需授权 | [工作流调用](../../tests/integration/workflow-invocations.test.ts) |
| 原图恢复 | 复用原图和已完成节点；保留暂停、取消和人工核对状态 | [独立工作流重启](../../tests/integration/standalone-workflow-restart.test.ts) |
| 失效执行者 | 失去执行租约后，不能提交资金或覆盖结果 | [旧执行者](../../tests/integration/obsolete-executor.test.ts) |
| 恢复 worker | 限制批次数量，隔离单运行失败，退出时等待当前执行完成 | [恢复 worker](../../tests/unit/agent/recovery-worker.test.ts) |

`process-restart.test.ts` 使用真实子进程。
测试在指定执行点发送 `SIGKILL`。
新子进程从数据库恢复原运行。
测试提前设置租约到期，省去到期等待时间。
模型传输受控；Pi、权限和银行事务使用项目代码。

浏览器故障夹具只构造持久化故障状态。
浏览器故障夹具不证明页面触发了真实进程崩溃。

## 计划、回复与界面回归

多步需求必须先保存覆盖全部显式步骤的计划。
计划采用有向无环图（DAG）表示依赖关系。
预检拒绝漏步、重复、对象替换和金额错配。
执行时再次检查本人资源、权限和报价。

| 检查对象 | 预期行为 | 测试入口 |
| --- | --- | --- |
| 完整计划 | 不完整计划不能先创建预算、授权或转账 | [多步计划](../../tests/integration/live-complete-plan.test.ts) |
| 否定与持仓 | 附加否定保留正向步骤；赎回绑定实际本人持仓 | [请求范围与持仓](../../tests/integration/request-scope-holdings.test.ts) |
| 暂停与取消 | 暂停阻止后续节点；取消撤销待处理授权 | [任务控制](../../tests/integration/task-feature-hardening.test.ts) |
| 金融回复 | 只使用服务端业务事实；未知结果不变成成功或失败 | [回复边界](../../tests/integration/financial-response-boundary.test.ts) |
| 实体与页面 | 资源歧义拒绝；异常详情绑定所选流水 | [前端回归](../../tests/integration/frontend-review-fixes.test.ts) |
| 澄清 | 保留已提供产品；拒绝模型伪造状态和金额 | [授权与澄清](../../tests/integration/decision-guidance.test.ts) |
| 模型请求 | 截止时间覆盖停滞流；传输重试有上限；用户取消不重试 | [请求限制](../../agent/providers/request-options.test.ts) |
| 规划重试 | 未执行业务时保留重试入口；新消息使旧入口失效 | [规划恢复](../../tests/integration/live-recovery.test.ts)、[重试界面](../../tests/integration/live-retry-ui.test.ts) |

计划预检不保证整张图原子成功。
后续节点失败不会撤销已入账交易。
人工核对测试见[人工核对 HTTP 测试](../../tests/app/manual-review-http.test.ts)。
调度测试见[定时派发 HTTP 测试](../../tests/app/scheduled-dispatch-http.test.ts)。
操作说明见[人工核对](manual-review.md)和[定时任务](scheduled-tasks.md)。

## 浏览器验收

离线浏览器入口使用系统 Chrome。
找不到 Chrome 时尝试 Edge。
`E2E_BROWSER_PATH` 可指定浏览器可执行文件。
入口选择空闲端口，并启动实际 Next.js 开发服务。
验收结束时关闭浏览器和服务进程树。

当前离线入口在 `JOURNEYS` 中注册 23 条流程。
`E2E_JOURNEYS` 按名称选择子集，未设置时执行全部流程。
下表列出其中 11 条资金与权限主流程。
其余流程见上文各小节。

| 流程标识 | 主要证据 |
| --- | --- |
| `workspace-http-and-mobile` | 首页、请求标识回退、输入法、手机导航和图表精确提示 |
| `a-transfer-confirm` | 确认、余额变化和 1 笔新增扣款 |
| `b-transfer-mfa` | 错码不扣款；正确码完成原操作 |
| `c-plan-pause-resume` | 暂停、继续和已完成节点保留 |
| `d-plan-cancel` | 取消后旧确认被拒，资金和限额不变 |
| `e-refresh-action-recovery` | 刷新恢复黄色确认和红色验证 |
| `f-wedge-refresh-recover` | 已提交但未结束的操作恢复，扣款不重复 |
| `g-manual-handoff` | 人工核对刷新保留；继续后仍需授权 |
| `h-investment-flow` | 申购和赎回的持仓、余额及流水一致 |
| `i-anomaly-detection` | 收入不当作异常消费，显示种子异常消费 |
| `j-circuit-breaker-lock` | 刷新后保持锁定；正确解锁留下审计 |

每条流程输出 `PASS`、`FAIL` 或 `SKIP`。
任何 `FAIL` 使入口返回非零退出码。
`SKIP` 不使入口失败，也不算验收通过。
入口见[离线浏览器验收](../../tests/e2e/acceptance.e2e.ts)。
`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts` 运行 HTTP 边界用例。
该入口不发模型请求，也不启动浏览器。
边界入口按 `PASS|FAIL|SKIP <case-id>` 逐条输出，并用 `SUMMARY` 汇总。
`pnpm exec tsx tests/e2e/weixin-live.e2e.ts` 运行微信通道验收。
该入口使用本地协议服务器，不冒充真实手机。

界面流程检查 390px 和 320px 手机宽度。
流程模拟普通 HTTP 缺少 `randomUUID` 的环境。
选择建议或确认输入法候选字时，不发送请求。
发送余额查询后，流水没有变化。
检查代码见[界面验收](../../tests/e2e/ui-shell.e2e-helper.ts)。

测试入口检查实际解析到的 Prisma Client。
生成客户端的 schema 必须与仓库当前 schema 一致。
能够实例化但字段过时的客户端会重新生成。
回归用例见[客户端生成检查](../../tests/unit/lib/prisma-client-generation.test.ts)。

## 真实模型验收

真实模型验收使用 DeepSeek，银行和 MFA 仍为模拟。
入口通过 Next.js 环境加载器使用本地配置。
不得直接读取或显示 `.env.local` 内容。
真实模型请求可能产生费用。

```sh
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
LIVE_SCENARIOS=1,3 pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

`LIVE_SCENARIOS` 选择场景编号。
未设置时执行入口登记的全部场景编号。
编号 `1`…`6` 是转账与多轮用例，`0` 和 `8`…`15` 是对话与上下文用例。
`2p` 跟随 `2` 一起选中；`lA`…`lL` 覆盖卡片、理财、锁定、身份解析与旧草稿切换。
多场景由独立子进程依次执行，每次重建专用验收库。
`2`、`2p` 保留在同一进程，覆盖取消后的再次发起。
每个子进程结束后关闭浏览器和服务器，避免账户锁定影响后续场景。
默认保留配置中的模型标识。
`LIVE_FORCE_MODEL` 可显式覆盖模型标识。
覆盖后必须在验收记录中写明模型标识。
入口见[真实模型浏览器验收](../../tests/e2e/live-acceptance.e2e.ts)。

生产模式固定使用 `.next-build`。
在 PowerShell 中先构建，再启动指定场景：

```powershell
$env:BANKING_NEXT_DIST_DIR = '.next-build'
pnpm build
$env:E2E_SERVER_MODE = 'production'
$env:LIVE_SCENARIOS = '2,15'
pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

修改产品代码后必须重新构建该目录。
默认 `pnpm build` 写入 `.next`，不会更新 `.next-build`。
切回开发验收时，移除当前终端的 `E2E_SERVER_MODE`。

故障注入验收区分错误响应和成功响应来源。
HTTP 503 注入用于检查故障处理。
脚本生成的成功响应仍属于受控模型证据。
正常请求转发至 DeepSeek 时，记录真实上游请求数。

## 验收证据与限制

验收记录至少包含以下信息。

1. 记录提交标识、运行命令和退出码。
2. 记录模型来源、模型标识和实际场景范围。
3. 保存 `PASS`、`FAIL`、`SKIP` 数量及原因。
4. 保存页面证据和操作标识。
5. 核对操作前后的余额、流水、执行回执和审计。
6. 核对刷新和重复操作后是否新增业务记录。
7. 记录模型请求数，区分重新规划和原操作继续。
8. 记录隔离库路径、配置覆盖和故障注入方式。

历史真实模型验收的结论范围见 [LIVE-ACCEPTANCE-REPORT.md](../../tests/e2e/LIVE-ACCEPTANCE-REPORT.md)。
该文件保留历史场景、认证提交、判定与产物恢复命令。
新的逐轮记录写入忽略目录，随本次验收单独保存。
账本口径、测试总数和构建结果以重新执行为准。
被认证的提交与当前 HEAD 的产品树不一致时，该结论不延伸到当前版本。

离线回归检查应用对指定响应的行为。
真实模型验收也不能穷举自然语言表达。
这两类验收都不证明真实银行或短信接入。
多实例部署、跨浏览器、负载和无障碍需另行验收。
开发服务的浏览器通过不替代生产构建验证。
