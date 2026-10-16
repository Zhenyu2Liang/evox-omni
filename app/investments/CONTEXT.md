# 理财页（/investments）

## 职责

- 只有一个文件 `page.tsx`：`/investments` 路由（Next.js 服务端组件，`export const dynamic = 'force-dynamic'`）。
- 服务端调用 `banking.investment.listProducts()` 与 `banking.investment.listHoldings(getConfig().demoUserId)`。
- 不实现表单：追加申购与部分赎回都在 `/agent` 对话中完成；本页只读展示产品与持仓。
- 持仓列表只含状态为 `HOLDING` 的行（`listHoldings` 过滤，见 `banking-sdk/investment.ts:781`）。

## 结构（page.tsx）

- 标题 `t('pages.investments.title')`（zh-CN「理财」），摘要、说明、跳转 `/agent` 的「咨询助手」。
- `<section data-investment-products>`（page.tsx:25）：产品网格，`InvestmentProductTile`（无 holding）。
- `<section data-investment-holdings>`（page.tsx:31）：标题 `t('pages.investments.holdings')`（zh-CN「当前持仓」），持有则渲染 `InvestmentProductTile`（带 holding）；空仓渲染 `EmptyState`。
- 每个持仓/产品卡片由 `components/banking/InvestmentProductTile.tsx` 渲染。

## 持仓三数（本金/市值/收益）

`InvestmentProductTile.tsx` 的 holding 区块（第 95–131 行）逐行渲染：

| 语义 | i18n key | zh-CN 文案 | en 文案 | 渲染组件 | 行号 |
| --- | --- | --- | --- | --- | --- |
| 本金（剩余已入账本金） | `business.investments.principal` | 持有金额 | Principal | `<Money amount={holding.amount} />` | 99–102 |
| 市值（未取整估值） | `business.investments.marketValue` | 市值 | Market value | `<DecimalMoney amount={holding.marketValue} />` | 106–109 |
| 收益（= 市值 − 本金，可负） | `business.investments.profit` | 收益 | Return | `<DecimalMoney amount={holding.profit} signed />` | 114–117 |

- 注意：界面标签是「持有金额」，**不是**「本金」；「持仓」是区块标签 `business.investments.holdings`（tile 内小标题，第 97 行）。
- `holding.amount` = 剩余本金 `centsToMoney(principalAmountMinor)`；`holding.marketValue` = `nonNegativeDecimal(estimatedMarketValue)`（永不为负）；`holding.profit` = 市值 − 本金（可为负）。见 `banking-sdk/investment.ts:780-802`。
- 部分赎回后 `amount` 已是剩余本金（见 tile 注释第 53–55 行）。

### 格式化函数与输出

- 本金：`components/ui/Money.tsx:14` → `formatCNY(amount)`（`Money.tsx:15`）。
  `formatCNY` 定义于 `lib/money.ts:79`：`¥` + 千分位整数 + `.` + 两位小数；负数为前缀 `-`。`signed` 未传 → 正数**不加** `+`。例：`¥4,118.91`。
- 市值/收益：`components/ui/DecimalMoney.tsx:10` → `formatDecimalCNY(amount)`（`DecimalMoney.tsx:11`）。
  `formatDecimalCNY` 定义于 `lib/decimal.ts:72`：四舍五入 `ROUND_HALF_UP` 到两位，`¥` + 千分位 + 两位小数；负数为前缀 `-`。例：`¥4,118.91`。
- `signed`（仅收益）：`DecimalMoney.tsx:12` `showPlus = signed && compareDecimal(amount, '0') > 0`。
  - 正收益 → `+¥118.91`；负收益 → `-¥118.91`；零 → `¥0.00`（不加 `+`）。
- 市值永为非负 → 始终 `¥…`，从不带 `+`/`-`。
- 所有金额用 `tabular-nums` 类，且都是精确字符串（无浮点）。

## DOM 选择器（e2e）

- 稳定钩子**仅有**两个 `data-*`：`[data-investment-products]`、`[data-investment-holdings]`（page.tsx:25/31）。
- **没有** `data-testid`，也没有 per-holding 的 id 属性；本仓库约定用 `data-*` 属性定位。
- 单个产品/持仓 = 一个 `Card` div（`components/ui/Card.tsx`，`div.rounded-2xl.bg-white`）。产品名在 `div.font-medium.text-banking-navy`（tile 第 64 行）。
- 每一数据行：`<div class="flex items-center justify-between gap-3 text-sm">`，含
  - 标签 `<span class="text-banking-navy/60">持有金额</span>`
  - 值 `<span class="font-medium text-banking-deep"><span class="tabular-nums">¥4,118.91</span></span>`
- 读取示例：在 `[data-investment-holdings]` 内按文本定位行再取 `span.tabular-nums`：
  `page.locator('[data-investment-holdings] div.flex.items-center.justify-between', { hasText: '持有金额' }).locator('span.tabular-nums')`。
- 注意：tile 内多个标签都用 `text-banking-navy/60`（预期年化收益率/期限/起购金额/持仓/持有金额/市值/收益/最近申购），必须在行级别（`hasText`）限定后再取值；「最近申购」行的值是日期（`text-banking-deep`，无 `font-medium`，无 `tabular-nums`）。

## 对话卡片（副面，申购/赎回后可断言处）

- `/agent` 的 `components/chat/cards/InvestmentsCard.tsx` 用相同 `DecimalMoney`/`Money` 渲染持仓。
- 顶部汇总标签：`cards.investment.amount`「持仓金额」、`cards.investment.marketValue`「持仓市值」、`cards.investment.profit`「累计收益」（`chat.zh-CN.json:105-113`）。
- 每持仓内联动标签同用 `business.investments.*`（`InvestmentsCard.tsx:89-93`）。
- 值结构 `ResultMetric`：`<dt class="text-xs text-banking-navy/60">` + `<dd class="… font-semibold tabular-nums text-banking-deep">`（`components/chat/cards/ResultCard.tsx:31-38`）。
- 申购/赎回回执 `BusinessReceiptCard`（`components/chat/cards/BusinessResultCards.tsx:76-96`）显示 `business.receipt.investmentPurchase`「理财申购结果」/`business.receipt.investmentRedemption`「理财赎回结果」、`business.receipt.valuation`「结算前赎回估值」。

## i18n 字典位置

- 持仓三数标签：`lib/i18n/messages/business.zh-CN.json`（principal:78、marketValue:79、profit:80、holdings:77、yield:73）与 `business.en.json`（78–80）。
- 页级文案：`lib/i18n/messages/pages.zh-CN.json`（`pages.investments.*`，182–190）。
- 卡片文案：`lib/i18n/messages/chat.zh-CN.json`（`cards.investment.*`，105–113）。
- 默认语言 `zh-CN`（`lib/i18n/shared.ts:12`，`resolveLocale` 仅 `'en'` 例外），故默认渲染中文标签。

## 约束

- 金额一律经 `Money`/`DecimalMoney`，禁止手工格式化。
- 市值/收益为估算值，未经结算取整；本金是已入账金额。
- 本页只读；申购/赎回的写入与确认在 `/agent`。
