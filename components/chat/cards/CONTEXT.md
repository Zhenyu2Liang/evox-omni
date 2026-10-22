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
卡片错误徽标（`MfaCard`、`ConfirmationCard`）使用 `localizeChatError`，未登记字符串原样显示，不回落错误文案登记表。
`ErrorCard` 用 `publicToolError(message, t, 'chat.error.toolFailed', code)` 渲染文本，原始 `message`/`detail` 仅限开发者模式诊断。

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
安全与拒绝类文案只经 `lib/public-text.ts`（`securityNotice`/`safePublicText`）或 `lib/tool-feedback.ts`（`publicToolError`/`publicToolSummary`）取得，组件内不做字符串清洗。

规则与映射见
[chat-presentation.md](../../../docs/cn/chat-presentation.md)。
验证入口见
[tests/unit/planner/CONTEXT.md](../../../tests/unit/planner/CONTEXT.md)。
