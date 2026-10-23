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

## 渲染契约（选择器锚点）

本目录**不渲染任何 `data-*` / `data-testid`**（全目录 0 命中），也没有 `role="alert"`。
Playwright 选择器只能依赖可见文本、原生元素、`role` 与 class。

- `Money`（`Money.tsx:14-22`）只渲染一个 `<span className="tabular-nums [className]">`，
  文本是 `lib/money.ts#formatCNY(amount)` 的完整结果，无 `title`。
  `formatCNY` 输出 `[-]¥<千分位整数>.<两位小数>`：`¥1,234.50`、`-¥0.20`（负号在 `¥` 前）、`¥0.00`；
  正数自身不带 `+`。`bigint` 入参按分解释，`string` 入参按元解释且最多两位小数
  （三位以上抛 `VALIDATION`，无舍入）。`signed` 为真且值严格 > 0 时前置 `+`（`Money.tsx:16`）。
- `DecimalMoney`（`DecimalMoney.tsx:14-22`）同样只渲染 `<span className="tabular-nums [className]">`，
  文本是 `lib/decimal.ts#formatDecimalCNY`：一次 HALF_UP 舍入到两位（`1.005` → `¥1.01`），
  千分位分组，符号取**原值**符号，故 `-¥0.00` 只可能来自这里，`formatCNY` 不会产生。
- `Card`（`Card.tsx:31-62`）根元素 `<div>`，class
  `rounded-2xl bg-white shadow-xs ring-1 ring-black/5 overflow-hidden`，无 `role`、无 `data-*`。
  `title` → `<div className="text-banking-navy font-semibold">`；
  `description` → `<div className="text-sm text-gray-500">`（有标题时追加 `mt-1`）；
  正文 `<div className="<pad> [min-h-0 overflow-y-auto overscroll-contain]">`；
  `footer` → `<div className="border-t border-banking-light bg-banking-light/40 text-sm text-gray-600 <pad>">`，
  仅当 `footer !== undefined` 时渲染。`padding`：`none: p-0`、`sm: p-3`、`md: p-5`（默认）、`lg: p-7`。
- `Badge`（`Badge.tsx:27-38`）是
  `<span className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium <TONE> <className>">`，
  无 `role`、无 `data-*`。`tone` 默认 `neutral`：
  `neutral: bg-gray-100 text-gray-700`、`info: bg-blue-50 text-banking-accent`、
  `success: bg-green-50 text-banking-success`、`warn: bg-amber-50 text-banking-warn`、
  `danger: bg-red-50 text-banking-danger`。
- 全目录仅 4 处 `role=`：`Dialog.tsx:46` `role="dialog"`、`Tabs.tsx:32` `role="tablist"`、
  `Tabs.tsx:42` `role="tab"`（另 `id="tab-<id>"`）、`Spinner.tsx:24` `role="status"`（另 `aria-label`）。
  其余 `aria-`：`Tabs.tsx:44` `aria-selected`、`Dialog.tsx:47` `aria-modal="true"`、
  `Button.tsx:60` `aria-busy`、`Button.tsx:70` `aria-hidden`、`EmptyState.tsx:24` `aria-hidden`。
- 客户端边界：`Button`、`Dialog`、`StatusBadge`、`Spinner`、`Tabs` 首行为 `'use client'`；
  `Money`、`DecimalMoney`、`Card`、`Badge`、`EmptyState`、`Table` 是服务端安全展示组件（无 Hook、无状态）。

## 已知问题

- `index.ts` 未导出 `DecimalMoney`（只导出 `./Money`），使用时须从 `./DecimalMoney` 直接导入。
- `rg` 工具在本仓库的默认内容输出常静默返回空结果（假阴性，已见于 `role=`、`aria-`、`tabular-nums`）；
  `-c` / `-l` 模式可信。核对属性存在性时用 `rg -c` 或直接读文件，不要据空结果下否定结论。

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
