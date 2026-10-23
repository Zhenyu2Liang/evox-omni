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
