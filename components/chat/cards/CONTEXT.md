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

## 授权与状态

`confirmation` 与 `mfa` 历史卡片使用 `ApprovalRecord`。
当前交互由父目录 `ApprovalRequest` 提供。
`ConfirmationCard` 与 `MfaCard` 提供该交互的具体控件。
`confirmationStatus.ts` 解释持久化操作状态。
终态记录不能因保留 RED 元数据而重新要求验证。

`ReconciliationCard` 展示结果待核对的操作。
它由对话界面单独组合，不属于卡片联合类型。
结果未知时不得显示已成功、已失败或资金未变。

`PlanCard` 展示节点与计划控制。
控制回调传递所属计划标识。
暂停、取消与恢复规则由服务端执行。

## 展示约束

金额、收款人与状态必须取自对应业务结果。
展示脱敏统一走零依赖的 `lib/mask.ts`（`maskPhone` / `maskAccountNumber` / `maskCardNumber`），
本目录的 `maskPhone.ts` 仅为 `lib/mask.ts` 的再导出，导入路径可保留。
卡片上的卡号 `numberMasked` 与关联账号 `linkedAccountNumber` 已由服务端脱敏，
不得再自行拼接掩码。
资源标识和执行身份不能由显示名称替代。

规则与映射见
[chat-presentation.md](../../../docs/cn/chat-presentation.md)。
验证入口见
[tests/unit/planner/CONTEXT.md](../../../tests/unit/planner/CONTEXT.md)。
