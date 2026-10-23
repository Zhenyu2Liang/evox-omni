# 对话业务卡片

## 数据与分派

`CardRenderer` 按 `ChatCard.type` 穷举分派。
共享类型定义在 `lib/contracts/agent.ts`。
工具输出先经服务端与传输契约校验。
卡片只展示结构化结果。

支持余额、转账、流水、消费、卡片、理财和订阅。
联系人、资产概览、定时记录与执行回执也有独立展示。
异常、计划和错误分别使用对应卡片。
新增类型时，必须更新分派与展示测试。

## 卡片结果卡（CardsCard）

`CardsCard`（`ChatCard.type === 'cards'`，data 为 `CardView[]`）用标题键 `cards.bankCards.title`（卡片/Bank cards），空态用 `cards.bankCards.empty.title` / `cards.bankCards.empty.description`。
每张卡复用 `business.cards.*` 键：类型 `business.cards.debit/credit/virtual`、状态 `business.cards.active/frozen/lost/pending`、额度 `business.cards.limit`（仅 CREDIT）/`business.cards.available`（仅 CREDIT）/`business.cards.monthlyLimit`（任意类型，字段存在即显示）/`business.cards.categoryLimits`；分类项标签同样是 `limit.category` 原始字符串。
限额值经 `Money`→`formatCNY` 展示；与 `banking/CardTile` 使用同一套键与分支规则，但布局不同（`ResultCard` + `ResultMetric`）。

### 关联账户四态（`linkedAccountStatus`）

账户区块不在此处自行判定，一律复用
`components/banking/card-account-display.ts` 的
`cardShowsAccountAmounts` / `cardAccountDisplay` / `linkedAccountNoticeKey` / `cardUnavailableNoticeKey`，
与 `banking/CardTile` 共用同一份纯函数。

| `linkedAccountStatus` | 渲染 |
| --- | --- |
| `LINKED` | 关联账户（`business.cards.linkedAccount`，值为 `accountNumber`，有 `accountName` 时以「 · 」拼接）+ 账户余额（`business.cards.accountBalance`）+ 可用余额（`business.cards.usableBalance`） |
| `MISSING` | 只渲染 `business.cards.linkedAccountMissing` 提示，不渲染任何金额 |
| `UNTRUSTED` | 只渲染 `business.cards.linkedAccountUntrusted` 提示，不渲染任何金额 |
| `NOT_APPLICABLE` | 无账户区块，保留 `business.cards.limit` / `business.cards.available` |

`accountBalance` 取 `accountAvailableBalance`，是绑定 CHECKING 账户的现金（账户余额），
不是授信额度，也不为卡片另设独立余额——同一账户的多张卡共享这一份余额。
`usableBalance` 取 `payableAmount`，是这张卡当前可用余额。
两者只在 `LINKED` 出现；字段缺失即不渲染，不显示占位符或 `0.00`。
授信额度标签 `business.cards.limit` / `business.cards.available` 仅限 `card.type === 'CREDIT'`。
`usable === false`（冻结/挂失/待激活）时额外渲染 `cardUnavailableNoticeKey` 的提示，
账户余额区块照常显示——不可用不等于没有余额。

## 理财结果卡（InvestmentsCard）

`InvestmentsCard`（`ChatCard.type === 'investments'`）用 `data.products` 与 `data.holdings` 组装条目：
每个持仓配其完整产品元数据，未持有的产品追加在后。
持仓缺少产品元数据时，`buildEntries` 抛出 `Investment holding product metadata is missing.`，不静默跳过。

汇总行只统计 `status === 'HOLDING'` 的持仓：

| 指标 | 键 | 值 | 渲染条件 |
| --- | --- | --- | --- |
| 持仓金额 | `cards.investment.amount` | 各 `holding.amount` 相加，`Money` | 有持仓 |
| 持仓市值 | `cards.investment.marketValue` | 各 `marketValue` 相加，`DecimalMoney` | 每个持仓都有 `marketValue` |
| 累计收益 | `cards.investment.profit` | 各 `profit` 相加，`DecimalMoney signed` | 每个持仓都有 `profit` |

字段缺失时，对应汇总指标不渲染，不用 0 补齐。

每个持仓条目从上到下渲染：

- 徽标：追加申购时为 `business.investments.addedToExisting`（已加购）；`valueBasis` 徽标取 `business.investments.valueBasis.migrated`（估算）或 `business.investments.valueBasis.insufficient`（历史数据不足）；状态取 `business.investments.holdingActive`（持有中）或 `holdingRedeemed`（已赎回）。
- 持有金额：`business.investments.principal`，值 `Money(holding.amount)`，即剩余持仓成本。每个持仓只渲染 1 次。
- 净值 + 份额事实：`<HoldingFacts holding={holding} layout="card" />`，与 tile 共用同一份事实来源。
- 最近申购：`business.investments.lastPurchase`，值 `formatDateTime`。
- 申购记录：`business.investments.purchases` 加 `purchaseCount`，只在有申购记录时渲染。

卡片级口径脚注是 `business.investments.profitScope` 与 `business.investments.disclaimer`。
仅当所有持仓条目都按净值 + 份额计价（`usesNetValueModel`）时，脚注才出现在卡片底部。
事实、徽标与布局变体的规则见
[banking/CONTEXT.md](../../banking/CONTEXT.md)。

`InvestmentsCard` 与 `HoldingFacts` 都不渲染费用：卡片只读 `amount`/`marketValue`/`profit`/`purchases`/`lastPurchaseAt`/`status`/`valueBasis`，
`HoldingView.redemptions`（每条含 `feeAmount`/`feeRule`）从不被读取，持仓区块不出现申购费或赎回费。

## 业务回执（BusinessReceiptCard）

`BusinessReceiptCard`（`ChatCard.type === 'receipt'`）按 `data.kind` 分两支：`budget` 取 `name`/`amount`/`status`/`purpose`/`dueDate`；
`investmentPurchase`/`investmentRedemption` 取 `amount`（`Money`）、`success` 徽标、`newBalance`（`cards.balanceAfter`）、`occurredAt`，
以及可选的 `redemptionValuation`（`business.receipt.valuation`，`DecimalMoney`）与 `settlementRounding`（`business.receipt.rounding`，有值即渲染 `business.receipt.halfUp`）。
回执契约 `BusinessReceipt` 没有费用字段，因此回执卡片不展示手续费、赎回费或费用口径。

## 调用详情（ActionDetails）

`ActionDetails.tsx` 是确认面板与历史授权记录共用的字段渲染器。
`ConfirmationCard`、`MfaCard` 与 `ApprovalRecord` 都调用 `ActionDetails`。

字段行来自服务端快照 `PendingActionSummary.fields`。
界面按快照原样显示，不重新报价、不重算金额。
标签与已知策略值经 `lib/i18n/display.ts` 翻译，未知标签和自由文本原样保留。

通用金额行 `cards.amount`（金额）仅在 `action.amount` 是字符串、且下面两条同时成立时渲染：
`fields` 里没有映射到 `cards.amount` 的字段，也没有映射到 `chat.field.settlementAmount`（预计到账金额）的字段。
赎回快照自带 `预计到账金额`，因此不再追加 `cards.amount` 行，同一个金额不会显示两次。

赎回到账快照由 `isRedemptionNetValueSnapshot(fields)` 判定：字段同时含 `赎回份额` 与 `成交净值`。
命中时在字段下方追加说明：

| 说明 | 键 | 文案 | 渲染条件 |
| --- | --- | --- | --- |
| 计算公式 | `chat.value.settlementFormula` | 到账金额 = 赎回份额 × 成交净值 | 命中快照 |
| 费用口径 | `chat.value.feeRuleSimulatedNone` | 模拟环境不收取赎回费，赎回费 ¥0.00 | 费用口径字段值含 `SIMULATED_NONE` |
| 重新确认 | `chat.value.reconfirmOnChange` | 确认期间净值变化时需重新确认 | 命中快照 |

`费用口径` 行本身照常作为普通字段行渲染：`localizeActionFieldValue` 没有 `chat.field.feeRule` 分支，值按服务端原文显示（如「赎回费 ¥0.00（SIMULATED_NONE：模拟规则免收）」）；免收句子是额外追加，不是替换。
费用判定只读值字符串：`isSimulatedNoneFeeField` 要求标签映射为 `chat.field.feeRule` 且 `field.value.includes('SIMULATED_NONE')`，没有结构化费用字段。
值不含 `SIMULATED_NONE` 时只显示原文，不打印免收句子，也不做任何清洗。
赎回字段与策略值的映射登记在 `lib/i18n/messages/display-sources.json`。

## 授权与状态

`confirmation` 与 `mfa` 历史卡片使用 `ApprovalRecord`。
当前交互由父目录 `ApprovalRequest` 提供。
`ConfirmationCard` 与 `MfaCard` 提供该交互的具体控件。
`confirmationStatus.ts` 解释持久化操作状态，终态记录不因保留 RED 元数据而重新要求验证。

`failed` 终态的原因由 `publicToolError(statusMessage/message, t)` 渲染；未传 `errorCode` 时回落 `chat.error.toolFailed`，传入时按 `PUBLIC_ERROR_CODES`（如 `CIRCUIT_OPEN` → `chat.error.securityLocked`）。

`locked` 是终态且不依赖服务端原文：`MfaCard` 与 `ApprovalRecord` 用同一组结构化事实渲染三段——
原因 `securityNotice({code:'MFA_LOCKED', reason:'mfa_attempts_exhausted'}, t)` → `chat.error.actionLocked`
（该句已包含「无法继续验证或执行」与「请在安全中心解除限制后重新发起操作」）；
状态 `cards.terminal.locked`（`MfaCard`）/ `chat.approval.status.locked`（`ApprovalRecord` 徽标与「当前」阶段行）；
解锁入口 `<Link href="/security">`（标签 `pages.security.title`，支持句 `pages.security.unlockDescription`）。
原因由状态推导；`statusMessage`/`message` 只出现在开发者模式诊断块，不做可见正文。
锁定态不渲染验证码输入、提交或重试入口：`MfaCard` 的 `readOnly` 由 `asTerminalStatus(status)` 或非 `pending`/`awaiting_mfa` 推导，`locked` 同时是只读且终态，输入框与 `footer` 均不渲染；`ApprovalRecord` 只渲染文本与安全中心链接。
非 MFA 的 `confirmation` 卡被结算为 `locked` 时（`ConfirmationCard`）只渲染 `cards.terminal.locked` 角标、不解释原因——MFA 次数耗尽只产生 `mfa` 卡片。
`terminalStatusView('locked')` 的 `label` 是未翻译的 `'Locked'`，而终态角标实际取 `cards.terminal.*` / `chat.approval.status.locked`，该 `label` 落在不可达分支。
`MfaCard` 的 `cards.mfa.locked` 分支（`readOnly && !terminal` 三元里再判 `status === 'locked'`）同样不可达：`locked` 属终态，`!terminal` 已先排除它；非 `pending`/`awaiting_mfa` 的只读状态只会落到 `cards.mfa.processing`。
卡片错误徽标（`MfaCard`、`ConfirmationCard`）使用 `localizeChatError`，未登记字符串原样显示，不回落错误文案登记表。
`ErrorCard` 用 `publicToolError(message, t, 'chat.error.toolFailed', code)` 渲染文本，原始 `message`/`detail` 仅限开发者模式诊断。

`ReconciliationCard` 展示结果待核对的操作。
`ReconciliationCard` 由对话界面单独组合，不属于卡片联合类型。
结果未知时不得显示已成功、已失败或资金未变。

`PlanCard` 展示节点与计划控制。
控制回调传递所属计划标识。
暂停、取消与恢复规则由服务端执行。

## DOM 测试钩子（e2e/Playwright 定位）

卡内几乎没有 test-id，定位靠 `data-*` 与中文 `aria-label`/按钮文案（默认语言 `zh-CN`）。

| 元素 | 选择器 |
| --- | --- |
| 底部授权面板 | `[data-approval-request="true"][data-action-id][data-kind="confirmation"｜"mfa"]`（`components/chat/ApprovalRequest.tsx`） |
| MFA 输入框 | `[data-approval-request="true"] input[aria-label="验证码"]`；无 `name`、无 test-id |
| 实时锁定块 | `[data-mfa-locked="true"]`（`MfaCard`） |
| 历史锁定回执 | `section[data-approval-history="true"][data-action-id][data-status="locked"]` 内的 `[data-approval-locked="true"]`（`ApprovalRecord`） |
| 历史阶段行 | `[data-approval-stage="previous"]` / `[data-approval-stage="current"]`（后者 `role="status"`），均带 `data-stage-status` |
| 卡片外层 | `[data-chat-card-type="mfa"｜"confirmation"]`（`CardRenderer`） |

按钮按角色文本定位：`取消`（`cards.cancel`）、`确认`（`cards.confirm`）、`验证`（`cards.verify`）。
实时锁定块与历史锁定块属性不同——实时 `data-mfa-locked`、历史 `data-approval-locked`，测试不要混用。
`cards.mfa.failedAttempts` 的 `{attempts}` 是客户端 `useAgentStream` 的自增计数（`ChatWindow` 传入 `attempts={stream.mfaAttempts}`），
与 `maxAttempts`（`lib/constants.ts` 的 `MFA_MAX_ATTEMPTS`）比较；`attempts >= maxAttempts` 分支要求面板仍 pending，
达到上限时 `settleAction` 已清除 `pendingAction`，故 `cards.mfa.failedAttemptsLimit` 实际不可达。
## 测试钩子与断言文本

本目录的卡片自身不输出 `data-*`（无 `data-testid`）；唯一稳定的卡片类型钩子是 `CardRenderer` 外层的 `data-chat-card-type={card.type}`（值为 `cards`/`dashboard`/`investments` 等）。
按可见文本断言限额或关联账户区块时，必须先用 `[data-chat-card-type="..."]` 限定卡片类型作用域。
`ResultMetric` 只渲染 `<dt>{label}</dt><dd>{value}</dd>`；金额经 `ui/Money` → `formatCNY` 输出 `¥1,234.00`（`¥` 前缀 + 千分位 + 两位小数）。
专用钩子只存在于授权类卡片：`ApprovalRecord` 的 `data-approval-history`/`data-action-id`/`data-status`/`data-approval-stage`（`previous`|`current`）/`data-stage-status`/`data-approval-locked`，`MfaCard` 的 `data-mfa-locked`，`ErrorCard` 开发者模式诊断块的 `data-error-diagnostics`。
跨卡片同名字面量：`DashboardCard`（`dashboard` 卡片）用 `business.assets.credit` 展示 `creditAvailable`，中文「信用卡可用额度」含「可用额度」子串、英文 `Available credit` 与 `business.cards.available` 完全相同。
本目录无「授信」字样，也不自建卡片余额键；限额与账户文案只经 `business.cards.*` 取得。

## 展示约束

金额、收款人与状态必须取自对应业务结果。
展示脱敏统一走零依赖的 `lib/mask.ts`（`maskPhone` / `maskAccountNumber` / `maskCardNumber`），
本目录的 `maskPhone.ts` 仅为 `lib/mask.ts` 的再导出，导入路径可保留。
卡片上的卡号 `numberMasked` 与关联账号 `linkedAccountNumber` 已由服务端脱敏，
不得再自行拼接掩码。
资源标识和执行身份不能由显示名称替代。
安全与拒绝类文案只经 `lib/public-text.ts`（`securityNotice`/`safePublicText`）或 `lib/tool-feedback.ts`（`publicToolError`/`publicToolSummary`）取得，组件内不做字符串清洗。

规则与映射见
[chat-presentation.md](../../../docs/cn/chat-presentation.md)。
验证入口见
[tests/unit/planner/CONTEXT.md](../../../tests/unit/planner/CONTEXT.md)。
