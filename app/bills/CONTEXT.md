# 账单页面

## 数据与显示

`page.tsx` 是按请求渲染的服务端页面。
页面直接调用 `banking.transaction` 读取数据。

- `analyzeSpending` 提供月度消费与分类统计。
- `listTransactions` 使用该月的半开时间范围。
- `listAnomalies` 的结果按同一时间范围过滤。

月份来自异步 `searchParams` 的 `month`。
有效格式为 `YYYY-MM`。
缺失或格式无效时使用演示业务月份。
页面已提供月份表单、分类图、趋势图与流水表。

图表使用 `components/charts` 的原生 SVG 组件。
账单页面只显示一张完整趋势图，不再重复显示相同数据的缩略曲线。
分类环图和柱图共用蓝绿、杏橙、灰紫、豆沙和鼠尾草绿等配色。
趋势线带浅蓝绿面积填充，与暖白页面背景区分。
月度支出金额使用深暖灰。朱红只强调页面标题细线、查询按钮和图表聚焦点。
颜色不代表新的风险判断。
金额显示使用 `Money` 与 `formatCNY`。
金额和比例计算使用精确金融工具。
异常标记不改变已入账消费总额。

## 修改约束

页面只读取业务数据。
异常处理动作必须调用所属业务入口。
日期与金额规则见
[financial-values.md](../../docs/cn/financial-values.md)。
图表约束见
[components/charts/CONTEXT.md](../../components/charts/CONTEXT.md)。
