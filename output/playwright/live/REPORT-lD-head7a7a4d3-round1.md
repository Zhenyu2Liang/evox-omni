# LIVE acceptance evidence — scenario `lD`（虚拟卡自然语言开卡 + 月限额）— HEAD `7a7a4d3` ROUND 1

本文件证明：在**当前 HEAD** 上，`lD` 场景一次独立 live 轮次仍然通过，且 `banking-sdk/card.ts` /
`banking-sdk/card-family.ts` 的「消费快照读取被强制执行那一刻所属月份」改动在生产路径上**行为等价**
（生产环境的那个时刻仍是 `demoNow()`）。

- 日期（本机）：2026-10-17，分钟级时间戳 **14:17** (+08:00)；墙钟约 40s（同一进程内完成
  `db push` → probe → `tsx prisma/seed.ts` → `next dev` 编译 → 真实浏览器 → 2 次真实模型请求 → 三条业务腿）
- **提交（HEAD，本轮认证）**：`7a7a4d32a6a1622deb7647ab6142fb7991b76805`
  ```
  Merge: 109478f 1e337ae
  Merge commit '109478f4b314a186ac972d62f76ba4b3300259de'; commit '1e337ae6eddf836724eb17bcc887679699d9eee5' into evogit-agent-T5-A1
  ```
  - 本轮关心的两次提交均已在历史的祖先链上（`git merge-base --is-ancestor 1e337ae HEAD` → 退出码 `0`）：
    - `248e4ea fix(banking-sdk): consumeCard snapshot reads the allowance at the enforced instant`
    - `1e337ae test(banking-sdk): align card-consumption snapshot assertion with enforced instant`
  - 历史证据轮次（第 1–3 轮）产生于 `f570d58 docs(e2e): note the prior-run screenshot set in the evidence map`，
    本轮**不覆盖**它们的目录与报告（`lD-round1/`…`lD-round3/`、`REPORT-lD-round1..3.md` 保持原样）。
- 模式：**live**（真实 DeepSeek 模型 + 真实 headless Chrome，无 mock、无请求拦截）
  - `/api/health` 观测值：`{"ok":true,"data":{"status":"ok","time":1792217837993,"llmMode":"live"}}`
  - 入口起的隔离服务：`next dev (pid=6820) → http://localhost:49179`
  - 入口横幅：`Live run uses the configured model.`（未设 `LIVE_FORCE_MODEL`）
- 解析后的活动模型 id：**`deepseek-flash`**
  - 权威来源为持久化的 `AgentRunEvent(eventType='provider_request_payload')`：共 **2** 条
    （`runId=cmvc087zx0000jsf8vml1bpbm`，`sequence=9` 与 `sequence=120`），两条的
    `payloadJson.payload.model` 均为 `"deepseek-flash"`
  - 请求体顶层键固定为 `["max_tokens","messages","model","stream","stream_options","thinking","tools"]`；
    `tools` 含 **29** 个工具名（含 `apply_virtual_card`、`consume_virtual_card`），与仓库工具目录一致
  - `AgentRunEvent` 的 `agent_end` 载荷记有 `"model":"deepseek-flash","provider":"deepseek","api":"openai-completions"`，
    即模型由真实 provider 返回；入口无 mock 分支、无响应改写（`ModelRequest` 2 条全为 `completed`、`attempt=1`）
- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 隔离数据库：`prisma/live-acceptance.db`（`db push` → probe → `tsx prisma/seed.ts`；`prisma/dev.db` 与
  `prisma/test.db` 未受影响；`.env.local` 只读取、未修改、未打印）
- 本轮为**独立进程**（该 HEAD 上仅此 1 轮），场景开始前数据库被完整重置。

## 1. 精确命令

```powershell
$env:LIVE_SCENARIOS='lD'
cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lD-7a7a4d3-round1.log 2>&1"
# 退出码由调用方捕获为 EXIT=<code>，写入日志尾部与 logs\live-lD-7a7a4d3-round1-exit.txt
```

PowerShell 不支持 `&&`，因此按上面两行分别执行；场景选择只经环境变量 `LIVE_SCENARIOS='lD'`，
未改动任何入口代码或断言。

完整 stdout：`logs/live-lD-7a7a4d3-round1.log`（未提交，`logs/` 被 gitignore）。

## 2. 退出码与汇总

| 项 | 值 |
| --- | --- |
| 进程退出码 | **0**（`EXIT=0`，见日志第 19 行与 `logs/live-lD-7a7a4d3-round1-exit.txt`） |
| 汇总行（逐字） | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` |

退出码 `0` 与 `PASS 1 ｜ FAIL 0 ｜ SKIP 0` 同时成立 → **PASS**。
本轮**没有重试**：这是该 HEAD 上的第一次也是唯一一次运行，不存在「跑绿一轮后抹去前次失败」的情况。

## 3. PASS 证据串（逐字，来自 reporter）

> 绝对路径前缀 `D:\projects\banking-agent\.genesis\workers\worker_T5_A45\` 以 `…` 代替，其余逐字保留。

```
PASS lD-live-virtual-card-apply-and-limit — lD 实际发送：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_3a027f737aa8128a4897d76c2c5424ce（RAW：type=VIRTUAL、status=ACTIVE、monthlyLimitMinor=10000（100.00）、linkedAccountId=acct_checking、creditLimitMinor=null、availableLimitMinor=null、卡号 ****4221 与既有卡片均不同）；payableAmount=100.00（月限额绑定，账户可用余额 23580.00）；/cards 渲染 {"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}（无「信用额度」/「可用额度」）；消费 30.00（购物/虚拟卡开卡消费验证）→ 消费成功：新增 CARD/DEBIT 流水 -3000（cmvc08e0h005djsf8lhgjfku3）+ 1 条 CardConsumption amountMinor=3000（cmvc08e0i005ejsf879h6985o），活期余额 23580.00 → 23550.00（恰扣一次）；payableAmount → 70.00，刷新后卡片「当前可支付金额」=¥70.00；超限 80.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 70.00；截图 …output\playwright\live\01-lD-new-virtual-card.png / …output\playwright\live\02-lD-after-spend.png / …output\playwright\live\03-lD-over-limit-refusal.png；证据 JSON …logs\lD-evidence.json
```

## 4. 自然语言提示词（逐字）

`tests/e2e/live-virtual-card.e2e-helper.ts#VC_APPLY_TURNS`（场景代码的候选序列，逐字）：

1. `请帮我新开一张虚拟卡，月消费限额设为100元`
2. `确认，请办理开卡`
3. `界面上方没有出现确认面板，请重新发起开卡申请`
4. `请直接为我开通这张月限额100元的虚拟卡，我已确认`

**实际发送：仅第 1 条**（证据 JSON `sentTurns` 为单元素数组）：

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

模型在**第 1 个自然轮次**就发出了受控工具调用并停放 MFA 卡片，第 2–4 条催促**未使用**。
消费腿与超限腿**不经过模型**：都通过 `/cards` 页真实消费弹窗（`app/cards/CardConsumeDialog.tsx`）提交，
没有额外模型轮次（`ModelRequest` 总数恰为 2，均属开卡腿的那一个 run）。

## 5. 模型观测到的工具调用（DB 权威：`ToolInvocation`）

| ordinal | toolName | args（逐字） | status | replaySafety | origin | attempt |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `describe_turn` | `{"operations":["apply_virtual_card"],"purpose":"operation"}` | `completed` | read_only | pi | 1 |
| 2 | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `completed` | idempotent | pi | 1 |

- `ToolInvocation` id：`call_ec5b3ce7-8de6-4b10-a56c-753c9ae9b16e`（`describe_turn`，`callId=call_00_t6eK4ZhTWe3e80iAefOK6625`）、
  `call_803f4ecf-edcf-4bc9-abb1-2bd5106adf9a`（`apply_virtual_card`，`callId=call_00_TgHKBlYMzstajdvE0x1L1113`，
  `operationKey=cmvc08abv004kjsf85exah6pt`）。
- 本轮模型**没有**先调用 `get_cards`；模型把月限额写成 `"100.00"`，服务端规范化为
  `monthlyLimitMinor=10000`（= ¥100.00），无金额歧义。
- `AuthorizationDecision`：恰 **1** 条 —— id `cmvc08abs004jjsf8mpwts8en`，tool `apply_virtual_card`，
  `decision=require_mfa`，`tier=RED`，`commandJson={"monthlyLimit":"100.00"}`，
  `reasonsJson=["Issue a virtual card after confirmation and strong verification."]`。
- `ModelRequest`：**2** 条（`cmvc0880p0008jsf8k5ikvy42` ordinal 1、`cmvc088wo003cjsf8hoo551zc` ordinal 2），
  均 `status=completed`、`attempt=1`（无重试、无恢复重放）。
- `AgentRun`：
  - `cmvc087zx0000jsf8vml1bpbm` → `waiting_verification`（`requestJson = {"kind":"input","message":"请帮我新开一张虚拟卡，月消费限额设为100元"}`，startedAt `06:17:20.250Z` / finishedAt `06:17:23.311Z`）
  - `cmvc08c8w0051jsf8ltg1nlce` → `completed`（`kind=authorization_result`，`actionId=cmvc08abv004kjsf85exah6pt`，
    `toolResult.data = {id, type: VIRTUAL, status: ACTIVE, monthlyLimit: "100.00", payableAmount: "100.00", linkedAccountId: acct_checking, numberMasked: "****4221", accountAvailableBalance: "23580.00", limits: []}`，
    summary=`虚拟卡 ****4221 已开通（月限额 ¥100.00）`，startedAt `06:17:25.759Z` / finishedAt `06:17:25.789Z`）
- `AgentSession` `demo:user_liming`：`status=active`、`revision=2`、`activeRunId=null`、`runLeaseToken=null`，
  `intentJson.steps = [{"key":"step-1","tool":"apply_virtual_card"}]`。

## 6. 确认 / MFA 面板（真实，非模型散文）

| 项 | 值 |
| --- | --- |
| 真实面板是否出现 | **是**（`apply_virtual_card` 工具调用经安全网关持久化 `PendingAction`，再由网关发出 `mfa_required` + `card` 事件；模型散文不创建面板） |
| `PendingAction` 条数 | 恰 **1** |
| `PendingAction.id` | `cmvc08abv004kjsf85exah6pt` |
| `sessionId` / `toolName` | `demo:user_liming` / `apply_virtual_card` |
| `riskLevel` / `requiresMfa` | `RED` / `true` |
| `status` | `executed`（终态；createdAt `2026-10-17T06:17:23.275Z`，updatedAt `2026-10-17T06:17:25.792Z`） |
| `argsJson` | `{"monthlyLimit":"100.00"}` |
| `userRequest` / `intent` | `请帮我新开一张虚拟卡，月消费限额设为100元` / `申请虚拟卡` |
| `invocationId` | `call_803f4ecf-edcf-4bc9-abb1-2bd5106adf9a`（= 真实 `apply_virtual_card` invocation 的 id） |
| 面板摘要（`summaryJson`） | `title`=`Issue a virtual card after confirmation and strong verification.`；fields：操作=`Issue a virtual card after confirmation and strong verification.`、风险等级=`🔴 红色`、卡片类型=`虚拟卡（VIRTUAL）`、卡组织=`银联（UnionPay）`、月限额=`¥100.00`、分类限额=`不设置（本次仅开卡）`、演示范围=`保存卡片及月限额配置；Demo 不提供刷卡支付`；`requiresMfa=true`，`mfaHint=该操作需安全验证，请输入 6 位短信验证码。` |
| `MfaChallenge` 条数 | 恰 **1** |
| `MfaChallenge` 字段 | id `cmvc08aby004ljsf8wyacve67`，`actionId=cmvc08abv004kjsf85exah6pt`（= 上面 PendingAction），**`code=123456`**、**`attempts=0`**、`maxAttempts=3`、`status=verified`、createdAt `06:17:23.278Z`、verifiedAt `06:17:25.720Z`、consumedAt `06:17:25.738Z`、expiresAt `06:22:23.277Z` |
| 完成方式 | 浏览器内真实提交 MFA 验证码 `123456`（`driveRedTool` 的 `submitMfa`）；`attempts=0` 证明**没有错误尝试**、未触达熔断上限 |
| 审计 `AuditLog` | 恰 1 条：id `cmvc08c8a004yjsf862ef464e`，tool `apply_virtual_card`，risk `RED`，`confirmationRequired=true`、`confirmed=true`、`mfaRequired=true`、`mfaResult=success`、`toolArgs={"monthlyLimit":"100.00"}`、`status=success` |
| 回执 `ExecutionReceipt` | 恰 1 条：`rcpt_3a027f737aa8128a4897d76c2c5424ce`，`key=cmvc08abv004kjsf85exah6pt`（= PendingAction id），tool `apply_virtual_card`，**`txId=null`**（开卡不产生资金流水），`commandDigest=ff1c9d5b228fab50ebeed3b8a7fa1e1e22cf1da8dece086924ac7e2ef9f82102` |
| 伪造面板 | **无**。`assertNoFabricatedConfirmationPanel` 未触发；本轮无催促轮次、无澄清、无 write-continuation、无重试（事件计数：`mfa_required`=1、`card`=2、`tool_start`=1、`tool_end`=2、`run_admitted`=2、`invocation_recovered`=1） |

## 7. 澄清 / 催促 / 续接 / 重试 / 超时

| 项 | 结果 |
| --- | --- |
| 澄清（clarification） | 无（模型直接带齐 `monthlyLimit`，未追问） |
| 催促（nudge） | 无（0 次；第 1 轮即停放 MFA 卡） |
| 续接（write-continuation） | 无（`describe_turn` 声明的 `apply_virtual_card` 在同一轮真实发起） |
| 重试（recovery / attempt） | 无（所有 `ToolInvocation.attempt=1`、`ModelRequest.attempt=1`；`invocation_recovered` 事件是 MFA 执行后按 operationKey 复用既有 invocation，非重试） |
| 超时 | 无 |
| 自然轮次 | 开卡腿 **1 轮**；消费腿 0 轮（UI 弹窗）；超限腿 0 轮（UI 弹窗） |

## 8. 权威 DB 交叉核对（`prisma/live-acceptance.db`，一次性 Prisma 客户端读取）

读取方式：`logs/*.ts`（未提交）在 `DATABASE_URL=file:…/prisma/live-acceptance.db` 下用 `pnpm exec tsx` 执行，
原始 dump 落 `logs/db-crosscheck.json`、`logs/db-extract2.json`、`logs/db-extract3.json`。

### 8.1 活期账户余额（`acct_checking` = `****8821`, CNY）

| | 金额 |
| --- | --- |
| BEFORE | `2358000` minor = **¥23,580.00**（证据 JSON `cashBeforeMinor` / `balanceBeforeMinor`） |
| AFTER | `2355000` minor = **¥23,550.00**（DB `Account.balanceMinor`） |
| 差额 | 恰 `-3000`（¥30.00，**仅扣一次**） |

### 8.2 恰一笔 `channel='CARD'` / `direction='DEBIT'` 流水

| 字段 | 值 |
| --- | --- |
| id | `cmvc08e0h005djsf8lhgjfku3` |
| accountId | `acct_checking` |
| amountMinor | `-3000`（= −¥30.00，精确） |
| channel / direction | `CARD` / `DEBIT` |
| category / merchant | `购物` / `虚拟卡开卡消费验证` |
| occurredAt | `2026-09-25T04:00:00.000Z`（= 服务端业务时钟 `DEMO_NOW` 2026-09-25T12:00:00+08:00；客户端**未**发送 `occurredAt`） |
| createdAt | `2026-10-17T06:17:28.049Z` |

同一 merchant 在库中恰 **1** 条（无重复扣款）。`acct_checking` 的 CARD 通道流水总数 **91**
（种子 90 + 本轮 1）；全表 `Transaction` 总数 **233**。

### 8.3 恰一条 `CardConsumption`

| 字段 | 值 |
| --- | --- |
| id | `cmvc08e0i005ejsf879h6985o` |
| cardId | `cardidem_3a027f737aa8128a4897d76c2c5424ce` |
| accountId | `acct_checking` |
| amountMinor | `3000` |
| category / merchant | `购物` / `虚拟卡开卡消费验证` |
| occurredAt | `2026-09-25T04:00:00.000Z`（服务端拥有，无客户端时间字段） |
| executionKey | `bf0e23eb-c379-4c0f-9547-f49499ec4b7f` |
| createdAt | `2026-10-17T06:17:28.050Z` |

本次运行库内 `CardConsumption` 总数 = **1**（种子不写入该表，因此这 1 条就是本轮的消费）。

该行的 `resultJson` 快照是本次「同一时刻」改动的直接证据（见 §9）：

```json
{"consumption":{...,"amount":"30.00","occurredAt":1790308800000,...},
 "card":{...,"monthlyLimit":"100.00","accountAvailableBalance":"23550.00","payableAmount":"70.00"},
 "accountAvailableBalance":"23550.00"}
```

快照里的 `payableAmount` 是 **`70.00`**（被强制执行的那个月的余额），而不是未扣减的 `100.00`。

### 8.4 新建的 RAW `Card` 行（**借记工具，不是信用卡**）

| 字段 | 值 |
| --- | --- |
| id | `cardidem_3a027f737aa8128a4897d76c2c5424ce` |
| userId | `user_liming` |
| type | `VIRTUAL` |
| status | `ACTIVE` |
| network | `UnionPay` |
| numberMasked | `****4221`（与既有 `****6688` / `****8821` / `****7788` 均不同） |
| **creditLimitMinor** | **`null`** |
| **availableLimitMinor** | **`null`** |
| monthlyLimitMinor | `10000`（= ¥100.00） |
| linkedAccountId | `acct_checking` |
| replacedByCardId | `null` |

卡片总数 **3 → 4**（类型/状态计数：`CREDIT/ACTIVE`=1、`DEBIT/ACTIVE`=1、`VIRTUAL/ACTIVE`=2；
两张 VIRTUAL 分别是种子 `card_virtual`（`monthlyLimitMinor=500000`）与本轮新卡）。
**没有重复生成虚拟卡**；`/cards` 该卡渲染仅 `账户可用余额=¥23,580.00`、`当前可支付金额=¥100.00`，
**无「信用额度」/「可用额度」行**。

### 8.5 服务端投影的可支付金额 = `min(可用现金, 剩余月限额)`

| 阶段 | 可用现金 | 剩余月限额 | `payableAmount`（`GET /api/cards` + 页面渲染） |
| --- | --- | --- | --- |
| 开卡后 | ¥23,580.00 | ¥100.00 | **¥100.00**（`min` 取月限额 → 月限额是绑定约束；`PendingAction.resultJson` 同值） |
| 消费 ¥30.00 后 | ¥23,550.00 | ¥70.00 | **¥70.00**（刷新后卡片「当前可支付金额」= ¥70.00） |
| 超限拒绝后 | ¥23,550.00 | ¥70.00 | **¥70.00**（不变） |

`min(23580.00, 100.00 − 0) = 100.00`；`min(23550.00, 100.00 − 30.00) = 70.00`；超限腿后剩余月限额仍 `7000` minor。

### 8.6 超限尝试（¥80.00 > 剩余 ¥70.00）

| 项 | 值 |
| --- | --- |
| HTTP | `POST /api/cards/cardidem_3a027f737aa8128a4897d76c2c5424ce/consume` → **422** |
| 响应体（逐字） | `{"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}` |
| 屏幕拒绝文案（弹窗 `p[role=alert]`，逐字） | `超出本月消费限额` |
| 资金/账本/消费移动 | **零**：无新 `Transaction`（merchant `虚拟卡超限拒绝验证` 在库中 **0** 条）、无新 `CardConsumption`、余额恒为 `2355000`、`payableAmount` 仍 `70.00` |

## 9. 与 `f570d58` 轮次的行为等价性（本轮改动的重点）

改动本身（`248e4ea`）：

- `banking-sdk/card.ts` / `banking-sdk/card-family.ts` / `banking-sdk/types.ts`：
  `loadCardView(row, now?)`、`spentThisMonthMinor(cardId, userId, now?)` 增加可选 `now`，**缺省仍为 `demoNow()`**；
  `consumeCard` 把它实际用于限额判断的 `at`（`consumeInstant(options.now)`，生产中即 `demoNow()`）继续传给快照与视图；
  `getCards` 改为 `rows.map((row) => loadCardView(row))`，避免 `Array#map` 的 index 被当作 `now` 泄漏进视图。
- `1e337ae` 只调整 `tests/unit/banking-sdk/` 的断言，未触碰产品代码。

本次运行在生产路径上**没有传 `options.now`**（HTTP 边界不接受时间参数），因此：

| 观测点 | 本轮值 | `f570d58` 第 3 轮值 |
| --- | --- | --- |
| `CardConsumption.resultJson.card.payableAmount` | `"70.00"` | 消费后 `70.00` |
| `CardConsumption.resultJson.accountAvailableBalance` | `"23550.00"` | `23550.00` |
| `occurredAt`（服务端业务时刻） | `2026-09-25T04:00:00.000Z` | 同 |
| `GET /api/cards` 的 `payableAmount` 进展 | `100.00 → 70.00 → 70.00` | 同 |
| 活期余额 | `2358000 → 2355000` | 同 |
| `CardConsumption` 条数 | 1 | 1 |

**结论：该改动在生产环境对 `lD` 是行为等价的**。本轮以快照 `payableAmount:"70.00"` 与
`100.00 → 70.00 → 70.00` 的可支付金额进展做了实测确认，不是仅靠读代码推断。

## 10. 页面最终状态与网络诊断

- 位于 `/cards`，真实消费弹窗保持打开并渲染红色拒绝提示 `超出本月消费限额`。
- 新虚拟卡卡片：`月限额 ¥100.00`、`关联账户 ****8821`、`账户可用余额 ¥23,550.00`、
  `当前可支付金额 ¥70.00`，无信用额度行。
- 累计 4xx/5xx = **1**（即上面这一次 422）、console error = **1**（同一 422 的资源加载失败）、pageerror = **0**。

## 11. 截图（本轮副本；入口固定文件名会被下一轮覆盖）

| 文件 | 大小 |
| --- | --- |
| `output/playwright/live/lD-head7a7a4d3-round1/01-lD-new-virtual-card.png` | 74,973 B |
| `output/playwright/live/lD-head7a7a4d3-round1/02-lD-after-spend.png` | 73,902 B |
| `output/playwright/live/lD-head7a7a4d3-round1/03-lD-over-limit-refusal.png` | 89,000 B |

原始证据文件（未提交，均在 `logs/`）：`logs/live-lD-7a7a4d3-round1.log`、
`logs/live-lD-7a7a4d3-round1-exit.txt`、`logs/lD-evidence.json`、`logs/db-crosscheck.json`、
`logs/db-extract2.json`、`logs/db-extract3.json`。

## 12. 清理验证

| 检查 | 结果 |
| --- | --- |
| `netstat -ano \| findstr :49179` | **无输出**（dev server 端口无监听） |
| `netstat -ano \| findstr LISTENING \| findstr :300` | **无输出** |
| `tasklist` 查 pid `6820` | **不存在**（`findstr 6820` 只命中无关的 `MicrosoftSecurityApp.exe 26820`） |
| 残留 `node.exe` | 全部属于宿主机工具链（`OpenAI\Codex\runtimes\...`），创建时间 11:23–11:35，**早于**本轮 14:17，无 `next dev` |
| 残留 `chrome.exe` | 属用户自有浏览器实例，非本轮 headless 实例（`finally` 中已 `await browser.close()`） |

证据文件：`logs/netstat-after.txt`、`logs/tasklist-all.txt`、`logs/node-procs.txt`、
`logs/cleanup.json`、`logs/cleanup2.txt`（均未提交）。

## 13. 本轮**未**验证的事项（NOT VERIFIED）

- 集群并发 / 多实例竞争：本地单进程验收不证明分布式租约与并发正确性。
- 真实银行接入：`banking-sdk` 与认证器都是明确的模拟器，本轮未接任何真实轨道。
- 生产构建（`pnpm build`）验收：本轮只跑 `next dev`。
- 真实模型的稳定性：只观察到**一次**成功；模型非确定性（例如下一轮只作散文、不发受控工具）可能改变
  自然轮次数量，但不影响本轮记录的结论。
- 模型侧 `occurredAt` 拒绝路径（`agent/tools/card.ts` 的「消费入账时间由服务端决定」，即
  `date-tamper-boundary.e2e.ts` 的 `x1`）：无法经 HTTP 触达，本轮未覆盖；HTTP 边界侧的
  `400 VALIDATION` 亦不在 `lD` 断言范围内。
- 错误验证码 / 熔断行为：`lD` 只提交正确码 `123456`（`attempts=0`），不触达 `maxAttempts=3`，
  锁定状态与刷新后的弹窗消失均未被本轮覆盖。
- 同一 HEAD 上的重复轮次：本轮只跑了 1 次，没有第二轮可比对。
- 除 `lD` 之外的场景（`lA`/`lB`/`lC`/`lE` 等）在同一 HEAD 上**未**重跑。
