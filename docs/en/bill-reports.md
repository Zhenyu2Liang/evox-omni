# Monthly and Annual Bill Reports

**English** | [简体中文](../cn/bill-reports.md)

Bill reports support viewing by month and by year, can generate model analysis, and can be exported as PDF, HTML, or details.
The entry point is "View Bill Report" on the bills page, at the address `/bills/reports`.

## Viewing Reports

1. Select "Monthly Report" or "Annual Report".
2. Select a month or enter a year, then select "View Report".
3. View the fund summary, spending categories, trends, and transaction details.

The month format is `YYYY-MM`, and the year range is 1000–9999.
When no date is specified, the demo business date is used, currently September 2026.
Invalid or mixed period parameters display an error form and do not query a different period.
The page supports Chinese, English, light and dark themes.

Details are sorted by transaction time from newest to oldest, with 50 entries per page.
Previous page and next page preserve the report period.
Empty reports can still be viewed and exported, with amounts displayed as zero.

## Amount and Date Conventions

Reports count only the current demo user's posted RMB transactions.
The business calendar is fixed as `Asia/Shanghai` and does not change with the deployment host's time zone.
The time range includes the start moment and excludes the end moment.
Monthly reports cover a calendar month; annual reports run from January 1 to January 1 of the following year.

| Metric | Convention |
| --- | --- |
| Fund inflow | Sum of the absolute values of amounts of `CREDIT` transactions, including investment redemptions |
| Fund outflow | Sum of the absolute values of amounts of `DEBIT` transactions, including investment subscriptions |
| Net inflow | Fund inflow minus fund outflow; does not represent investment returns |
| Consumption spending | Sum of debit transaction amounts whose category is not `投资`, consistent with the existing monthly consumption analysis |
| Suspicious transaction count | Number of transactions in the period still carrying an anomaly flag; amounts are still included in the summary |
| Consumption share | Category consumption divided by period consumption, kept to two decimal places |

After rounding, the shares may not sum to 100%.
Monthly reports start from the beginning of the month and aggregate trends every 7 days, with the final segment retaining the remaining days.
For example, September displays `01-07`, `08-14`, `15-21`, `22-28`, `29-30`.
The SDK and JSON interfaces still retain daily data, including non-transaction dates and leap days.
Annual reports are displayed by month, with 12 points in total.
The trend chart uses blue for inflow and purple for outflow, consistent between the page and exports.
Consumption change rates are compared with the previous month and the previous year respectively.
When prior-period consumption is zero, the change rate is empty.

Amounts are summed using integer cents, and boundaries return strings with two decimal places.
Chart coordinates use displayed values and cannot be used in reverse for aggregation.
Reports reflect transactions at read time; no frozen version is saved, and no balance or future returns are projected.

## Export

- "Export PDF": directly download a PDF containing charts, data summary, and generated analysis.
- "Export CSV": download all transaction details for the selected period, to be opened with tools such as Excel.
- "Export HTML": download the complete report containing embedded charts, data summary, and generated analysis.

Exports are not affected by the page's 50 entries per page or the interactive query limit of 200 entries.
CSV uses UTF-8 BOM, and amounts are exact decimals with signs.
Fields are uniformly quoted; text that could trigger a formula has a leading single quote added.
Original merchants, categories, and notes remain in the database.
HTML charts are embedded SVG and still display when opened offline.
HTML escapes text, includes print styles, and does not execute scripts.
PDF uses the same charts and analysis, laid out in A4 portrait, with details starting on a new page.
Currently `.xlsx` files are not provided.

## Generating Analysis

Select "Generate Analysis" on the report page to generate consumption observations and suggestions for the period.
Normal viewing and export do not automatically call the model.
Reports with no transactions do not call the model.

The model receives only the fund summary, prior-period comparison, main consumption categories, and suspicious transaction count.
The model does not receive complete transaction details, merchants, notes, account numbers, or conversation history, and has no banking tools.
All amounts and ratios are still provided by the server; the model generates only textual interpretation.
Results that are incomplete, contain fabricated values, or claim completed actions are not saved.

Analysis is saved by owning user, data snapshot, language, and model configuration.
Repeated viewing, clicking, or exporting reuses the completed result.
After transactions or anomaly flags change, the old analysis is no longer attached to the new report.
When multiple pages generate simultaneously, only one request is allowed to hold the generation right.
After a failure, an explicit retry is possible; normal downloads do not retry the model.

Each generation allows at most 2 model HTTP requests, 16000 reserved tokens, and 45 seconds.
The output limit is 1800 tokens; stricter global configuration continues to apply.
The budget is written to `BillReportAnalysis.budgetJson` before the request is sent.
`LLM_MODE=mock` returns an offline result explicitly labeled "simulated analysis".

## PDF Runtime Requirements

The PDF service uses the local Chrome, Edge, or Chromium and requires no model calls.
`BANKING_PDF_BROWSER_PATH` can be used to specify the browser executable path.
When not set, common installation locations are checked.
The deployment environment must provide a browser; the application does not automatically download browsers.
PDF rendering disables scripts and network requests, and each service process handles at most 2 files simultaneously.

## HTTP and Code Entry Points

```text
GET /api/bills/reports?period=month&month=2026-09
GET /api/bills/reports?period=year&year=2026&format=csv&locale=zh-CN
GET /api/bills/reports?period=year&year=2026&format=html&locale=en
GET /api/bills/reports?period=month&month=2026-09&format=pdf&locale=zh-CN
POST /api/bills/reports/analysis
```

`format` supports `json`, `csv`, `html`, `pdf`, defaulting to `json`.
`locale` supports `zh-CN`, `en`, defaulting to Chinese.
JSON uses the existing `{ ok, data }` response wrapper, and amounts remain strings.
CSV, HTML, and PDF return the downloaded file directly on success and return an error wrapper on failure.
Responses prohibit caching, and download filenames contain only the checked period.
Duplicate, unknown, or mixed parameters return `400 VALIDATION`.
Request parameters cannot select another user.

Business reads are provided by [bill-report.ts](../../banking-sdk/bill-report.ts).
A single query within the owning user's scope reads current-period and prior-period transactions, then computes all results.
CSV is handled by [bill-report-export.ts](../../lib/bill-report-export.ts).
Charts and summary display share [bill-report-presentation.ts](../../lib/bill-report-presentation.ts).
HTML and PDF are generated by [bill-report-html.ts](../../lib/bill-report-html.ts) and
[bill-report-pdf.ts](../../lib/bill-report-pdf.ts) respectively.
The page and interface are located at the [report page](../../app/bills/reports/page.tsx) and
[report interface](../../app/api/bills/reports/route.ts).
The analysis POST accepts `{ query: { period, month 或 year }, locale }`.
Model generation and budget are handled by [bill-report-analysis.ts](../../agent/bill-report-analysis.ts).
Reports do not modify bank transactions, balances, or authorization status.
The existing `analyze_spending` tool continues to provide monthly consumption analysis.

## Regression Testing

```sh
pnpm exec vitest run tests/unit/banking-sdk/bill-report.test.ts tests/integration/bill-reports-http.test.ts
pnpm exec vitest run tests/unit/bill-report-presentation.test.ts tests/integration/bill-report-analysis.test.ts
pnpm exec tsx tests/e2e/bill-reports.e2e.ts
```

SDK and HTTP tests cover amount precision, period boundaries, user and currency isolation, complete export, and text escaping.
Browser tests use an independent `prisma/bill-report-e2e.db`.
By default, `.next-build` is built first, then the production-mode test service is started.
When the latest build already exists, `E2E_SERVER_MODE=production` can be set to reuse it.
The test database is rebuilt at runtime to verify forms, pagination, downloads, printing, and empty states.
UI acceptance includes mobile layout, English, dark theme, and keyboard switching.
Screenshots and execution results are written to `logs/bill-reports/`.
By default, the simulated model is used and no real banking service is connected.
Setting `BILL_REPORT_LIVE=1` verifies real model analysis.
Real model scenarios still use an independent test database and check HTTP 200 and the saved request budget.

First version verification: all 346 test files and 3314 tests in the repository passed.
After the 2026-10-29 update, all 348 test files and 3328 tests in the repository passed.
Then 55 special supplementary tests were completed.
The 11 browser scenarios for the simulated model and the real model passed respectively.
PDF Chinese, charts, pagination, and 232 annual details have been checked.
Build, type checking, and targeted ESLint passed.
Execution results are saved in `logs/bill-reports/`.
