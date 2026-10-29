# 月度与年度账单报告

账单报告支持按月、按年查看，可生成模型分析并导出 PDF、HTML 或明细。
入口为账单页的“查看账单报告”，地址是 `/bills/reports`。

## 查看报告

1. 选择“月度报告”或“年度报告”。
2. 选择月份或输入年份，再选择“查看报告”。
3. 查看资金汇总、消费分类、趋势与交易明细。

月份格式为 `YYYY-MM`，年份范围为 1000–9999。
未指定日期时使用演示业务日期，当前为 2026 年 9 月。
无效或混用的周期参数会显示错误表单，不会改查其他周期。
页面支持中文、英文、浅色和深色主题。

明细按交易时间从新到旧排列，每页 50 笔。
上一页和下一页保留报告周期。
空报告仍可查看与导出，金额显示为零。

## 金额与日期口径

报告只统计当前演示用户的人民币已入账流水。
业务日历固定为 `Asia/Shanghai`，不随部署主机时区改变。
时间范围包含开始时刻，不包含结束时刻。
月报覆盖自然月，年报覆盖 1 月 1 日至下一年 1 月 1 日。

| 指标 | 口径 |
| --- | --- |
| 资金流入 | `CREDIT` 流水的金额绝对值之和，包含投资赎回 |
| 资金流出 | `DEBIT` 流水的金额绝对值之和，包含投资申购 |
| 净流入 | 资金流入减资金流出，不代表投资收益 |
| 消费支出 | 分类不是 `投资` 的借记流水金额之和，与现有月度消费分析一致 |
| 可疑交易数 | 本期仍带异常标记的流水条数，金额仍计入汇总 |
| 消费占比 | 分类消费除以本期消费，保留两位小数 |

占比舍入后，其和可能不等于 100%。
月报从月初开始，每 7 天汇总趋势，末段保留剩余日期。
例如 9 月显示 `01-07`、`08-14`、`15-21`、`22-28`、`29-30`。
SDK 与 JSON 接口仍保留按日数据，包含无交易日期与闰日。
年报按月展示，共 12 个点。
趋势图以蓝色表示流入、紫色表示流出，页面与导出保持一致。
消费变化率分别与上月、上年比较。
上期消费为零时，变化率为空。

金额使用整数分求和，边界返回两位小数的字符串。
图表坐标使用展示数值，不能反向参与汇总。
报告反映读取时的流水，不保存冻结版本，也不推算余额或未来收益。

## 导出

- “导出 PDF”：直接下载含图表、数据摘要与已生成分析的 PDF。
- “导出 CSV”：下载所选周期的全部交易明细，用 Excel 等工具打开。
- “导出 HTML”：下载含内嵌图表、数据摘要与已生成分析的完整报告。

导出不受页面每页 50 笔或交互查询 200 笔上限影响。
CSV 使用 UTF-8 BOM，金额为带正负号的精确小数。
字段统一加引号；可能触发公式的文字增加前导单引号。
原始商户、分类和备注仍保留在数据库中。
HTML 图表为内嵌 SVG，离线打开仍可显示。
HTML 对文本转义，包含打印样式，不执行脚本。
PDF 使用同一份图表和分析，按 A4 纵向排版，明细另起一页。
当前不提供 `.xlsx` 文件。

## 生成分析

在报告页面选择“生成分析”，生成本期消费观察与建议。
普通查看与导出不会自动调用模型。
无交易的报告不调用模型。

模型只接收资金汇总、上期比较、主要消费分类和可疑交易数。
模型不接收完整流水、商户、备注、账号或对话历史，也没有银行工具。
所有金额和比例仍由服务端提供，模型只生成文字解读。
不完整、带虚构数值或操作完成声明的结果不会保存。

分析按所属用户、数据快照、语言和模型配置保存。
重复查看、点击或导出复用已完成结果。
流水或异常标记变化后，旧分析不再附到新报告。
多个页面同时生成时，只允许一个请求持有生成权。
失败后可显式重试，普通下载不会重试模型。

每次生成最多允许 2 次模型 HTTP 请求、16000 个预留 token 和 45 秒。
输出上限为 1800 token；更严格的全局配置继续生效。
预算在请求发出前写入 `BillReportAnalysis.budgetJson`。
`LLM_MODE=mock` 返回明确标为“模拟分析”的离线结果。

## PDF 运行条件

PDF 服务使用本机的 Chrome、Edge 或 Chromium，无需模型调用。
可用 `BANKING_PDF_BROWSER_PATH` 指定浏览器可执行文件路径。
未设置时检查常见安装位置。
部署环境必须提供浏览器，应用不会自动下载浏览器。
PDF 渲染禁用脚本和网络请求，每个服务进程同时最多处理 2 份文件。

## HTTP 与代码入口

```text
GET /api/bills/reports?period=month&month=2026-09
GET /api/bills/reports?period=year&year=2026&format=csv&locale=zh-CN
GET /api/bills/reports?period=year&year=2026&format=html&locale=en
GET /api/bills/reports?period=month&month=2026-09&format=pdf&locale=zh-CN
POST /api/bills/reports/analysis
```

`format` 支持 `json`、`csv`、`html`、`pdf`，默认 `json`。
`locale` 支持 `zh-CN`、`en`，默认中文。
JSON 使用现有 `{ ok, data }` 响应封装，金额仍为字符串。
CSV、HTML 和 PDF 成功时直接返回下载文件，失败时返回错误封装。
响应禁止缓存，下载文件名只包含经过检查的周期。
重复、未知、混用参数返回 `400 VALIDATION`。
请求参数不能选择其他用户。

业务读取由 [bill-report.ts](../../banking-sdk/bill-report.ts) 提供。
一次所属用户范围内的查询读取本期与上期流水，再计算全部结果。
CSV 由 [bill-report-export.ts](../../lib/bill-report-export.ts) 负责。
图表与汇总展示共用 [bill-report-presentation.ts](../../lib/bill-report-presentation.ts)。
HTML 和 PDF 分别由 [bill-report-html.ts](../../lib/bill-report-html.ts)、
[bill-report-pdf.ts](../../lib/bill-report-pdf.ts) 生成。
页面和接口分别位于[报告页面](../../app/bills/reports/page.tsx)与
[报告接口](../../app/api/bills/reports/route.ts)。
分析 POST 接收 `{ query: { period, month 或 year }, locale }`。
模型生成与预算由 [bill-report-analysis.ts](../../agent/bill-report-analysis.ts) 负责。
报告不修改银行流水、余额或授权状态。
现有 `analyze_spending` 工具继续提供月度消费分析。

## 回归测试

```sh
pnpm exec vitest run tests/unit/banking-sdk/bill-report.test.ts tests/integration/bill-reports-http.test.ts
pnpm exec vitest run tests/unit/bill-report-presentation.test.ts tests/integration/bill-report-analysis.test.ts
pnpm exec tsx tests/e2e/bill-reports.e2e.ts
```

SDK 与 HTTP 测试覆盖金额精度、周期边界、用户与币种隔离、完整导出和文本转义。
浏览器测试使用独立的 `prisma/bill-report-e2e.db`。
默认先构建 `.next-build`，再启动生产模式测试服务。
已有最新构建时，可设置 `E2E_SERVER_MODE=production` 复用。
运行时重建该测试库，验证表单、分页、下载、打印和空状态。
界面验收包含手机布局、英文、深色主题和键盘切换。
截图和执行结果写入 `logs/bill-reports/`。
默认使用模拟模型，不连接真实银行服务。
设置 `BILL_REPORT_LIVE=1` 可验证真实模型分析。
真实模型场景仍使用独立测试库，并检查 HTTP 200 与已保存的请求预算。

首次版本验证：全库 346 个测试文件、3314 项测试通过。
2026-10-29 更新后，全库 348 个测试文件、3328 项测试通过。
随后完成 55 项专项补测。
模拟模型和真实模型的 11 个浏览器场景分别通过。
PDF 中文、图表、分页与 232 笔年度明细已核对。
构建、类型检查和专项 ESLint 通过。
执行结果保存在 `logs/bill-reports/`。
