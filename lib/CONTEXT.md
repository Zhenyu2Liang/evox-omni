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

## 修改约束

- 修改共享类型时，必须更新 `contracts/` 的原定义。
- 金融单位规则见 [financial-values.md](../docs/cn/financial-values.md)。
- 数据访问规则见 [db/CONTEXT.md](db/CONTEXT.md)。
- `index.ts` 不得导出数据库客户端。
- 新增展示脱敏一律使用 `lib/mask.ts`，不得在调用层重复实现。
- 本目录不得依赖业务执行层或界面层。
- 意图声明与计划校验入口见 [agent/CONTEXT.md](../agent/CONTEXT.md)。

开发命令见 [development.md](../docs/cn/development.md)。
