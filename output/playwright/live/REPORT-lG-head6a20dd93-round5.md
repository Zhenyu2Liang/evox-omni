# lG LIVE 验收报告 — round 5（FAIL，模型原因）

## 概要

| 项 | 值 |
| --- | --- |
| 场景 | `lG` / `lG-live-full-card-loss-replace-chain-single-session` |
| 轮次 | round 5（第 2 个在稳定 harness 上的独立轮） |
| 命令 | `$env:LIVE_SCENARIOS='lG'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lG-r5.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lG-r5.out & exit !EC!"` |
| 工具报告退出码 | **1**（`logs/lG-r5-exitcode.txt` = `TOOL_REPORTED_EXIT=1`） |
| 日志内 EXIT 行 | `EXIT=1`（`logs/lG-r5.out` 第 13 行） |
| 时长 | 169.51 s |
| 汇总行 | **缺失**：进程在 unhandled rejection 处终止，未打印 `== 汇总 ==` |
| `/api/health` | `{"ok":true,"data":{"status":"ok","time":1792341627313,"llmMode":"live"}}`（`llmMode":"live"`） |
| 模型 | `AgentRunEvent(eventType='provider_request_payload').payloadJson.payload.model` = `deepseek-flash`，`providerRequestPayloadRows=13`、`unparsablePayloads=0`、`payloadsWithoutPayloadModel=0` |
| 噪声 | `累计网络 4xx/5xx：1，console error：1，pageerror：0`（1 次为预期的 422 `LIMIT_EXCEEDED`） |
| 判定 | **FAIL（cause=模型未发起受控工具（模型行为））** |

## 认证的产品树

被认证产品树提交：`6a20dd93`（本轮开始时 `git rev-parse --short HEAD`，`logs/lG-r5-producthead.txt`）。

等价性证明（报告文件本身未跟踪，产品树未变）：

```
git diff --stat 6a20dd93 HEAD -- banking-sdk agent security planner lib app components prisma scripts
# （空）
```

## 逐轮/逐提示词结果

| # | 提示词（逐字） | 模型散文（摘要） | 工具调用 | PendingAction | 结果 |
| --- | --- | --- | --- | --- | --- |
| 1 | `请新开一张月消费限额100元的虚拟卡，绑定我的活期账户。` | `卡片申请处理结果…`（虚拟卡已开通） | `apply_virtual_card {"monthlyLimit":"100.00"}` | `cmve1xhne0038s0f88d0dhxoz` RED requiresMfa executed | PASS：新 VIRTUAL/ACTIVE `cardidem_c3e534c2fa0bb88f6748914b1c3c463d` ****4900，`monthlyLimitMinor=10000`，`linkedAccountId='acct_checking'`，MFA `123456`（`cmve1xhnh0039s0f8jp29cg76`，attempts=0/3） |
| 2 | `/cards` 真实对话框消费 `30.00` | — | — | — | PASS：`Transaction cmve1xkk60041s0f8k64sunw3` −3000（channel=CARD），`CardConsumption cmve1xkk60042s0f8qgk8j1or`，可支付 `70.00` |
| 3 | `尾号4900的虚拟卡信息泄露，请正式挂失，我确认不可撤销。` | `卡片挂失处理结果：第1笔操作实际执行成功；…` | `report_lost_card {"cardId":"cardidem_c3e5…","reason":"卡片信息泄露"}` | `cmve1xmuh008zs0f8hou26hp5` RED | PASS：源卡 LOST，金额不变 |
| 4 | `请为刚才正式挂失的尾号4900虚拟卡再补办一张新卡。` | `卡片补办处理结果：第1笔操作实际执行成功；…` | `replace_card {"cardId":"cardidem_c3e5…"}` | `cmve1xqga00e0s0f8myp3xcl1` RED requiresMfa，**验证前无新卡** | PASS：验证前 0 张新卡、源卡仍 LOST；验证后恰 1 张新 VIRTUAL/ACTIVE `cmve1xque00ees0f8a0103wo4` ****2995，同 `acct_checking`，额度连续 `70.00`（未重置 100.00） |
| 5 | `/cards` 对话框消费 `70.00`，再尝试 `1.00` | — | — | — | PASS：`Transaction cmve1xrzz00eus0f8yydhvx7b` −7000，`CardConsumption cmve1xrzz00evs0f8xla029l8`，可支付 `0.00`；`1.00` 被 `422 LIMIT_EXCEEDED`「超过虚拟卡月限额。」拒绝且零副作用 |
| 6 | `尾号6688的信用卡丢失，请正式挂失，我接受不可撤销。` | `卡片挂失处理结果：第1笔操作实际执行成功；卡片 ****6688 已挂失（原因：信用卡丢失）。` | `report_lost_card {"cardId":"card_credit","reason":"信用卡丢失"}` | `cmve1xvwt00krs0f8ax3rlag3` RED | PASS：`card_credit` LOST |
| 7 | `请为刚挂失的尾号6688信用卡补办新卡。` | 见下 | **真实发出** `replace_card {"cardId":"card_credit"}` | `cmve1xyjn00oms0f87wvyr3n0` RED requiresMfa（验证前停放） | PASS：验证前无新卡；MFA `123456` 后恰 1 张新 CREDIT/ACTIVE `cmve1xyqs00p0s0f8wsl9m86y` ****9932（≠****6688），`replacedByCardId` 链接成立，`creditLimitMinor=availableLimitMinor=1_800_000`，非 LOST CREDIT 合计 `18000.00`（朴素全 CREDIT `36000.00` 已排除） |
| 8 | `确认，请继续办理刚才这笔业务，发起真正的待确认操作，让我在面板里验证。` | `刚才那笔补办业务已经执行完成了，没有遗留的待确认或待验证环节…因此现在既没有正在等待的操作，也不会出现验证面板。…` | **无工具调用**（最后一次 ToolInvocation 为 `describe_turn` `call_8085e752-…` @16:40:55.952Z） | 无新 PendingAction | **FAIL**：`assertNoFabricatedConfirmationPanel` 抛错 → `未处理的 rejection：模型声称确认/MFA 面板已存在（命中「验证面板」），但页面没有确认/MFA 卡片；GET /api/actions 无 pending/awaiting_mfa 待处理项 → cause=模型未发起受控工具（模型行为）` |

第 8 轮业务事实（POSITIVE：无第二张补办卡）：卡数 6 与唯一 ACTIVE CREDIT id `cmve1xyqs00p0s0f8wsl9m86y` 在最终 turn 前后不变；未产生第二次 `replace_card`。

## 卡片行（最终 DB）

| id | type | status | numberMasked | linkedAccountId | replacedByCardId | creditLimitMinor | availableLimitMinor | monthlyLimitMinor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `card_credit` | CREDIT | LOST | ****6688 | — | `cmve1xyqs00p0s0f8wsl9m86y` | 1800000 | 1800000 | — |
| `cmve1xyqs00p0s0f8wsl9m86y` | CREDIT | ACTIVE | ****9932 | — | — | 1800000 | 1800000 | — |
| `card_debit` | DEBIT | ACTIVE | ****8821 | — | — | — | — | — |
| `card_virtual` | VIRTUAL | ACTIVE | ****7788 | `acct_checking` | — | — | — | 500000 |
| `cardidem_c3e534c2fa0bb88f6748914b1c3c463d` | VIRTUAL | LOST | ****4900 | `acct_checking` | `cmve1xque00ees0f8a0103wo4` | — | — | 10000 |
| `cmve1xque00ees0f8a0103wo4` | VIRTUAL | ACTIVE | ****2995 | `acct_checking` | — | — | — | 10000 |

## 金额与账本

- 仪表盘 `23580.00` → `23480.00`，只被两笔正常消费改变（−30.00、−70.00）；`acct_checking=2348000`、`acct_savings=5000000`。
- `Transaction` 总数 234，新增仅 `cmve1xkk60041s0f8k64sunw3`(−3000) 与 `cmve1xrzz00eus0f8yydhvx7b`(−7000)，均 `channel=CARD`、`occurredAt=2026-09-25T04:00:00Z`。
- `CardConsumption` 2 条（3000 / 7000），无第三条（1.00 拒绝未落账）。
- PendingAction 5 条，全部 RED / requiresMfa / executed：`apply_virtual_card`、`report_lost_card`、`replace_card`、`report_lost_card`、`replace_card`（`userRequest` 为逐字提示词）。
- MfaChallenge 5 条：`cmve1xhnh0039s0f8jp29cg76`、`cmve1xmui0090s0f8trbhzjp0`、`cmve1xqgc00e1s0f8ccu3gtj1`、`cmve1xvwv00kss0f8lh0lhykp`、`cmve1xyjz00ons0f88k67qzhq`，全部 verified、attempts=0、maxAttempts=3。
- `CircuitBreakerState` 未触发（failures=0，locked=false）。

## 逐断言结果

| 断言 | 结果 |
| --- | --- |
| 提示词 1：新 VIRTUAL/ACTIVE、`monthlyLimitMinor=10000`、`linkedAccountId='acct_checking'`、真实确认+MFA | PASS |
| 前端消费 `30.00` → 可支付 `70.00` | PASS |
| 提示词 3：`report_lost_card`、源卡 LOST、金额不变 | PASS |
| 提示词 4：真实 `replace_card`（RED/requiresMfa）、验证前无新卡且源卡仍 LOST | PASS |
| 提示词 4 后：恰 1 张新 VIRTUAL/ACTIVE、同账户、额度连续 `70.00`→`70.00` | PASS |
| 消费 `70.00` 成功（可支付 `0.00`）、`1.00` 被 422 拒绝且零副作用 | PASS |
| 提示词 6：`card_credit` LOST | PASS |
| 提示词 7：真实 `replace_card`（非 manual-only 拒绝、非纯散文）、验证前停放 | PASS |
| 提示词 7 后：恰 1 张新 CREDIT/ACTIVE、新卡号 ≠****6688、`replacedByCardId` 链接、额度继承 `1_800_000`、非 LOST CREDIT 合计 `18000.00`（排除 `36000.00`） | PASS |
| 提示词 8（最终 turn）：无第二张补办卡、卡数与唯一 ACTIVE CREDIT id 不变 | PASS（业务事实） |
| 提示词 8：模型经受控工具发起/或明确声明无遗留动作 **而不声称面板** | **FAIL**（散文声称/命中「验证面板」，无工具调用 → harness 守卫抛错，进程异常终止） |
| 现金/账本不变性：只有两笔成功消费改变资金；卡数按基线推导 | PASS |

## 判定

**FAIL**，原因 = 模型行为（`cause=模型未发起受控工具（模型行为）`）：第 8 轮模型仅作散文、未发出任何受控工具调用，且其散文命中 `findConfirmationPanelClaim` 的「验证面板」判定词，`assertNoFabricatedConfirmationPanel` 因此判定失败并抛出未处理 rejection（无 `== 汇总 ==` 行、无 `logs/lG-evidence.json`）。

### 观察（未修改，提交给上层决定）

第 8 轮命中文字来自**否定句**「…也不会出现验证面板。」，`tests/e2e/panel-claim.e2e-helper.ts#findConfirmationPanelClaim` 未将其识别为否定表述。这是 harness 的潜在假阳性风险（与产品缺陷不同）。按本轮 fix loop 约定（模型原因不削弱断言、不改提示词），本轮不做任何修改，仅记录。

## 证据

- `logs/lG-r5.out`（1353 B，14 行）、`logs/lG-r5-exitcode.txt`、`logs/lG-r5-end.txt`、`logs/lG-r5-start.txt`、`logs/lG-r5-producthead.txt`
- `logs/lG-r5-db.txt`（323 行）、`logs/lG-r5.db`（4030464 B）
- `logs/lG-r5-prose.txt`（会话 transcript 尾部，含第 8 轮逐字散文）
- `logs/lG-r5-postcleanup.txt`（16:43:22.619Z，无 harness Chrome / node，67 listeners）
- 截图：`output/playwright/live/lG-head6a20dd93-round5/01-lG-virtual-replacement.png`、`02-lG-virtual-refusal.png`、`03-lG-credit-replacement.png`
- `logs/lG-r5-evidence.json`：**未生成**（`writeScenarioEvidence` 未被触达）
