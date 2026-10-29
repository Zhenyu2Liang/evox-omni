# 账单报告页面

`page.tsx` 按请求读取 `banking.report.getBillReport`。
`ReportFilters.tsx` 只管理月度与年度切换状态，通过 GET 表单查询。
月报展示由 `reportDisplayTrend` 每 7 天汇总，SDK 按日数据不变。
页面与 HTML/PDF 必须共用 `reportTrendSvg`，文字必须转义。
趋势流入使用蓝色 `banking-flow-in`，流出使用紫色 `banking-flow-out`。
明暗主题与离线导出必须保持相同的系列含义。
SVG 使用的系列颜色必须在 `@theme static` 中声明，避免被 Tailwind 清除。
`ReportAnalysis.tsx` 只能在点击时发送生成请求。
分析必须按数据快照与语言隔离，普通查看和下载不得自动调用模型。
字段必须有可访问标签，控件必须支持键盘和明暗主题。
报告文案必须使用 `pages.reports.*`，界面语言来自现有语言设置。

页面每页显示 50 笔明细，翻页保留周期。
明细的 `description` 必须传给最右侧的 `TransactionRemark` 备注列，空备注显示“—”。
导出链接不带页码，必须包含当前报告周期及语言。
PDF 与 HTML 必须附带当前快照的已保存分析。
无效周期必须显示错误表单，不得悄悄扩大查询范围。
空报告必须保留日期表单和导出入口。
金额使用 `formatCNY`，图表数值转换只能用于坐标。

接口位于 `app/api/bills/reports/route.ts`。
业务口径与测试入口见 [bill-reports.md](../../../docs/cn/bill-reports.md)。
