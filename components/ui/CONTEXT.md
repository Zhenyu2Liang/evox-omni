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
金融单位见
[financial-values.md](../../docs/cn/financial-values.md)。

## 渲染结构（供 DOM / Playwright 断言）

`Card`、`Money`、`Badge` 都是无 Hook、无状态的展示组件，不声明 `'use client'`，
在 DOM 中表现为普通 `<div>`/`<span>`。
本目录没有任何 `data-*` 属性（包括 `data-testid`）；
`aria-*`/`role` 只出现在 `Button`、`Dialog`、`EmptyState`、`Spinner`、`Tabs`。
对本目录组件的 DOM 断言只能用元素类型、静态 className 与文本内容。

`Card` 根节点是 `<div>`（`rounded-2xl bg-white shadow-xs ring-1 ring-black/5 overflow-hidden`，
`layout='request'` 时追加 `flex min-h-0 flex-1 flex-col`，最后接调用方 `className`）。
头部 `<div>` 仅在 `title !== undefined || description !== undefined` 时存在
（`border-b border-banking-light` + 内边距）；
标题渲染为内部 `<div class="text-banking-navy font-semibold">`，不是标题级元素，也没有 `title` 属性；
描述为 `text-sm text-gray-500`（有标题时追加 `mt-1`）。
`children` 包在带内边距的 `<div>` 中（`request` 布局追加 `min-h-0 overflow-y-auto overscroll-contain`）。
页脚 `<div>` 仅在 `footer !== undefined` 时存在（`border-t border-banking-light bg-banking-light/40 text-sm text-gray-600`）；
`footer={null}` 仍渲染一个空的页脚框，只有省略（`undefined`）才完全不存在。
同理 `title=""` 会渲染空标题并保留头部边框与 `mt-1` 判定。
`padding` 默认 `'md'`，映射 `none→p-0`、`sm→p-3`、`md→p-5`、`lg→p-7`，同时作用于头部、主体、页脚。

`Money` 渲染单个 `<span class="tabular-nums …">`，`className` 追加在后，无 `data-*`、`title`、`aria-*`。
文本来自 `lib/money.ts#formatCNY`：`¥` + 千分位整数 + 两位小数，
负数前缀 `-`（如 `-¥1,234.56`），零为 `¥0.00`；
`signed` 只在金额严格大于 0 时前置 `+`，与 `formatCNY` 组合成 `+¥1,234.56`，零与负数不加 `+`。
`DecimalMoney` 的 `<span>` 结构与 `className` 规则和 `Money` 完全一致，只有格式化函数不同。

`Badge` 渲染单个 `<span class="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium …">`，
再接 tone 类与 `className`；`tone` 默认 `'neutral'`，映射
`neutral→bg-gray-100 text-gray-700`、`info→bg-blue-50 text-banking-accent`、
`success→bg-green-50 text-banking-success`、`warn→bg-amber-50 text-banking-warn`、
`danger→bg-red-50 text-banking-danger`；无 `data-*`/`role`/`aria-*`。
`StatusBadge` 只是把 tier 映射成 tone 后渲染 `Badge`，DOM 形态相同。

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
