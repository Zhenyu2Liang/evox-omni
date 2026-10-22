# 理财页（/investments）

## 职责

- 只有一个文件 `page.tsx`：`/investments` 路由（Next.js 服务端组件，`export const dynamic = 'force-dynamic'`）。
- 服务端调用 `banking.investment.listProducts()` 与 `banking.investment.listHoldings(getConfig().demoUserId)`。
- 不实现表单：追加申购与赎回都在 `/agent` 对话中完成；本页只读展示产品与持仓。
- 持仓列表只含状态为 `HOLDING` 的行（`listHoldings` 过滤，见 `banking-sdk/investment.ts`）。

## 结构（page.tsx）

- 标题 `t('pages.investments.title')`（zh-CN“理财”），摘要、说明、跳转 `/agent` 的“咨询助手”。
- 说明卡（page.tsx:24-28）：`pages.investments.description`，下方两行小字是 `business.investments.profitScope` 与 `business.investments.disclaimer`。
- `<section data-investment-products>`（page.tsx:29）：产品网格，`InvestmentProductTile`（无 holding）。
- `<section data-investment-holdings>`（page.tsx:35）：标题 `t('pages.investments.holdings')`（zh-CN“当前持仓”），持有则渲染 `InvestmentProductTile`（带 holding）；空仓渲染 `EmptyState`。
- 每个持仓/产品卡片由 `components/banking/InvestmentProductTile.tsx` 渲染。

## 持仓事实（净值 + 份额）

持仓区块渲染 1 行持有金额，其余事实由 `components/banking/HoldingFacts.tsx` 提供：

| 语义 | i18n key | zh-CN 文案 | 渲染组件 |
| --- | --- | --- | --- |
| 持有金额（剩余持仓成本） | `business.investments.principal` | 持有金额 | `<Money amount={holding.amount} />` |
| 持仓份额（6 位小数） | `business.investments.shares` + `business.investments.units.shares` | 持仓份额 | 定长文本，单位“份” |
| 最新净值（4 位小数） | `business.investments.netValue` + `business.investments.units.netValue` | 最新净值 | 定长文本，单位“元/份” |
| 净值日期 | `business.investments.netValueDate` | 净值日期 | `formatBusinessDate`（`YYYY-MM-DD`） |
| 持仓市值（未取整估值） | `business.investments.marketValue` | 市值 | `<DecimalMoney amount={holding.marketValue} />` |
| 剩余持仓成本 | `business.investments.remainingCost` | 剩余持仓成本 | `<Money amount={holding.amount} />` |
| 持仓收益（未实现） | `business.investments.holdingProfit` | 持仓收益 | `<DecimalMoney amount={holding.profit} signed />` |
| 持仓收益率 | `business.investments.holdingProfitRate` | 持仓收益率 | `rateRatioToPercent` 加 `%` |
| 累计收益 | `business.investments.cumulativeProfit` | 累计收益 | `<DecimalMoney amount={holding.cumulativeProfit} signed />` |
| 已实现收益 | `business.investments.realizedProfit` | 已实现收益 | `<DecimalMoney amount={holding.realizedProfit} />` |

- 界面标签是“持有金额”，不是“本金”。“持仓”是区块小标题 `business.investments.holdings`。
- “持有金额”是 tile 自有行，“剩余持仓成本”是 `HoldingFacts` 的行，两行值同为 `holding.amount`。
- `holding.amount` 是剩余持仓成本 `centsToMoney(principalAmountMinor)`，部分赎回后已扣减。
- `holding.marketValue` = 份额 × 最新净值的精确乘积，展示按 HALF_UP 取整到两位。
- `holding.profit` 是未实现收益，`holding.cumulativeProfit` = 已实现收益 + 持仓收益。
- 缺失的事实渲染 `business.investments.insufficient`（历史数据不足），不渲染 0。
- 没有净值字段的旧持仓只渲染市值与收益两行。
- 持仓按净值 + 份额计价时，小标题右侧显示 `valueBasis` 徽标：`MIGRATED_ESTIMATE` 为“估算”，`HISTORICAL_DATA_INSUFFICIENT` 为“历史数据不足”，`NET_VALUE` 无徽标。
- 持仓区块底部是口径与免责声明：`business.investments.profitScope` 与 `business.investments.disclaimer`。
- 各事实的判定、布局与徽标规则见 [components/banking/CONTEXT.md](../../components/banking/CONTEXT.md)。
- 收益口径与取整规则见 [investments.md](../../docs/cn/investments.md)。

### 格式化函数与输出

- 持有金额、剩余持仓成本：`components/ui/Money.tsx` → `formatCNY`（`lib/money.ts`）。
  `¥` 加千分位整数加两位小数；负数为前缀 `-`；`signed` 未传时正数不加 `+`。例：`¥4,118.91`。
- 市值、收益、已实现收益：`components/ui/DecimalMoney.tsx` → `formatDecimalCNY`（`lib/decimal.ts`）。
  四舍五入 `ROUND_HALF_UP` 到两位。`signed` 时正数前置 `+`，零不带 `+`。例：`+¥118.91`。
- 份额与净值：`formatDecimalFixed(value, 6)` 与 `formatDecimalFixed(value, 4)`，只补足或截断到定长小数，不经金额格式化。例：`1234.567890 份`、`1.0234 元/份`。
- 净值日期：`formatBusinessDate`，按 UTC+08:00 输出 `YYYY-MM-DD`。
- 所有金额用 `tabular-nums` 类，且都是精确字符串（无浮点）。

## DOM 选择器（e2e）

- 稳定钩子**仅有**两个 `data-*`：`[data-investment-products]`、`[data-investment-holdings]`（page.tsx:29/35）。
- **没有** `data-testid`，也没有 per-holding 的 id 属性；本仓库约定用 `data-*` 属性定位。
- 单个产品/持仓 = 一个 `Card` div（`components/ui/Card.tsx`，`div.rounded-2xl.bg-white`）。产品名在 `div.font-medium.text-banking-navy`。
- 每一数据行：`<div class="flex items-center justify-between gap-3 text-sm">`，含
  - 标签 `<span class="text-banking-navy/60">持有金额</span>`
  - 值 `<span class="font-medium text-banking-deep">…</span>`
- 读取示例：在 `[data-investment-holdings]` 内按精确标签文本定位行，再取同一父元素的第二个 `span`。
- 注意：tile 内多个标签都用 `text-banking-navy/60`。
  标签包括预期年化收益率、期限、起购金额、持仓、持有金额、市值、持仓份额、最新净值与最近申购。
  取值前必须先用标签文本限定到行。
- “最近申购”行的值是日期（`text-banking-deep`，无 `font-medium`，无 `tabular-nums`）。
- “收益”行只在没有净值字段的旧持仓上出现；按净值 + 份额计价的持仓使用“持仓收益”“累计收益”“已实现收益”标签。

## 对话卡片（副面，申购/赎回后可断言处）

- `/agent` 的 `components/chat/cards/InvestmentsCard.tsx` 用同一份事实与相同的 `Money`/`DecimalMoney` 渲染持仓。
- 顶部汇总标签：`cards.investment.amount`“持仓金额”、`cards.investment.marketValue`“持仓市值”、`cards.investment.profit`“累计收益”（`chat.zh-CN.json:108-110`）。
- 每持仓内联动标签同用 `business.investments.*`。
- 值结构 `ResultMetric`：`<dt class="text-xs text-banking-navy/60">` 加 `<dd class="… font-semibold tabular-nums text-banking-deep">`（`components/chat/cards/ResultCard.tsx`）。
- 申购/赎回回执 `BusinessReceiptCard`（`components/chat/cards/BusinessResultCards.tsx`）显示 `business.receipt.investmentPurchase`“理财申购结果”/`business.receipt.investmentRedemption`“理财赎回结果”、`business.receipt.valuation`“结算前赎回估值”。

## i18n 字典位置

- 持仓事实标签：`lib/i18n/messages/business.zh-CN.json` 与 `business.en.json`（88-102）。
  行号：principal:81、marketValue:82、profit:83、holdings:80、yield:76。
  净值 + 份额事实行号：shares:88、netValue:89、netValueDate:90、remainingCost:91。
  收益与单位行号：holdingProfit:92、holdingProfitRate:93、cumulativeProfit:94、realizedProfit:95。
  徽标与口径行号：valueBasis.migrated:96、valueBasis.insufficient:97、insufficient:98、units.shares:99、units.netValue:100、disclaimer:101、profitScope:102。
- 页级文案：`lib/i18n/messages/pages.zh-CN.json`（`pages.investments.*`，195-203）。
- 卡片文案：`lib/i18n/messages/chat.zh-CN.json`（`cards.investment.*`，105-113）。
- 默认语言 `zh-CN`（`lib/i18n/shared.ts`，`resolveLocale` 仅 `'en'` 例外），故默认渲染中文标签。

## 约束

- 金额一律经 `Money`/`DecimalMoney`，禁止手工格式化。
- 份额、净值与日期经 `formatDecimalFixed`/`formatBusinessDate`，禁止拼字符串。
- 市值与收益是未结算估值，剩余持仓成本是已入账金额。
- 缺失的事实显示“历史数据不足”，不用本金或零补齐。
- 本页只读；申购/赎回的写入与确认在 `/agent`。
