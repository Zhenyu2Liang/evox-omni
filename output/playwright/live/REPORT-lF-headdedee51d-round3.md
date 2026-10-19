# lF 真实模型在线验收 — 第 3 轮（认证产品树 `dedee51d`）

场景：`lF-live-credit-report-lost-and-replace-new-session`（信用卡挂失 → 补办新卡，新会话）
结果：**PASS**（1 场景通过、0 失败、0 跳过）

## 1. 认证产品树与等价性证明

- 认证产品树提交（本轮启动时 `git rev-parse --short HEAD`，由入口内 `certifiedHead()` 打印）：**`dedee51d`**
- 运行前工作树干净（第 2 轮证据提交 `dedee51d` 之后无产品改动）。
- 等价性证明命令：

```
git diff --stat dedee51d HEAD -- banking-sdk agent security planner lib app components prisma scripts
```

输出：空。即 `dedee51d` 之后新增的提交只包含 `output/playwright/**` 证据文件（本报告与截图），
不含 `banking-sdk agent security planner lib app components prisma scripts` 任何路径，
因此本轮结果认证的产品树与 `dedee51d` 等价。

## 2. 命令与退出码（双信号）

```
$env:LIVE_SCENARIOS='lF'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs/lF-r3.out 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs/lF-r3.out & exit !EC!"; exit $LASTEXITCODE
```

| 信号 | 值 |
| --- | --- |
| 工具报告的进程退出码 | **0** |
| 日志 `logs/lF-r3.out:16` 的 `EXIT=` 行 | **`EXIT=0`** |
| 汇总行 `logs/lF-r3.out:15` | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` |
| `/api/health`（`logs/lF-r3.out:8`） | `{"ok":true,"data":{"status":"ok","time":1792339570946,"llmMode":"live"}}` |
| 耗时 | 35.5 s（`_r3_start.txt` `2026-10-19T00:05:51.688` → `_r3_end.txt` `2026-10-19T00:06:27.177`） |
| 环境 | 隔离库 `file:D:/projects/banking-agent/.genesis/workers/worker_T6_A91/prisma/live-acceptance.db`（独立重置：db push 阶梯 → probe → `prisma/seed.ts`），`next dev pid=60784` → `http://localhost:64858`，浏览器 `C:\Program Files\Google\Chrome\Application\chrome.exe` |

网络/前端噪声：`logs/lF-r3.out:11` → `累计网络 4xx/5xx：0，console error：0，pageerror：0`。

## 3. 逐轮提示词（逐字）与模型散文（逐字）

| 腿 | 用户提示词（逐字发送） | 模型散文 |
| --- | --- | --- |
| 1 挂失 | `我的尾号6688信用卡丢失了，请正式挂失，我确认不可撤销。` | `(无散文)` |
| MFA | `123456` | — |
| 2–4 补办 | `请为刚挂失的尾号6688信用卡补办新卡。` | `(无散文)` |
| MFA | `123456` | — |

两腿都在首轮直接发出受控工具调用，**没有消耗**任何 `driveRedTool` 催促轮次（无「散文只有请确认」的情形），
`MAX_TURNS_PER_LEG=6` 的续推预算未被使用。散文为空是模型行为（直接发工具调用），不是面板伪造：
本轮从未出现「散文声称面板」，`assertNoFabricatedConfirmationPanel` 守卫未触发。

## 4. 工具调用与持久化 `PendingAction.argsJson`

持久化行（`== PendingAction (all rows) ==`，2 行，逐字）：

```
cmve0pfu7006tugf88wxyvwns toolName=report_lost_card status=executed riskLevel=RED requiresMfa=true sessionId=demo:user_liming createdAt=2026-10-18T16:06:15.919Z
  argsJson={"cardId":"card_credit","reason":"用户确认信用卡丢失，要求正式挂失（不可撤销）"}
  mfa=cmve0pfu9006uugf8si551fey status=verified attempts=0 maxAttempts=3
cmve0pk6k00aougf8sncvla5f toolName=replace_card status=executed riskLevel=RED requiresMfa=true sessionId=demo:user_liming createdAt=2026-10-18T16:06:21.548Z
  argsJson={"cardId":"card_credit"}
  mfa=cmve0pk6l00apugf8esuqxj81 status=verified attempts=0 maxAttempts=3
```

（`/api/actions` 在验证前观测到 `replace_card` 为 `status=awaiting_mfa`、`tier=RED`、`requiresMfa=true`；
上表 `executed` 是 MFA 提交后的最终落库状态。）

`MfaChallenge` 两行：`cmve0pfu9006uugf8si551fey`（`report_lost_card`）与 `cmve0pk6l00apugf8esuqxj81`（`replace_card`），
均 `status=verified attempts=0 maxAttempts=3`，`verifiedAt=2026-10-18T16:06:17.344Z` / `...16:06:21.705Z`。

## 5. 卡片行（前 → 后）与额度不翻倍

验证前基线（`GET /api/cards` + SQLite）：`cardCount=3`、`sourceStatus=LOST`、`sourceReplacedByCardId=null`、`newlyCreatedCardIds=[]`
（`replace_card` 停放期间**未新增任何卡、未改任何状态**）。

验证后 SQLite `Card` 全表（4 行）：

| id | type | status | numberMasked | replacedByCardId | creditLimitMinor | availableLimitMinor | monthlyLimitMinor | linkedAccountId |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `card_credit` | CREDIT | **LOST** | `****6688` | `cmve0pkb700b2ugf8qcnl4km9` | 1800000 | 1800000 | 1800000 | null |
| `card_debit` | DEBIT | ACTIVE | `****8821` | null | null | null | null | null |
| `card_virtual` | VIRTUAL | ACTIVE | `****7788` | null | null | null | null | 500000 |
| `cmve0pkb700b2ugf8qcnl4km9` | **CREDIT** | **ACTIVE** | `****4485` | null | **1800000** | **1800000** | 1800000 | null |

- 恰 **1** 张新 CREDIT ACTIVE 卡，卡号 `****4485` ≠ 源卡 `****6688`（新卡号）。
- 源卡 `card_credit` 保持 `LOST`，`replacedByCardId` 指向新卡。
- `creditLimitMinor` / `availableLimitMinor` 均 `1_800_000`（原样继承，未重置、未放大）。
- 卡片总数 **3 → 4**（基线 + 1）。
- 额度合计：非 LOST CREDIT 可用合计 **`18000.00`**（挂失前 `18000.00`，不变）；
  把 LOST 源卡计入的朴素全 CREDIT 合计 **`36000.00`**（`naiveAllCreditAvailableMinor=3600000`）作为 **bug 签名显式排除**。
  `/cards` 渲染一致：补办卡「信用额度」=¥18,000.00、「可用额度」=¥18,000.00；源卡「可用额度」=¥18,000.00 但状态 LOST 不计入。

## 6. 资金与账本不变

| 断言 | 结果 |
| --- | --- |
| dashboard 余额 | `23580.00` → `23580.00`（不变） |
| `acct_checking.balanceMinor` | `2358000` |
| `GET /api/bills` 新增 / 消失 | **0 / 0** 条 |
| `Transaction` 行数 | `232`（不变） |
| `CardConsumption` 行数 | `0` |

## 7. 没有「只能手动办理」拒绝

`replace_card` 的受控工具调用**真实发出并被网关受理**（`PendingAction` `cmve0pk6k00aougf8sncvla5f`，RED + requiresMfa），
验证后真实产出一张新卡。因此「模型可调用 `replace_card`」这一能力事实在本轮**成立**；
未出现任何「新建/删除实体卡只能人工」套用到「已挂失卡补办」的拒绝。

## 8. 模型身份（从持久化行证明，非仅 health）

```
providerRequestPayloadRows=6
unparsablePayloads=0 payloadsWithoutPayloadModel=0
model counts=[["deepseek-flash",6]]
```

即 6 条 `AgentRunEvent(eventType='provider_request_payload')` 的 `payloadJson.payload.model` 全部为 `deepseek-flash`，
`ModelRequest` 6 行全部 `status=completed`（无 `errorCode`）。
模型 id 提取路径修正说明：第 1 轮报告的提取脚本输出 `model counts=[]`，原因是 `ModelRequest` 无 `model` 字段且无 `createdAt`；
本轮改为读取 `AgentRunEvent.payloadJson`（日志包裹为 `{ modelRequestId, payload }`）的 `payload.model`，并改为 `startedAt` 排序，
因此第 2、3 轮都能从持久化行证明模型身份，而不是只引用 `/api/health` 的 `llmMode:"live"`。

## 9. 截图与证据路径

- 截图：`output/playwright/live/lF-headdedee51d-round3/01-lF-cards-after-lost.png`、`.../02-lF-cards-after-replace.png`
- 原始 stdout：`logs/lF-r3.out`（含 `EXIT=0`）
- 场景证据 JSON：`logs/lF-r3-evidence.json`；DB 快照：`logs/lF-r3-db.txt`、`logs/lF-r3.db`
- 以上 `logs/*`、`output/playwright/*` 均在 `.gitignore` 中，只有本报告与两张 PNG 用 `git add -f` 提交。

## 10. 逐项判定

| # | 必须成立的事实 | 判定 |
| --- | --- | --- |
| 1 | `replace_card` `PendingAction` `tier=RED`、`requiresMfa=true`、pending/awaiting_mfa，且**早于**任何建卡 | PASS（`cmve0pk6k00aougf8sncvla5f`，验证前 `cardCount=3`、`newlyCreatedCardIds=[]`） |
| 2 | MFA `123456` 后恰 1 张新 CREDIT ACTIVE 卡、新卡号 ≠ `****6688` | PASS（`cmve0pkb700b2ugf8qcnl4km9` / `****4485`） |
| 3 | 源卡保持 `LOST` 且 `replacedByCardId` → 新卡 | PASS |
| 4 | `creditLimitMinor`/`availableLimitMinor` = `1_800_000` 继承不变 | PASS |
| 5 | 卡片总数 = 基线 + 1 | PASS（3 → 4） |
| 6 | 非 LOST CREDIT 合计 `18000.00` 前后不变，朴素 `36000.00` 排除 | PASS（1800000 / 3600000 分列） |
| 7 | dashboard `23580.00` 不变、`/api/bills` 新增 0 / 消失 0 | PASS |
| 8 | 模型真实发出 `replace_card`，无「只能手动办理」拒绝 | PASS |

## 11. 诚实说明

- 本轮是**独立进程、独立重置库**的一次运行；未复用第 1、2 轮的任何进程或数据库。
- 未修改任何提示词、产品代码或 `tests/e2e/*` 代码；未 mock/拦截模型；未手工改库。
- 模型非确定性说明：本轮两腿均在首轮直接发出受控工具，未出现散文-only 轮次；这与「散文声称面板」缺陷无关（本轮无此类文本）。
- 本轮唯一认证的产品树是本报告声明的 `dedee51d`；不得外推到其它提交或其它场景（`lA`/`lG` 等未被本轮覆盖）。
