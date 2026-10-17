# LIVE 回归证据 — 组合场景 `lA,lC`（信用卡挂失→补办 + 虚拟卡消费）— ROUND 1

- 日期（本机）：2026-10-17 13:48:34 → 13:49:46 (+08:00)
- 提交（HEAD）：`4a05bf4`（merge commit；本 worktree 未修改任何产品代码）
- 模式：**live**（真实 DeepSeek 模型 + 真实 headless Chrome，无 mock、无请求拦截）
  - `/api/health` 观测值：`{"ok":true,"data":{"status":"ok","time":1792216144196,"llmMode":"live"}}`
- 解析后的活动模型 id：**`deepseek-flash`**（未设 `LIVE_FORCE_MODEL`；入口打印 `Live run uses the configured model.`，模型 id 来自 `.env.local` 的 `LLM_MODEL`）
- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 隔离数据库：`prisma/live-acceptance.db`（每轮入口先删除并 `db push` → probe → `tsx prisma/seed.ts`；`prisma/dev.db` 与 `prisma/test.db` 未受影响）
- 本轮两个场景在**同一进程、同一数据库**中顺序执行（先 `lA` 后 `lC`），`lC` 的卡片数断言以场景开始时的 `GET /api/cards` 为基线

## 1. 精确命令

```powershell
$env:LIVE_SCENARIOS='lA,lC'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

实际执行形式（保留退出码，stdout+stderr 逐字落盘为 UTF-8）：

```powershell
$env:LIVE_SCENARIOS='lA,lC'
cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lA-lC-round1.log 2>&1"
```

完整输出：`logs/lA-lC-round1.log`（未提交，`logs/` 被 gitignore）。

## 2. 退出码与汇总

| 项 | 值 |
| --- | --- |
| 进程退出码 | **0** |
| 汇总行（逐字） | `== 汇总：PASS 2 ｜ FAIL 0 ｜ SKIP 0 ==` |

退出码 0 与 `PASS 2 ｜ FAIL 0 ｜ SKIP 0` 同时成立 → **PASS**。场景 `7` 未被选中（`LIVE_SCENARIOS` 不含 `7`），所以本轮只有 `lA`/`lC` 两次 PASS，无 SKIP。

## 3. PASS 证据串（逐字，来自 reporter）

### 3.1 `lA`

```
PASS lA-live-credit-card-report-lost-and-replace — A1 实际发送：「我的信用卡丢失了，请帮我正式挂失尾号6688的信用卡」 → MFA 123456 → card_credit=LOST；A2 实际发送：「请为我挂失的信用卡补办一张新卡」 → MFA 123456 → 新卡 cmvbz84fi00a64gf81y50o1d9（信用额度=¥18,000.00、可用额度=¥18,000.00，状态含「正常」）；/cards 上 card_credit 显示「已挂失」+「已补卡」；GET /api/cards：共 4 张、唯一 ACTIVE 信用卡 id=cmvbz84fi00a64gf81y50o1d9、creditLimit=18000.00、availableLimit=18000.00、card_credit.status=LOST、replacedByCardId=cmvbz84fi00a64gf81y50o1d9；再次补卡实际发送：「请为我挂失的信用卡补办一张新卡」 → 「确认，请为我补办」（重复请求，允许重放/返回既有结果/显式拒绝，不要求二次 MFA/工具执行）后仍为 4 张、ACTIVE id=cmvbz84fi00a64gf81y50o1d9（未新增第二张）；可用信用额度（非 LOST 信用卡合计）：补办前 18000.00（card_credit:ACTIVE:可用=18000.00）→ 补办后 18000.00（唯一 ACTIVE 补办卡 cmvbz84fi00a64gf81y50o1d9:可用=18000.00；card_credit:LOST:可用=18000.00，已排除）；把 LOST 源卡也计入的朴素合计 18000.00 → 36000.00（重复计额度，已被断言排除）；重复补卡后合计=18000.00；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\01-lA-cards.png
```

### 3.2 `lC`

```
PASS lC-live-virtual-card-consumption — C1 实际发送：「我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？」 → 「那我这张虚拟卡当前最多可以支付多少钱？」 → 仍恰 1 张 VIRTUAL 卡（card_virtual，未被重复开通）；C2 前端消费弹窗（绑定 card_virtual，月限额 ¥5,000.00、关联账户 ****8821、消费前当前可支付金额 ¥5,000.00）提交 ¥88.00（购物/虚拟卡消费验证）→ 消费成功；SQLite：新增 1 条 channel=CARD/DEBIT 流水 -8800（cmvbz8r09013n4gf8mll2uc5m）、1 条 CardConsumption amountMinor=8800（cmvbz8r0a013o4gf8r9xahrjk）；活期余额 23580.00 → 23492.00（恰扣一次）；card_virtual.payableAmount 5000.00 → 4912.00 = min(可用余额 23492.00、剩余月限额 4912.00)；卡片「当前可支付金额」=¥4,912.00；记账时间由服务端拥有：弹窗请求体逐字 {"amount":"88.00","category":"购物","merchant":"虚拟卡消费验证","executionKey":"d2315b1a-21c2-4de9-80aa-8f4052dc5cc6"}（键=amount,category,executionKey,merchant，无 occurredAt），落账 Transaction.occurredAt 与 CardConsumption.occurredAt 均为 2026-09-25T04:00:00.000Z（= DEMO_NOW 服务端业务时钟 2026-09-25T12:00:00+08:00）；截图 D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\02-lC-consume-form.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\03-lC-consume-success.png / D:\projects\banking-agent\.genesis\workers\worker_T5_A40\output\playwright\live\04-lC-card-tile.png
```

## 4. 自然语言提示词（逐字，实际发送）

### 4.1 `lA` — 挂失腿（A1）

| # | 提示词 | 说明 |
| --- | --- | --- |
| 1 | `我的信用卡丢失了，请帮我正式挂失尾号6688的信用卡` | **唯一实际发送的一条**；第 1 轮即停放 MFA 卡 |

候选序列中未使用的催促：`确认，请办理`、`界面上方没有出现确认面板，请重新发起这张卡的挂失`、`请直接帮我办理挂失，我已经确认`。

### 4.2 `lA` — 补办腿（A2）

| # | 提示词 | 说明 |
| --- | --- | --- |
| 1 | `请为我挂失的信用卡补办一张新卡` | **唯一实际发送的一条**；第 1 轮即停放 MFA 卡 |

未使用的催促：`确认，请为我补办`、`界面上方没有出现确认面板，请重新发起补办`、`请直接为我补办一张新卡，我已确认`。

### 4.3 `lA` — 幂等腿（第二次补办）

| # | 提示词 | 说明 |
| --- | --- | --- |
| 1 | `请为我挂失的信用卡补办一张新卡` | 该轮模型**只输出散文、未发起受控工具**（`AgentRun cmvbz8cvn00am4gf82cqfpoaq` = `completed`、1 次 `ModelRequest`、0 个 `ToolInvocation`），无面板、无 `PendingAction` |
| 2 | `确认，请为我补办` | 第 2 轮模型发起 `describe_turn(replace_card)` + `replace_card`，停放 MFA 卡并执行 |

`driveRedTool` 在第 2 轮拿到卡片后结束，候选第 3 条 `请再提交一次这张卡的补办申请，我要确认不会重复发卡` **未发送**。该腿共 **2 个自然轮次**。

### 4.4 `lC` — 虚拟卡确认腿（C1）

| # | 提示词 | 说明 |
| --- | --- | --- |
| 1 | `我只是想确认一下我现有的那张虚拟卡（尾号7788）的状态，不需要新办卡，可以吗？` | 纯信息询问，GREEN，无面板 |
| 2 | `那我这张虚拟卡当前最多可以支付多少钱？` | 模型调用 `get_cards`（GREEN `allow`），无面板 |

该腿 `requireCardAtEnd = false`（纯信息请求不产生 `PendingAction`），共 **2 个自然轮次**；`VIRTUAL_CONSUME_AMOUNT`/消费腿**不经过模型**（走 `/cards` 真实消费弹窗）。

## 5. 确认 / MFA 面板

| 腿 | 真实面板是否出现 | `PendingAction` | 完成方式 |
| --- | --- | --- | --- |
| A1 挂失 | **是** | `cmvbz7zi8005x4gf8ji3namck`，`report_lost_card`，`riskLevel=RED`，`requiresMfa=true`，`status=executed` | 浏览器内真实提交 MFA `123456`；`MfaChallenge.status=verified`、`attempts=0/3`、`verifiedAt=2026-10-17T05:49:12.213Z` |
| A2 补办 | **是** | `cmvbz83lr009s4gf8g9nnqjne`，`replace_card`，`RED`，`requiresMfa=true`，`status=executed` | MFA `123456`；`verified`、`attempts=0/3`、`verifiedAt=2026-10-17T05:49:16.005Z` |
| 幂等腿 | **是**（第二轮） | `cmvbz8hru00jp4gf83vndz4u9`，`replace_card`，`RED`，`requiresMfa=true`，`status=executed` | MFA `123456`；`verified`、`attempts=0/3`、`verifiedAt=2026-10-17T05:49:34.254Z`；执行结果为**既有补办卡**（未新发卡） |
| C1 虚拟卡确认 | **否**（信息型请求，无受控写工具） | 无 | — |
| C2 消费 | **否**（走 `/cards` 消费弹窗，非模型工具） | 无 | UI 弹窗直接提交 |

三轮 MFA 均一次通过、零错误尝试，未触发熔断。面板均由安全网关从真实工具调用持久化 `PendingAction` 产生，非模型散文。

## 6. 澄清 / 催促 / 重试 / 超时

| 项 | lA | lC |
| --- | --- | --- |
| 澄清（clarification） | 无（模型直接带齐 `cardId`/`reason`，未追问） | 无（信息型问答，无需补参数） |
| 催促（nudge） | 幂等腿 1 次（散文轮次 → `确认，请为我补办`）；挂失/补办腿 0 次 | 0 次 |
| 续接（write-continuation） | 挂失/补办腿未触发（同轮真实发起）；幂等腿第 1 轮为纯散文、无 `describe_turn` 写声明 | 无 |
| 重试 / 恢复 | 无（`AgentRun.recoveryAttempts=0`、全部 `ToolInvocation.attempt=1`） | 无 |
| 超时 | 无 | 无 |
| 自然轮次 | A1 **1**、A2 **1**、幂等腿 **2** | C1 **2**，消费腿 **0**（UI 弹窗） |
| `assertNoFabricatedConfirmationPanel` | 未触发失败（无「散文声称面板」） | 未触发失败 |

模型调用规模（DB 权威）：`AgentRun` 共 **9** 条、`ModelRequest` 共 **12** 条、`ToolInvocation` 共 **9** 条。工具序列：

| run | 工具（ordinal） |
| --- | --- |
| 挂失腿 | `get_cards`(1) → `describe_turn({"operations":["report_lost_card"],"purpose":"operation"})`(2) → `report_lost_card({"cardId":"card_credit","reason":"用户报告信用卡丢失，要求正式挂失"})`(3) |
| 补办腿 | `describe_turn({"operations":["replace_card"],"purpose":"operation"})`(1) → `replace_card({"cardId":"card_credit"})`(2) |
| 幂等腿 | 第 1 轮无工具；第 2 轮 `describe_turn({"operations":["replace_card"],"purpose":"operation"})`(1) → `replace_card({"cardId":"card_credit"})`(2) |
| C1 第 1 轮 | 无工具（纯散文回答） |
| C1 第 2 轮 | `describe_turn({"operations":["get_cards"],"purpose":"query"})`(1) → `get_cards({})`(2) |

授权决策（`AuthorizationDecision`）：`get_cards` → `allow`/`GREEN`；`report_lost_card` → `require_mfa`/`RED`；`replace_card` → `require_mfa`/`RED`（两次）。

## 7. 权威 DB 交叉核对（`prisma/live-acceptance.db`，一次性 Prisma 客户端，运行结束后立即读取）

原始转储：`logs/lA-lC-round1.db.json`、`logs/lA-lC-round1.ops.json`（未提交）。

### 7.1 `lA` — 信用卡状态与「额度不得翻倍」

| 卡片 id | type | status | creditLimit | availableLimit | monthlyLimit | replacedByCardId |
| --- | --- | --- | --- | --- | --- | --- |
| `card_credit` | CREDIT | **LOST** | 18000.00 | 18000.00 | 18000.00 | `cmvbz84fi00a64gf81y50o1d9` |
| `cmvbz84fi00a64gf81y50o1d9`（**新卡**） | CREDIT | **ACTIVE** | 18000.00 | 18000.00 | 18000.00 | null |
| `card_debit` | DEBIT | ACTIVE | null | null | null | null |
| `card_virtual` | VIRTUAL | ACTIVE | null | null | 5000.00（`500000`） | null |

| 断言 | 值 | 结论 |
| --- | --- | --- |
| 源卡 `card_credit` 仍 `LOST` | `LOST` | ✅ |
| 恰有 1 张 ACTIVE CREDIT 卡 | `activeCreditCardIds = ["cmvbz84fi00a64gf81y50o1d9"]`、`creditCardCount = 2`（1 ACTIVE + 1 LOST） | ✅ 只新增 1 张 |
| 新卡可用额度继承原卡（未放大） | `18000.00` = 原卡 `18000.00` | ✅ |
| **非 LOST 信用卡可用额度合计** | **`18000.00`**（`cmvbz84fi00a64gf81y50o1d9:ACTIVE:可用=18000.00`） | ✅ **未翻倍** |
| 朴素全 CREDIT 合计（bug 特征，必须排除） | **`36000.00`**（`card_credit:LOST:可用=18000.00` + 新卡 `18000.00`） | ⛔ 已判为错误基线，断言显式排除 |
| 卡片总数 | **4**（补办后）。幂等腿第二次 `replace_card` 后仍 4，且 ACTIVE 信用卡 id 不变 | ✅ 未发第三张卡 |
| 幂等腿重复请求结果 | 新 `PendingAction` + 新回执 `rcpt_074157e007dfa0ce5d8aea2668d0e18a`，`toolResult.data.id` 仍为 `cmvbz84fi00a64gf81y50o1d9`、`numberMasked=****6827` | ✅ 返回既有结果（允许的选择） |
| 重复请求后非 LOST 合计 | `18000.00`（再未放额度） | ✅ |

回执：`rcpt_b8bf0b79488ebccb034710126ff1b6ef`（`report_lost_card`）、`rcpt_d509ba4c3536029fea33b6781f71195e`（`replace_card`）、`rcpt_074157e007dfa0ce5d8aea2668d0e18a`（重复 `replace_card`），三者 `txId=null`（挂失/补办不产生资金流水）。审计：三条 `AuditLog` 均 `riskLevel=RED`、`confirmationRequired=true`、`confirmed=true`、`mfaRequired=true`、`mfaResult=success`、`status=success`。

### 7.2 `lC` — 消费的唯一性、余额与可支付金额

| 项 | 值 |
| --- | --- |
| 流水 id | `cmvbz8r09013n4gf8mll2uc5m` |
| `amountMinor` | `-8800`（= **−¥88.00**，精确） |
| `channel` / `direction` | `CARD` / `DEBIT` |
| `category` / `merchant` | `购物` / `虚拟卡消费验证` |
| `occurredAt` | **`2026-09-25T04:00:00.000Z`**（= `DEMO_NOW` 2026-09-25T12:00:00+08:00） |
| 同一 `merchant` 的 CARD/DEBIT 流水数 | **恰 1 条**（`virtualDebitsCount=1`） |
| `acct_checking` CARD/DEBIT 流水总数 | **91**（种子 90 → +1） |

| 项 | 值 |
| --- | --- |
| `CardConsumption` id | `cmvbz8r0a013o4gf8r9xahrjk` |
| `cardId` / `accountId` | `card_virtual` / `acct_checking` |
| `amountMinor` | `8800`（= **¥88.00**） |
| `category` / `merchant` | `购物` / `虚拟卡消费验证` |
| `occurredAt` | **`2026-09-25T04:00:00.000Z`**（与流水 `occurredAt` 相等：`debitAndConsumptionOccurredAtEqual=true`） |
| `executionKey` | `d2315b1a-21c2-4de9-80aa-8f4052dc5cc6`（唯一，可重放不重复扣款） |
| 库内 `CardConsumption` 总数 | **1** |

| 项 | BEFORE | AFTER |
| --- | --- | --- |
| `acct_checking.balanceMinor` | `2358000`（¥23,580.00） | **`2349200`（¥23,492.00）** |
| 差额 | — | 恰 `-8800`（**仅扣一次**） |
| `card_virtual` 剩余月限额（`500000` − `8800`） | 5000.00 | 4912.00 |
| `card_virtual.payableAmount` | 5000.00 | **4912.00** = `min(可用余额 23492.00, 剩余月限额 4912.00)` ✅ |
| `/cards` 渲染「当前可支付金额」 | — | **`¥4,912.00`**（`readCardTileRows` 断言） |

记账时间由服务端拥有：消费弹窗 POST 请求体逐字为 `{"amount":"88.00","category":"购物","merchant":"虚拟卡消费验证","executionKey":"d2315b1a-21c2-4de9-80aa-8f4052dc5cc6"}`，键集 = `amount,category,executionKey,merchant`，**无 `occurredAt`**；落账时间全部来自 `demoNow()`。

## 8. 截图（本轮副本；入口固定文件名会被下一轮覆盖）

- `output/playwright/live/lA-lC-round1/01-lA-cards.png`（`/cards`：补办卡与「已挂失」+「已补卡」源卡）
- `output/playwright/live/lA-lC-round1/02-lC-consume-form.png`（消费弹窗）
- `output/playwright/live/lA-lC-round1/03-lC-consume-success.png`（消费成功）
- `output/playwright/live/lA-lC-round1/04-lC-card-tile.png`（刷新后卡片「当前可支付金额」= ¥4,912.00）

网络/控制台：`累计网络 4xx/5xx：0，console error：0，pageerror：0`。

## 9. 结论

本轮 `lA` + `lC` 组合在同一进程、同一数据库内顺序执行，两次场景均 PASS，退出码 0，无 SKIP。`lA` 补办未把可用信用额度翻倍（非 LOST 合计恒为 18000.00，朴素合计 36000.00 已被断言排除），幂等腿未发第三张卡；`lC` 恰一笔 CARD/DEBIT 流水、恰一条 `CardConsumption`、余额恰好扣一次、可支付金额等于 `min(可用现金, 剩余月限额)`，记账时间完全由服务端 `DEMO_NOW` 决定。
