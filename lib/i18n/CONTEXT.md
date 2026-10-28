# 界面本地化

## 职责与入口

| 入口 | 职责 |
| --- | --- |
| `shared.ts` | 语言校验、消息键类型、模板插值 |
| `server.ts` | 请求级 `getServerI18n()`，通过 Next cookies 读取 `banking_locale` |
| `LocaleProvider.tsx` | 客户端翻译上下文、cookie 持久化、服务端组件刷新 |
| `LocaleText.tsx` | `<LocaleText messageKey params />`：只输出 `t(messageKey, params)` 文本的客户端叶子组件，让父级保持服务端可渲染 |
| `messages/` | 应用框架、对话、业务与页面文案的中英文对照目录 |
| `display.ts` | 静态元数据与策略值的翻译，以及调用详情字段来源判断 |

## 品牌文字

`app.brand` 为“万象柜坊”，`app.brandDescription` 为“EvoX Omni”。
`app.slogan` 和 `chat.welcome.title` 使用“一坊通万象，一语办万事。”。
中英文目录、帮助标题与助手标签使用同一品牌名称。

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

## 费用（fee）文案

本目录只有“费用口径”展示标签，没有任何费用计算、费用字段或费用占位符。
与手续费相关的键只有两个：`chat.field.feeRule`（zh `费用口径` / en `Fee basis`，`messages/chat.*.json:260`，由 `display-sources.json#fields:87` 映射）与 `chat.value.feeRuleSimulatedNone`（`messages/chat.*.json:277`，zh“模拟环境不收取赎回费，赎回费 ¥0.00。”/ en“No redemption fee is charged in the simulation; the redemption fee is ¥0.00.”）。
`chat.value.feeRuleSimulatedNone` 是固定字面量：不带 `{...}` 占位符，`¥0.00` 写死在文案里，不渲染任何计算结果；它也不在 `display-sources.json#policyValues`（`:120-133`）中，因此 `localizeActionFieldValue` 不翻译费用数值。
字段标签 `费用口径` 由调用方以 TS 字面量写进摘要（`security/security-gateway.ts`），不经 `chat.field.feeRule` 查表。
检索 `费用`/`fee` 会命中两处**订阅费用**文案，与银行手续费无关：`pages.subscriptions.summary`（zh“…费用与续费日期”/ en“…Fees and renewal dates”，`messages/pages.*.json:76`）与 `pages.subscriptions.listDescription`（zh“名称 / 费用 / 计费周期 / 下次扣费”/ en“Name / fee / billing cycle / next charge”，`:86`）。
`business.subscriptions.nextCharge`（下次扣费 / Next charge）与 `cards.reconciliation.recoverable.help`（不会重复扣款）里的“扣费/扣款”是扣款语义，同样不是手续费。

## 卡片标签

`business.cards.*` 提供卡片业务的中英文标签，语义如下。
全部 23 个键集中在 `messages/business.zh-CN.json:47-69` 与 `messages/business.en.json:47-69`（两侧行号一致）；`app`/`chat`/`pages` 目录不含该前缀的键。
这些值都是纯字面量，**没有 `{...}` 占位符**，`t(key)` 的结果就是目录里的原字符串。

关联账户与余额标签：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.cards.debit` | 借记卡 | Debit card | `CardTile` 卡片类型标签（DEBIT） |
| `business.cards.credit` | 信用卡 | Credit card | 卡片类型标签（CREDIT） |
| `business.cards.virtual` | 虚拟卡 | Virtual card | 卡片类型标签（VIRTUAL） |
| `business.cards.limit` | 信用额度 | Credit limit | CREDIT 卡的额度行 |
| `business.cards.monthlyLimit` | 月限额 | Monthly limit | 月消费限额行 |
| `business.cards.linkedAccount` | 关联账户 | Linked account | 卡片关联的账户名称或编号 |
| `business.cards.accountAvailable` | 账户可用余额 | Account available balance | 关联账户当前可用余额 |
| `business.cards.payableAmount` | 当前可支付金额 | Currently payable | 结合卡片额度与账户余额后当前可支付的金额 |
| `business.cards.accountBalance` | 账户余额 | Account balance | 关联账户的现金余额 |
| `business.cards.usableBalance` | 可用余额 | Usable balance | 结合卡片状态与额度后可动用的余额 |
| `business.cards.linkedAccountMissing` | 未关联账户 | No linked account | 卡片没有关联账户时的占位文案 |
| `business.cards.linkedAccountUntrusted` | 账户暂不可用 | Account unavailable | 关联账户信息不可信时的提示 |
| `business.cards.cardUnavailable` | 卡片不可用 | Card unavailable | 卡片整体不可用的短标签 |
| `business.cards.cardFrozenNotice` | 卡片已冻结，暂不可用于消费（余额仍可查看） | Card frozen — not usable for spending; the balance is still viewable | 冻结状态下的说明句：不可消费但余额仍可查看 |
| `business.cards.cardLostNotice` | 卡片已挂失，暂不可用于消费（余额仍可查看） | Card reported lost — not usable for spending; the balance is still viewable | 挂失状态下的说明句：不可消费但余额仍可查看 |
| `business.cards.balanceFromAccount` | 余额来自关联账户 | Balance from the linked account | 说明余额来源是关联账户 |

卡片类型、状态与额度标签：

| 键 | zh-CN | en | 含义 |
| --- | --- | --- | --- |
| `business.cards.debit` | 借记卡 | Debit card | `CardView.type === 'DEBIT'` |
| `business.cards.credit` | 信用卡 | Credit card | `CardView.type === 'CREDIT'` |
| `business.cards.virtual` | 虚拟卡 | Virtual card | `CardView.type === 'VIRTUAL'` |
| `business.cards.active` | 正常 | Active | `status === 'ACTIVE'` |
| `business.cards.frozen` | 已冻结 | Frozen | `status === 'FROZEN'` |
| `business.cards.lost` | 已挂失 | Reported lost | `status === 'LOST'` |
| `business.cards.pending` | 待激活 | Pending activation | `status === 'PENDING'` |
| `business.cards.replaced` | 已补卡 | Replaced | 已被补卡替换的卡片徽标（`replacedByCardId` 有值） |
| `business.cards.limit` | 信用额度 | Credit limit | 仅 CREDIT 卡 |
| `business.cards.available` | 可用额度 | Available credit | 仅 CREDIT 卡 |
| `business.cards.monthlyLimit` | 月限额 | Monthly limit | 卡片带月限额时的一行 |
| `business.cards.categoryLimits` | 分类限额 | Category limits | 分类限额区块标题 |

这些卡片键全部**不含占位符**，`t(key)` 返回值即目录原文；en 的 `cardFrozenNotice` / `cardLostNotice` 使用 U+2014 em dash（`Card frozen — not usable…`），断言时不得写成连字符。
`lib/i18n/messages/pages.*.json` 不含任何 `business.cards.*` 键，`shared.ts:15`/`:21` 的展开覆盖不会改变这些值；`pages.cards.*` 是 `/cards` 页面自身的表单、消费与空态文案。
关联账户名称复用既有 `business.cards.linkedAccount`；`business.cards.usableBalance` 是更通用的可用余额标签。
同一含义复用既有键，例如不另设 `business.cards.linkedAccountName`。
主金额与详情属于不同语境，按各自语义选择键。
当前渲染方：`components/banking/CardTile.tsx` 把 `accountBalance` / `usableBalance` 渲染成 `<dt>` 标签，`linkedAccount` 渲染成 `<span>` 标签，`cardUnavailable` / `cardFrozenNotice` / `cardLostNotice` / `linkedAccountMissing` / `linkedAccountUntrusted` 由 `components/banking/card-account-display.ts` 的映射选择。
`business.cards.accountAvailable`、`business.cards.payableAmount`、`business.cards.balanceFromAccount` 是旧详情键。
`CARD_LABEL_RETIRED` 保留前两者的文字，用于检查旧详情。
`CardPrimaryAmount` 使用 `business.presentation.payable`，可显示同名的“当前可支付金额”。
该主金额文字存在不等于重新使用旧详情键，验收同时核对金额。
浏览器验收断言的卡片标签来自 `tests/e2e/card-labels.e2e-helper.ts` 的 `CARD_LABEL`，它用 `createTranslator('zh-CN')` 读目录而不是复制字符串。

本目录没有“卡号”“账号”“尾号”“结算账户”这类键：脱敏卡号是 `CardView.numberMasked`（`****6688`，4 个 `*` + 4 位数字）原样渲染，关联账号是 `CardView.linkedAccountNumber`，都不经目录；“结算账户”只出现在 `chat.policy.consume_virtual_card` 的策略描述里。
`/cards` 页自身的键集中在 `pages.cards.*`（`messages/pages.zh-CN.json:30-74` 与 `pages.en.json:30-74` 行号一致）；其中 `pages.cards.summary`（`{count}`）与 `pages.cards.verificationFailed`（`{attempts}`）含占位符，断言前必须先补值，其余卡片页键是纯字面量。
`tests/e2e/card-labels.e2e-helper.ts` 尚未收录类型键、状态键与三条不可用提示键（`cardUnavailable`/`cardFrozenNotice`/`cardLostNotice`）。
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
## 翻译查找与插值（`shared.ts`）

目录装载：`shared.ts:1-8` 只静态 import 本目录 `messages/` 下的 8 个 JSON（`app`/`chat`/`business`/`pages` × `zh-CN`/`en`）。
`agent/messages/*.json`（服务端叙述模板）与 `security/messages/mfa.zh-CN.json` 是彼此独立的候选文案目录，本目录从不读取，它们的键也不在本目录词表内。
合并方式：`english`（`shared.ts:15`）是四份 en 目录的对象展开；`messages`（`:19-22`）按 locale 展开四份目录——键是扁平字符串、没有命名空间，重名时后展开的 `pages` 覆盖前者。
`MessageKey`（`:16`）= `keyof typeof english`，即键集合以**英文目录**为权威；`isMessageKey`（`:25-27`）也只在 `english` 上 `Object.hasOwn`。
`resolveLocale`（`:30-32`）：只有 `'en'` 得到 en，其余任何值（含 `undefined`、大小写变体）都回退 `DEFAULT_LOCALE`（`:12` = `'zh-CN'`）；这是唯一的回退层，`server.ts:8` 与 `LocaleProvider.tsx:37` 都经它。
插值（`translate`，`:35-39`）：单花括号 `{name}`，正则 `/\{([A-Za-z][A-Za-z0-9_]*)\}/g`。
占位符名首字符必须是字母，后续只能是字母/数字/下划线。
`{{name}}` 的匹配从第二个 `{` 开始，只替换内层，结果残留一双花括号（`{值}`），因此目录里必须写 `{count}` 而非 `{{count}}`。
`params` 中没有该名时占位符原样保留（`:37` 返回 `placeholder`）；`params` 值经 `String()` 转换，金额必须以已格式化字符串传入。
缺失键：`translate` 直接做 `messages[locale][key].replace(...)`，键不存在时抛 `TypeError`（对 `undefined` 调 `replace`），**没有**键级回退、不返回键名、不返回空串；`Record<MessageKey, string>` 的类型只是假设，运行期不校验。
因此新增键必须同时写进 en 与 zh-CN 目录（否则类型或运行期失败），中英文键顺序在四份文件中保持一致便于对照。
键是**扁平字面量**，没有嵌套路径遍历：`t('cards.mfa.label')` 里的点号只是键名的一部分，`translate` 直接 `messages[locale][key]` 取值。
参数名不统一，按键取值：`cards.mfa.failedAttempts` 用 `{attempts}`，`cards.mfa.failedAttemptsLimit` 用 `{attempts, maxAttempts}`，`chat.error.verificationRemaining` 用 `{count}`（值来自 `failure.attemptsLeft ?? 0`），`security.reset.success` 与 `security.breaker.failureCount` 用 `{count, max}`。
`tests/e2e/` 的断言文案经 `createTranslator('zh-CN')` 从本目录读取（`tests/e2e/acceptance.e2e.ts:695` 与多数 `*.e2e-helper.ts`），新增 e2e 断言必须沿用该写法而非硬编码中文字面量；`tests/e2e/conversation.zh-CN.json` 是用户提示词与否定词的 fixture，不是界面文案表。

## 安全与验证文案的跨目录分布

同一概念在多个目录各有一份，文案并不相同，改动时必须同时核对：

| 层 | 目录 | 键 |
| --- | --- | --- |
| 对话卡片 | `messages/chat.zh-CN.json` | `cards.mfa.*`、`cards.terminal.*`、`cards.confirm`/`cards.verify`/`cards.cancel`、`chat.approval.*`、`chat.error.*` |
| 安全中心与熔断 | `messages/business.zh-CN.json` | `security.breaker.*`、`security.reset.*`、`security.events.*`、`security.permissions.*` |
| 页面 | `messages/pages.zh-CN.json` | `pages.security.*`、`pages.cards.locked`、`pages.activity.status.locked`、`pages.audit.status.locked` |

`已锁定` 精确出现在三处：`cards.terminal.locked`、`pages.activity.status.locked`、`pages.audit.status.locked`。
`chat.approval.status.locked` 是“验证已锁定”，`cards.mfa.locked` 是完整句“已锁定，请到安全中心处理。”，两者不可替代 `cards.terminal.locked`。
终态卡片的 `terminalStatusView`（`components/chat/cards/confirmationStatus.ts`）自带硬编码中文标签且不经本目录，见 [components/chat/cards/CONTEXT.md](../../components/chat/cards/CONTEXT.md)。
客户端查找链：`createTranslator(locale)`（`shared.ts:41-43`）返回 `(key, params?) => translate(locale, key, params)`，签名见 `Translator`（`shared.ts:18`），返回值就是目录字符串本身（无包裹、无追加空白或标点）。
`LocaleProvider`（`LocaleProvider.tsx:23-48`）用 `useState(initialLocale)` + `useMemo(() => createTranslator(locale))` 提供上下文的 `t`；`useI18n()`（`:51-53`）就是 `useContext(I18nContext)`。
不在 `LocaleProvider` 之内时 `useI18n()` 落到 `DEFAULT_CONTEXT`（`:15-20`），即 `zh-CN` 的 translator 与 `pending: false`、空操作 `setLocale`。
`initialLocale` 由 `app/layout.tsx:25` 的 `getServerI18n()` 给出；`setLocale`（`:36-44`）写 cookie `banking_locale`（`Path=/; Max-Age=31536000; SameSite=Lax`，https 时加 `Secure`），再 `router.refresh()` 刷新服务端组件，不重挂载对话。
因此全新浏览器（无 cookie）服务端读到 `undefined`，`resolveLocale` 回退 `zh-CN`，页面文案为中文目录。

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
