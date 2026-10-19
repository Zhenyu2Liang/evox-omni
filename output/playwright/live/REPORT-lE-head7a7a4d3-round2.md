# lE 单轮真实模型验收报告 — HEAD `339c50b`（产品树等价于 `7a7a4d3`）round 2

本文件是本轮唯一的结论证据。
历史轮次（`output/playwright/live/REPORT-lE-head7a7a4d3-round1.md` 及其截图目录）保持原样，本轮不修改、不覆盖、不混写。

## 1. 本轮为何存在：替换的是测量方法，不是断言

上一轮（产品树 `7a7a4d3` 的 lE round 1）用下面两步取进程退出码：

```
cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lE-...log 2>&1"
cmd /c "echo EXIT=%ERRORLEVEL%"
```

该方法是可证明无效的：`%ERRORLEVEL%` 在命令行解析时展开，带的是程序**运行之前**的值；并且末尾的 `echo` 成为该 `cmd` 里最后一个原生命令，连 `cmd` 自身的退出码都由它决定。本轮先做对照实验（第 3 节 CONTROL A），用一个真正 `exit 7` 的程序走同一路径，结果仍打印 `EXIT=0`。

因此上一轮打印的 `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` **本身不能证明退出码为 0**；按 `tests/e2e/CONTEXT.md`，「打印 PASS 但退出码非 0」必须记为失败。本轮只替换退出码的测量方式；断言一条未删、未弱化、未跳过，产品代码一行未改。

## 2. 被测提交与工作区

| 项目 | 值 |
| --- | --- |
| HEAD 提交 | `339c50b884f42598f034ff013c32bb16350fea1a`（`339c50b`） |
| 产品树基准（卡片入账瞬间提交） | `7a7a4d32a6a1622deb7647ab6142fb7991b76805`（`7a7a4d3`） |
| 产品树等价证明 | `git diff --stat 7a7a4d3 HEAD -- banking-sdk agent security planner lib app components prisma scripts` → **空输出**（`logs/tree-proof.txt` 第 1–5 行） |
| 与 `7a7a4d3` 的全部差异 | `git diff --name-only 7a7a4d3 HEAD` 只列出证据文件（`output/playwright/REPORT-*.md`、`output/playwright/live/REPORT-*.md`、`output/playwright/live/lD-*/lE-*` 的 PNG），无任何产品文件 |
| 开工前工作区 | `git status --porcelain` 为空（`logs/pre-run-state.txt` 第 2–3 行） |
| 场景 | `lE` / `scenarioVirtualCardReplaceContinuity` / id `lE-live-virtual-card-replace-continuity` |

## 3. 退出码捕获方法的对照实验（先证明，再运行）

完整记录见 `logs/exitcode-control.txt`；对照程序源码为 `logs/exit7.js`（`process.exit(7)`）与 `logs/exit0.js`（`process.exit(0)`）。

| 对照 | 命令形状 | 工具报告的进程退出码（信号 1） | 日志内 `EXIT=` 行（信号 2） | 结论 |
| --- | --- | --- | --- | --- |
| 参照 | `node logs\exit7.js; exit $LASTEXITCODE` | `7` | — | 程序本身确实 exit 7 |
| CONTROL A（**上一轮用过的旧方法**） | `cmd /c "pnpm exec node logs\exit7.js > … & echo EXIT=%ERRORLEVEL% >> …"` | `0` | `EXIT=0` | **两个信号都错**：真实的 7 被吞掉，证明旧方法无效（实测，不是断言） |
| CONTROL B（本轮方法） | `cmd /v:on /c "pnpm exec node logs\exit7.js > … & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> … & exit !EC!"; exit $LASTEXITCODE` | `7` | `EXIT=7` | 两个信号都能**发现非 0** |
| CONTROL C（本轮方法，零值对照） | 同上，程序改为 `logs\exit0.js` | `0` | `EXIT=0` | 0 仍是 0，不是「永远非 0」 |

## 4. 执行的命令

```powershell
# 环境（.env.local 只复制，从不打印、从不编辑）
cmd /c copy /Y d:\projects\banking-agent\.env.local .env.local

# 依赖与 Prisma Client（输出重定向到 logs/）
cmd /c "pnpm install --frozen-lockfile > logs\install.log 2>&1"   # Done in 41.9s，pnpm v12.3.4
cmd /c "pnpm db:generate > logs\prisma-generate.log 2>&1"         # Generated Prisma Client (7.10.0) → .\lib\db\generated

# 退出码方法对照（第 3 节）之后，本轮唯一一次场景运行
$env:LIVE_SCENARIOS='lE'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lE-head-round2.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lE-head-round2.log & exit !EC!"; exit $LASTEXITCODE
```

单进程运行，全程未并行启动任何其它套件或第二个 e2e 进程；工具报告耗时 42.63 秒。
入口自建隔离库 `prisma/live-acceptance.db`（`db push` 阶梯 → probe → `tsx prisma/seed.ts`），未触碰 `prisma/dev.db`、`prisma/test.db`，未编辑 `.env.local`。

## 5. 两个退出码信号与汇总行

| 信号 | 值 | 出处 |
| --- | --- | --- |
| 信号 1：工具报告的进程退出码 | `0` | 本次 PowerShell 调用的退出码（`exit $LASTEXITCODE`，已由 CONTROL B 证明可捕获 7） |
| 信号 2：日志内 `EXIT=` 行 | `EXIT=0` | `logs/live-lE-head-round2.log` 第 19 行（延迟展开写入） |

汇总行（`logs/live-lE-head-round2.log` 第 18 行，逐字）：

```
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

场景明细（`logs/live-lE-head-round2.log` 第 12 行，逐字，单行）：

```
PASS lE-live-virtual-card-replace-continuity — lE 实际发送（开卡）：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_b0aeb5ece9b12e0edec896d1323b239f（monthlyLimitMinor=10000、linkedAccountId=acct_checking）；挂失前消费 30.00（购物/虚拟卡挂失前消费验证）= 新增 CARD/DEBIT 流水 -3000（cmvc1bi5w0041vof86pezrbir）+ 1 条 CardConsumption（cmvc1bi5x0042vof8t9lxd5yz），活期余额 23580.00 → 23550.00；挂失实际发送：「我刚才新办的那张虚拟卡（尾号4977，月限额100元）丢失了，请帮我正式挂失这张卡」 → MFA 123456 → RAW status=LOST、资金零变化；补办实际发送：「请为我刚才挂失的虚拟卡（原卡尾号4977）补办一张新卡」 → MFA 123456 → cardidem_b0aeb5ece9b12e0edec896d1323b239f.replacedByCardId=cmvc1boyz00emvof8fi5avmcs（恰新增 1 张 VIRTUAL/ACTIVE 卡）；补办卡 RAW：linkedAccountId=acct_checking（= 原卡 acct_checking，继承修复生效）、monthlyLimitMinor=10000、卡号 ****0148 ≠ 原卡 ****4977、无信用额度；家庭月限额连续：已用 3000 → payableAmount=70.00（=70.00，不是 100.00），卡片渲染 {"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}；补办卡消费 70.00（购物/虚拟卡补办续限验证）= 新增 CARD/DEBIT 流水 -7000（cmvc1bq4f00f2vof8dqr5jryd）+ 1 条 CardConsumption（cmvc1bq4g00f3vof8fkqbg3jx），活期余额 23550.00 → 23480.00（恰扣一次）→ payableAmount=0.00；额度用尽后 1.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 0.00；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A49\output\playwright\live\01-lE-replacement-card.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A49\output\playwright\live\02-lE-exhausted-refusal.png；证据 JSON D:\projects\banking-agent\.genesis\workers\worker_T5_A49\logs\lE-evidence.json
```

## 6. live 证据（无 mock、无拦截）

- `/api/health`（`logs/live-lE-head-round2.log` 第 8 行，逐字）：`{"ok":true,"data":{"status":"ok","time":1792219664410,"llmMode":"live"}}`
- 入口自述（第 3 行）：`Live run uses the configured model.`（未设置 `LIVE_FORCE_MODEL`；第 6 行：`Live provider configuration is applied; configuration values are not displayed.`）
- 解析后的模型 id（`AgentRunEvent(eventType='provider_request_payload').payloadJson.payload.model`，`logs/lE-dbcheck-round2.txt` 第 141–148 行）：6 条事件全部为 `deepseek-flash`、`stream=true`
  - `runId=cmvc1bcvu0000vof814yc9rkv` sequence 9 / 72
  - `runId=cmvc1bijb0043vof8krnm25ka` sequence 9 / 72
  - `runId=cmvc1blrl00a2vof8bztiwr8d` sequence 9 / 68
- `ModelRequest` 6 行，状态依次全为 `completed`
- 运行期网络异常只有 1 条 4xx，就是本场景**故意**的超限拒绝：`POST 422 …/api/cards/cmvc1boyz00emvof8fi5avmcs/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}`；`pageerror=0`

## 7. 提示词（逐字）与工具调用（含参数）

三条自然语言腿各用 1 轮即触发受控工具（未需要催促）。逐字来源：`logs/lE-evidence.json` 与 `logs/lE-dbcheck-round2.txt` 第 151–165 行（`AgentSession.stateJson`）。

| 腿 | 用户提示词（逐字） | 工具调用（逐字参数） |
| --- | --- | --- |
| 开卡 | `请帮我新开一张虚拟卡，月消费限额设为100元` | `describe_turn {"purpose":"operation","operations":["apply_virtual_card"]}` → `apply_virtual_card {"monthlyLimit":"100.00"}` |
| 挂失 | `我刚才新办的那张虚拟卡（尾号4977，月限额100元）丢失了，请帮我正式挂失这张卡` | `describe_turn {"purpose":"operation","operations":["report_lost_card"]}` → `report_lost_card {"cardId":"cardidem_b0aeb5ece9b12e0edec896d1323b239f","reason":"用户报告卡片遗失，要求正式挂失"}` |
| 补办 | `请为我刚才挂失的虚拟卡（原卡尾号4977）补办一张新卡` | `describe_turn {"purpose":"operation","operations":["replace_card"]}` → `replace_card {"cardId":"cardidem_b0aeb5ece9b12e0edec896d1323b239f"}` |

`ToolInvocation` 共 6 行、全部 `status=completed`、`origin=pi`；业务调用的 `operationKey` 与对应 `PendingAction.id` 一致（`logs/lE-dbcheck-round2.txt` 第 131–138 行）。

## 8. 确认/MFA 面板 = 真实 `PendingAction` + `MfaChallenge`（三腿，全部由真实工具调用产生）

`PendingAction` 恰好 3 行、均 `riskLevel=RED`、`requiresMfa=true`、`status=executed`，每行各有 1 条 `MfaChallenge`（`logs/lE-dbcheck-round2.txt` 第 122–129 行）：

| 面板 | `PendingAction.id` | toolName | argsJson（逐字） | `userRequest`（逐字） | MfaChallenge |
| --- | --- | --- | --- | --- | --- |
| 1 | `cmvc1bee00038vof87k0i68mi` | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `请帮我新开一张虚拟卡，月消费限额设为100元` | `cmvc1bee40039vof8l5h87wbg`，code `123456`，attempts `0/3`，status `verified`，consumedAt `2026-10-17T06:47:50.547Z` |
| 2 | `cmvc1bkes0099vof8o738ye0h` | `report_lost_card` | `{"cardId":"cardidem_b0aeb5ece9b12e0edec896d1323b239f","reason":"用户报告卡片遗失，要求正式挂失"}` | `我刚才新办的那张虚拟卡（尾号4977，月限额100元）丢失了，请帮我正式挂失这张卡` | `cmvc1bket009avof8rhtob3sm`，code `123456`，attempts `0/3`，status `verified`，consumedAt `2026-10-17T06:47:56.637Z` |
| 3 | `cmvc1bom300e8vof8whl9glwa` | `replace_card` | `{"cardId":"cardidem_b0aeb5ece9b12e0edec896d1323b239f"}` | `请为我刚才挂失的虚拟卡（原卡尾号4977）补办一张新卡` | `cmvc1bom400e9vof8knzxdkuy`，code `123456`，attempts `0/3`，status `verified`，consumedAt `2026-10-17T06:48:01.838Z` |

每个面板都对应一条真实 `ToolInvocation`（第 7 节），不存在「散文声称面板却无 `PendingAction`」的情形；本报告的任何面板结论都由上表的持久化行支撑。

## 9. DB 交叉核对（权威 SQLite，只读脚本 `logs/lE-dbcheck-round2.ts`，输出 `logs/lE-dbcheck-round2.txt`）

`demoNow()` = `2026-09-25T04:00:00.000Z`（`lib/clock.ts`，UTC+08:00 月窗口）。`userId=user_liming`，结算账户 `acct_checking`。

**RAW `Card` 行**（第 10–16 行）

| 卡 | type | status | numberMasked | monthlyLimitMinor | credit/available | linkedAccountId | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 源卡 `cardidem_b0aeb5ece9b12e0edec896d1323b239f` | VIRTUAL | **LOST** | ****4977 | 10000 | null / null | acct_checking | **cmvc1boyz00emvof8fi5avmcs** |
| 补办卡 `cmvc1boyz00emvof8fi5avmcs` | **VIRTUAL** | **ACTIVE** | ****0148 | **10000（同源卡）** | null / null | **acct_checking（继承源卡）** | null |

卡号不同（`****0148` ≠ `****4977`），结算账户继承成功，月限额相同，补办卡无任何信用额度列。

**额度连续性（补办不得重置）**

| 时点 | 剩余可支付 | 来源 |
| --- | --- | --- |
| 开卡后 | `100.00` | RAW `monthlyLimitMinor=10000`，此时尚未消费（lE 在开卡与首笔消费之间不渲染卡片，故 100.00 未以「当前可支付金额」形式出现；本报告不把未观测值当作观测值） |
| 挂失前消费 `30.00` 后 | `70.00` | `/cards` `payableAmount=70.00` + 卡片渲染 `当前可支付金额=¥70.00`（`logs/lE-evidence.json` 的 `payableAfterReplace`、`tileRows`） |
| 补办完成后 | **仍 `70.00`** | 同上；并显式排除 `payableAmount === 100.00`（重置 bug 签名） |
| 补办卡消费 `70.00` 后 | `0.00` | `/cards` `payableAmount=0.00`（`payableAfterExhaustion`） |

DB 侧卡家族月度已用（`banking-sdk/card-family.ts#cardFamilyMonthSpend`，同 `demoNow()` 月窗口，`logs/lE-dbcheck-round2.txt` 第 118–120 行）：源卡家族 `10000`、补办卡家族 `10000` —— 说明两卡属于同一家族；月额度先 `3000`（补办时刻，`logs/lE-evidence.json#familySpentMinor`）后 `10000`，故 `min(账户可用余额, 10000 − 10000) = 0.00`。

**消费与资金（恰一次）**

| 项目 | 值 |
| --- | --- |
| `CardConsumption` 总数 | 2（源卡 1 + 补办卡 1） |
| 源卡消费 | `cmvc1bi5x0042vof8t9lxd5yz`：cardId=源卡、`amountMinor=3000`、`购物`/`虚拟卡挂失前消费验证`、executionKey `8bc04075-54cd-4e04-b9ab-4ee66137b994` |
| 补办卡消费 | `cmvc1bq4g00f3vof8fkqbg3jx`：cardId=补办卡、`amountMinor=7000`、`购物`/`虚拟卡补办续限验证`、executionKey `be44af36-1c8b-4ef9-be70-81a140a43acc` |
| 补办卡的 `channel=CARD`/`direction=DEBIT` `Transaction` | 恰好 1 条：`cmvc1bq4f00f2vof8dqr5jryd`，`amountMinor=-7000`，`occurredAt=2026-09-25T04:00:00.000Z` |
| 账户余额 | `acct_checking.balanceMinor`：2358000 → 2355000（-3000）→ **2348000**（-7000，恰扣一次） |
| 超限拒绝 | `1.00`（`虚拟卡超限拒绝验证`）→ 弹窗文案「超出本月消费限额」，`422 LIMIT_EXCEEDED`；DB 无该商家的 `Transaction`/`CardConsumption`，余额不变，`payableAmount` 仍 `0.00` |

消费入账时间由服务端拥有：两条 `CardConsumption.occurredAt` 与本轮新增的两条 `Transaction.occurredAt` 均为 `2026-09-25T04:00:00.000Z`（`demoNow()`），本轮未向请求体发送任何 `occurredAt`。

## 10. 截图

- `output/playwright/live/lE-head7a7a4d3-round2/01-lE-replacement-card.png`（88,746 字节）— 补办后新卡 `****0148`，卡片渲染 `当前可支付金额 ¥70.00`
- `output/playwright/live/lE-head7a7a4d3-round2/02-lE-exhausted-refusal.png`（105,405 字节）— 额度用尽后的「超出本月消费限额」拒绝

原始产物（只在 `logs/`，gitignored，不提交）：`logs/live-lE-head-round2.log`、`logs/lE-evidence.json`、`logs/lE-dbcheck-round2.txt`、`logs/lE-dbcheck-round2.ts`、`logs/exitcode-control.txt`、`logs/ctl7.log`、`logs/ctl0.log`、`logs/ctl-old-method.log`、`logs/install.log`、`logs/prisma-generate.log`、`logs/cleanup-check-round2.txt`、`logs/cleanup-own-procs.txt`、`logs/tree-proof.txt`。

## 11. 资源清理

- dev server（`next dev`，pid 14572，`http://localhost:52744`）与浏览器已由入口 `teardown()`/`process.on('exit')` 兜底结束。
- 端口与 PID（`logs/cleanup-check-round2.txt`，`cmd /v:on` 延迟展开，退出码可信）：
  - `netstat -ano | findstr LISTENING | findstr :52744` → 无输出，退出码 `1`（无监听）
  - `netstat -ano | findstr LISTENING | findstr :3000` → 无输出，退出码 `1`（无监听）
  - **正对照**：对含 `:52744-here` 的文件执行 `findstr` → 输出匹配行、退出码 `0`，证明 `findstr` 确实在读文件，因此上面的 `1` 是「真的没有」而不是「没读」
  - **负对照**：对不含该串的文件执行 `findstr` → 无输出、退出码 `1`
  - `tasklist /fi "pid eq 14572"` → `INFO: No tasks are running which match the specified criteria.`（`logs/cleanup-pid-devserver.txt`）
- 进程（`logs/cleanup-own-procs.txt`）：系统中 `node.exe`/`chrome.exe` 里命令行引用 `worker_T5_A49|next-server|playwright|live-acceptance` 的数量为 `MATCH_COUNT=0`。
- `git status --porcelain` 在清理后为空（`logs/cleanup-git-status.txt` 只有 `GIT_EXIT=0` 行，无文件列表）。

本轮的临时脚本与日志都在 `logs/`（gitignored），未提交；未提交任何 `*.db`、`.env*`、`node_modules`。

## 12. 未验证项（NOT verified）

明确未验证，不得据本报告推断：

1. 集群并发、多进程或多浏览器并发行为（本轮单进程单浏览器）。
2. 真实银行/清算接入（本项目仅模拟）。
3. 浏览器渲染质量本身：只核对了第 10 节两张截图覆盖的补办卡与拒绝态画面。
4. MFA 错误验证码路径（`attempts > 0`、尝试上限、锁定持久化）：三条腿都只提交正确码 `123456`，`MfaChallenge.attempts` 恒为 `0/3`。
5. 开卡后「可支付金额 100.00」的界面渲染：lE 在该时点不渲染卡片，本轮未观测（见第 9 节说明）。
6. 除 `lE` 之外任何场景在本 HEAD 的通过情况（本轮未运行其它场景）。
7. 模型非确定性：本轮三条腿都在第 1 条自然轮次内发起受控工具调用，但单轮通过不能证明该模型长期稳定。
8. 生产构建（`next build`）与部署路径。
