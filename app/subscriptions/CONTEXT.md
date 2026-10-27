# 订阅页面

`page.tsx` 按请求读取有效订阅。
数据来自 `banking.subscription.listSubscriptions`。
页面展示订阅明细、年度费用估算与提醒数量。
汇总面板按内容区宽度调整列数，金额保持完整显示。
明细使用分隔线列表，费用与状态在行首，扣费时间和提醒状态在下一行。

年度费用按扣费周期换算。
月度、季度、年度分别按 12、4、1 次计费。
计算使用整数分，显示使用精确金额字符串。
年度费用只是按当前记录估算。

取消订阅与修改提醒通过助手办理。
这些操作采用工具目录中的确认策略。
页面读取列表不会代替用户确认。

订阅组件见
[components/banking/CONTEXT.md](../../components/banking/CONTEXT.md)。
权限定义见
[agent/tools/CONTEXT.md](../../agent/tools/CONTEXT.md)。
