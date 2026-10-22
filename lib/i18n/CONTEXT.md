# 界面本地化

## 职责与入口

| 入口 | 职责 |
| --- | --- |
| `shared.ts` | 语言校验、消息键类型、模板插值 |
| `server.ts` | 请求级 `getServerI18n()`，通过 Next cookies 读取 `banking_locale` |
| `LocaleProvider.tsx` | 客户端翻译上下文、cookie 持久化、服务端组件刷新 |
| `LocaleText.tsx` | 面向服务端安全原语的客户端叶子组件，支持渲染回调 |
| `messages/` | 应用框架、对话、业务与页面文案的中英文对照目录 |
| `display.ts` | 静态元数据与策略值的翻译，以及调用详情字段来源判断 |

## 投资标签

`business.investments.*` 提供投资业务的中英文标签，语义如下：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.investments.lastPurchase` | 最近申购 | Last purchase | 最近一次申购的时间或说明 |
| `business.investments.purchases` | 申购记录 | Purchases | 申购记录区块标题 |
| `business.investments.purchaseCount` | 共 {count} 笔 | {count} purchases | 申购笔数，模板含 `{count}` 占位符 |
| `business.investments.addedToExisting` | 已加购 | Added to existing | 对已持有产品再次申购的标记 |

净值 + 份额事实的标签与单位：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.investments.shares` | 持仓份额 | Shares held | 持仓份额行标签 |
| `business.investments.netValue` | 最新净值 | Latest net value | 最新净值行标签 |
| `business.investments.netValueDate` | 净值日期 | Net value date | 净值日期行标签 |
| `business.investments.remainingCost` | 剩余持仓成本 | Remaining cost | 剩余持仓成本行标签 |
| `business.investments.holdingProfit` | 持仓收益 | Holding return | 未实现收益行标签 |
| `business.investments.holdingProfitRate` | 持仓收益率 | Holding return rate | 持仓收益率行标签 |
| `business.investments.cumulativeProfit` | 累计收益 | Cumulative return | 累计收益行标签 |
| `business.investments.realizedProfit` | 已实现收益 | Realized return | 已实现收益行标签 |
| `business.investments.valueBasis.migrated` | 估算 | Estimated | 旧数据派生持仓的徽标 |
| `business.investments.valueBasis.insufficient` | 历史数据不足 | Insufficient history | 无法估值的持仓徽标 |
| `business.investments.insufficient` | 历史数据不足 | Insufficient history | 单个事实缺失时的占位文本 |
| `business.investments.units.shares` | 份 | shares | 份额单位，跟在 6 位小数之后 |
| `business.investments.units.netValue` | 元/份 | CNY/unit | 净值单位，跟在 4 位小数之后 |
| `business.investments.profitScope` | 持仓收益为未实现收益；累计收益 = 已实现收益 + 持仓收益。 | Holding return is unrealized; cumulative return = realized return + holding return. | 收益口径说明 |
| `business.investments.disclaimer` | 收益为模拟估算，不承诺保本。 | Returns are simulated estimates; capital is not guaranteed. | 估算免责声明 |

事实缺失时用 `business.investments.insufficient`，不用 0 占位。
徽标、行与布局规则见
[components/banking/CONTEXT.md](../../components/banking/CONTEXT.md)。

## 赎回字段与策略值

赎回确认快照的字段标签取 `chat.field.*`，策略值取 `chat.value.*`：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `chat.field.redemptionShares` | 赎回份额 | Shares redeemed | 快照中的赎回份额 |
| `chat.field.netValue` | 成交净值 | Execution net value | 快照中的成交净值 |
| `chat.field.netValueDate` | 净值日期 | Net value date | 快照中的净值日期 |
| `chat.field.settlementAmount` | 预计到账金额 | Expected settlement amount | 快照中的预计到账金额 |
| `chat.field.feeRule` | 费用口径 | Fee basis | 费用口径字段 |
| `chat.field.redemptionMode` | 赎回口径 | Redemption basis | 赎回口径字段 |
| `chat.value.redemptionByShares` | 按份额赎回 | Redeem by shares | 赎回口径值 |
| `chat.value.redemptionByAmount` | 按金额赎回 | Redeem by amount | 赎回口径值 |
| `chat.value.redemptionAll` | 全部赎回 | Redeem all | 赎回口径值 |
| `chat.value.notPublished` | 未公布 | Not published | 产品无净值时的日期值 |
| `chat.value.valuationChange` | 净值、份额或到账金额变化时停止执行，需重新确认。 | Stops when the net value, shares or settlement amount changes; reconfirmation is required. | 赎回口径的策略值 |
| `chat.value.settlementFormula` | 到账金额 = 赎回份额 × 成交净值 | Settlement amount = shares redeemed × execution net value | 到账金额计算口径 |
| `chat.value.feeRuleSimulatedNone` | 模拟环境不收取赎回费，赎回费 ¥0.00。 | No redemption fee is charged in the simulation; the redemption fee is ¥0.00. | 模拟免费用口径 |
| `chat.value.reconfirmOnChange` | 确认期间净值变化时需重新确认。 | If the net value changes before confirmation, the redemption must be reconfirmed. | 重新确认提示 |

## 卡片标签

`business.cards.*` 提供卡片业务的中英文标签，语义如下：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.cards.linkedAccount` | 关联账户 | Linked account | 卡片关联的账户名称或编号 |
| `business.cards.accountAvailable` | 账户可用余额 | Account available balance | 关联账户当前可用余额 |
| `business.cards.payableAmount` | 当前可支付金额 | Currently payable | 结合卡片额度与账户余额后当前可支付的金额 |

`pages.cards.consume*` 提供卡片消费界面（模拟消费表单、消费结果提示与消费记录）的中英文标签。

## 显示映射（display-sources）

`messages/display-sources.json` 将界面已知的静态元数据值映射到消息键，供展示层翻译。
映射键必须与源值完全一致，值必须指向已存在的消息键（单元测试校验该不变量）。
`titles` 必须覆盖 `lib/contracts/tool-catalog.ts` 中每个工具的 `description`，将其映射到对应的 `chat.policy.<toolName>` 消息键，由 `tests/unit/lib/i18n-display.test.ts` 校验。
含动态内容的源值无法静态映射，展示层按原样保留、不翻译。
例如部分赎回策略值 `部分赎回（本金 ¥…／共计 ¥…）` 内嵌金额，保持原样显示，不得添加正则或模式匹配。
完全赎回策略值 `全部赎回该笔持仓` 映射到 `chat.value.fullRedemption`。

赎回快照使用下列映射：

| 源值 | 目标键 | 归属 |
| --- | --- | --- |
| `赎回份额` | `chat.field.redemptionShares` | `fields` |
| `成交净值` | `chat.field.netValue` | `fields` |
| `净值日期` | `chat.field.netValueDate` | `fields` |
| `预计到账金额` | `chat.field.settlementAmount` | `fields` |
| `费用口径` | `chat.field.feeRule` | `fields` |
| `赎回口径` | `chat.field.redemptionMode` | `fields` |
| `按份额赎回` | `chat.value.redemptionByShares` | `policyValues` |
| `按金额赎回` | `chat.value.redemptionByAmount` | `policyValues` |
| `全部赎回` | `chat.value.redemptionAll` | `policyValues` |
| `未公布` | `chat.value.notPublished` | `policyValues` |
| `净值、份额或到账金额变化时停止执行，需重新确认` | `chat.value.valuationChange` | `policyValues` |

只有 `policyValues` 登记的值按策略值翻译，其他字段值原样显示。

## 展示辅助函数（display.ts）

`display.ts` 提供标签与策略值的翻译，以及判断调用详情字段来源的辅助函数：

| 函数 | 作用 |
| --- | --- |
| `isActionAmountField(label)` | 标签是否映射到 `cards.amount` |
| `isActionSettlementAmountField(label)` | 标签是否映射到 `chat.field.settlementAmount`，用于抑制重复的通用金额行 |
| `isRedemptionNetValueSnapshot(fields)` | 字段是否同时含 `chat.field.redemptionShares` 与 `chat.field.netValue`，即赎回到账快照 |
| `isSimulatedNoneFeeField(field)` | 是否 `chat.field.feeRule` 且值含 `SIMULATED_NONE` |
| `localizeActionFieldLabel` / `localizeActionFieldValue` | 翻译字段标签与已知策略值 |

`localizeActionFieldValue` 只对 `risk`、`operation` 与白名单策略字段翻译值。
白名单包含 `chat.field.redemptionScope`、`chat.field.amountChange`、`chat.field.monthlyLimit`、`chat.field.demoScope`、`chat.field.reminder`、`chat.field.redemptionMode`、`chat.field.netValueDate`。
白名单外的字段值按原样显示，金融事实不重写。

## 修改约束

- 默认 `zh-CN`，即使浏览器偏好英文；仅 `en` 选择英文。
- 标识符、键名与注释使用英文，中文界面文案放入语言 JSON。
- 翻译完整模板；金融金额以已格式化的精确字符串传入。
- 不得为插值或本地化格式将金额转换为二进制浮点数。
- 仅本地化静态界面元数据；保留用户文本、模型回复与金融事实。
- 切换语言只更新展示，不重挂载对话、不重提交操作、不改变授权。
- 偏好 cookie 不是身份 cookie，不授予任何权限。
- 服务端数据访问保留在服务端模块；本地化不构成客户端数据库导入的理由。
- 中英文目录必须同时登记相同键与相同占位符，单元测试校验键与占位符一致性。

## 验证

`tests/unit/lib/i18n.test.ts` 校验语言目录与插值。真实浏览器验收流程校验默认语言、
持久化、客户端/服务端翻译与对话保留。
