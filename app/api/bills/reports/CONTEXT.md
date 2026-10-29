# 账单报告接口

`GET /api/bills/reports` 返回固定演示用户的月度或年度报告。
身份必须取自服务端配置，不得接受请求指定的用户。
读取前必须检查可信访问地址，重复或无效参数必须返回错误。
业务读取只调用 `banking.report.getBillReport`。

`format=json` 返回现有成功封装；`csv`、`html` 和 `pdf` 返回下载文件。
响应必须设置 `private, no-store` 与 `nosniff`。
HTML 必须使用脚本禁用策略；文字必须转义。
CSV 的不可信文字必须防止公式执行。
文件名只能使用经过检查的报告周期。
`analysis/route.ts` 只接受周期与语言，不接受客户端提交的流水、分析或用户。
POST 必须先检查同源请求，再读取服务端报告。
GET 只能读取匹配快照的分析缓存，不得调用模型。

格式与统计口径见 [bill-reports.md](../../../../docs/cn/bill-reports.md)。
