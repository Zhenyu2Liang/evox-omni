# 卡片页面

## 职责

`page.tsx` 按请求读取演示用户的卡片，交给 `CardManager` 组合界面。
`CardManager.tsx` 承载卡片列表、手动申请恢复、刷新、消费入口与消费弹窗。
`CardChangeDialog.tsx` 展示新增、删除、验证与取消。
`CardConsumeDialog.tsx` 展示单卡消费表单与该卡消费记录。

## 数据来源

服务端用 `banking.card.getCards(demoUserId)` 投影 `CardView[]`，作为 `CardManager` 的初始 props。
客户端刷新只走 `GET /api/cards` 与 `GET /api/cards/changes`，只采用最新请求序号的响应。
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
- `footer` 是右对齐 `<div>`，内含 `data-card-consume`、`data-card-delete` 两个 `<span>` 包 `Button`。
卡片列表为空时渲染 `EmptyState`：标题/描述分别落在 `<div>` 与 `<p>`，既不是 heading 角色也没有 data 钩子，只能按文本定位。
`EmptyState` 自身没有 `role`/`data-*`；`CardTile` 内部除 `data-card-*` 之外没有任何 `data-*`、`aria-*`、`role`、`id` 属性，标题用的是 `<div>` 而非 heading。
`CardTile` 的段落依次为：卡类型+`card.network`（`text-sm` 的 `<div>`，形如「借记卡 · UnionPay」）、`numberMasked`（font-mono `<div>`）、状态 `Badge`（可加「已补卡」`Badge`）、不可用提示 `Badge`、CREDIT 的 `<dl>`（`business.cards.limit`/`business.cards.available`）、关联账户行（label `<span>` + 值 `<span>`，非 `<dt>`）、账户余额 `<dl>`（`business.cards.accountBalance`/`business.cards.usableBalance`）、绑定异常提示 `<p>`、月限额行（label `<span>`）、分类限额 `<ul>/<li>`（`business.cards.categoryLimits` 标题为 `<div>`）。
金额一律经 `ui/Money` 渲染成 `¥1,800.00` 形式（千分位 + `¥`，`lib/money.ts#formatCNY`），断言金额必须含该格式。
`CardConsumeDialog` 打开时在 `data-card-consume-dialog` 内**再渲染一个 `CardTile`（仅传 `card`，无 `footer`/`className`）**，因此同一张卡的卡号与限额文本在页面上会同时存在两份（网格内 + 弹窗内）。
弹窗标题为 `<h2 id="card-change-title">` / `<h2 id="card-consume-title">`，`dialog` 用 `aria-labelledby` 指向它们；字段名固定为 `type`、`creditLimit`、`monthlyLimit`、`confirmed`、`code`、`amount`、`category`、`merchant`。
`AppShell` 侧栏导航链接也渲染 `app.cards`＝「卡片」，与页面 `<h1>` 同文本，故按文本定位必须限定 `main h1` 或 `[data-card-list]`。

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
页面层只读 `usable` 与 `linkedAccountStatus`，用于决定入口按钮、弹窗提示与表单可用态。

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

## 测试

相关 HTTP 测试在 `tests/app/card-consume-http.test.ts`、`tests/app/manual-card-management.test.ts` 与 `tests/app/card-freeze-audit-http.test.ts`。
e2e 场景在 `tests/e2e/live-virtual-card.e2e-helper.ts` 与 `tests/e2e/card-management.e2e-helper.ts`。
本目录只读这些测试，不修改测试文件；e2e 断言 `p[role="alert"]`，故不可用原因块不得改用 `role="alert"`。
金额展示规则见 [financial-values.md](../../docs/cn/financial-values.md)。
测试钩子：data-card-consume（入口）、data-card-consume-dialog、data-card-consume-card-id、data-card-consume-summary、data-card-consume-form、data-card-consumptions、data-card-consumption（记录行）、data-card-id（单个卡片容器）。
消费相关 e2e 断言以 data-card-* 钩子定位，改动这些属性名会破坏 tests/e2e 下的场景。
`POST /api/cards/[id]/consume` 拒绝任何携带 `occurredAt` 的请求体（400 `VALIDATION`）：入账时间归服务端所有，界面不发送该字段，也不要补充任何客户端时间。
手动卡片验证是本目录唯一自带错误码的 MFA 面：`security/manual-card-management.ts` 熔断时抛 `AppError('CIRCUIT_OPEN')`，`_lib/http.ts` 映射为 HTTP 423 失败信封，`CardManager.tsx` 84-100 行据此把申请置为 `locked` 并显示 `pages.cards.locked`。
同一处检查的 `'LOCKED'` 不在 `ErrorCode`（`lib/errors.ts:1`）里，服务端不可能返回，属不可达分支。
助手侧 `POST /api/actions/[id]/verify` 是 200 `ok:false` + `status:'locked'`、信封无 `code`，故这套按码提示无法复用于操作卡片。
