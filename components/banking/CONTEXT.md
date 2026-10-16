# 银行业务展示组件

## 组件职责

| 组件 | 内容 |
| --- | --- |
| `AssetSummaryCard` | 资产、余额、额度与消费摘要 |
| `RecentTransactions` | 交易列表 |
| `CardTile` | 脱敏卡号、状态与限额 |
| `SubscriptionTile` | 费用、周期与下次扣费 |
| `InvestmentProductTile` | 产品及可选持仓 |
| `AnomalyBanner` | 异常记录与调用方提供的动作 |
| `AgentTaskTimeline` | 计划节点与执行状态 |

组件使用 `useI18n` 展示本地化标签。
金融值和状态来自调用方的数据。
SDK 类型通过类型导入使用。

## 投资持仓渲染（e2e 定位）

`InvestmentProductTile` 持有区块按条件渲染，标签取 `business.investments.*`：

| 行 | 键 | 中文 | 英文 | 值 |
| --- | --- | --- | --- | --- |
| 持有金额 | `business.investments.principal` | 持有金额 | Principal | `Money(holding.amount)`（预订本金） |
| 市值 | `business.investments.marketValue` | 市值 | Market value | `DecimalMoney(holding.marketValue)`（未舍入） |
| 收益 | `business.investments.profit` | 收益 | Return | `DecimalMoney(holding.profit) signed` |
| 最近申购 | `business.investments.lastPurchase` | 最近申购 | Last purchase | `formatDateTime` |
| 申购记录 | `business.investments.purchases` + `purchaseCount` | 申购记录 · 共 {count} 笔 | — | 计数 |

持仓本金标签是“持有金额”，不是“本金”。
“本金”只出现在申购/赎回确认卡字段（`chat.field.principal`，经 `lib/i18n/display.ts` 映射）。
市值、收益、最近申购、申购记录行仅在对应 DTO 字段存在时渲染。

对话结果卡 `chat/cards/InvestmentsCard` 用同类标签（`<dl>/<dt>/<dd>`），
并另用汇总键 `cards.investment.amount`（持仓金额）、`cards.investment.marketValue`（持仓市值）、`cards.investment.profit`（累计收益）。

组件均无 `data-testid`；金额值 span 恒带 `tabular-nums`。
`InvestmentProductTile` 标签 span `text-banking-navy/60`、值 span `text-banking-deep`，
`InvestmentsCard` 标签 `dt` `text-banking-navy/60`、值 `dd` `font-medium text-banking-deep`。
`/investments` 页面以 `data-investment-holdings`（含持仓）与 `data-investment-products`（仅产品）标记 `.map` 区块。

金额格式：`Money`→`formatCNY`（`lib/money.ts`，`¥#,##0.00` 精确到分）；
`DecimalMoney`→`formatDecimalCNY`（`lib/decimal.ts`，HALF_UP 到两位）；二者输出形状一致（`[±]¥#,##0.00`）。
`signed` 时正数前置 `+`。年化率经 `rateRatioToPercent`（比值×100）加 `%`，如 `3.2575%`。

## 修改约束

- 本目录不请求数据或执行银行业务。
- 交互回调由客户端调用方提供。
- 金额必须沿用通用组件的单位约定。
- 脱敏号码不得代替服务端资源标识。

界面测试方法见
[test-cases.md](../../docs/cn/test-cases.md)。
