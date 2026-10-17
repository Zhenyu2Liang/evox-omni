# LIVE 验收证据 — 场景 `lD`（虚拟卡自然语言开卡 + 月限额）— HEAD `fa36508` ROUND 2

本文件记录 `lD` 场景在**当前 HEAD** 上的一次独立真实模型轮次。本轮只更换**退出码测量方法**，
不更换、不弱化、不跳过任何断言。

## 0. 为什么存在这一轮

上一轮（`REPORT-lD-head7a7a4d3-round1.md`）把进程退出码用
`cmd /c "…"` 后再单独 `cmd /c "echo EXIT=%ERRORLEVEL%"` 的方式捕获。该方法是**已被证伪的**：
在那个 shell 里 `%ERRORLEVEL%` 在解析时展开，因此即使子进程真的 `exit 7`，控制命令仍打印 `EXIT=0`。
证据（`logs/exitcode-control.txt`、`logs/flawed-method.log`，控制程序 `logs/exit7.cjs` = `process.exit(7)`）：

```
cmd /c "node logs\exit7.cjs"; cmd /c "echo EXIT=%ERRORLEVEL% >> logs\flawed-method.log"
→ 日志内容： EXIT=0            （子进程实际退出码 7）
```

因此上一轮打印的 `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` **本身不构成退出码 0 的证明**；
按 `tests/e2e/CONTEXT.md`，「打印 PASS 但退出码非 0」必须记为失败。本轮用被证明能识别非零码的
捕获路径重测同一套断言。

## 1. HEAD 与产品树等价性

| 项 | 值 |
| --- | --- |
| HEAD（`git rev-parse HEAD`） | `fa36508b61881b839f79fb1a187abbaec6f20f8e` |
| HEAD 提交时间 | `2026-10-17 14:35:37 +0800` |
| 产品树基线 | `7a7a4d3`（card-instant 提交） |
| `git diff --stat 7a7a4d3 HEAD -- banking-sdk agent security planner lib app components prisma scripts` | **空输出**（产品树逐字节等于 `7a7a4d3`） |
| `git diff --stat 7a7a4d3 HEAD -- tests` | **空输出**（测试树也完全相同） |
| `git diff --stat 7a7a4d3 HEAD`（全量） | 仅 9 个 `output/` 证据文件（两份 mock/日期边界报告 + 上一轮 lD/lE 报告与 5 张 PNG） |

即本轮观测到的产品行为只能来自 `7a7a4d3` 的产品代码，与上一轮相同；差别只在测量方式。

## 2. 精确命令

### 2.1 环境准备（新工作树）

```powershell
cmd /c copy /Y d:\projects\banking-agent\.env.local .env.local
#           → 1 file(s) copied.（只读副本；从未打印或修改内容）
cmd /c "pnpm install --frozen-lockfile > logs\install.log 2>&1"
#           → Done in 1m 23.3s using pnpm v12.3.4
cmd /c "pnpm db:generate > logs\prisma-generate.log 2>&1"
#           → ✔ Generated Prisma Client (7.10.0) to .\lib\db\generated in 117ms
```

### 2.2 本轮唯一一次套件运行（单进程，无并发套件）

```powershell
$env:LIVE_SCENARIOS='lD'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-head-round2.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lD-head-round2.log & exit !EC!"; exit $LASTEXITCODE
```

- 唯一原生命令是套件本身；`; exit $LASTEXITCODE` 使**工具报告的退出码**等于套件退出码
  （第 3 节的 C1/C3 证明：缺这一句时工具报告的是 PowerShell 宿主的 0，不是子进程的码）。
- 日志内的 `EXIT=!EC!` 行用**延迟展开**写入，是第二个独立信号。
- 场景选择只经环境变量 `LIVE_SCENARIOS='lD'`；未改动入口代码、未设 `E2E_SKIP_DB_RESET`。
- 入口自行准备隔离库 `prisma/live-acceptance.db`（`db push` → probe → `tsx prisma/seed.ts`）；
  `prisma/dev.db`、`prisma/test.db` 未被触碰；`.env.local` 只读取。

### 2.3 权威 DB 交叉核对（一次性脚本，位于 `logs/`，不提交）

```powershell
pnpm exec tsx logs\dump-lD-round2.ts cardidem_c9d4e2a18b5823d8e71913e140f25b13   # → logs\live-lD-round2-db.txt
pnpm exec tsx logs\check-lD-round2.ts cardidem_c9d4e2a18b5823d8e71913e140f25b13  # → logs\live-lD-round2-check.txt
```

两个脚本都用仓库自己的 `lib/db/database.ts#createDatabaseClient` 打开 `prisma/live-acceptance.db`
（一次性 PrismaClient，连接时 `PRAGMA journal_mode = WAL`），与入口的断言互不共享代码路径。

## 3. 退出码捕获法的证明（STEP 1，先于套件运行完成）

逐条为**独立**的 PowerShell 调用；"工具退出码" 指工具结果里的 Exit Code。
控制程序：`logs/exit7.cjs` → `process.exit(7)`，`logs/exit0.cjs` → `process.exit(0)`。

| # | 命令 | 工具退出码 | 日志内 `EXIT=` |
| --- | --- | --- | --- |
| C1 | `cmd /c "exit 7"` | **0** ← 假值：工具报告的是 PowerShell 宿主码 | — |
| C2 | `cmd /c "exit 7"; exit $LASTEXITCODE` | **7** | — |
| C3 | `cmd /v:on /c "node logs\exit7.cjs > … & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> … & exit !EC!"` | **0** ← 同上，宿主码 | **7** |
| C4 | **本轮采用**：C3 + `; exit $LASTEXITCODE` | **7** | **7** |
| C5 | 上一轮方法：`cmd /c "node logs\exit7.cjs"; cmd /c "echo EXIT=%ERRORLEVEL% >> logs\flawed-method.log"` | 0 | **0** ← 子进程真退出 7，仍打印 0 ⇒ 该方法无效 |
| C6 | 负向对照：`exit0.cjs` 走 C4 同一路径 | **0** | **0** |
| C7 | `pnpm exec` 传播：`pnpm exec node logs\exit7.cjs` 走 C4 同一路径 | **7** | **7** |

结论：本轮采用 C4。两个信号都**被证明能够携带非零码**（C4、C7），也**被证明不会卡在非零**
（C6）；C1/C3 说明"唯一原生命令"不足以保证工具退出码是子进程的，必须显式
`exit $LASTEXITCODE`。C5 说明上一轮方法不可作为证据。原始记录：`logs/exitcode-control.txt`。

## 4. 本轮结果：两个退出码信号 + 汇总行

| 项 | 值 |
| --- | --- |
| 信号 1：工具报告退出码 | **0** |
| 信号 2：日志尾部 `EXIT=` 行（延迟展开） | **`EXIT=0`**（日志第 19 行） |
| 汇总行（逐字，日志第 18 行） | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` |
| 结论 | **PASS**（退出码 0 与 `PASS 1 ｜ FAIL 0 ｜ SKIP 0` 同时成立） |

本轮是该 HEAD 上**第一次也是唯一一次**运行，没有重试，不存在"跑绿一轮后抹去前次失败"。

运行环境（日志逐字摘录）：

```
· 隔离 LIVE 数据库：file:D:/projects/banking-agent/.genesis/workers/worker_T5_A48/prisma/live-acceptance.db（prisma/dev.db 与 prisma/test.db 不受影响）
· next dev (pid=30688) → http://localhost:51027（/api/health 与 /agent 均已就绪）
· /api/health={"ok":true,"data":{"status":"ok","time":1792219238082,"llmMode":"live"}}
· 真实浏览器：C:\Program Files\Google\Chrome\Application\chrome.exe
· 累计网络 4xx/5xx：1，console error：1，pageerror：0
```

- 模式：**live**。`/api/health` 的 `llmMode` 为 `"live"`；入口横幅为 `Live run uses the configured model.`
  （未设 `LIVE_FORCE_MODEL`）。无 mock provider、无响应拦截：入口起真实 `next dev` 并驱动真实 Chrome。
- 解析后的活动模型 id：**`deepseek-flash`**
  权威来源 `AgentRunEvent(eventType='provider_request_payload')` 共 **2** 条
  （`runId=cmvc1281r000014f8jx8jzhjr`，`sequence=9` 与 `72`），两条 `payloadJson.payload.model` 均为 `"deepseek-flash"`，
  两条都带 **29** 个 `tools` 条目。
- 唯一 1 条 4xx 是本轮**期望**的超限拒绝（逐字）：
  ```
  · [4xx/5xx] POST 422 http://localhost:51027/api/cards/cardidem_c9d4e2a18b5823d8e71913e140f25b13/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}
  ```

## 5. 逐字提示词

本轮模型第一轮就发起了受控工具，因此只发送 **1** 条自然语言轮次（未消耗任何续接/催促轮次）：

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

两个互相独立的逐字来源：
- `logs/lD-evidence.json` → `sentTurns[0]`（场景自己记录的实发轮次）；
- SQLite `AgentRun.requestJson` → `{"kind":"input","message":"请帮我新开一张虚拟卡，月消费限额设为100元"}`；
- SQLite `PendingAction.userRequest` → `请帮我新开一张虚拟卡，月消费限额设为100元`。

## 6. 工具调用与参数（权威 DB，逐字）

`ToolInvocation` 共 **2** 条，均 `status=completed`、`errorCode=null`：

| ordinal | toolName | argsJson（逐字） | callId |
| --- | --- | --- | --- |
| 1 | `describe_turn` | `{"operations":["apply_virtual_card"],"purpose":"operation"}` | `call_00_tsnTBeDOy4ze5nyn3hJr8203` |
| 2 | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `call_00_mGUEXlUN6ZY8ambpLM1U4138` |

`AgentRun` 共 **2** 条，均为 `session=demo:user_liming`：
- `cmvc1281r000014f8jx8jzhjr` `status=waiting_verification`（用户轮次，停等验证）
- `cmvc12bi2003p14f8zqv79fx3` `status=completed`（`kind=authorization_result`，`toolResult.ok=true`，
  `summary="虚拟卡 ****1418 已开通（月限额 ¥100.00）"`）

## 7. 确认/MFA 面板的后端真实行（无伪造面板）

面板只可能在安全网关从**真实工具调用**持久化 `PendingAction` 之后出现。本轮恰好各 **1** 行，且一一对应：

`PendingAction`（唯一一行）：

| 字段 | 值 |
| --- | --- |
| id | `cmvc129lr003814f8mp8zi6rk` |
| toolName | `apply_virtual_card` |
| argsJson | `{"monthlyLimit":"100.00"}` |
| riskLevel / requiresMfa | `RED` / `true` |
| status | `executed` |
| invocationId | `call_9558387d-5fb2-4246-9f26-2dcf5de13ae9`（=第 6 节 `apply_virtual_card` 的调用 id） |
| userRequest | `请帮我新开一张虚拟卡，月消费限额设为100元` |
| intent | `申请虚拟卡` |
| createdAt → updatedAt | `2026-10-17T06:40:42.015Z` → `2026-10-17T06:40:44.506Z` |

`MfaChallenge`（唯一一行）：

| 字段 | 值 |
| --- | --- |
| id | `cmvc129lv003914f80u5er6g3` |
| actionId | `cmvc129lr003814f8mp8zi6rk`（=上面那条 `PendingAction`） |
| code / attempts / maxAttempts | `123456` / `0` / `3` |
| status | `verified`（`verifiedAt=2026-10-17T06:40:44.254Z`、`consumedAt=…44.275Z`） |

- `MfaChallenge` 中 actionId 找不到 `PendingAction` 的行数 = **0**（无孤立 MFA 行）。
- `AuditLog` 恰 **1** 行：`apply_virtual_card` / `risk=RED` / `status=success` / `confirmed=true` / `mfa=success` /
  `dedupeKey=exec:cmvc129lr003814f8mp8zi6rk`。
- `ExecutionReceipt` 恰 **1** 行：`rcpt_c9d4e2a18b5823d8e71913e140f25b13`、`tool=apply_virtual_card`、`key=cmvc129lr003814f8mp8zi6rk`。
- 本轮模型在第一条轮次内就发起了受控工具，"散文声称面板却无 `PendingAction`" 的守卫
  （`assertNoFabricatedConfirmationPanel`）未触发失败。

## 8. DB 交叉核对数字（`logs/live-lD-round2-check.txt`）

### 8.1 新虚拟卡 RAW `Card` 行

| 字段 | 值 | 期望 |
| --- | --- | --- |
| id | `cardidem_c9d4e2a18b5823d8e71913e140f25b13` | — |
| type | `VIRTUAL` | VIRTUAL |
| status | `ACTIVE` | ACTIVE |
| monthlyLimitMinor | `10000` | `100.00` |
| creditLimitMinor | `null` | null |
| availableLimitMinor | `null` | null |
| linkedAccountId | `acct_checking` | `acct_checking` |
| numberMasked | `****1418` | 与既有卡片（`****6688`/`****8821`/`****7788`）均不同 |
| replacedByCardId | `null` | — |

全部 `Card` 行共 **4** 条（`card_credit`/CREDIT、`card_debit`/DEBIT、`card_virtual`/VIRTUAL、
本轮新卡 `cardidem_…`/VIRTUAL）：未重复生成虚拟卡。

### 8.2 恰一笔流水 + 恰一条消费行

| 项 | 值 |
| --- | --- |
| `channel='CARD'` + `direction='DEBIT'` + `merchant='虚拟卡开卡消费验证'` 的 `Transaction` 数 | **1** |
| 该行 | `cmvc12d8j004114f8o26zpzup`、`accountId=acct_checking`、`amountMinor=-3000`、`category=购物`、`occurredAt=2026-09-25T04:00:00.000Z` |
| `merchant='虚拟卡超限拒绝验证'` 的 CARD/DEBIT 流水数 | **0**（被拒绝的消费未移动资金） |
| `CardConsumption` 全表行数 | **1** |
| 该行 | `cmvc12d8k004214f8864larvi`、`cardId=<新卡>`、`accountId=acct_checking`、`amountMinor=3000`、`merchant=虚拟卡开卡消费验证`、`executionKey=d0999d6b-46ad-4a10-a0ff-6dae6c3570cf` |
| 新卡的 `CardConsumption` 行数 | **1**（未重复扣款） |

### 8.3 余额恰扣一次 + `payableAmount` 进程

| 项 | 值 |
| --- | --- |
| `acct_checking.balanceMinor`（消费前，场景记录） | `2358000` = `23580.00` |
| `acct_checking.balanceMinor`（运行结束，DB 实读） | `2355000` = `23550.00` |
| 差额 | 恰 `3000`（`30.00`），只扣一次 |
| 新卡已用月限额（`CardConsumption` 求和） | `3000` |
| 剩余月限额 | `7000` = `70.00` |
| DB 侧重算 `min(账户可用余额 23550.00, 剩余月限额 70.00)` | `7000` = `70.00` |

`payableAmount` 进程（本轮运行时由 `/api/cards` + 页面断言读取，并以"不等于即抛错"的方式强制，
见 `logs/lD-evidence.json` 的 `payable`）：

| 时刻 | payableAmount | 依据 |
| --- | --- | --- |
| 开卡后 | `100.00` | `min(23580.00, 100.00 − 0.00)`，月限额绑定而非活期余额 |
| 消费 `30.00` 后 | `70.00` | `min(23550.00, 100.00 − 30.00)` |
| 超限 `80.00` 被拒绝后 | `70.00` | 不变 |

`/cards` 卡片渲染（`lD-evidence.json` 的 `tileRows`，刷新后实读）：
开卡后 `{"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}`；
消费后 `{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`（不出现"信用额度"/"可用额度"行）。
消费弹窗摘要：`{"关联账户":"****8821","账户可用余额":"¥23,580.00","月限额":"¥100.00","当前可支付金额":"¥100.00"}`。

超限拒绝：`80.00`（`虚拟卡超限拒绝验证`）→ HTTP `422` `LIMIT_EXCEEDED`，弹窗文案
`超出本月消费限额`；流水、余额、`CardConsumption` 零变化（8.2 的 0 行 + 8.3 的余额不变）。

## 9. 截图（本轮目录，未触碰既有轮次目录）

```
output/playwright/live/lD-head7a7a4d3-round2/01-lD-new-virtual-card.png        (75,037 B)
output/playwright/live/lD-head7a7a4d3-round2/02-lD-after-spend.png             (74,169 B)
output/playwright/live/lD-head7a7a4d3-round2/03-lD-over-limit-refusal.png      (89,047 B)
```

`output/playwright/live/` 下的 `lD-round1..3/`、`lD-head7a7a4d3-round1/`、`REPORT-lD-*.md`（其它轮次）均未修改。

## 10. 清理与端口

快照：`logs/netstat-snapshot.txt`、`logs/tasklist-snapshot.txt`；判定：`logs/cleanup-check.txt`、`logs/cleanup-mine.txt`。

| 检查 | 结果 |
| --- | --- |
| POSITIVE CONTROL `findstr /C:"51027" logs\port-control.txt` | 命中 `127.0.0.1:51027 LISTENING 30688`（证明 `findstr` 确实读该文件、该模式可命中） |
| `findstr /C:"51027" logs\netstat-snapshot.txt` | 只有 `TIME_WAIT` 残留套接字，**无 `LISTENING` 行** |
| `netstat -ano | 筛选 :51027 且 LISTENING` | **空**（其正向对照：合成行 `0.0.0.0:51027 … LISTENING 4242` 能被同一筛选命中） |
| `findstr /C:"30688" logs\tasklist-snapshot.txt`（入口报的 `next dev` pid） | **空** → 动态 dev-server 进程已退出 |
| 命令行提及本工作树路径 `worker_T5_A48` 的进程 | **无** |
| 命令行提及 `live-acceptance.db` 的进程 | **无** |
| 入口是否打印 `port … freed: YES` | **未打印**（该入口在正常路径只做 `teardown()`，不输出该行；端口/进程由上面的 PID 与 `netstat` 事实独立证明） |
| `git status --porcelain` | **空** |

机器上仍有其它 `chrome.exe` / `node.exe`（其它工作树与用户浏览器），它们的命令行**都不引用本工作树**，
本轮未触碰它们；本轮套件全程单进程，未与其它套件并发。

## 11. 本轮未验证的事项（不要据此推断）

- 本 HEAD 上只跑了 `lD` **一轮**。单样本不证明 live 模型稳定性；本轮模型首轮即发起受控工具，
  不能据此推断其它轮次不需要催促/续接。
- 其它场景（`lA`/`lB`/`lC`/`lE`、`1`–`15`、`7`）本轮**未运行**。
- `pnpm test`（unit/scenarios/integration/app）、`pnpm typecheck`、lint、生产构建本轮**未运行**；
  本文件不主张这些检查的状态。
- `/api/health` 只在运行时由入口读取一次（日志第 8 行）；服务随后被 `teardown()` 停掉，
  因此没有"运行后复读"。模型侧的独立交叉核对来自 DB 的 `provider_request_payload` 事件。
- 退出码 0 只由第 3 节被证明的两种捕获信号得出；本轮**不**用打印的 PASS 文本作为退出码证据。
- 浏览器验收不证明集群并发、真实银行接入或生产构建可用。