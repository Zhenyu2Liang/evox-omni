# LIVE 验收证据 — 场景 `lD`（虚拟卡自然语言开卡 + 月限额）— HEAD `0c50e2f` ROUND 3

本文件记录 `lD` 场景在产品树 `7a7a4d3` 上的**第三个独立真实模型轮次**（`LLM_MODE=live`、真实无头 Chrome、真实 `next dev`、独立 SQLite）。
本轮不修改任何断言、不跳过任何步骤，唯一目的是把该产品树上的可认证轮次从 2 轮补到 3 轮。

## 1. 被测提交与产品树等价性

| 项 | 值 |
| --- | --- |
| 分支 | `evogit-agent-T5-A50` |
| HEAD（`git rev-parse HEAD`） | `0c50e2f78681753fe6ec58d922a6beb396906145` |
| HEAD 提交时间 / 说明 | `2026-10-17 14:53:24 +0800` — `test(e2e): certify virtual-card acceptance at the card-instant product tree 7a7a4d3` |
| 产品树基线 | `7a7a4d3`（card-instant 提交） |
| `git diff --stat 7a7a4d3 HEAD -- banking-sdk agent security planner lib app components prisma scripts` | **空输出** |
| `git diff --stat 7a7a4d3 HEAD -- tests` | 仅 `tests/e2e/CONTEXT.md`、`tests/e2e/LIVE-ACCEPTANCE-REPORT.md`（证据/文档，无测试逻辑改动） |
| `git diff --name-only 7a7a4d3 HEAD` | 仅 `output/playwright/**` 证据文件 + 上述两个测试文档 |

因此本轮观测到的行为只能来自 `7a7a4d3` 的产品代码。
证据提交本身会让 HEAD 前移，故本轮报告声明认证的是**产品树提交** `7a7a4d3`，等价的 HEAD 是 `0c50e2f`。

## 2. 环境准备（新工作树，只读复制）

```powershell
Copy-Item 'D:\projects\banking-agent\.env.local' -Destination '.env.local'   # 只读副本，值从不打印
cmd /v:on /c "pnpm install --frozen-lockfile > logs\install.log 2>&1 & set EC=!ERRORLEVEL! & ..."
#   -> Done in 54.2s using pnpm v12.3.4；INSTALL_EXIT=0
cmd /v:on /c "pnpm db:generate > logs\prisma-generate.log 2>&1 & ..."
#   -> Generated Prisma Client (7.10.0) to .\lib\db\generated in 165ms
```

工具链：`node v25.9.0`、`pnpm 12.3.4`、`tsx 4.23.15`、`playwright-core 1.64.0`、`prisma 7.10.0`。
`.env.local` 仅含 `LLM_MODE` / `LLM_PROVIDER` / `LLM_MODEL` / `DEEPSEEK_API_KEY` 四个键（115 B），本轮只读取，未编辑、未提交、未回显。

## 3. 退出码捕获方法的对照实验（先证明方法，再运行套件）

`cmd /c "..."` 之后再单独 `cmd /c "echo EXIT=%ERRORLEVEL%"` 是**已证伪**的方法（`%ERRORLEVEL%` 在解析期展开）。
本轮在同一 shell 中重做了三组对照（控制程序 `logs/exit7.cjs` = `process.exit(7)`，`logs/exit0.cjs` = `process.exit(0)`）：

| 对照 | 命令 | 工具报告的退出码 | 日志行 |
| --- | --- | --- | --- |
| C1 被证伪的方法 | `cmd /c "node logs\exit7.cjs"; cmd /c "echo EXIT=%ERRORLEVEL% >> logs\flawed-method-round3.log"` | `0` | `logs/flawed-method-round3.log` → `EXIT=0`（而子进程实际退出码是 7） |
| C2 采用的方法（非零） | `cmd /v:on /c "node logs\exit7.cjs > logs\proven-exit7.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> ... & exit !EC!"; exit $LASTEXITCODE` | **`7`** | `logs/proven-exit7.log` → `EXIT=7` |
| C3 采用的方法（零） | 同上，换成 `logs/exit0.cjs` | `0` | `logs/proven-exit0.log` → `EXIT=0` |

C2/C3 一起证明该路径**既报得出非零，也不会永远报非零**；C1 证明被弃用的方法给出的 `EXIT=0` 不携带子进程退出码。

## 4. 本轮唯一一次运行：两个退出码信号 + 汇总行

```powershell
$env:LIVE_SCENARIOS='lD'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-head-round3.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lD-head-round3.log & exit !EC!"; exit $LASTEXITCODE
```

| 信号 | 值 |
| --- | --- |
| 信号 1：工具报告的进程退出码 | **`0`** |
| 信号 2：日志内的延迟展开行（`logs/live-lD-head-round3.log` 末行） | **`EXIT=0`** |
| 汇总行 | **`== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`** |

打印 PASS 与非零退出码不会同时成立：本轮两个信号都为 0，故判定 **PASS**。
场景选择只经环境变量 `LIVE_SCENARIOS='lD'`；未改动入口代码，未设 `E2E_SKIP_DB_RESET`，未与其它套件并发。
进程耗时 38.6 s（与第 1/2 轮同量级：模型首轮即发起受控工具）。

## 5. live 证据（无 mock、无拦截）

- `/api/health` → `{"ok":true,"data":{"status":"ok","time":1792220259530,"llmMode":"live"}}`（日志第 8 行）。
- 真实浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`（日志第 9 行）。
- 模型 id：`deepseek-flash`，来自 `logs/lD-evidence.json` 的 `model` 字段（入口的 `liveModelId()` 从持久化的 `provider_request_payload` 事件读取；`LIVE_FORCE_MODEL` 未设置）。
- 隔离库：`file:D:/projects/banking-agent/.genesis/workers/worker_T5_A50/prisma/live-acceptance.db`（≠ `dev.db` / `test.db` / 用户备份）。
- 业务写入经真实网关：`apply_virtual_card` 需要确认/MFA，`123456` 由 harness 在真实 MFA 卡片里输入。
- 全程无响应拦截、无 mock、无以 SDK/HTTP 调用替代前端操作。

## 6. 逐字提示词 / 轮次

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

`logs/lD-evidence.json` 的 `sentTurns` 只有这一条 —— **首轮即发起受控工具，未消耗催促或续接预算**。
消费腿与超限腿是纯 `/cards` 弹窗提交，**0 个模型轮次**。## 7. 确认/MFA 面板与工具调用

本轮的 `PendingAction` / `MfaChallenge` / `ToolInvocation` 行**没有在运行后单独 dump**：同一个隔离库文件随后被 `lE` 轮次重建（`db push` → seed），`lD` 的门控行已随库重建消失。
这一点如实记录，不用推断替代证据。本轮关于门控的事实来自：

- 场景内的强制断言：`applyVirtualCardViaAgent` 只有在真实 RED 工具发起、真实确认/MFA 卡片被完成之后，才可能等到 `GET /api/cards` 出现新卡；该断言通过（见 `PASS` 行）。
- 运行日志第 12 行的 PASS 证据串：`MFA 123456 -> 新虚拟卡 cardidem_974723860f5e22adc06772726460e218`。
- `assertNoFabricatedConfirmationPanel` 在散文轮次中从未触发；日志 `pageerror: 0`。

同一提交上的 `lE` 轮次在本轮之后 dump 到了 `logs/live-round3-db.json`（三条 `PendingAction` = 三个真实工具调用，见 `REPORT-lE-head7a7a4d3-round3.md` 第 8 节），可作为「面板 = 真实行」的旁证，但**不能**替代 `lD` 自己的行。

## 8. DB 数字（本轮运行时读取，`logs/lD-evidence.json`）

### 8.1 新虚拟卡 RAW `Card` 行

| 字段 | 值 |
| --- | --- |
| `id` | `cardidem_974723860f5e22adc06772726460e218` |
| `type` / `status` | `VIRTUAL` / `ACTIVE` |
| `network` | `UnionPay` |
| `numberMasked` | `****2003`（与既有全部卡片号不同） |
| `monthlyLimitMinor` | `10000`（¥100.00） |
| `linkedAccountId` | `acct_checking` |
| `creditLimitMinor` / `availableLimitMinor` | `null` / `null` |
| `replacedByCardId` | `null` |

消费弹窗摘要（服务端投影）：`{"关联账户":"****8821","账户可用余额":"¥23,580.00","月限额":"¥100.00","当前可支付金额":"¥100.00"}`。
`/cards` 卡片渲染（刷新后实读）：开卡后 `{"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}`；消费后 `{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`；不出现「信用额度」/「可用额度」行。

### 8.2 恰一笔流水 + 恰一条消费行

| 项 | 值 |
| --- | --- |
| 消费输入 | `30.00` / `购物` / `虚拟卡开卡消费验证` |
| `Transaction` | `cmvc1o8o200418sf8ixspw918`，`channel=CARD`、`direction=DEBIT`、`-3000` |
| `CardConsumption` | `cmvc1o8o300428sf8cdofet99`，`amountMinor=3000` |
| 活期余额 | `2358000` → `2355000`（¥23,580.00 → ¥23,550.00，恰扣一次） |

入账时间由服务端拥有（`demoNow()`，UTC+08:00 月窗口）；本轮没有任何请求体携带 `occurredAt`。

### 8.3 `payableAmount` 进程（服务端投影，非模型给数）

| 时刻 | payableAmount | 依据 |
| --- | --- | --- |
| 开卡后 | `100.00` | `min(23580.00, 100.00 - 0.00)` |
| 消费 `30.00` 后 | `70.00` | `min(23550.00, 100.00 - 30.00)` |
| 超限 `80.00` 被拒绝后 | `70.00` | 不变 |

超限腿：`80.00`（`虚拟卡超限拒绝验证`）→ HTTP `422` `LIMIT_EXCEEDED` `超过虚拟卡月限额。`，弹窗文案 `超出本月消费限额`；
流水、余额、`CardConsumption` 零变化，`payableAmount` 仍 `70.00`（`assertNoSpend` 通过）。
日志 `[4xx/5xx]` 计数：1（唯一一次即该拒绝），`pageerror: 0`。

## 9. 截图（本轮新目录，未触碰既有轮次目录）

```
output/playwright/live/lD-head7a7a4d3-round3/01-lD-new-virtual-card.png      (75,140 B)
output/playwright/live/lD-head7a7a4d3-round3/02-lD-after-spend.png           (74,205 B)
output/playwright/live/lD-head7a7a4d3-round3/03-lD-over-limit-refusal.png    (89,191 B)
```

harness 写入的固定文件名（`output/playwright/live/01-lD-*.png` 等）每轮会被覆盖，因此本轮已复制到带被认证提交与轮次号的新目录。
`...-round1/`、`...-round2/` 与 `REPORT-lD-*.md` 的其它轮次文件均未修改。

## 10. 清理与端口

| 检查 | 结果 |
| --- | --- |
| 入口报的端口 / dev-server pid | `55343` / `58284` |
| `netstat -ano` 过滤 `:55343` | **空**（连 `TIME_WAIT` 残留都没有） |
| 同命令正向对照 | 能列出 69 条 `LISTENING` 行，证明过滤可命中 |
| `tasklist /FI "PID eq 58284"` | `No tasks are running which match the specified criteria` |
| 命令行提及 `live-acceptance` 的 `node.exe` | **无** |
| 命令行提及 `worker_T5_A50` 的 `chrome.exe` | **无** |

## 11. 本轮未验证的事项（不要据此推断）

- `lD` 的门控行（`PendingAction` / `MfaChallenge` / `ToolInvocation`）**未在运行后独立 dump**（隔离库随后被 `lE` 轮次重建）。见第 7 节。
- 本轮是同一产品树的**第 3 个样本**；三轮都在首轮就发起受控工具，不能据此推断其它轮次不需要催促/续接，也不证明长期模型稳定性。
- 其它场景（`lA`/`lB`/`lC`/`lE`、live id `0`–`15`、`2p`、`7`）本轮**未运行**。
- `pnpm test`、`pnpm typecheck`、lint、`next build` 本轮**未运行**；本文件不主张这些检查的状态。
- 超限 HTTP `422` 来自 harness 网络日志与屏幕 `role="alert"` 文案，未另做原始 HTTP 复现。
- 浏览器验收不证明集群并发、真实银行接入或生产构建可用。