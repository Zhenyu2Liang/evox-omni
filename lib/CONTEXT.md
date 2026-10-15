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
| `prisma-cli-env.ts` | Prisma 命令环境与可执行文件解析 |
| `db/` | 客户端、事务上下文与仓储 |

## 金融与时间约定

已入账金额使用 `BigInt` 分，字段以 `Minor` 结尾。
JSON 金额使用十进制字符串。
`moneyToCents` 校验小数位与有符号 64 位范围。
比例、数量与未结算估值使用 `decimal.ts`。
`moneyToChartNumber` 只用于图形坐标。
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

## 修改约束

- 修改共享类型时，必须更新 `contracts/` 的原定义。
- 金融单位规则见 [financial-values.md](../docs/cn/financial-values.md)。
- 数据访问规则见 [db/CONTEXT.md](db/CONTEXT.md)。
- `index.ts` 不得导出数据库客户端。
- 本目录不得依赖业务执行层或界面层。
- 意图声明与计划校验入口见 [agent/CONTEXT.md](../agent/CONTEXT.md)。

开发命令见 [development.md](../docs/cn/development.md)。
