# 卡片页面

当前卡片优先展示正常卡，再展示临时锁定卡。
挂失或已有补办关联的旧卡放在默认收起的历史区域，可手动展开查看及使用原有操作。
展示分组不改变卡片状态、账户关联、限额或操作权限。

## 职责

`page.tsx` 按请求读取演示用户的卡片，交给 `CardManager` 组合界面。
`CardManager.tsx` 承载卡片列表、手动申请恢复、刷新、消费入口与消费弹窗。
`CardChangeDialog.tsx` 展示新增、删除、验证与取消。
`CardConsumeDialog.tsx` 展示单卡消费表单与该卡消费记录。
消费预览、验证与重放共用 `lib/contracts/card-consumption.ts` 的响应类型。
验证提交绑定原 `actionId`、消费参数、确认标记与验证码。
前端不能改变金额或类别后继续使用原挑战。
冻结、挂失、账户锁定与限额检查仍由服务端在执行前复核。
提交表单只创建待验证操作；核对原参数并通过 MFA 后才扣款。
验证期间锁定原表单；错误验证码保留原操作身份，终态不再提供验证。

## 数据来源

`page.tsx` 是异步服务端组件并带 `export const dynamic = 'force-dynamic'`，服务端用 `banking.card.getCards(demoUserId)` 投影 `CardView[]`，作为 `CardManager` 的初始 props，故首屏 HTML 已含 `CardTile` 的关联账户与余额行，e2e 不必等客户端 fetch 即可断言。
客户端刷新只走 `GET /api/cards` 与 `GET /api/cards/changes`，只采用最新请求序号的响应。
`CardManager` 首帧 `refreshing=true`、`loaded=false`，`disabled = busy || refreshing || !loaded`，故刷新请求返回前入口按钮全为 disabled；断言按钮可用性必须等这两个请求完成。
本页没有授信额度汇总头：页头只有 `pages.cards.summary`（`{count} 张卡片 · 额度与状态`）的卡片计数；`信用额度` 只出现在新增/审阅弹窗（`CardChangeDialog.tsx`），信用卡可用总额汇总在 `/overview` 的 `AssetSummaryCard`。
消费弹窗打开时只单独请求 `GET /api/cards/[id]/consumptions`，不在整页重复请求消费记录。

## 接口

| 接口 | 用途 |
| --- | --- |
| `GET /api/cards` | 读取当前卡片 |
| `GET /api/cards/changes` | 恢复未完成的手动申请 |
| `POST /api/cards` | 提交新增申请 |
| `DELETE /api/cards/[id]` | 提交删除申请 |
| `POST /api/cards/changes/[id]/verify` | 确认原申请并验证 |
| `POST /api/cards/changes/[id]/cancel` | 取消尚未执行的申请 |
| `POST /api/cards/[id]/consume` | 提交模拟消费 |
| `GET /api/cards/[id]/consumptions` | 读取单卡消费记录 |

所有接口的请求用户由服务端注入，客户端不得发送 userId。

## 页面结构（浏览器断言用）

`page.tsx` 是 `dynamic = 'force-dynamic'` 的服务端组件，只渲染唯一客户端组件 `CardManager`。
`CardManager` 的根元素是 `<main className="mx-auto flex w-full min-w-0 max-w-6xl …">`，内部顺序固定：
- `<header>` 内 `<h1>` 取 `pages.cards.title`（卡片），同级 `<p>` 取 `pages.cards.summary`（`{count}`）；右侧两个 `<span>` 钩子 `data-card-refresh`、`data-card-add` 各包一个 `Button`。
- 演示说明 `<p>` 取 `pages.cards.demoDescription`。
- 通知段按需渲染一个 `<p>`，`role` 为 `alert`（错误）或 `status`（成功）。
- 未完成操作 `<section data-card-pending-changes>`，`<h2>` 取 `pages.cards.pending`，每项 `<li data-card-pending-change-id={id}>` 内含 `pages.cards.reviewAdd`/`reviewDelete` 文案、`card.numberMasked`（font-mono）与 `pages.cards.resume` 按钮。
- 卡片网格 `<section data-card-list className="grid min-w-0 gap-4 sm:grid-cols-2">`：是网格 `<div>`，不是 `<ul>/<li>`；每张卡是 `<div data-card-id={id}>` 包一个 `<CardTile card footer />`。
- `footer` 是靠右排列的 `<div>`，内含 `data-card-consume`、`data-card-delete` 两个 `<span>` 包 `Button`。
卡片列表为空时渲染 `EmptyState`：标题/描述分别落在 `<div>` 与 `<p>`，既不是 heading 角色也没有 data 钩子，只能按文本定位。
`EmptyState` 自身没有 `role`/`data-*`；`CardTile` 内部除 `data-card-*` 之外没有任何 `data-*`、`aria-*`、`role`、`id` 属性，标题用的是 `<div>` 而非 heading。
`CardTile` 的段落依次为：卡类型+`card.network`（`text-sm` 的 `<div>`，形如“借记卡 · UnionPay”）、`numberMasked`（font-mono `<div>`）、状态 `Badge`（可加“已补卡”`Badge`）、不可用提示 `Badge`、CREDIT 的 `<dl>`（`business.cards.limit`/`business.cards.available`）、关联账户行（label `<span>` + 值 `<span>`，非 `<dt>`）、账户余额 `<dl>`（`business.cards.accountBalance`/`business.cards.usableBalance`）、绑定异常提示 `<p>`、月限额行（label `<span>`）、分类限额 `<ul>/<li>`（`business.cards.categoryLimits` 标题为 `<div>`）。
金额一律经 `ui/Money` 渲染成 `¥1,800.00` 形式（千分位 + `¥`，`lib/money.ts#formatCNY`），断言金额必须含该格式。
`CardConsumeDialog` 打开时在 `data-card-consume-dialog` 内**再渲染一个 `CardTile`（仅传 `card`，无 `footer`/`className`）**，因此同一张卡的卡号与限额文本在页面上会同时存在两份（网格内 + 弹窗内）。
弹窗标题为 `<h2 id="card-change-title">` / `<h2 id="card-consume-title">`，`dialog` 用 `aria-labelledby` 指向它们；字段名固定为 `type`、`creditLimit`、`monthlyLimit`、`confirmed`、`code`、`amount`、`category`、`merchant`。
`AppShell` 侧栏导航链接也渲染 `app.cards`＝“卡片”，与页面 `<h1>` 同文本，故按文本定位必须限定 `main h1` 或 `[data-card-list]`。

## 命令边界

卡片新增与删除是模拟记录管理，只在页面办理，助手不能调用。
冻结、解冻、挂失、补卡与分类限额调整走独立工具策略。
虚拟卡申请与挂失卡补办可由助手发起，与其他敏感操作一样需要确认和验证码。
手动申请使用 security/manual-card-management.ts：服务端要求 RED 验证、所有权检查与强制审计。

## CardView 原样直传

`CardView` 由服务端投影，页面层不挑字段、不补默认值。
`linkedAccountStatus` 为 `MISSING`/`UNTRUSTED` 时账号与余额字段整体缺失，界面绝不补 0，也不兜底成默认账户。
`linkedAccountName`、`linkedAccountNumber`、`accountAvailableBalance`、`payableAmount` 只在 `LINKED` 时出现。
关联账户、账户余额、可用余额与不可用提示的唯一渲染处是 `components/banking/CardTile`；本目录只传 `card` 与 `footer`。
页面层复用 `cardSupportsConsumption` 与 `cardCanConsume`。
信用卡隐藏消费按钮，显示 `pages.cards.creditConsumeUnsupported`。
借记卡与虚拟卡只有在 `usable` 且 `linkedAccountStatus === 'LINKED'` 时可消费。
打开弹窗、提交表单和服务端消费都检查卡片类型。

## 消费弹窗

摘要 `data-card-consume-summary` 只读 DTO 字符串字段，不做任何客户端计算，金额一律交给 `Money` 渲染。
关联账户行优先 `linkedAccountName`，并保留 `linkedAccountNumber`（font-mono）。
账户余额行读 `accountAvailableBalance`，可用余额行读 `payableAmount`，月限额行读 `monthlyLimit`。
不可用原因块位于摘要之前并使用 `role="status"`：卡片不可用时按 FROZEN/LOST/其它给提示，关联缺失或不可信时给对应提示。
卡片不可用只禁用提交（入口按钮、`fieldset disabled`、`submit` 守卫、提交按钮 `disabled`），余额与限额摘要照常展示。
入账时间归服务端所有；请求体只含 `amount`、可选 `category`/`merchant` 与 `executionKey`，含 `occurredAt` 会被 400 `VALIDATION` 拒绝。
消费请求由服务端注入 userId；表单不接收真实卡号、支付凭据或密码。
消费失败按错误码映射提示：资金不足、超出月限额、卡片不可消费或通用失败；VALIDATION 拒绝时展示服务端返回的原因。
忙碌状态阻止重复提交与关闭弹窗。

## 幂等

每次消费尝试按“卡片 + 金额 + 分类 + 商户”生成 `executionKey`，重试同一尝试复用，成功后重新生成。
手动申请按输入签名生成 `requestId`，网络重试保留原标识。
验证与取消使用持久化申请标识；关闭弹窗不等于取消已保存申请。
手动申请不混入助手的待确认操作恢复。

## 文案与测试钩子

本目录不内联任何中文字面量：三段组件都只调用 `useI18n().t(键)`，键由 `lib/i18n/shared.ts` 合并后才是完整表。
断言文本必须从目录文件读取，不在页面里抄：`pages.cards.*` 在 `lib/i18n/messages/pages.zh-CN.json`（第 30-74 行）、`business.cards.*` 在 `business.zh-CN.json`（第 47-69 行）、`cards.mfa.label` 在 `chat.zh-CN.json`（第 135 行）。
默认语言是 `zh-CN`（`lib/i18n/shared.ts:12`），语言 Cookie 只切换展示，不改变键到文本的映射来源。

### 首屏与水合（断言稳定性）

`page.tsx` 是服务端组件并 `export const dynamic = 'force-dynamic'`（`page.tsx:6`），首次 HTML 就带完整卡片网格，无 `loading.tsx`、无骨架屏。
`CardManager` 以服务端 `initialCards` 初始化 `cards`，随后 `useEffect` 立即并发请求 `GET /api/cards` 与 `GET /api/cards/changes` 覆盖列表；初始 `refreshing = true`、`loaded = false`，故首帧所有按钮是真 `disabled`。
`GET /api/cards/changes` 决定待办 `section[data-card-pending-changes]` 是否出现，服务端不预渲染待办。
断言前必须等 `span[data-card-add] button`、`span[data-card-refresh] button` 变为可用，否则读到的是水合前的禁用态。
卡片顺序由服务端投影决定（`lib/db/repositories/card.ts` 按 `id asc`），种子数据顺序为信用卡、借记卡、虚拟卡。
`/cards` 没有自己的 `metadata`，`<title>` 来自 `app/layout.tsx` 的 `app.brandTitle`（`万象柜坊 EvoX Omni`）；侧栏与移动端标题用 `app.cards`（`卡片`）。
语言链为 `app/layout.tsx:25` `getServerI18n()` → `LocaleProvider initialLocale` → 组件 `useI18n().t`；`resolveLocale` 只认 Cookie `banking_locale`（`lib/i18n/shared.ts:13`）的 `'en'`，其余一律 `zh-CN`，`Accept-Language` 与 `localStorage` 不参与。

### 非目录文本

卡片行的 `{类型} · {network}`（`components/banking/CardTile.tsx:82-84`）里 `network` 是 DTO 原始值，种子为 `UnionPay`（`prisma/seed.ts:295,307,320`）。
卡号是 `card.numberMasked` 原样输出（`CardTile.tsx:85-87`），种子为 `****6688` / `****8821` / `****7788`（`prisma/seed.ts:296,308,321`），4 星 4 位、无空格。
金额一律 `Money` → `formatCNY`（`lib/money.ts:79-84`）：`¥` + 千分位 + 两位小数，与语言无关，例如 `¥18,000.00`。
关联账户行是数据拼接 `{linkedAccountName} · {linkedAccountNumber}`（`CardTile.tsx:76,126`），种子为 `活期账户 · ****8821`。
分类限额的分类名是 `limit.category` 原值（`CardTile.tsx:174`），种子为 `餐饮` / `娱乐` / `购物` / `出行`。
上述文本随数据库变化，整句匹配只对固定种子数据成立。

### 页面骨架（`CardManager.tsx`）

| 键 | 元素 | ARIA role | 钩子 | 出现条件 |
| --- | --- | --- | --- | --- |
| `pages.cards.title` | `h1` | 无（默认 heading） | 无 | 恒显示 |
| `pages.cards.summary` | `h1` 同级 `p` | 无 | 无 | 恒显示，插值 `{count}` = `cards.length` |
| `pages.cards.refresh` | `Button`（secondary） | `button` | 外层 `span[data-card-refresh]` | 恒显示 |
| `pages.cards.add` | `Button` | `button` | 外层 `span[data-card-add]` | 恒显示 |
| `pages.cards.demoDescription` | 独立 `p`（`bg-banking-light` 块） | 无 | 无 | 恒显示 |
| `pages.cards.refreshFailed` | 通知 `p` | `alert` | 无 | 刷新两个接口任一失败 |
| `pages.cards.validation` / `conflict` / `locked` / `failed` | 通知 `p` | `alert` | 无 | 按响应 `error.code` 映射，`failed` 为兜底 |
| `pages.cards.verificationFailed` | 通知 `p` | `alert` | 无 | 验证被拒，插值 `{attempts}` = `attemptsLeft ?? 0` |
| `business.cards.cardFrozenNotice` / `cardLostNotice` / `cardUnavailable` | 通知 `p` | `alert` | 无 | 点开 `usable === false` 卡片的“消费”入口时按 `status` 取一 |
| `pages.cards.added` / `deleted` / `cancelled` | 通知 `p` | `status` | 无 | 变更执行或取消成功 |
| `pages.cards.pending` | `h2` | 无 | 容器 `section[data-card-pending-changes]` | 仅 `changes.length > 0` |
| `pages.cards.reviewAdd` / `reviewDelete` | 行内文本节点 | 无 | `li[data-card-pending-change-id={changeId}]` | 同上，按 `change.kind` 取一 |
| `pages.cards.locked` | 行内 `p`（`text-banking-danger`） | 无 | 同上 `li` 内 | 该变更 `status === 'locked'` |
| `pages.cards.resume` | `Button`（secondary） | `button` | 同上 `li` 内 | 同上，每行一个 |
| `pages.cards.consume` | `Button`（secondary, sm） | `button` | `span[data-card-consume]` | 仅借记卡与虚拟卡显示；`!cardCanConsume(card)` 时 disabled |
| `pages.cards.delete` | `Button`（ghost, sm） | `button` | `span[data-card-delete]` | 同上；该卡已有删除申请时 disabled |
| `pages.cards.emptyTitle` | `EmptyState` 的 `div.font-semibold` | 无（`components/ui/EmptyState.tsx` 不加 role） | 无 | 仅 `cards.length === 0` |
| `pages.cards.emptyDescription` | `EmptyState` 的 `p` | 无 | 无 | 同上 |

页面骨架顺序固定为 `header`（标题、摘要、刷新、添加）→ 演示说明 `p` → 通知 `p` → 待办 `section` → 卡片网格 `section`。
卡片网格是 `section[data-card-list]`，每张卡一个 `div[data-card-id={cardId}]`，内含 `CardTile` 与本行的两个按钮。

### 变更弹窗（`CardChangeDialog.tsx`）

根元素是 `dialog[data-card-change-dialog]`，带 `data-card-change-id`、`data-card-change-status` 与 `aria-labelledby="card-change-title"`；`data-card-change-id`/`-status` 只在复核既有变更时存在。

| 键 | 元素 | ARIA role | 钩子 / 位置 |
| --- | --- | --- | --- |
| `pages.cards.add` / `reviewAdd` / `reviewDelete` | `h2#card-change-title` | 无 | 按 `selection.kind` 与 `change.kind` 取一 |
| `pages.cards.close` | `Button`（ghost, sm） | `button` | 标题右侧 |
| `pages.cards.addDescription` / `deleteDescription` | `p` | 无 | 标题下方 |
| `pages.cards.validation` | 错误 `p` | `alert` | 本地金额校验失败时优先于 `props.error` |
| 页面通知原文（`props.error`） | 同一个错误 `p` | `alert` | 请求失败时页面通知键的插值文本被注入此处 |
| `pages.cards.type` / `creditLimit` / `monthlyLimit` | 三个 `label` | 无 | `form[data-card-add-form]` 内；`creditLimit` 仅 CREDIT |
| `pages.cards.review` | 提交按钮 / 删除确认按钮 | `button` | 添加表单内一处，删除复核一处 |
| `pages.cards.confirmDetails` | checkbox 的 `label` | 无 | `form[data-card-verification-form]` 内 |
| `cards.mfa.label` | 验证码输入 `label` | 无 | 同上 |
| `pages.cards.verificationHint` | `p`（`text-xs`） | 无 | 同上 fieldset 末尾 |
| `pages.cards.cancelChange` | `Button`（secondary） | `button` | 验证表单按钮区左侧 |
| `pages.cards.verify` | `Button`（type=submit） | `button` | 验证表单按钮区右侧 |
| `pages.cards.locked` | `p`（`text-banking-danger`） | `status` | 复核时 `change.status === 'locked'` |
| `business.cards.limit` / `business.cards.monthlyLimit` | 复核 `dl` 的 `dt` | 无 | 仅对应限额存在时 |

### 消费弹窗（`CardConsumeDialog.tsx`）

根元素是 `dialog[data-card-consume-dialog]`，带 `data-card-consume-card-id` 与 `aria-labelledby="card-consume-title"`。

| 键 | 元素 | ARIA role | 钩子 / 位置 |
| --- | --- | --- | --- |
| `pages.cards.consumeTitle` | `h2#card-consume-title` | 无 | 标题 |
| `pages.cards.close` | `Button`（ghost, sm） | `button` | 标题右侧 |
| `business.cards.cardFrozenNotice` / `cardLostNotice` / `cardUnavailable` / `linkedAccountMissing` / `linkedAccountUntrusted` | 不可用原因块内每键一个 `p` | 容器 `status` | 位于摘要之前；状态在前、关联状态在后 |
| `business.cards.linkedAccount` / `accountBalance` / `usableBalance` / `monthlyLimit` | 摘要 `dl` 的 `dt` | 无 | `dl[data-card-consume-summary]`，只在字段存在时出现 |
| `pages.cards.validation` | 通知 `p` | `alert` | 本地金额校验失败 |
| `pages.cards.consumeSuccess` | 通知 `p` | `status` | 提交成功 |
| `pages.cards.consumeInsufficient` / `consumeLimitExceeded` / `consumeUnavailable` / `consumeFailed` | 通知 `p` | `alert` | 按错误码映射，`consumeFailed` 为兜底（含记录加载失败） |
| 服务端原因原文 | 通知 `p` | `alert` | `VALIDATION` 且信封带 `error.message` 时取代目录文本（`occurredAt` 被拒即此路径） |
| `pages.cards.consumptions` | `h3` | 无 | `section[data-card-consumptions]` |
| `pages.cards.consumptionsEmpty` | `p` | 无 | `p[data-card-consumptions-empty]`，记录为空且已加载 |
| `pages.cards.consumeAmount` / `consumeCategory` / `consumeMerchant` | 三个 `label` | 无 | `form[data-card-consume-form]` 内 |
| `pages.cards.consumeSubmit` | 提交按钮 | `button` | 表单底部，`blocked` 时 disabled |

记录行是 `li[data-card-consumption={recordId}]`，商户与分类是数据字段而非文案键。

### 断言要点

`role` 与 `data-*` 钩子是稳定契约；中文字面量属于目录文件，断言必须读取目录文本或整句匹配，不得在测试里另抄一份。
含插值的键（`pages.cards.summary`、`pages.cards.verificationFailed`）必须按插值后的整句匹配。
`/cards` 上 `p[role="alert"]` 可能同时命中页面通知与弹窗错误段且文本相同，断言时用 `dialog p[role="alert"]` 或 `main > p[role="alert"]` 区分。
成功提示一律是 `role="status"`，`p[role="alert"]` 只覆盖失败与本地校验失败；不可用原因块虽用 `role="status"` 也不得改成 `alert`。

## 测试

相关 HTTP 测试在 `tests/app/card-consume-http.test.ts`、`tests/app/manual-card-management.test.ts` 与 `tests/app/card-freeze-audit-http.test.ts`。
e2e 场景在 `tests/e2e/live-virtual-card.e2e-helper.ts` 与 `tests/e2e/card-management.e2e-helper.ts`。
本目录只读这些测试，不修改测试文件；e2e 断言 `p[role="alert"]`，故不可用原因块不得改用 `role="alert"`。
金额展示规则见 [financial-values.md](../../docs/cn/financial-values.md)。
测试钩子：data-card-consume（入口）、data-card-consume-dialog、data-card-consume-card-id、data-card-consume-summary、data-card-consume-form、data-card-consumptions、data-card-consumption（记录行）、data-card-id（单个卡片容器）。
卡片变更钩子：data-card-change-dialog（含 data-card-change-id / data-card-change-status）、data-card-add-form、data-card-verification-form（`CardChangeDialog.tsx:99` 的验证表单，内含 `input[name="confirmed"]` 复选框与 `input[name="code"]`），以及列表侧 data-card-pending-changes / data-card-pending-change-id。
验证表单的验证码输入没有 `aria-label`、没有 `placeholder`，可见标签与无障碍名都来自外层 `<label>` 包裹的 `t('cards.mfa.label')`；`cards.mfa.label` 是本目录唯一的 `cards.mfa.*` 键，不渲染 `MfaCard`。
每个钩子与文案键的对应关系见上文“文案与测试钩子”三张表，本节不再重复列举。
消费相关 e2e 断言以 data-card-* 钩子定位，改动这些属性名会破坏 tests/e2e 下的场景。
`data-card-id`（值为 `card.id`）是列表里唯一的单卡定位钩子；`components/banking/CardTile` 内部没有任何 `data-*`/`aria-*`，关联账户名（`linkedAccountName · linkedAccountNumber` 合成一串）、账户余额与可用余额只能按 `dt`/`span` 标签文本在该作用域内定位。
`POST /api/cards/[id]/consume` 拒绝任何携带 `occurredAt` 的请求体（400 `VALIDATION`）：入账时间归服务端所有，界面不发送该字段，也不得补充任何客户端时间。
手动卡片验证是本目录唯一自带错误码的 MFA 面：`security/manual-card-management.ts` 熔断时抛 `AppError('CIRCUIT_OPEN')`，`_lib/http.ts` 映射为 HTTP 423 失败信封，`CardManager.tsx` 84-100 行据此把申请置为 `locked` 并显示 `pages.cards.locked`。
同一处检查的 `'LOCKED'` 不在 `ErrorCode`（`lib/errors.ts:1`）里，服务端不可能返回，属不可达分支。
助手侧 `POST /api/actions/[id]/verify` 是 200 `ok:false` + `status:'locked'`、信封无 `code`，故这套按码提示无法复用于操作卡片。
