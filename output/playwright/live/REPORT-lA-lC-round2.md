# LIVE 回归证据 — 组合场景 `lA,lC`（信用卡挂失→补办 + 虚拟卡消费）— ROUND 2

- 日期（本机）：2026-10-17 13:51:47 → 13:52:35 (+08:00)
- 提交（HEAD）：`2b47799`（第 1 轮证据提交；本 worktree 未修改任何产品代码）
- 模式：**live**（真实 DeepSeek 模型 + 真实 headless Chrome，无 mock、无请求拦截）
  - `/api/health` 观测值：`{"ok":true,"data":{"status":"ok","time":1792216328587,"llmMode":"live"}}`
- 解析后的活动模型 id：**`deepseek-flash`**（未设 `LIVE_FORCE_MODEL`；入口打印 `Live run uses the configured model.`，模型 id 来自 `.env.local` 的 `LLM_MODEL`）
- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 隔离数据库：`prisma/live-acceptance.db`（本轮独立进程，入口重新删除并 `db push` → probe → `tsx prisma/seed.ts`；`dev.db`/`test.db` 未受影响）
- 本轮为**独立进程、独立数据库**，与第 1 轮无状态重叠；`lA` 仍在同进程内先于 `lC` 执行

## 1. 精确命令

```powershell
$env:LIVE_SCENARIOS='lA,lC'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

实际执行形式（保留退出码，stdout+stderr 逐字落盘为 UTF-8）：

```powershell
$env:LIVE_SCENARIOS='lA,lC'
cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lA-lC-round2.log 2>&1"
```

完整输出：`logs/lA-lC-round2.log`（未提交，`logs/` 被 gitignore）。

## 2. 退出码与汇总

| 项 | 值 |
| --- | --- |
| 进程退出码 | **0** |
| 汇总行（逐字） | `== 汇总：PASS 2 ｜ FAIL 0 ｜ SKIP 0 ==` |

退出码 0 与 `PASS 2 ｜ FAIL 0 ｜ SKIP 0` 同时成立 → **PASS**。未选场景 `7`，无 SKIP。

## 3. PASS 证据串（逐字，来自 reporter）

### 3.1 `lA`

```
PASS lA-live-credit-card-report-lost-and-replace — A1 实际发送：「我的信用卡丢失了，请帮我正式挂失尾号6688的信用卡」 → MFA 123456 → card_credit=LOST；A2 实际发送：「请为我挂失的信用卡补办一张新卡」 → MFA 123456 → 新卡 cmvbzbzwo00c640f8xyi8y74e（信用额度=¥18,000.00、可用额度=¥18,000.00，状态含「正常」）；/cards 上 card_credit 显示「已挂失」+「已补卡」；GET /api/cards：共 4 张、唯一 ACTIVE 信用卡 id=cmvbzbzwo00c640f8xyi8y74e、creditLimit=18000.00、availableLimit=18000.00、card_credit.status=LOST、replacedByCardId=cmvbzbzwo00c640f8xyi8y74e；再次补卡实际发送：「请为我挂失的信用卡补办一张新卡」 → 「确认，请为我补办」 → 「请再提交一次这张卡的补办申请，我要确认不会重复发卡」（重复请求，允许重放/返回既有结果/显式拒绝，不要求二次 MFA/工具执行）后仍为 4 张、ACTIVE id=cmvbzbzwo00c640f8xyi8y74e（未新增第二张）；可用信用额度（非 LOST 信用卡合计）：补办前 18000.00（card_credit:ACTIVE:可用=18000.00）→ 补办后 18000.00（唯一 ACTIVE 补办卡 cmvbzbzwo00c640f8xyi8y74e:可用=18000.00；card_credit:LOST:可用=18000.00，已排除）；把 LOST 源卡也计入的朴素合计 18000.00 → 36000.00（重复计额度，已被断言排除）；重复补卡后合计=18000.00；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\01-lA-cards.png
```

### 3.2 `lC`

```
PASS lC-live-virtual-card-consumption — C1 实际发送：「我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？」 → 「那我这张虚拟卡当前最多可以支付多少钱？」 → 仍恰 1 张 VIRTUAL 卡（card_virtual，未被重复开通）；C2 前端消费弹窗（绑定 card_virtual，月限额 ¥5,000.00、关联账户 ****8821、消费前当前可支付金额 ¥5,000.00）提交 ¥88.00（购物/虚拟卡消费验证）→ 消费成功；SQLite：新增 1 条 channel=CARD/DEBIT 流水 -8800（cmvbzcd9u01lr40f8ajt5ihdq）、1 条 CardConsumption amountMinor=8800（cmvbzcd9v01ls40f8iqgzxwkd）；活期余额 23580.00 → 23492.00（恰扣一次）；card_virtual.payableAmount 5000.00 → 4912.00 = min(可用余额 23492.00、剩余月限额 4912.00)；卡片「当前可支付金额」=¥4,912.00；记账时间由服务端拥有：弹窗请求体逐字 {"amount":"88.00","category":"购物","merchant":"虚拟卡消费验证","executionKey":"8cc993d9-46a2-462c-b829-db3266ef61a4"}（键=amount,category,executionKey,merchant，无 occurredAt），落账 Transaction.occurredAt 与 CardConsumption.occurredAt 均为 2026-09-25T04:00:00.000Z（= DEMO_NOW 服务端业务时钟 2026-09-25T12:00:00+08:00）；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\02-lC-consume-form.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\03-lC-consume-success.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\04-lC-card-tile.png
```

## 4. 自然语言提示词（逐字，实际发送）

### 4.1 `lA` — 挂失腿（A1）

| # | 提示词 |
| --- | --- |
| 1 | `我的信用卡丢失了，请帮我正式挂失尾号6688的信用卡` |

**唯一实际发送的一条**，第 1 轮即停放 MFA 卡。未使用的候选催促：`确认，请办理`、`界面上方没有出现确认面板，请重新发起这张卡的挂失`、`请直接帮我办理挂失，我已经确认`。

### 4.2 `lA` — 补办腿（A2）

| # | 提示词 |
| --- | --- |
| 1 | `请为我挂失的信用卡补办一张新卡` |

**唯一实际发送的一条**，第 1 轮即停放 MFA 卡。未使用的候选催促：`确认，请为我补办`、`界面上方没有出现确认面板，请重新发起补办`、`请直接为我补办一张新卡，我已确认`。

### 4.3 `lA` — 幂等腿（第二次补办）

| # | 提示词 | 该轮的模型行为 |
| --- | --- | --- |
| 1 | `请为我挂失的信用卡补办一张新卡` | 纯散文回答，0 个 `ToolInvocation`、无 `PendingAction`（`AgentRun cmvbzc0hk00cm40f8fb7yjssl` = `completed`，1 次 `ModelRequest`） |
| 2 | `确认，请为我补办` | 仍为纯散文/拒绝重复，0 个 `ToolInvocation`、无 `PendingAction`（`AgentRun cmvbzc24800ih40f8buv35vhk` = `completed`，1 次 `ModelRequest`） |
| 3 | `请再提交一次这张卡的补办申请，我要确认不会重复发卡` | 仍为纯散文，0 个 `ToolInvocation`、无 `PendingAction`（`AgentRun cmvbzc3r100p440f8qf9cao82` = `completed`，1 次 `ModelRequest`） |

**3 个自然轮次用尽**（候选序列全部发送）——本轮模型选择「不重复执行写操作、只作解释」，属于断言允许的三条路径之一（重放 / 返回既有结果 / 显式拒绝）。该腿的判定完全依据权威 `GET /api/cards`：卡片仍 4 张、ACTIVE 信用卡 id 未变。

### 4.4 `lC` — 虚拟卡确认腿（C1）

| # | 提示词 | 该轮的模型行为 |
| --- | --- | --- |
| 1 | `我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？` | 纯信息回答（无工具、GREEN） |
| 2 | `那我这张虚拟卡当前最多可以支付多少钱？` | `describe_turn({"operations":["get_cards"],"purpose":"query"})` → `get_cards({})` |

共 **2 个自然轮次**，`requireCardAtEnd = false`；消费腿不经过模型（走 `/cards` 真实消费弹窗）。

## 5. 确认 / MFA 面板

| 腿 | 真实面板是否出现 | `PendingAction` | 完成方式 |
| --- | --- | --- | --- |
| A1 挂失 | **是** | `cmvbzbw96007140f8ydkw1ux2`，`report_lost_card`，`RED`，`requiresMfa=true`，`status=executed` | 浏览器内真实提交 MFA `123456`；`MfaChallenge.status=verified`、`attempts=0/3`、`verifiedAt=2026-10-17T05:52:13.821Z` |
| A2 补办 | **是** | `cmvbzbzbl00bs40f84hrbbflr`，`replace_card`，`RED`，`requiresMfa=true`，`status=executed` | MFA `123456`；`verified`、`attempts=0/3`、`verifiedAt=2026-10-17T05:52:16.767Z` |
| 幂等腿 | **否** | 无（3 轮均为散文，模型未发起受控工具） | — |
| C1 虚拟卡确认 | **否**（信息型请求） | 无 | — |
| C2 消费 | **否**（UI 消费弹窗） | 无 | — |

两次 MFA 均一次通过、零错误尝试，无熔断；面板均由网关从真实工具调用持久化 `PendingAction` 产生，非模型散文。本轮库内 `PendingAction` 总数 = **2**（无第三次补办动作）。

## 6. 澄清 / 催促 / 重试 / 超时

| 项 | lA | lC |
| --- | --- | --- |
| 澄清（clarification） | 无 | 无 |
| 催促（nudge） | 幂等腿 2 次（3 轮全用尽）；挂失/补办腿 0 次 | 0 次 |
| 续接（write-continuation） | 幂等腿 3 轮均为纯散文且无 `describe_turn` 写声明，未触发现有界续接 | 无 |
| 重试 / 恢复 | 无（`recoveryAttempts=0`，全部 `ToolInvocation.attempt=1`） | 无 |
| 超时 | 无 | 无 |
| 自然轮次 | A1 **1**、A2 **1**、幂等腿 **3** | C1 **2**、消费腿 **0** |
| `assertNoFabricatedConfirmationPanel` | 未触发失败（散文未声称面板） | 未触发失败 |

模型调用规模（DB 权威）：`AgentRun` **9** 条、`ModelRequest` **9** 条、`ToolInvocation` **8** 条。

| run | 工具（ordinal） |
| --- | --- |
| 挂失腿 | `describe_turn({"operations":["get_cards"],"purpose":"operation"})`(1) → `get_cards({})`(2) → `describe_turn({"operations":["report_lost_card"],"purpose":"operation"})`(3) → `report_lost_card({"cardId":"card_credit","reason":"卡片丢失，用户申请正式挂失"})`(4) |
| 补办腿 | `describe_turn({"operations":["replace_card"],"purpose":"operation"})`(1) → `replace_card({"cardId":"card_credit"})`(2) |
| 幂等腿 3 轮 | **无工具调用** |
| C1 第 2 轮 | `describe_turn({"operations":["get_cards"],"purpose":"query"})`(1) → `get_cards({})`(2) |

授权决策（`AuthorizationDecision`）：`get_cards` → `allow`/`GREEN`；`report_lost_card` → `require_mfa`/`RED`；`replace_card` → `require_mfa`/`RED`。

## 7. 权威 DB 交叉核对（`prisma/live-acceptance.db`，运行结束后立即读取）

原始转储：`logs/lA-lC-round2.db.json`、`logs/lA-lC-round2.ops.json`（未提交）。

### 7.1 `lA` — 信用卡状态与「额度不得翻倍」

| 卡片 id | type | status | creditLimit | availableLimit | monthlyLimit | numberMasked | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `card_credit` | CREDIT | **LOST** | 18000.00 | 18000.00 | 18000.00 | ****6688 | `cmvbzbzwo00c640f8xyi8y74e` |
| `cmvbzbzwo00c640f8xyi8y74e`（**新卡**） | CREDIT | **ACTIVE** | 18000.00 | 18000.00 | 18000.00 | ****7185 | null |
| `card_debit` | DEBIT | ACTIVE | null | null | null | ****8821 | null |
| `card_virtual` | VIRTUAL | ACTIVE | null | null | 5000.00（`500000`） | ****7788 | null |

| 断言 | 值 | 结论 |
| --- | --- | --- |
| 源卡 `card_credit` 仍 `LOST` | `LOST`（`availableLimitMinor` 仍 1800000，但状态为 LOST 不参与可用合计） | ✅ |
| 恰有 1 张 ACTIVE CREDIT 卡 | `activeCreditCardIds = ["cmvbzbzwo00c640f8xyi8y74e"]`、`creditCardCount=2`（1 ACTIVE + 1 LOST） | ✅ 仅新增 1 张 |
| 新卡额度继承原卡 | `creditLimit=availableLimit=18000.00` | ✅ 未放大 |
| **非 LOST 信用卡可用额度合计** | **`18000.00`** | ✅ **未翻倍** |
| 朴素全 CREDIT 合计（bug 特征，必须排除） | **`36000.00`**（`card_credit:LOST:18000.00` + 新卡 `18000.00`） | ⛔ 已显式排除 |
| 卡片总数（幂等腿用尽 3 轮后） | **4**；`card_debit` 1 张、`card_virtual` 1 张；ACTIVE 信用卡 id 不变 | ✅ 未发第三张卡 |
| 幂等腿库内痕迹 | 无第三个 `PendingAction`、无第二条 `replace_card` 回执/审计（回执仅 `rcpt_e038e3753a57f8c9c1c5231a2e344dc9`、`rcpt_e98c443f902bf58ec0e1f24fc2e825aa`） | ✅ 重复请求未再执行写操作 |
| 重复请求后非 LOST 合计 | `18000.00` | ✅ |

审计：两条 `AuditLog` 均 `riskLevel=RED`、`confirmationRequired=true`、`confirmed=true`、`mfaRequired=true`、`mfaResult=success`、`status=success`；回执 `txId=null`（挂失/补办不产生资金流水）。

### 7.2 `lC` — 消费的唯一性、余额与可支付金额

| 项 | 值 |
| --- | --- |
| 流水 id | `cmvbzcd9u01lr40f8ajt5ihdq` |
| `amountMinor` | `-8800`（= **−¥88.00**） |
| `channel` / `direction` | `CARD` / `DEBIT` |
| `category` / `merchant` | `购物` / `虚拟卡消费验证` |
| `occurredAt` | **`2026-09-25T04:00:00.000Z`**（= `DEMO_NOW` 2026-09-25T12:00:00+08:00） |
| 同一 `merchant` 的 CARD/DEBIT 流水数 | **恰 1 条**（`virtualDebitsCount=1`） |
| `acct_checking` CARD/DEBIT 流水总数 | **91**（种子 90 → +1） |

| 项 | 值 |
| --- | --- |
| `CardConsumption` id | `cmvbzcd9v01ls40f8iqgzxwkd` |
| `cardId` / `accountId` | `card_virtual` / `acct_checking` |
| `amountMinor` | `8800`（= **¥88.00**） |
| `category` / `merchant` | `购物` / `虚拟卡消费验证` |
| `occurredAt` | **`2026-09-25T04:00:00.000Z`**（`debitAndConsumptionOccurredAtEqual=true`） |
| `executionKey` | `8cc993d9-46a2-462c-b829-db3266ef61a4` |
| 库内 `CardConsumption` 总数 | **1** |

| 项 | BEFORE | AFTER |
| --- | --- | --- |
| `acct_checking.balanceMinor` | `2358000`（¥23,580.00） | **`2349200`（¥23,492.00）** |
| 差额 | — | 恰 `-8800`（**仅扣一次**） |
| `card_virtual` 剩余月限额 | 5000.00 | 4912.00 |
| `card_virtual.payableAmount` | 5000.00 | **4912.00** = `min(23492.00, 4912.00)` ✅ |
| `/cards` 渲染「当前可支付金额」 | — | **`¥4,912.00`** |

请求体键集 `amount,category,executionKey,merchant`，**无 `occurredAt`**；落账时间全部来自服务端 `demoNow()`。

## 8. 截图（本轮副本；入口固定文件名会被下一轮覆盖）

- `output/playwright/live/lA-lC-round2/01-lA-cards.png`
- `output/playwright/live/lA-lC-round2/02-lC-consume-form.png`
- `output/playwright/live/lA-lC-round2/03-lC-consume-success.png`
- `output/playwright/live/lA-lC-round2/04-lC-card-tile.png`

固定名文件 `output/playwright/live/0{1..4}-*.png`（受 git 跟踪）在本轮结束时被入口覆盖，其内容即**本轮**渲染；每轮独立副本见 `lA-lC-round1/`、`lA-lC-round2/`。

网络/控制台：`累计网络 4xx/5xx：0，console error：0，pageerror：0`。

## 9. 结论

第 2 轮（独立进程 + 独立数据库）与第 1 轮结论一致：`lA` + `lC` 双 PASS、退出码 0、无 SKIP；补办未使可用信用额度翻倍（非 LOST 合计恒 18000.00，朴素合计 36000.00 被排除），幂等腿 3 轮散文拒绝重复执行、未发第三张卡；`lC` 恰一笔 CARD/DEBIT 流水与恰一条 `CardConsumption`、余额恰扣一次、可支付金额 = `min(可用现金, 剩余月限额)`、记账时间由 `DEMO_NOW` 决定。

与第 1 轮的**行为差异（非缺陷）**：幂等腿第 1 轮在第 2 个自然轮次由模型重新发起 `replace_card` 并返回既有结果；第 2 轮模型 3 轮均只用散文解释、未再发起写工具。两条路径都在断言允许范围内，且卡片数与额度均未变化。
