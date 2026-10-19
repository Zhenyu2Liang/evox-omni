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

组件保留叶子模块的客户端边界。
`StatusBadge` 使用本地化 Hook。
不得把所有展示组件都视为服务端组件。

通用 `Dialog` 不提供焦点约束或页面滚动锁。
移动导航使用 `app/_components` 中的原生对话框。
不得用导航行为描述通用 `Dialog` 的能力。

主题来自 `app/globals.css`。
本目录不负责数据请求或业务授权。
显示测试见 `tests/unit/planner/financial-display.test.ts`。
