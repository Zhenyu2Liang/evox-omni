# LIVE acceptance evidence — scenario `lD`（虚拟卡开卡 + 月限额）— ROUND 1

- 日期（本机）：2026-10-17 13:37:55 → 13:38:35 (+08:00)
- 提交（HEAD）：`2434548 test(e2e/live): record single-definition primitives and refresh lA /cards screenshot`
- 模式：**live**（真实 DeepSeek 模型 + 真实 headless Chrome，无 mock、无请求拦截）
  - `/api/health` 观测值：`{"ok":true,"data":{"status":"ok","time":1792215505207,"llmMode":"live"}}`
- 解析后的活动模型 id：**`deepseek-flash`**（入口未设 `LIVE_FORCE_MODEL`，`LLM_MODEL` 来自 `.env.local`；入口打印 `Live run uses the configured model.`，证据 JSON 内 `"model": "deepseek-flash"`）
- 浏览器：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 隔离数据库：`prisma/live-acceptance.db`（`db push` → probe → `tsx prisma/seed.ts`；`prisma/dev.db` 与 `prisma/test.db` 未受影响）

## 1. 精确命令

```powershell
$env:LIVE_SCENARIOS='lD'; pnpm exec tsx tests/e2e/live-acceptance.e2e.ts
```

实际执行形式（保留退出码、原始字节写日志，避免 PowerShell 管道吞输出）：

```powershell
cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lD-round1.log 2>&1"
```

完整输出：`logs/lD-round1.log`（未提交，`logs/` 被 gitignore）。

## 2. 退出码与汇总

| 项 | 值 |
| --- | --- |
| 进程退出码 | **0** |
| 汇总行（逐字） | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` |

退出码 0 与 `PASS 1 ｜ FAIL 0 ｜ SKIP 0` 同时成立 → **PASS**。

## 3. PASS 证据串（逐字，来自 reporter）

```
PASS lD-live-virtual-card-apply-and-limit — lD 实际发送：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_0e773b75bff65563fd60ec2c76f988fb（RAW：type=VIRTUAL、status=ACTIVE、monthlyLimitMinor=10000（100.00）、linkedAccountId=acct_checking、creditLimitMinor=null、availableLimitMinor=null、卡号 ****1299 与既有卡片均不同）；payableAmount=100.00（月限额绑定，账户可用余额 23580.00）；/cards 渲染 {"账户可用余额":"¥23,580.00","当前可支付金额":"¥100.00"}（无「信用额度」/「可用额度」）；消费 30.00（购物/虚拟卡开卡消费验证）→ 消费成功：新增 CARD/DEBIT 流水 -3000（cmvbyucw1006n4of8y5ijlco3）+ 1 条 CardConsumption amountMinor=3000（cmvbyucw2006o4of8l0u4uk66），活期余额 23580.00 → 23550.00（恰扣一次）；payableAmount → 70.00，刷新后卡片「当前可支付金额」=¥70.00；超限 80.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 70.00；截图 …01-lD-new-virtual-card.png / …02-lD-after-spend.png / …03-lD-over-limit-refusal.png；证据 JSON …logs\lD-evidence.json
```

## 4. 自然语言提示词（剧情代码候选 + 实际发送）

`tests/e2e/live-virtual-card.e2e-helper.ts#VC_APPLY_TURNS`（逐字候选序列）：

1. `请帮我新开一张虚拟卡，月消费限额设为100元`
2. `确认，请办理开卡`
3. `界面上方没有出现确认面板，请重新发起开卡申请`
4. `请直接为我开通这张月限额100元的虚拟卡，我已确认`

**实际发送：仅第 1 条**（`sentTurns` 证据 JSON 与 `driveRedTool` 返回的 `sent` 均为单元素数组）：

```
请帮我新开一张虚拟卡，月消费限额设为100元
```

模型在**第 1 个自然轮次**就调用了受控工具并停放 MFA 卡，第 2–4 条催促未使用。消费腿与超限腿**不经过模型**：均通过 `/cards` 页真实消费弹窗（`app/cards/CardConsumeDialog.tsx`）提交，没有额外模型轮次。
## 5. 模型观测到的工具调用（DB 权威：`ToolInvocation`）

| ordinal | toolName | args（逐字） | status | replaySafety | origin |
| --- | --- | --- | --- | --- | --- |
| 1 | `describe_turn` | `{"operations":["apply_virtual_card"],"purpose":"operation"}` | `completed` | read_only | pi |
| 2 | `get_cards` | `{}` | `completed` | read_only | pi |
| 3 | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `completed` | idempotent | pi |

`ModelRequest` 数 = 2。`AgentRun`：`cmvbyu7pa00004of89npoar4z`（`waiting_verification`，requestJson = `{"kind":"input","message":"请帮我新开一张虚拟卡，月消费限额设为100元"}`）→ `cmvbyub3d006b4of8f9hz4ts7`（`completed`，`kind=authorization_result`，`toolResult.data={id: cardidem_0e7…, type: VIRTUAL, status: ACTIVE, monthlyLimit: 100.00, payableAmount: 100.00, linkedAccountId: acct_checking, numberMasked: ****1299}`）。

授权决策（`AuthorizationDecision`）：`get_cards` → `allow` / `GREEN`；`apply_virtual_card` → `require_mfa` / `RED`。

## 6. 确认 / MFA 面板

| 项 | 值 |
| --- | --- |
| 真实面板是否出现 | **是**（由 `apply_virtual_card` 工具调用经安全网关持久化 `PendingAction` 产生，非模型散文） |
| `PendingAction.toolName` | `apply_virtual_card` |
| `PendingAction.argsJson` | `{"monthlyLimit":"100.00"}` |
| `PendingAction.riskLevel` | `RED` |
| `PendingAction.requiresMfa` | `true` |
| `PendingAction.status` | `executed`（终态；updatedAt 2026-10-17T05:38:31.498Z） |
| `userRequest` / `intent` | `请帮我新开一张虚拟卡，月消费限额设为100元` / `申请虚拟卡` |
| 面板摘要（summaryJson） | `虚拟卡（VIRTUAL）`、`银联（UnionPay）`、`月限额 ¥100.00`、`分类限额 不设置（本次仅开卡）`、`requiresMfa=true` |
| 完成方式 | 浏览器内真实提交 MFA 验证码 `123456`；`MfaChallenge.status=verified`、`attempts=0/3`、`verifiedAt=2026-10-17T05:38:31.424Z`（无错误尝试、无熔断） |
| 审计 | `AuditLog`：tool=`apply_virtual_card`、risk=`RED`、`confirmationRequired=true`、`confirmed=true`、`mfaRequired=true`、`mfaResult=success`、`status=success`、`toolArgs={"monthlyLimit":"100.00"}` |
| 回执 | `ExecutionReceipt rcpt_0e773b75bff65563fd60ec2c76f988fb`，tool=`apply_virtual_card`，key=`cmvbyu9hh005u4of8lunq1zzz`（= PendingAction id），`txId=null`（开卡不产生资金流水） |

## 7. 澄清 / 催促 / 重试 / 超时

| 项 | 结果 |
| --- | --- |
| 澄清（clarification） | 无（模型直接带齐 `monthlyLimit`，未追问） |
| 催促（nudge） | 无（0 次；第 1 轮即停放 MFA 卡，未触发 `assertNoFabricatedConfirmationPanel`） |
| 续接（write-continuation） | 无（`describe_turn` 声明的 `apply_virtual_card` 同轮真实发起） |
| 重试（recovery / attempt） | 无（所有 `ToolInvocation.attempt=1`、`AgentRun.recoveryAttempts=0`） |
| 超时 | 无 |
| 自然轮次 | 开卡腿 **1 轮**；消费腿 0 轮（UI 弹窗）；超限腿 0 轮（UI 弹窗） |

## 8. 权威 DB 交叉核对（`prisma/live-acceptance.db`，一次性 Prisma 客户端）

### 8.1 活期账户余额

| | 金额 |
| --- | --- |
| BEFORE | `2358000` minor = **¥23,580.00** |
| AFTER | `2355000` minor = **¥23,550.00** |
| 差额 | 恰 `-3000`（¥30.00，仅扣一次） |

### 8.2 恰一笔 `channel='CARD'` / `direction='DEBIT'` 流水

| 字段 | 值 |
| --- | --- |
| id | `cmvbyucw1006n4of8y5ijlco3` |
| amountMinor | `-3000`（= −¥30.00，精确） |
| channel / direction | `CARD` / `DEBIT` |
| category / merchant | `购物` / `虚拟卡开卡消费验证` |
| occurredAt | `2026-09-25T04:00:00.000Z`（= 服务端业务时钟 `DEMO_NOW` 2026-09-25T12:00:00+08:00） |

同一 merchant 在库中恰 1 条（无重复扣款）；`acct_checking` 的 CARD 通道流水总数 90（种子）→ **91**（+1）。

### 8.3 恰一条 `CardConsumption`

| 字段 | 值 |
| --- | --- |
| id | `cmvbyucw2006o4of8l0u4uk66` |
| cardId | `cardidem_0e773b75bff65563fd60ec2c76f988fb` |
| accountId | `acct_checking` |
| amountMinor | `3000` |
| category / merchant | `购物` / `虚拟卡开卡消费验证` |
| occurredAt | `2026-09-25T04:00:00.000Z` |
| executionKey | `cc3ef956-1e27-46ea-84a6-dd606afdca2e` |

本次运行库内 `CardConsumption` 总数 = **1**。

### 8.4 新建的 RAW `Card` 行（**借记工具，不是信用卡**）

| 字段 | 值 |
| --- | --- |
| id | `cardidem_0e773b75bff65563fd60ec2c76f988fb` |
| type | `VIRTUAL` |
| status | `ACTIVE` |
| network | `UnionPay` |
| numberMasked | `****1299`（与既有 `****6688` / `****8821` / `****7788` 均不同） |
| monthlyLimitMinor | `10000`（= ¥100.00，唯一约束） |
| linkedAccountId | `acct_checking` |
| **creditLimitMinor** | **`null`** |
| **availableLimitMinor** | **`null`** |
| replacedByCardId | `null` |

卡片总数 3 → 4（仅新增 1 张）。`/cards` 该卡 `<dl>` 仅 `账户可用余额=¥23,580.00`、`当前可支付金额=¥100.00`，**无「信用额度」/「可用额度」行**，卡片全文亦不含这两个词。

### 8.5 服务端投影的可支付金额 = `min(可用现金, 剩余月限额)`

| 阶段 | 可用现金 | 剩余月限额 | `payableAmount`（`GET /api/cards` + 页面渲染） |
| --- | --- | --- | --- |
| 开卡后 | ¥23,580.00 | ¥100.00 | **¥100.00**（`min` 取月限额 → 月限额是绑定约束） |
| 消费 ¥30.00 后 | ¥23,550.00 | ¥70.00 | **¥70.00**（刷新后卡片「当前可支付金额」= ¥70.00） |
| 超限拒绝后 | ¥23,550.00 | ¥70.00 | **¥70.00**（不变） |

### 8.6 超限尝试（`¥80.00` > 剩余 ¥70.00）

| 项 | 值 |
| --- | --- |
| HTTP | `POST /api/cards/cardidem_0e773b75bff65563fd60ec2c76f988fb/consume` → **422** |
| 错误码 | `LIMIT_EXCEEDED`；服务端 message：`超过虚拟卡月限额。` |
| 屏幕拒绝文案（弹窗 `p[role=alert]`，逐字） | `超出本月消费限额` |
| 资金/账本/消费移动 | **零**：无新 `Transaction`、无新 `CardConsumption`、余额恒为 `2355000`、`payableAmount` 仍 `70.00` |

## 9. 页面最终状态

- 位于 `/cards`，真实消费弹窗保持打开并渲染红色拒绝提示 `超出本月消费限额`。
- 新虚拟卡卡片：`月限额 ¥100.00`、`关联账户 ****8821`、`账户可用余额 ¥23,550.00`、`当前可支付金额 ¥70.00`，无信用额度行。
- 网络/控制台：累计 4xx/5xx = 1（即上面这一次 422），console error = 1（同一 422），pageerror = 0。

## 10. 截图（本轮保留副本；入口固定文件名会被下一轮覆盖）

- `output/playwright/live/lD-round1/01-lD-new-virtual-card.png`
- `output/playwright/live/lD-round1/02-lD-after-spend.png`
- `output/playwright/live/lD-round1/03-lD-over-limit-refusal.png`
