# lJ — /cards 借记卡展示绑定结算账户余额（live round 6）

- certifies commit: `53fbde4`
- chromium: `C:\Program Files\Google\Chrome\Application\chrome.exe` (E2E_BROWSER_PATH)
- command: `LIVE_SCENARIOS=lJ pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
- EXITCODE=0
- == 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==

## screenshots

- `01-lJ-baseline-cards.png`
- `02-lJ-second-virtual-card.png`
- `03-lJ-transfer-cards.png`
- `04-lJ-transfer-overview.png`
- `05-lJ-frozen-card.png`
- `06-lJ-lost-virtual-card.png`

## PASS line (verbatim)

PASS lJ-live-debit-card-linked-account-balance — lJ 模型 deepseek-flash（/api/health llmMode=live，completed ModelRequest 6 条，其中 6 条关联到上游 completion id；示例 aa594231-0383-4b53-a281-0c2b3112cebd 取自 provider_response_event 的 payload.id，上游自报 model=deepseek-flash、system_fingerprint=e72d3c7f663d3e1383b00b3884cb4501、响应头仅 ["content-type"]/[200]）｜基线：SQLite Card.linkedAccountId(card_debit)=acct_checking → Account 活期账户/****8821 23580.00；GET /api/cards card_debit linkedAccountStatus=LINKED name=活期账户 number=****8821 accountAvailableBalance=23580.00 payableAmount=23580.00 usable=true（无信用额度字段、无卡片自有余额）；/cards DOM 行「关联账户」=「活期账户 · ****8821」「账户余额」=¥23,580.00「可用余额」=¥23,580.00 状态=「正常」；虚拟卡 card_virtual 同一余额 ¥23,580.00、可用 ¥5,000.00（月限额 5000.00）；信用卡 card_credit 只有「可用额度」=¥18,000.00、无账户行、无「关联账户」；页面无「授信额度」；第 2 张虚拟卡（自然语言「请帮我新开一张虚拟卡，月消费限额设为100元」）：cardidem_5d50fe276c3f7358ab9d508d6ca00e8e 同余额 ¥23,580.00、可用 ¥100.00，三张卡账户余额全等，checkingBalance 与 totalAssets 未变；真实业务「给张伟转12.34元」：SQLite 余额 23580.00 → 23567.66（流水 txidem_ff9529ffb6f3a3ccf2c73ba7e4d89165 -1234），/cards DOM 借记=¥23,567.66 虚拟=¥23,567.66 新虚拟=¥23,567.66，/api/cards=23567.66，/api/dashboard.checkingBalance=23567.66，/overview 含 ¥23,567.66，totalAssets 仅下降 12.34；冻结（「请把我的借记卡冻结（我确认，可随时解冻）。」）：SQLite status=FROZEN、usable=false、余额仍 ¥23,567.66、可用 ¥23,567.66，tile 逐字「已冻结」+「卡片已冻结，暂不可用于消费（余额仍可查看）」，消费按钮 disabled，同时 card_virtual 仍可用；挂失（「尾号7788的虚拟卡丢失了，请正式挂失，我确认不可撤销。」）：SQLite status=LOST、usable=false、余额仍 ¥23,567.66、可用 ¥5,000.00，tile 逐字「已挂失」+「卡片已挂失，暂不可用于消费（余额仍可查看）」，消费按钮 disabled，creditAvailable=18000.00（=非 LOST CREDIT 合计）、totalAssets 未变；截图 D:\projects\banking-agent\.genesis\workers\worker_T7_A703\output\playwright\live\01-lJ-baseline-cards.png / D:\projects\banking-agent\.genesis\workers\worker_T7_A703\output\playwright\live\02-lJ-second-virtual-card.png / D:\projects\banking-agent\.genesis\workers\worker_T7_A703\output\playwright\live\03-lJ-transfer-cards.png / D:\projects\banking-agent\.genesis\workers\worker_T7_A703\output\playwright\live\04-lJ-transfer-overview.png / D:\projects\banking-agent\.genesis\workers\worker_T7_A703\output\playwright\live\05-lJ-frozen-card.png / D:\projects\banking-agent\.genesis\workers\worker_T7_A703\output\playwright\live\06-lJ-lost-virtual-card.png；证据 JSON D:\projects\banking-agent\.genesis\workers\worker_T7_A703\logs\lJ-evidence.json

`lJ-evidence.json` carries the run evidence: SQLite rows, the `GET /api/cards` projection, the three-way
money comparison (`/cards` DOM vs `GET /api/dashboard` vs SQLite), the verbatim rendered copy and the
real-model proof (completed `ModelRequest` rows + upstream completion ids).
