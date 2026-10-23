# 通用界面组件

## 入口

`index.ts` 导出容器、按钮、徽标、金额、表格和对话框。
具体属性以各组件的 TypeScript 接口为准。

- `Money` 显示已入账金额。
- `DecimalMoney` 显示未结算的十进制估值：仅显示时按 HALF_UP 保留两位小数并保留符号与千分位，存储的估值保持全精度。
- `StatusBadge` 显示权限等级。
- `Dialog` 提供覆盖层、背景点击和 Escape 关闭。
- `Tabs` 与 `Button` 接收调用方交互。
- `EmptyState`、`Spinner` 展示空状态与加载状态。

`Money` 的字符串输入单位是元。
显式 `bigint` 输入单位是分。
格式化使用 `lib/money`，不接受普通数值金额。
本目录不含费用概念：12 个源文件（含 `index.ts`）无 `fee`/`Fee`/`feeAmount`/`feeRule`/`SIMULATED_NONE`，也无 手续费 / 管理费 / 费用 / 赎回费 文案。
`Money` 与 `DecimalMoney` 只有 `amount`、`signed`、`className` 三个属性，不接受单位、标签或百分比，全目录也没有 `%` 字符；
费率或费用行只能由调用方经 `title`/`footer`/`header`/`label`/`children` 自行渲染，`Table` 的“手续费”列同样须由调用方定义 `header`/`render`。
金融单位见
[financial-values.md](../../docs/cn/financial-values.md)。

## 渲染契约（选择器锚点）

本目录**不渲染任何 `data-*` / `data-testid`**（全目录 0 命中），也没有 `role="alert"`。
Playwright 选择器只能依赖可见文本、原生元素、`role` 与 class。
`Card`、`Money`、`DecimalMoney`、`Badge` 都是无 Hook、无状态的展示组件，不声明 `'use client'`，
在 DOM 中表现为普通 `<div>`/`<span>`。

`Money`（`Money.tsx:14-22`）只渲染一个 `<span className="tabular-nums [className]">`，
文本是 `lib/money.ts#formatCNY(amount)` 的完整结果，无 `data-*`、`title`、`aria-*`。
`formatCNY` 输出 `[-]¥<千分位整数>.<两位小数>`：`¥1,234.50`、`-¥0.20`（负号在 `¥` 前）、`¥0.00`；
正数自身不带 `+`。`bigint` 入参按分解释，`string` 入参按元解释且最多两位小数
（三位以上抛 `VALIDATION`，无舍入）。`signed` 为真且值严格 > 0 时前置 `+`（`Money.tsx:16`），零与负数不加。

`DecimalMoney`（`DecimalMoney.tsx:14-22`）的 `<span>` 结构与 `className` 规则和 `Money` 完全一致，
文本是 `lib/decimal.ts#formatDecimalCNY`：一次 HALF_UP 舍入到两位（`1.005` → `¥1.01`），
千分位分组，符号取**原值**符号，故 `-¥0.00` 只可能来自这里，`formatCNY` 不会产生。

`Card`（`Card.tsx:31-62`）根元素 `<div>`，class
`rounded-2xl bg-white shadow-xs ring-1 ring-black/5 overflow-hidden`；
`layout='request'` 时追加 `flex min-h-0 flex-1 flex-col`，最后接调用方 `className`。无 `role`、无 `data-*`。
头部 `<div>` 仅在 `title !== undefined || description !== undefined` 时存在（`border-b border-banking-light` + 内边距）；
`title` → `<div className="text-banking-navy font-semibold">`，是内部 `<div>`，不是标题级元素，也没有 `title` 属性；
`description` → `<div className="text-sm text-gray-500">`（有标题时追加 `mt-1`）；
`title=""` 会渲染空标题并保留头部边框与 `mt-1` 判定。
正文 `<div className="<pad> [min-h-0 overflow-y-auto overscroll-contain]">`；
`footer` → `<div className="border-t border-banking-light bg-banking-light/40 text-sm text-gray-600 <pad>">`，
仅当 `footer !== undefined` 时渲染；`footer={null}` 仍渲染一个空的页脚框。
`padding` 默认 `'md'`：`none: p-0`、`sm: p-3`、`md: p-5`、`lg: p-7`，同时作用于头部、主体、页脚。

`Badge`（`Badge.tsx:27-38`）是
`<span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium <TONE> <className>">`，
无 `role`、无 `data-*`。`tone` 默认 `neutral`：
`neutral: bg-gray-100 text-gray-700`、`info: bg-blue-50 text-banking-accent`、
`success: bg-green-50 text-banking-success`、`warn: bg-amber-50 text-banking-warn`、
`danger: bg-red-50 text-banking-danger`。
`StatusBadge` 只是把 tier 映射成 tone 后渲染 `Badge`，DOM 形态相同。

全目录仅 4 处 `role=`：`Dialog.tsx:46` `role="dialog"`、`Tabs.tsx:32` `role="tablist"`、
`Tabs.tsx:42` `role="tab"`（另 `id="tab-<id>"`）、`Spinner.tsx:24` `role="status"`（另 `aria-label`）。
其余 `aria-`：`Tabs.tsx:44` `aria-selected`、`Dialog.tsx:47` `aria-modal="true"`、
`Button.tsx:60` `aria-busy`、`Button.tsx:70` `aria-hidden`、`EmptyState.tsx:24` `aria-hidden`。

客户端边界：`Button`、`Dialog`、`StatusBadge`、`Spinner`、`Tabs` 首行为 `'use client'`；
`Money`、`DecimalMoney`、`Card`、`Badge`、`EmptyState`、`Table` 是服务端安全展示组件（无 Hook、无状态）。

## 已知问题

- `index.ts` 未导出 `DecimalMoney`（只导出 `./Money`），使用时须从 `./DecimalMoney` 直接导入。
- `rg` 工具在本仓库的默认内容输出常静默返回空结果（假阴性，已见于 `role=`、`aria-`、`tabular-nums`）；
  `-c` / `-l` 模式可信。核对属性存在性时用 `rg -c` 或直接读文件，不要据空结果下否定结论。

## 修改约束

## 渲染契约（e2e 定位）

本目录组件都不输出 `data-testid` 或任何 `data-*` 钩子，也没有 `title`/`aria-label` 透传；
e2e 只能按可见文本或结构定位。

- `Button` 渲染原生 `<button>`，`type` 默认 `button`（`Button.tsx:48,56-57`）。
  `variant` 默认 `primary`、`size` 默认 `md`，二者只切换 class。
- `disabled` 与 `loading` 都写入真实的 `disabled` 属性（`Button.tsx:53,59`），
  因此 `loading` 的按钮在 DOM 中就是 `disabled`。
- `loading` 不追加任何文案或 i18n：只插入一个 `aria-hidden="true"` 的旋转 `span`
  （`animate-spin rounded-full border-2 border-current border-t-transparent` + `h-* w-*`），
  并设置 `aria-busy="true"`；可见文本始终等于 `children`。
- `EmptyState` 根节点是 `div.flex.flex-col.items-center.justify-center.rounded-2xl.border.border-dashed`；
  `title` 渲染在没有角色语义的 `div`（`text-banking-navy font-semibold`），
  `description` 渲染为 `<p class="text-sm text-gray-500">`。
  标题不是 `h1`/`h2`，`getByRole('heading')` 定位不到。
  `description`/`icon`/`action` 为假值时不渲染该节点。
- `Money` 渲染单个 `span.tabular-nums`，文本就是 `lib/money.ts#formatCNY` 的输出
  `[±]¥#,##0.00`（千分位、恒两位小数），`¥` 与数字在同一文本节点；
  `signed` 只给正数前置 `+`。
  字符串输入单位是元，且拒绝超过两位小数的输入（`AppError('VALIDATION')`）。
- `Badge` 渲染 `span.inline-flex.items-center.rounded-full`，`tone` 默认 `neutral`。
- `Card` 结构：根 `div.rounded-2xl.bg-white.shadow-xs.ring-1.ring-black/5.overflow-hidden`（`className` 追加到根），
  有 `title`/`description` 时渲染 `div.border-b`（`title` 是 `div`，`description` 是 `div.mt-1`），
  正文是 `div.p-5`（`padding` 默认 `md`），`footer` 存在时追加
  `div.border-t.border-banking-light.bg-banking-light/40`。

## 修改约束

组件保留叶子模块的客户端边界。
`StatusBadge` 使用本地化 Hook。
不得把所有展示组件都视为服务端组件。

通用 `Dialog` 不提供焦点约束或页面滚动锁。
移动导航使用 `app/_components` 中的原生对话框。
不得用导航行为描述通用 `Dialog` 的能力。

主题来自 `app/globals.css`。
本目录不负责数据请求或业务授权。
显示测试见 `tests/unit/planner/financial-display.test.ts`。
`DecimalMoney` 的渲染字面量断言（`+¥118.91`、`-¥0.00`、`¥4,118.91` 等）在
`tests/unit/planner/decimal-format.test.ts`，可直接作为选择器文本锚点。
