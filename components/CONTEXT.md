# 界面组件

## 职责与目录

组件展示服务端数据并管理界面交互。
组件不决定业务权限或持久化资金变化。

| 目录 | 职责 |
| --- | --- |
| [ui](ui/CONTEXT.md) | 金额、按钮、容器、表格与对话框 |
| [banking](banking/CONTEXT.md) | 资产、流水、卡片与理财展示 |
| [charts](charts/CONTEXT.md) | 原生 SVG 图表 |
| [security](security/CONTEXT.md) | 权限说明、安全事件与熔断状态 |
| [chat](chat/CONTEXT.md) | 对话、历史、流事件与授权交互 |
| [chat/cards](chat/cards/CONTEXT.md) | 结构化业务结果与历史授权记录 |
| `runtime/` | 运行记录与事件展示 |

`index.ts` 和子目录索引保持中性导出。
交互或本地化组件在叶子模块声明客户端边界。
是否使用客户端组件，以模块指令和 Hook 为准。

## 数据与显示

共享契约来自 `lib/contracts`。
SDK 数据类型使用类型导入。
工具结果通过共享输出契约和传输校验。
组件必须保留业务状态与操作身份。

金额显示使用 `Money` 或 `DecimalMoney`。
收益类字段可为负（亏损持仓）：`profit` / `realizedProfit` / `cumulativeProfit` 只经 `DecimalMoney` → `formatDecimalCNY`（`lib/decimal.ts:87-91`，内部 `decimalText` 保留负号），`profitRate` 只经 `signedRateToPercent`（`lib/decimal.ts:71-73`）。
非负门禁只用于产品年化收益率与入账金额/估值：`rateRatioToPercent`（`lib/decimal.ts:76-78`）、`nonNegativeDecimal`（`lib/decimal.ts:36-40`）、`valuationToMinor`（`lib/decimal.ts:81-84`）在负值上抛 `AppError('VALIDATION')`，在 render 期调用会崩掉整棵客户端树；绝不把 `profitRate` 或收益字段交给它们。
组件内 `rateRatioToPercent` 仅两处调用，入参都是 `product.annualYieldRate`（业务上非负）：`banking/InvestmentProductTile.tsx:48-50`（`formatRate`，用于 :79）与 `chat/cards/InvestmentsCard.tsx:76`。
`DecimalMoney` 的 `signed` 只添加正号，负号由 `formatDecimalCNY` 给出（`ui/DecimalMoney.tsx:15-19`）。
部分赎回后的持仓按剩余本金（`holding.amount`）及估算市值与收益显示。
已加购持仓显示最近申购时间（`lastPurchaseAt`）与申购记录数（`purchases`），
投资产品卡与对话投资卡片以“已加购”标记加购。
收益率与收益的符号处理只有一条路径：带符号的持仓收益率 `HoldingView.profitRate` 走 `lib/decimal.ts#signedRateToPercent`（`banking/HoldingFacts.tsx:91`）。
只有非负的产品年化收益率 `ProductView.annualYieldRate` 才走 `rateRatioToPercent`（内部 `nonNegativeDecimal` 门禁：负值在渲染期抛 `AppError('VALIDATION')`，会清空整棵客户端树）。
带符号的 `profit`/`cumulativeProfit`/`realizedProfit` 交给 `DecimalMoney signed`；累计金额用 `addDecimal`/`addMoney`，二者都接受带符号文本（`chat/cards/InvestmentsCard.tsx:123-127`）。
展示层不得用 `Math.abs`、`Number()`、截断或自行补号绕开非负门禁；组件内没有一处把带符号值送入非负门禁。

卡片结算账户区块只由 `CardView.linkedAccountStatus` 决定，
由 `banking/card-account-display.ts` 的纯函数统一归约，
`banking/CardTile` 与 `chat/cards/CardsCard` 复用同一套判定，不各自实现。
`LINKED` 展示关联账户（`linkedAccountName` + 已脱敏 `linkedAccountNumber`，缺省回退 `linkedAccountId`）、
账户余额（`accountAvailableBalance`）与该卡可用余额（`payableAmount`）；
`MISSING`（未关联账户）与 `UNTRUSTED`（账户暂不可用）只展示提示文案，
不渲染任何金额，不得以 0 占位；
`NOT_APPLICABLE` 是信用卡，只展示 `信用额度`（`business.cards.limit`）与 `可用额度`（`business.cards.available`）。
`accountAvailableBalance` 是关联账户的现金余额，不是授信额度，也不是卡片自有的第二份余额。
`usable === false`（FROZEN/LOST）另加「卡片不可用」提示，账户余额区块照常显示。
展示脱敏统一走 `lib/mask.ts`，`chat/cards/maskPhone.ts` 仅为再导出。

图表只有坐标可转换为普通数值。
本地化使用 `lib/i18n`，不改变金融值与资源身份。
安全与拒绝类文案只经 `lib/public-text.ts`（`securityNotice`/`safePublicText`）
或 `lib/tool-feedback.ts`（`publicToolError`/`publicToolSummary`）取得；
组件内不做字符串清洗，内部诊断串（安全标记、原始 JSON、堆栈）不进入可见文本。
服务端自由文本（如 `SecurityEvent.message`）渲染前先用 `isInternalDiagnostic` 判定，
判定为内部诊断时改显示结构化字段对应的目录文案（安全事件按 `event.kind`）。
锁定终态卡片只展示锁定原因、当前状态与安全中心入口，
不渲染验证码输入、提交或重试控件。
颜色与圆角使用 `app/globals.css` 中的主题。

## 定位与可测性

组件不输出 `data-testid`；页面级 `data-*` 钩子（如 `data-card-id`、`data-card-list`）由页面提供，不在组件内。
`Button` 的 `disabled` 与 `loading` 都落到原生 `disabled` 属性；`loading` 只插入旋转 `span` 并设 `aria-busy`，不追加文案。
`EmptyState` 的标题渲染为无角色的 `div`，`getByRole('heading')` 定位不到。
金额文本统一是 `[±]¥#,##0.00` 的单个 `span.tabular-nums`。
具体 DOM 契约见 `ui/CONTEXT.md`（Button / EmptyState / Money / Card / Badge）与 `banking/CONTEXT.md`（CardTile 行结构）。

## 修改约束

- 客户端不得导入 Prisma 或服务端业务执行函数。
- 用户操作通过 API 获得服务端结果。
- 历史授权记录不得重复提供执行按钮。
- 新增卡片类型时，必须更新 `CardRenderer` 的穷举分派。
- 组件不做轮询或自动重试：无 `setInterval`、无 `EventSource`、无定时重发；请求只在用户动作或挂载恢复时发起，一次性上限用 `setTimeout` 中止（现有两处均为 5000ms，见 `chat/CONTEXT.md`「客户端请求与计时器」）。
- 卡片不得持有独立余额；账户余额不得用授信口径的键或文案展示。
- 关联账户判定只走 `banking/card-account-display.ts`，不在组件内复制四态逻辑或脱敏逻辑。
- 授权交互只有一处：底部停靠的 `chat/ApprovalRequest`（`data-approval-request` → `ConfirmationCard`/`MfaCard`）；
  对话内的 `mfa` 与 `confirmation` 卡片一律由 `chat/cards/ApprovalRecord` 只读渲染，不出现输入框或提交按钮。
- 锁定态只在对话内回执出现：写 `data-approval-locked`（`ApprovalRecord`）。
  `MfaCard` 的 `data-mfa-locked` 因 `settleAction` 在终态先清空 `pendingAction`（`ChatWindow` 随即卸载底部停靠）而不可达，
  测试不得断言它；两者文案同源（`securityNotice({code:'MFA_LOCKED',reason:'mfa_attempts_exhausted'})`）。

对话显示规则见
[chat-presentation.md](../docs/cn/chat-presentation.md)。
验证方法见 [test-cases.md](../docs/cn/test-cases.md)。
