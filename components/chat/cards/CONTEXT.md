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

虚拟卡（`card.type === 'VIRTUAL'`）按字段存在性追加指标。
绑定账户用 `business.cards.linkedAccount`，值取 `linkedAccountNumber`，缺失时取 `linkedAccountId`。
账户可用余额用 `business.cards.accountAvailable`，值取 `accountAvailableBalance`。
当前可支付额用 `business.cards.payableAmount`，值取 `payableAmount`。
`accountAvailableBalance` 是绑定 CHECKING 账户的可用现金（账户可用余额），
不是授信额度，只能用 `business.cards.accountAvailable` 展示，不得使用 `business.cards.available`。
授信额度标签 `business.cards.limit` / `business.cards.available` 仅限 `card.type === 'CREDIT'`。
上述字段缺失时不渲染对应指标，不显示占位符或空值。

## 授权与状态

`confirmation` 与 `mfa` 历史卡片使用 `ApprovalRecord`。
当前交互由父目录 `ApprovalRequest` 提供。
`ConfirmationCard` 与 `MfaCard` 提供该交互的具体控件。
`confirmationStatus.ts` 解释持久化操作状态，终态记录不因保留 RED 元数据而重新要求验证。
`MfaCard` 与 `ApprovalRecord` 都只在终态为 `failed` 时用 `publicToolError(statusMessage/message, t)` 渲染原因行；
`locked` 只渲染状态徽标（`cards.terminal.locked` / `chat.approval.status.locked`），原文仅开发者模式可见。
`publicToolError` 未传 `errorCode` 时回落到 `chat.error.toolFailed`；传入时按 `PUBLIC_ERROR_CODES`（如 `CIRCUIT_OPEN` → `chat.error.securityLocked`）。

终态原因只在 `failed` 时渲染：`ApprovalRecord`（60 行）、`ConfirmationCard`（64 行）、`MfaCard`（66 行）。
`locked` 属终态（`confirmationStatus.ts` 12-18 行），只渲染 `chat.approval.status.locked` / `cards.terminal.locked` 徽标，服务端 `message` 不显示。
`terminalStatusView('locked')` 的 `label` 是未翻译的 `'Locked'`（64-65 行），而终态角标实际取 `cards.terminal.*`（`ConfirmationCard` 68 行），该 `label` 只剩未使用分支。
`MfaCard` 的 `readOnly` 由 `asTerminalStatus(status)` 或非 `pending`/`awaiting_mfa` 推导（41-42 行），`locked` 因此同时是只读且终态。
卡片错误徽标（`MfaCard` 102 行、`ConfirmationCard` 121 行）使用 `localizeChatError`，未登记字符串原样显示，不回落错误文案登记表。
`ErrorCard` 用 `publicToolError(message, t, 'chat.error.toolFailed', code)` 渲染文本（24 行），原始 `message`/`detail` 仅限开发者模式诊断（25-28 行）。

`ReconciliationCard` 展示结果待核对的操作。
它由对话界面单独组合，不属于卡片联合类型。
结果未知时不得显示已成功、已失败或资金未变。

`PlanCard` 展示节点与计划控制。
控制回调传递所属计划标识。
暂停、取消与恢复规则由服务端执行。

## 展示约束

金额、收款人与状态必须取自对应业务结果。
电话号码使用脱敏显示。
资源标识和执行身份不能由显示名称替代。

规则与映射见
[chat-presentation.md](../../../docs/cn/chat-presentation.md)。
验证入口见
[tests/unit/planner/CONTEXT.md](../../../tests/unit/planner/CONTEXT.md)。
