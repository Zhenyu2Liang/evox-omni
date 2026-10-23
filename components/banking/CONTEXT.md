# 银行业务展示组件

## 组件职责

| 组件 | 内容 |
| --- | --- |
| `AssetSummaryCard` | 资产、余额、额度与消费摘要 |
| `RecentTransactions` | 交易列表 |
| `CardTile` | 脱敏卡号、状态、限额与关联账户 |
| `SubscriptionTile` | 费用、周期与下次扣费 |
| `InvestmentProductTile` | 产品及可选持仓 |
| `HoldingFacts` | 一个持仓的净值 + 份额事实，供 tile 与对话卡片共用 |
| `AnomalyBanner` | 异常记录与调用方提供的动作 |
| `AgentTaskTimeline` | 计划节点与执行状态 |

组件使用 `useI18n` 展示本地化标签。
金融值和状态来自调用方的数据。
SDK 类型通过类型导入使用。
`card-account-display.ts` 是不渲染任何内容的纯函数模块，供卡片类组件共用关联账户判定。

## 投资持仓渲染（e2e 定位）

`InvestmentProductTile` 的持仓区块按条件渲染，标签取 `business.investments.*`：

| 区块 | 键 | 中文 | 英文 | 值 |
| --- | --- | --- | --- | --- |
| 小标题 | `business.investments.holdings` | 持仓 | Holdings | 右侧可带 `valueBasis` 徽标 |
| 持有金额 | `business.investments.principal` | 持有金额 | Principal | `Money(holding.amount)`（剩余持仓成本） |
| 净值 + 份额事实 | 见“净值 + 份额事实” | — | — | `<HoldingFacts holding={holding} layout="tile" />` |
| 最近申购 | `business.investments.lastPurchase` | 最近申购 | Last purchase | `formatDateTime` |
| 申购记录 | `business.investments.purchases` + `purchaseCount` | 申购记录 · 共 {count} 笔 | — | 计数 |

持有金额行在持仓存在时始终渲染，值是剩余持仓成本。
标签是“持有金额”，不是“本金”。
“本金”只出现在申购、赎回确认卡字段（`chat.field.principal`，经 `lib/i18n/display.ts` 映射）。
最近申购与申购记录行仅在对应 DTO 字段存在时渲染。

## 净值 + 份额事实（HoldingFacts）

`HoldingFacts.tsx` 是持仓事实的唯一来源。
`InvestmentProductTile` 与对话卡片 `chat/cards/InvestmentsCard` 都调用 `HoldingFacts`，两处显示的数值相同。
事实只取自 `HoldingView` DTO，界面不重算。

| 事实 | 键 | 中文 | 英文 | 值 |
| --- | --- | --- | --- | --- |
| 持仓份额 | `business.investments.shares` | 持仓份额 | Shares held | `formatDecimalFixed(shares, 6)` 加 `business.investments.units.shares`（份） |
| 最新净值 | `business.investments.netValue` | 最新净值 | Latest net value | `formatDecimalFixed(latestNetValue, 4)` 加 `business.investments.units.netValue`（元/份） |
| 净值日期 | `business.investments.netValueDate` | 净值日期 | Net value date | `formatBusinessDate`，输出 `YYYY-MM-DD`（北京时间） |
| 持仓市值 | `business.investments.marketValue` | 市值 | Market value | `DecimalMoney(marketValue)`；估值缺省不取整，展示 HALF_UP 到两位 |
| 剩余持仓成本 | `business.investments.remainingCost` | 剩余持仓成本 | Remaining cost | `Money(holding.amount)`，已入账人民币分 |
| 持仓收益 | `business.investments.holdingProfit` | 持仓收益 | Holding return | `DecimalMoney(profit) signed`，为未实现收益 |
| 持仓收益率 | `business.investments.holdingProfitRate` | 持仓收益率 | Holding return rate | `rateRatioToPercent(profitRate)` 加 `%` |
| 累计收益 | `business.investments.cumulativeProfit` | 累计收益 | Cumulative return | `DecimalMoney(cumulativeProfit) signed` |
| 已实现收益 | `business.investments.realizedProfit` | 已实现收益 | Realized return | `DecimalMoney(realizedProfit)`，不加正号 |

收益口径见 [investments.md](../../docs/cn/investments.md)。

缺失的事实渲染 `business.investments.insufficient`（历史数据不足），不渲染 0。
`holding.amount` 始终存在，是唯一不缺省的金额事实。
没有净值字段的旧持仓只渲染市值与收益两行，不显示份额、净值与成本行。
`usesNetValueModel(holding)` 判定持仓是否按净值 + 份额计价：`valueBasis`、`shares`、`latestNetValue`、`cumulativeProfit` 有一个存在即为真。
`valueBasisLabelKey(holding)` 返回徽标键，`NET_VALUE` 返回 `undefined`，即不显示徽标。

## valueBasis 徽标

徽标紧跟持仓小标题，位于其右侧：

| `valueBasis` | 徽标键 | 文案 | 色调 |
| --- | --- | --- | --- |
| `NET_VALUE` | 无 | — | — |
| `MIGRATED_ESTIMATE` | `business.investments.valueBasis.migrated` | 估算 | info |
| `HISTORICAL_DATA_INSUFFICIENT` | `business.investments.valueBasis.insufficient` | 历史数据不足 | warn |

## 布局变体

`HoldingFacts` 的 `layout` 决定行结构，标签文本相同：

- `tile`：`InvestmentProductTile` 使用。行是 `div.flex.items-center.justify-between.gap-3.text-sm`，标签与值是兄弟 `span`，分别用 `text-banking-navy/60` 与 `font-medium text-banking-deep`。
- `card`：`InvestmentsCard` 使用。行是 `dt` 与 `dd` 的 flex 容器，分别用 `text-banking-navy/60` 与 `font-medium text-banking-deep`。

e2e 行读取器按标签 `span` 的文本精确定位，再取同一父元素的第二个 `span`。
标签文本相同，两处可按同一组标签断言。

## 口径与免责声明

持仓区块底部显示 `business.investments.profitScope` 与 `business.investments.disclaimer`。
`profitScope` 只在持仓按净值 + 份额计价时出现。
`disclaimer`（收益为模拟估算，不承诺保本）随持仓始终出现。

对话结果卡 `chat/cards/InvestmentsCard` 用同类事实（`dt`/`dd`），
并另用汇总键 `cards.investment.amount`（持仓金额）、`cards.investment.marketValue`（持仓市值）、`cards.investment.profit`（累计收益）。

组件均无 `data-testid`；金额值 span 恒带 `tabular-nums`。
`/investments` 页面以 `data-investment-holdings`（含持仓）与 `data-investment-products`（仅产品）标记 `.map` 区块。

金额格式：`Money`→`formatCNY`（`lib/money.ts`，`¥#,##0.00` 精确到分）；
`DecimalMoney`→`formatDecimalCNY`（`lib/decimal.ts`，HALF_UP 到两位）；二者输出形状一致（`[±]¥#,##0.00`）。
`signed` 时正数前置 `+`。年化率经 `rateRatioToPercent`（比值×100）加 `%`，如 `3.2575%`。
份额与净值经 `formatDecimalFixed` 定长输出，6 位与 4 位小数，不经金额格式化。
净值日期经 `formatBusinessDate` 按 UTC+08:00 输出 `YYYY-MM-DD`。

## 卡片渲染（CardTile）

`CardTile` 由 `CardView` DTO 驱动（`banking-sdk`）：卡类型+网络、脱敏卡号 `numberMasked`、状态徽章、限额与结算账户绑定信息。
类型/状态映射为 `MessageKey`（`@/lib/i18n/shared`）：

| 字段 | 键 | 中文 | 英文 |
| --- | --- | --- | --- |
| 类型 DEBIT/CREDIT/VIRTUAL | `business.cards.debit`/`credit`/`virtual` | 借记卡/信用卡/虚拟卡 | Debit card/Credit card/Virtual card |
| 状态 ACTIVE/FROZEN/LOST/PENDING | `business.cards.active`/`frozen`/`lost`/`pending` | 正常/已冻结/已挂失/待激活 | Active/Frozen/Reported lost/Pending activation |
| 信用额度 | `business.cards.limit` | 信用额度 | Credit limit |
| 可用额度 | `business.cards.available` | 可用额度 | Available credit |
| 月限额 | `business.cards.monthlyLimit` | 月限额 | Monthly limit |
| 分类限额 | `business.cards.categoryLimits` | 分类限额 | Category limits |
| 关联账户 | `business.cards.linkedAccount` | 关联账户 | Linked account |
| 账户余额 | `business.cards.accountBalance` | 账户余额 | Account balance |
| 可用余额 | `business.cards.usableBalance` | 可用余额 | Usable balance |
| 未关联账户 | `business.cards.linkedAccountMissing` | 未关联账户 | No linked account |
| 账户暂不可用 | `business.cards.linkedAccountUntrusted` | 账户暂不可用 | Account unavailable |
| 卡片不可用 | `business.cards.cardUnavailable` | 卡片不可用 | Card unavailable |
| 已冻结提示 | `business.cards.cardFrozenNotice` | 卡片已冻结，暂不可用于消费（余额仍可查看） | Card frozen — not usable for spending; the balance is still viewable |
| 已挂失提示 | `business.cards.cardLostNotice` | 卡片已挂失，暂不可用于消费（余额仍可查看） | Card reported lost — not usable for spending; the balance is still viewable |
| 已补卡 | `business.cards.replaced` | 已补卡 | Replaced |

固定渲染：卡类型与状态始终显示（状态用 `Badge`，`STATUS_TONE`：ACTIVE→success、FROZEN→info、LOST→danger、PENDING→warn；非风控状态不用 `StatusBadge`）。
`card.replacedByCardId !== undefined` 时插入 `business.cards.replaced` 徽章。
月限额行在所有卡类型上，仅当 `card.monthlyLimit` 存在时渲染（`Money`→`formatCNY`）；它表示月度消费限额，不是账户资金。
分类限额块仅当 `card.limits.length > 0` 时渲染，每行标签是 `limit.category` 原始字符串（非 i18n），值为 `Money(limit.amount)`。

结算账户区块严格按 `CardView.linkedAccountStatus` 四态渲染，判定与提示键统一取自 `card-account-display.ts`，与卡类型无关（DEBIT 与 VIRTUAL 同规则）：

| `linkedAccountStatus` | 关联账户行 | 账户金额区块 | 提示 |
| --- | --- | --- | --- |
| `LINKED` | `linkedAccountName` · 脱敏账号（`linkedAccountNumber`，缺失回退 `linkedAccountId`） | 「账户余额」=`Money(accountAvailableBalance)`、「可用余额」=`Money(payableAmount)`，各自按字段存在渲染 | 无 |
| `MISSING` | 不渲染 | **不渲染任何金额，绝不显示 0** | `business.cards.linkedAccountMissing` |
| `UNTRUSTED` | 不渲染 | **不渲染任何金额，绝不显示 0**（余额未知） | `business.cards.linkedAccountUntrusted` |
| `NOT_APPLICABLE` | 不渲染 | 不渲染；信用卡改走下列信用额度区块 | 无 |

信用卡（`linkedAccountStatus === 'NOT_APPLICABLE'`）保留信用额度区块：`card.type === 'CREDIT'` 且
`creditLimit`/`availableLimit` 存在时，以两列 `<dl>` 渲染 `business.cards.limit` / `business.cards.available`。

卡片可用性与绑定状态正交：`card.usable === false` 时另加一枚提示徽章
（`FROZEN`→`business.cards.cardFrozenNotice`、`LOST`→`business.cards.cardLostNotice`、其他→`business.cards.cardUnavailable`；
色调 `UNAVAILABLE_TONE`：FROZEN→warn、LOST→danger、其他→neutral），但 `LINKED` 的账户余额区块**照常显示**——
卡片不可用不等于余额为零。

关联账户值是纯文本（脱敏账户号或内部标识），不经 `Money`，组件不再二次脱敏。
账户余额是结算账户的**账户余额**，可用余额是**该卡当前可用余额**（`min(账户余额, 家庭本月剩余限额)`）；
两者只用 `business.cards.accountBalance` / `business.cards.usableBalance`，
**绝不用** `business.cards.limit` / `business.cards.available`（授信额度字样）。
账户余额与可用余额并列于两列 `<dl className="grid grid-cols-2 gap-3">`（`dt` `text-xs text-banking-navy/60`，`dd` `text-sm font-semibold text-banking-deep`）；
关联账户为 flex 行（标签 `text-banking-navy/60`，值 `font-semibold text-banking-deep`）；提示文案为 `<p className="text-sm text-banking-navy/60">`。
限额字段（`creditLimit`/`availableLimit`/`monthlyLimit`/`limits[].amount`）与 `accountAvailableBalance`/`payableAmount` 都是 `MoneyAmount`（CNY 十进制字符串），经 `Money`→`formatCNY` 展示；`linkedAccountNumber`/`linkedAccountId`/`linkedAccountName` 是文本。

## 关联账户展示（card-account-display.ts）

`card-account-display.ts` 是纯函数模块：无 React、无 Hook、不请求数据、不引入 i18n 运行时
（只用 `import type` 取 `CardView`/`CardLinkedAccountStatus`、`MessageKey`、`MoneyAmount`）。
`CardTile` 与对话结果卡 `chat/cards/CardsCard` 共用同一套四态判定，不得各自重写分支。
模块内不做脱敏、不做金额计算：账号由服务端脱敏，金额原样交给 `ui/Money`。

导出契约：

| 导出 | 签名 | 语义 |
| --- | --- | --- |
| `CardAccountDisplay` | `interface { accountName?: string; accountNumber?: string; accountBalance?: MoneyAmount; usableBalance?: MoneyAmount }` | 账户字段集合，非 `LINKED` 时全部 `undefined` |
| `cardShowsAccountAmounts` | `(card: CardView) => boolean` | 是否渲染账户金额区块；仅 `linkedAccountStatus === 'LINKED'` 为 `true` |
| `cardAccountDisplay` | `(card: CardView) => CardAccountDisplay` | 取关联账户名称、脱敏账号（`linkedAccountNumber ?? linkedAccountId`）、账户余额（`accountAvailableBalance`）、可用余额（`payableAmount`）；非 `LINKED` 返回 `{}` |
| `linkedAccountNoticeKey` | `(status: CardLinkedAccountStatus) => MessageKey \| undefined` | `MISSING`→`business.cards.linkedAccountMissing`、`UNTRUSTED`→`business.cards.linkedAccountUntrusted`、`LINKED`/`NOT_APPLICABLE`→`undefined` |
| `cardUnavailableNoticeKey` | `(card: CardView) => MessageKey \| undefined` | `usable` 为 `true` 时 `undefined`；否则 `FROZEN`→`business.cards.cardFrozenNotice`、`LOST`→`business.cards.cardLostNotice`、其余→`business.cards.cardUnavailable` |

导入路径：`@/components/banking/card-account-display`（不经 `index.ts` 桶导出）。

## 修改约束

- 本目录不请求数据或执行银行业务。
- 交互回调由客户端调用方提供。
- 金额必须沿用通用组件的单位约定。
- 脱敏号码不得代替服务端资源标识。
- 持仓事实只在 `HoldingFacts` 维护，其他组件不得另写一份。
- 账户余额（`accountAvailableBalance`）是关联账户的资金，不是授信额度；
  `MISSING`/`UNTRUSTED` 时不渲染任何金额，也不得以 0 占位。
- 卡片不得持有独立余额：余额与可用余额都派生自结算账户。

界面测试方法见
[test-cases.md](../../docs/cn/test-cases.md)。
