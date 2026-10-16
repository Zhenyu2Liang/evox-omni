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
| 市值 | `business.investments.marketValue` | 市值 | Market value | `DecimalMoney(holding.marketValue)`（显示按 HALF_UP 舍入到两位；存储估值不舍入） |
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

## 卡片渲染（CardTile）

`CardTile` 由 `CardView` DTO 驱动（`banking-sdk`）：卡类型+网络、脱敏卡号 `numberMasked`、状态徽章与限额。
类型/状态映射为 `MessageKey`（`@/lib/i18n/shared`）：

| 字段 | 键 | 中文 | 英文 |
| --- | --- | --- | --- |
| 类型 DEBIT/CREDIT/VIRTUAL | `business.cards.debit`/`credit`/`virtual` | 借记卡/信用卡/虚拟卡 | Debit card/Credit card/Virtual card |
| 状态 ACTIVE/FROZEN/LOST/PENDING | `business.cards.active`/`frozen`/`lost`/`pending` | 正常/已冻结/已挂失/待激活 | Active/Frozen/Reported lost/Pending activation |
| 信用额度 | `business.cards.limit` | 信用额度 | Credit limit |
| 可用额度 | `business.cards.available` | 可用额度 | Available credit |
| 月限额 | `business.cards.monthlyLimit` | 月限额 | Monthly limit |
| 分类限额 | `business.cards.categoryLimits` | 分类限额 | Category limits |
| 已补卡 | `business.cards.replaced` | 已补卡 | Replaced |

渲染分支：卡类型与状态始终显示（状态用 `Badge`，`STATUS_TONE`：ACTIVE→success、FROZEN→info、LOST→danger、PENDING→warn；非风控状态不用 `StatusBadge`）。
信用额度/可用额度两行仅在 `card.type === 'CREDIT'` 且对应字段存在时渲染。
月限额行在所有卡类型上，仅当 `card.monthlyLimit` 存在时渲染（`Money`→`formatCNY`）。
分类限额块仅当 `card.limits.length > 0` 时渲染，每行标签是 `limit.category` 原始字符串（非 i18n），值为 `Money(limit.amount)`。
`card.replacedByCardId !== undefined` 时插入 `business.cards.replaced` 徽章。
限额字段（`creditLimit`/`availableLimit`/`monthlyLimit`/`limits[].amount`）是 `MoneyAmount`（CNY 十进制字符串），经 `Money`→`formatCNY` 展示。

## 修改约束

- 本目录不请求数据或执行银行业务。
- 交互回调由客户端调用方提供。
- 金额必须沿用通用组件的单位约定。
- 脱敏号码不得代替服务端资源标识。

界面测试方法见
[test-cases.md](../../docs/cn/test-cases.md)。
