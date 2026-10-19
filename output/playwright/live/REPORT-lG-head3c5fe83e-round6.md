# LIVE 验收报告 — 场景 lG 第 6 轮（head 3c5fe83e）

场景：`lG-live-full-card-loss-replace-chain-single-session`
入口：`tests/e2e/live-acceptance.e2e.ts`（`LIVE_SCENARIOS='lG'`），真实模型 + 真实浏览器 + 真实 `/agent` `/cards` 路由。

## 结论

**FAIL（测试脚手架缺陷 / harness 假阳性）** —— 业务链路 1–7 全部通过（DB 权威核对见下），第 8 轮断言在
`assertNoFabricatedConfirmationPanel` 处误判：模型散文真实地**否认**存在待确认步骤
（「不存在尚未发起、或仍在等待您确认的步骤」），守卫却命中「等待您确认」并抛出未处理 rejection。
`findConfirmationPanelClaim` 已在本轮后修复（提交 `ca281edf`），修复验证见文末。
本轮**不是**模型缺陷，**不是**产品缺陷；第 8/9 项断言未被脚手架评估（见「断言明细」）。

## 被认证的产品树

- 产品树提交：`3c5fe83e`（`git rev-parse --short HEAD`，本轮开始时）
- 等价性证明：`git diff --stat 3c5fe83e HEAD -- banking-sdk agent security planner lib app components prisma scripts` **为空**（字符数 0），
  即本报告所在提交只改 `tests/e2e` 与证据文件，产品代码与 `3c5fe83e` 完全一致。

## 运行

命令（逐字，PowerShell）：

```
$env:LIVE_SCENARIOS='lG'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lG-r6.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lG-r6.out & exit !EC!"; exit $LASTEXITCODE
```

| 项目 | 值 |
| --- | --- |
| 工具报告的进程退出码 | **1** |
| 日志中的 `EXIT=` 行 | `EXIT=1`（`logs/lG-r6.out:13`） |
| 汇总行 `== 汇总 ==` | **缺失**（入口在 `unhandledRejection` 处理器里 `process.exit(1)`，未走到汇总） |
| 起止（UTC） | 17:10:38.974 → 17:13:37.993 |
| 时长 | **179.01 s** |
| 隔离库 | `prisma/live-acceptance.db`（独立准备：db push → probe → `tsx prisma/seed.ts`） |
| 端口 | `next dev (pid=54548) → http://localhost:50779` |
| `/api/health` | `{"ok":true,"data":{"status":"ok","time":1792343461898,"llmMode":"live"}}` |
| 模型 | **`deepseek-flash`** — 由持久化 `AgentRunEvent(eventType='provider_request_payload').payloadJson.payload.model` 证明：12 行、单一取值 `deepseek-flash` |
| 网络/console 噪声 | 累计网络 4xx/5xx = 1；console error = 1 —— 均为第 5 轮的**预期** 422 限额拒绝 |

噪声逐字：

```
· [console error] Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)
· [net 422] POST http://localhost:50779/api/cards/cmve316js00em60f80n7yefa3/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}
```

失败行（`logs/lG-r6.out:12`）：

```
未处理的 rejection：模型声称确认/MFA 面板已存在（命中「等待您确认」），但页面没有确认/MFA 卡片；GET /api/actions 无 pending/awaiting_mfa 待处理项 → cause=模型未发起受控工具（模型行为）
```

## 起始基线

种子卡片 3 张（场景起始 `GET /api/cards` 基线）：
`card_credit`（CREDIT/ACTIVE，`****6688`，credit/available 1800000）、`card_debit`（DEBIT/ACTIVE，`****8821`）、
`card_virtual`（VIRTUAL/ACTIVE，`****7788`，月限额 500000，`linked_account_id=acct_checking`）。
活期 `acct_checking` 余额 2358000（23580.00）。卡片总数一律由基线推导，未硬编码。

## 逐轮表（逐字）

模型原文取自持久化会话 `AgentSession('demo:user_liming').stateJson`（`logs/lG-r6-transcript.txt`），
`PendingAction.argsJson` 取自 `logs/lG-r6-db.txt`。

### 第 1 轮 — `请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。`
- 工具调用：`describe_turn {"operations":["apply_virtual_card"],"purpose":"operation"}` → `apply_virtual_card {"monthlyLimit":"100.00"}`
- `PendingAction`：`cmve30tiu003860f80d1oada6` / `apply_virtual_card` / `RED` / `requiresMfa=1` / `executed`
- `MfaChallenge`：`cmve30tix003960f868pvqf3b` / attempts 0 / maxAttempts 3 / `verified`（验证码 123456）
- 模型原文：「虚拟卡申请处理结果：第1笔操作实际执行成功；虚拟卡 ****3865 已开通（月限额 ¥100.00）。」
- 卡片：新增 `cardidem_5f48fb701276beaf4b75dfac886f803c` VIRTUAL/ACTIVE/`****3865`/monthly_limit_minor **10000**/`acct_checking`，credit 与 available 均 null
- 金额：`accountAvailableBalance 23580.00`、`payableAmount 100.00`
- 断言 1：**PASS**

### 第 2 轮 — 前端 `/cards` 消费 `30.00`
- 无对话轮次（直接路由 `POST /api/cards/<new>/consume`，`app/cards/CardConsumeDialog.tsx` 只提交 amount/category/merchant）
- `CardConsumption`：`cmve30wwa004260f80ozlf7qt` / 3000 / 购物 / 虚拟卡开卡消费验证 / occurredAt 1790308800000
- `Transaction`：`cmve30wwa004160f8eosbsagr` / -3000 / DEBIT / `channel=CARD` / 同一 occurredAt
- 可支付：`payableAmount 70.00`；余额 23550.00
- 断言 2：**PASS**

### 第 3 轮 — `尾号3865的虚拟卡信息泄露，请正式挂失，我确认不可撤销。`
- 工具调用：`report_lost_card {"cardId":"cardidem_5f48…f803c","reason":"卡信息泄露，客户要求正式挂失（不可撤销）"}`
- `PendingAction`：`cmve30z2s009d60f83udpt7x0` / RED / requiresMfa / `executed`；`MfaChallenge` `cmve30z2u009e60f8phjgqwqf` verified
- 模型原文：「卡片挂失处理结果：第1笔操作实际执行成功；卡片 ****3865 已挂失（原因：卡信息泄露，客户要求正式挂失（不可撤销））。」
- 卡片：`cardidem_5f48…` → `LOST`（金额未变：23550.00，`payableAmount 70.00`）
- 断言 3：**PASS**

### 第 4 轮 — `请为刚才正式挂失的尾号3865虚拟卡再补办一张新卡。`
- 工具调用：`describe_turn {operations:[replace_card]}` → `replace_card {"cardId":"cardidem_5f48…f803c"}`
- `PendingAction`：`cmve316c800e860f8kjphohw9` / `replace_card` / RED / requiresMfa / `executed`；`MfaChallenge` `cmve316ca00e960f8pe48ioal` verified
- 验证前：脚手架 `driveReplaceLegAndVerify` 断言「停在 replace_card 待确认动作、尚无新卡、源卡仍 LOST」并通过（否则不会走到第 5 轮）
- 模型原文：「卡片补办处理结果：第1笔操作实际执行成功；已为原挂失卡片补办新卡 ****6534（当前状态：正常）。」
- 卡片：新增 `cmve316js00em60f80n7yefa3` VIRTUAL/ACTIVE/`****6534`/monthly_limit_minor 10000/`acct_checking`；
  源卡 `replaced_by_card_id=cmve316js00em60f80n7yefa3`、仍 `LOST`
- 续限连续：补办前 70.00 → 补办后 **70.00**（未重置为 100.00）
- 断言 4：**PASS**

### 第 5 轮 — 前端在补办卡上消费 `70.00`，再 `1.00`
- 成功：`CardConsumption` `cmve317p400f360f8i94eqvdq` / 7000 / 虚拟卡补办续限验证；`Transaction` `cmve317p300f260f8nmrykuv0` / -7000 / CARD/DEBIT
- 可支付：**0.00**
- 拒绝：`1.00` → HTTP `422` `{"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}`，界面文案含「超出本月消费限额」
  变体「超过虚拟卡月限额。」（`VC_LIMIT_EXCEEDED_TEXT` 命中）；零副作用（无新增 `Transaction`/`CardConsumption`，余额未变）
- 余额：23550.00 → 23480.00
- 断言 5：**PASS**

### 第 6 轮 — `尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。`
- 工具调用：`get_cards {}` → `describe_turn {operations:[report_lost_card]}` → `report_lost_card {"cardId":"card_credit","reason":"信用卡丢失，客户要求正式挂失（不可撤销）"}`
- `PendingAction`：`cmve31c9c00k560f89rp34fbz` / RED / requiresMfa / `executed`；`MfaChallenge` `cmve31c9e00k660f8oibv0ep9` verified
- 模型原文：「卡片挂失处理结果：第1笔操作实际执行成功；卡片 ★★★★6688 已挂失（原因：信用卡丢失，客户要求正式挂失（不可撤销））。」
- 卡片：`card_credit` → `LOST`（未新增/删除卡片）
- 断言 6：**PASS**

### 第 7 轮 — `请为刚挂失的尾号6688信用卡补办新卡。`（历史上曾被「只能手动办理」拒绝的那一句）
- 工具调用：`describe_turn {operations:[replace_card]}` → **真实** `replace_card {"cardId":"card_credit"}`（非口语拒绝、非纯散文）
- `PendingAction`：`cmve31fmu00o060f8ro12ilg3` / `replace_card` / `RED` / `requiresMfa=1` / `executed`（验证前已停放在闸门 ✅）；`MfaChallenge` `cmve31fmv00o160f8ewk07d8i` verified
- 模型原文：「卡片补办处理结果：第1笔操作实际执行成功；已为原挂失卡片补办新卡 ****1289（当前状态：正常）。」
- 卡片：新增 `cmve31fz800oe60f85d1be887` CREDIT/ACTIVE/`****1289`（≠ `****6688`）；
  `credit_limit_minor=1800000`、`available_limit_minor=1800000`、`monthly_limit_minor=1800000`（继承）；
  源卡 `card_credit.replaced_by_card_id = cmve31fz800oe60f85d1be887`，仍 `LOST`
- 非 LOST 信用可用合计：`1800000`（**18000.00**）；朴素全 CREDIT 合计 `3600000`（36000.00）被显式排除为 bug 签名
- 断言 7：**PASS**

### 第 8 轮 — `确认，请继续办理刚才这笔业务，发起真实的待确认操作，让我在面板里验证。`
- 工具调用：**无**（模型未发起任何受控工具；`ToolInvocation` 无本轮记录，`PendingAction` 无新增行 —— 仍在 5 行）
- 模型原文（逐字）：

```
我刚才已经实际执行了补办信用卡的操作，不存在尚未发起、或仍在等待您确认的步骤：

- 原卡 ****6688 已正式挂失，状态仍为已挂失，永久不可恢复；
- 新卡 ****1289 已补办成功，当前状态正常，信用额度 ¥18,000.00 与可用额度 ¥18,000.00 均继承原卡。

需要说明的是，新卡 ****1289 的消费分类限额目前为空（原卡曾设有餐饮、娱乐、购物、出行分类限额），信用额度本身并未改变。如果希望在新卡上重新设置这些分类限额，告诉我具体金额和分类即可。

另外，如果您想核对补办后的整体用卡情况，我也可以帮您查看当前所有卡片状态。
```

- 该散文**否认**存在待确认步骤，与真相一致（本轮确实没有待确认动作）→ **不是**用户可见的面板伪造。
- 脚手架在 `assertNoFabricatedConfirmationPanel` 处命中「等待您确认」并抛错 → **harness 假阳性**。
- 断言 8：**未评估（FAIL by harness）**；但运行后 DB 独立核对证明其实质要求成立：
  卡片总数仍为 6（基线 3 + 本链路新增 3 = 1 LOST 虚拟卡 + 1 补办虚拟卡 + 1 补办信用卡），
  唯一 ACTIVE CREDIT 仍为 `cmve31fz800oe60f85d1be887`，未出现第二张补办卡。

## 卡片行（运行后，DB 权威）

```
id | type | status | numberMasked | credit_limit_minor | available_limit_minor | monthly_limit_minor | replaced_by_card_id | linked_account_id
cmve31fz800oe60f85d1be887 | CREDIT | ACTIVE | ****1289 | 1800000 | 1800000 | 1800000 |  | 
card_credit | CREDIT | LOST | ****6688 | 1800000 | 1800000 | 1800000 | cmve31fz800oe60f85d1be887 | 
card_debit | DEBIT | ACTIVE | ****8821 |  |  |  |  | 
card_virtual | VIRTUAL | ACTIVE | ****7788 |  |  | 500000 |  | acct_checking
cmve316js00em60f80n7yefa3 | VIRTUAL | ACTIVE | ****6534 |  |  | 10000 |  | acct_checking
cardidem_5f48fb701276beaf4b75dfac886f803c | VIRTUAL | LOST | ****3865 |  |  | 10000 | cmve316js00em60f80n7yefa3 | acct_checking
```

类型/状态汇总：CREDIT ACTIVE 1、CREDIT LOST 1、DEBIT ACTIVE 1、VIRTUAL ACTIVE 2、VIRTUAL LOST 1（共 6）。

## PendingAction（5 行，全部 RED/requiresMfa/executed）

```
cmve30tiu003860f80d1oada6 | apply_virtual_card | RED | 1 | executed | {"monthlyLimit":"100.00"}
cmve30z2s009d60f83udpt7x0 | report_lost_card   | RED | 1 | executed | {"cardId":"cardidem_5f48…f803c","reason":"…"}
cmve316c800e860f8kjphohw9 | replace_card       | RED | 1 | executed | {"cardId":"cardidem_5f48…f803c"}
cmve31c9c00k560f89rp34fbz | report_lost_card   | RED | 1 | executed | {"cardId":"card_credit","reason":"…"}
cmve31fmu00o060f8ro12ilg3 | replace_card       | RED | 1 | executed | {"cardId":"card_credit"}
```

`MfaChallenge` 5 行，全部 `attempts=0`/`maxAttempts=3`/`verified`（只提交正确码 123456）。
`CircuitBreakerState`：`failures=0`、`locked=0`。
`ExecutionReceipt` 5 行，与 5 个 `PendingAction` 一一对应（`rcpt_5f48…`、`rcpt_72fd…`、`rcpt_f406…`、`rcpt_4b31…`、`rcpt_6cd7…`）。

## 断言明细

| # | 断言 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 新开 VIRTUAL/ACTIVE、月限额 10000、绑定 `acct_checking`、真实确认 + MFA | **PASS** | Card 行 + PendingAction/MfaChallenge |
| 2 | 前端消费 30.00 → payable 70.00、1 笔 CARD/DEBIT 流水 + 1 条 CardConsumption | **PASS** | `cmve30wwa…` 两条记录 |
| 3 | `report_lost_card`、源卡 LOST、金额不变 | **PASS** | `cardidem_5f48…` LOST，余额 23550.00 |
| 4 | 真 `replace_card`（RED/requiresMfa）验证前停放、验证后恰 1 张同账户续限卡 | **PASS** | `cmve316c8…` + `cmve316js…`，70.00→70.00 |
| 5 | 消费 70.00 成功（payable 0.00），1.00 被 422 LIMIT_EXCEEDED 拒绝且零资金变化 | **PASS** | 422 报文 + 无第 3 笔流水/消费 |
| 6 | `card_credit` → LOST | **PASS** | `cmve31c9c…` |
| 7 | 真 `replace_card`、恰 1 张 CREDIT/ACTIVE、新卡号 ≠ ****6688、额度继承、非 LOST 合计 18000.00（排除 36000.00） | **PASS** | `cmve31fz8…`、`1800000` vs `3600000` |
| 8 | 第 8 轮不再产生第二张补办卡 | **未评估（harness 中断）**；运行后 DB 证明实质成立 | 卡片总数 6、唯一 ACTIVE CREDIT 不变 |
| 9 | 只有两笔成功消费改变资金；卡数由基线推导 | **未评估（harness 中断）**；运行后 DB 证明实质成立 | 余额 2358000−3000−7000=2348000；CARD/DEBIT 仅新增 2 行 |

## 失败原因与修复（测试侧）

`findConfirmationPanelClaim` 的两个边界共同造成假阳性：

1. `CLAUSE_BOUNDARY` 把「、」当作子句边界 —— 但「、」是并列枚举，`不存在 A、或仍在 B` 中的否定管辖 **B**；
2. `NEGATION_LOOKBEHIND = 10` 的窗口够不到「不存在」。

修复（提交 `ca281edf`，仅 `tests/e2e/panel-claim.e2e-helper.ts`）：把「、」移出 `CLAUSE_BOUNDARY`，窗口放宽到 24 字符，
并写明理由。修复验证用**非 vitest** 直连脚本 `logs/panel-claim-check.mts`（`pnpm exec tsx`）：
10 条正向用例全部仍命中、21 条否定用例全部仍不命中、5 条真实伪造仍命中、第 5 轮与第 6 轮逐字否定句均不再命中
（`TOTAL_FAILURES=0`，见 `logs/lG-panel-claim-check-after-fix.txt`）。

> 遗留建议：第 6 轮这句逐字否定句应作为回归用例补进 `tests/unit/panel-claim.test.ts`（第 5 轮那句已在那里）。
> 该文件属 `tests/unit`，不在本 worker 的 `tests/e2e` 节点与「只改 tests/e2e」的修复范围内，且 vitest 由另一 agent 负责，故未改动。

## 证据路径

- `logs/lG-r6.out`（stdout，含 `EXIT=1`）、`logs/lG-r6-exitcode.txt`、`logs/lG-r6-start.txt`、`logs/lG-r6-end.txt`、`logs/lG-r6-producthead.txt`
- `logs/lG-r6.db`（WAL checkpoint 后副本，`0|0|0`）、`logs/lG-r6-db.txt`（sqlite dump）、`logs/lG-r6-proof.sql`/`lG-cards.sql`（查询脚本）
- `logs/lG-r6-state.json`（原始 `AgentSession.stateJson`，86607 字节）、`logs/lG-r6-transcript.txt`（逐轮逐字）
- 截图：`output/playwright/live/lG-head3c5fe83e-round6/01-lG-virtual-replacement.png`、`02-lG-virtual-refusal.png`、`03-lG-credit-replacement.png`
- **缺失**：`logs/lG-r6-evidence.json` —— 入口在 `unhandledRejection` 中退出，从未执行 `writeScenarioEvidence`。