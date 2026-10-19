# LIVE acceptance evidence — scenario `lD`（虚拟卡开卡 + 月限额）— ROUND 2

- 日期（本机）：2026-10-17 13:39:33 → 13:40:08 (+08:00)
- 提交（HEAD）：`2434548 test(e2e/live): record single-definition primitives and refresh lA /cards screenshot`
- 模式：**live**（真实 DeepSeek 模型 + 真实 headless Chrome，无 mock、无请求拦截）
  - `/api/health` 观测值：`{"ok":true,"data":{"status":"ok","time":1792215597716,"llmMode":"live"}}`
  - 入口起的隔离服务：`next dev (pid=65900) → http://localhost:55051`
- 解析后的活动模型 id：**`deepseek-flash`**（入口未设 `LIVE_FORCE_MODEL`，`LLM_MODEL` 来自 `.env.local`；入口打印 `Live run uses the configured model.`，证据 JSON 内 `"model": "deepseek-flash"`）
- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 隔离数据库：`prisma/live-acceptance.db`（`db push` → probe → `tsx prisma/seed.ts`；`prisma/dev.db` 与 `prisma/test.db` 未受影响）
- 本轮为**独立进程**（第 2 轮），与第 1、3 轮无共享状态；场景开始前数据库被完整重置。

## 1. 精确命令

```powershell
$env:LIVE_SCENARIOS='lD'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

实际执行形式（保留退出码、原始字节写日志，避免 PowerShell 管道吞输出）：

```powershell
cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lD-round2.log 2>&1"
```

完整输出：`logs/lD-round2.log`（未提交，`logs/` 被 gitignore）。

## 2. 退出码与汇总

| 项 | 值 |
| --- | --- |
| 进程退出码 | **0** |
| 汇总行（逐字） | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` |

退出码 0 与 `PASS 1 ｜ FAIL 0 ｜ SKIP 0` 同时成立 → **PASS**。

## 3. PASS 证据串（逐字，来自 reporter）

> 绝对路径前缀 `D:\projects\banking-agent\.genesis\workers\worker_T5_A38\` 以 `…` 代替，其余逐字保留。

```
PASS lD-live-virtual-card-apply-and-limit — lD 实际发送：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_f4d9e01d8fc83fa2ef27acaa2713694d（RAW：type=VIRTUAL、status=ACTIVE、monthlyLimitMinor=10000（100.00）、linkedAccountId=acct_checking、creditLimitMinor=null、availableLimitMinor=null、卡号 ****4531 与既有卡片均不同）；payableAmount=100.00（月限额绑定，账户可用余额 23580.00）；/cards 渲染 {"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}（无「信用额度」/「可用额度」）；消费 30.00（购物/虚拟卡开卡消费验证）→ 消费成功：新增 CARD/DEBIT 流水 -3000（cmvbywc930041zof83mloao5u）+ 1 条 CardConsumption amountMinor=3000（cmvbywc940042zof80zmwtvag），活期余额 23580.00 → 23550.00（恰扣一次）；payableAmount → 70.00，刷新后卡片「当前可支付金额」=¥70.00；超限 80.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 70.00；截图 …output\playwright\live\01-lD-new-virtual-card.png / …output\playwright\live\02-lD-after-spend.png / …output\playwright\live\03-lD-over-limit-refusal.png；证据 JSON …logs\lD-evidence.json
```

## 4. 自然语言提示词（剧情代码候选 + 实际发送）

`tests/e2e/live-virtual-card.e2e-helper.ts#VC_APPLY_TURNS`（逐字候选序列）：

1. `请帮我新开一张虚拟卡，月消费限额设为100元`
2. `确认，请办理开卡`
3. `界面上方没有出现确认面板，请重新发起开卡申请`
4. `请直接为我开通这张月限额100元的虚拟卡，我已确认`

**实际发送：仅第 1 条**（本轮证据 JSON `sentTurns` 与 `driveRedTool` 返回的 `sent` 均为单元素数组）：

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

模型在**第 1 个自然轮次**就调用了受控工具并停放 MFA 卡，第 2–4 条催促**未使用**（`sentTurns.length == 1`）。消费腿与超限腿**不经过模型**：均通过 `/cards` 页真实消费弹窗（`app/cards/CardConsumeDialog.tsx`）提交，没有额外模型轮次。

## 5. 模型观测到的工具调用（DB 权威：`ToolInvocation`）

| ordinal | toolName | args（逐字） | status | replaySafety | origin | attempt |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `describe_turn` | `{"operations":["apply_virtual_card"],"purpose":"operation"}` | `completed` | read_only | pi | 1 |
| 2 | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `completed` | idempotent | pi | 1 |

本轮与第 1 轮的唯一差别：模型**没有**先调用 `get_cards` 读卡列表（总调用 2 次而非 3 次），因此 `AuthorizationDecision` 只有 `apply_virtual_card → require_mfa / RED` 一条、没有 `get_cards → allow / GREEN`。这是模型自由路径差异，不影响任何断言。

`ModelRequest` 数 = 2。`AgentRun`：`cmvbyw73m0000zof89y5rrija`（`waiting_verification`，`requestJson = {"kind":"input","message":"请帮我新开一张虚拟卡，月消费限额设为100元"}`）→ `cmvbywaly003pzof8x2d80b0r`（`completed`，`kind=authorization_result`，`toolResult.data={id: cardidem_f4d9e01d8fc83fa2ef27acaa2713694d, type: VIRTUAL, status: ACTIVE, monthlyLimit: 100.00, payableAmount: 100.00, linkedAccountId: acct_checking, numberMasked: ****4531, accountAvailableBalance: 23580.00}`）。`AgentSession` `demo:user_liming`，`status=active`，`revision=2`，`activeRunId=null`。

## 6. 确认 / MFA 面板

| 项 | 值 |
| --- | --- |
| 真实面板是否出现 | **是**（由 `apply_virtual_card` 工具调用经安全网关持久化 `PendingAction` 产生，非模型散文） |
| `PendingAction.id` | `cmvbyw8qi0038zof8bzelz5ye` |
| `PendingAction.toolName` | `apply_virtual_card` |
| `PendingAction.argsJson` | `{"monthlyLimit":"100.00"}` |
| `PendingAction.riskLevel` | `RED` |
| `PendingAction.requiresMfa` | `true` |
| `PendingAction.status` | `executed`（终态；createdAt `2026-10-17T05:40:01.722Z`，updatedAt `2026-10-17T05:40:04.181Z`） |
| `userRequest` / `intent` | `请帮我新开一张虚拟卡，月消费限额设为100元` / `申请虚拟卡` |
| 面板摘要（summaryJson） | `title`=`Issue a virtual card after confirmation and strong verification.`；fields：操作=`Issue a virtual card after confirmation and strong verification.`、风险等级=`🔴 红色`、卡片类型=`虚拟卡（VIRTUAL）`、卡组织=`银联（UnionPay）`、月限额=`¥100.00`、分类限额=`不设置（本次仅开卡）`、演示范围=`保存卡片及月限额配置；Demo 不提供刷卡支付`；`requiresMfa=true`，`mfaHint=该操作需安全验证，请输入 6 位短信验证码。` |
| 完成方式 | 浏览器内真实提交 MFA 验证码 `123456`（`driveRedTool` 的 `submitMfa`）；`MfaChallenge.maxAttempts=3`、`attempts=0`、`status=verified`、`verifiedAt=2026-10-17T05:40:03.875Z`（无错误尝试、无熔断） |
| 审计 | `AuditLog`：tool=`apply_virtual_card`、risk=`RED`、`confirmationRequired=true`、`confirmed=true`、`mfaRequired=true`、`mfaResult=success`、`status=success`、`toolArgs={"monthlyLimit":"100.00"}` |
| 回执 | `ExecutionReceipt rcpt_f4d9e01d8fc83fa2ef27acaa2713694d`，tool=`apply_virtual_card`，`key=cmvbyw8qi0038zof8bzelz5ye`（= PendingAction id），`txId=null`（开卡不产生资金流水） |

## 7. 澄清 / 催促 / 重试 / 超时

| 项 | 结果 |
| --- | --- |
| 澄清（clarification） | 无（模型直接带齐 `monthlyLimit`，未追问） |
| 催促（nudge） | 无（0 次；第 1 轮即停放 MFA 卡，未触发 `assertNoFabricatedConfirmationPanel`） |
| 续接（write-continuation） | 无（`describe_turn` 声明的 `apply_virtual_card` 同轮真实发起） |
| 重试（recovery / attempt） | 无（所有 `ToolInvocation.attempt=1`、`AgentRun.recoveryAttempts=0`） |
| 超时 | 无 |
| 自然轮次 | 开卡腿 **1 轮**；消费腿 0 轮（UI 弹窗）；超限腿 0 轮（UI 弹窗） |
| 本轮墙钟耗时 | 约 35s（13:39:33 → 13:40:08，含数据库重建与 dev server 启动） |

## 8. 权威 DB 交叉核对（`prisma/live-acceptance.db`，一次性 Prisma 客户端）

### 8.1 活期账户余额（`acct_checking` = `****8821`, CNY）

| | 金额 |
| --- | --- |
| BEFORE | `2358000` minor = **¥23,580.00**（证据 JSON `cashBeforeMinor` / `balanceBeforeMinor`） |
| AFTER | `2355000` minor = **¥23,550.00**（DB `Account.balanceMinor`） |
| 差额 | 恰 `-3000`（¥30.00，仅扣一次） |

### 8.2 恰一笔 `channel='CARD'` / `direction='DEBIT'` 流水

| 字段 | 值 |
| --- | --- |
| id | `cmvbywc930041zof83mloao5u` |
| amountMinor | `-3000`（= −¥30.00，精确） |
| channel / direction | `CARD` / `DEBIT` |
| category / merchant | `购物` / `虚拟卡开卡消费验证` |
| occurredAt | `2026-09-25T04:00:00.000Z`（= 服务端业务时钟 `DEMO_NOW` 2026-09-25T12:00:00+08:00） |
| isAnomaly | `false` |

同一 merchant 在库中恰 1 条（无重复扣款）；`acct_checking` 的 CARD 通道流水总数 90（种子）→ **91**（+1）。客户端**未**发送 `occurredAt`（服务端拥有记账时间）。

### 8.3 恰一条 `CardConsumption`

| 字段 | 值 |
| --- | --- |
| id | `cmvbywc940042zof80zmwtvag` |
| cardId | `cardidem_f4d9e01d8fc83fa2ef27acaa2713694d` |
| accountId | `acct_checking` |
| amountMinor | `3000` |
| category / merchant | `购物` / `虚拟卡开卡消费验证` |
| occurredAt | `2026-09-25T04:00:00.000Z` |
| executionKey | `918feda4-db0d-4d1a-8d58-c41f3e90ef2f` |

本次运行库内 `CardConsumption` 总数 = **1**。

### 8.4 新建的 RAW `Card` 行（**借记工具，不是信用卡**）

| 字段 | 值 |
| --- | --- |
| id | `cardidem_f4d9e01d8fc83fa2ef27acaa2713694d` |
| type | `VIRTUAL` |
| status | `ACTIVE` |
| network | `UnionPay` |
| numberMasked | `****4531`（与既有 `****6688` / `****8821` / `****7788` 均不同） |
| monthlyLimitMinor | `10000`（= ¥100.00，唯一约束） |
| linkedAccountId | `acct_checking` |
| **creditLimitMinor** | **`null`** |
| **availableLimitMinor** | **`null`** |
| replacedByCardId | `null` |

卡片总数 3 → 4（仅新增 1 张；库内 CREDIT 卡仍只有 `card_credit`，其 `creditLimitMinor=1800000`）。`/cards` 该卡 `<dl>` 仅 `账户可用余额=¥23,580.00`、`当前可支付金额=¥100.00`，**无「信用额度」/「可用额度」行**，卡片全文亦不含这两个词。

### 8.5 服务端投影的可支付金额 = `min(可用现金, 剩余月限额)`

| 阶段 | 可用现金 | 剩余月限额 | `payableAmount`（`GET /api/cards` + 页面渲染） |
| --- | --- | --- | --- |
| 开卡后 | ¥23,580.00 | ¥100.00 | **¥100.00**（`min` 取月限额 → 月限额是绑定约束） |
| 消费 ¥30.00 后 | ¥23,550.00 | ¥70.00 | **¥70.00**（刷新后卡片「当前可支付金额」= ¥70.00） |
| 超限拒绝后 | ¥23,550.00 | ¥70.00 | **¥70.00**（不变） |

### 8.6 超限尝试（`¥80.00` > 剩余 ¥70.00）

| 项 | 值 |
| --- | --- |
| HTTP | `POST /api/cards/cardidem_f4d9e01d8fc83fa2ef27acaa2713694d/consume` → **422** |
| 错误码 | `LIMIT_EXCEEDED`；服务端 message：`超过虚拟卡月限额。` |
| 屏幕拒绝文案（弹窗 `p[role=alert]`，逐字） | `超出本月消费限额` |
| 资金/账本/消费移动 | **零**：无新 `Transaction`、无新 `CardConsumption`、余额恒为 `2355000`、`payableAmount` 仍 `70.00` |

## 9. 页面最终状态

- 位于 `/cards`，真实消费弹窗保持打开并渲染红色拒绝提示 `超出本月消费限额`。
- 新虚拟卡卡片：`月限额 ¥100.00`、`关联账户 ****8821`、`账户可用余额 ¥23,550.00`、`当前可支付金额 ¥70.00`，无信用额度行。
- 网络/控制台：累计 4xx/5xx = 1（即上面这一次 422），console error = 1（同一 422），pageerror = 0。

## 10. 截图（本轮保留副本；入口固定文件名会被下一轮覆盖）

| 文件 | 大小 |
| --- | --- |
| `output/playwright/live/lD-round2/01-lD-new-virtual-card.png` | 74,957 B |
| `output/playwright/live/lD-round2/02-lD-after-spend.png` | 73,902 B |
| `output/playwright/live/lD-round2/03-lD-over-limit-refusal.png` | 88,968 B |

原始证据文件（未提交）：`logs/lD-round2.log`、`logs/lD-round2-evidence.json`、`logs/lD-round2-db.json`。
