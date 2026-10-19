# lE 单轮真实模型验收报告 — HEAD `7a7a4d3` round 1

本文件是本轮唯一的结论证据。
历史轮次（commit `f570d58` 的 round 1–3）留在 Git 历史，不与本轮混写。

## 1. 被测提交与目的

| 项目 | 值 |
| --- | --- |
| HEAD 提交 | `7a7a4d32a6a1622deb7647ab6142fb7991b76805`（`7a7a4d3`），`109478f` 与 `1e337ae` 的合并提交 |
| 卡片入账瞬间提交 | `1e337ae`（*test(banking-sdk): align card-consumption snapshot assertion with enforced instant*） |
| HEAD 是否包含 `1e337ae` | 是：`git merge-base --is-ancestor 1e337ae HEAD` → true |
| 场景 | `lE` / `scenarioVirtualCardReplaceContinuity` / id `lE-live-virtual-card-replace-continuity` |
| 工作区起点 | `git status --porcelain` 为空 |

本轮目的：`banking-sdk/card.ts`（`consumeCard` 结果快照）与 `banking-sdk/card-family.ts`（`loadCardView` 用与限额判定同一瞬间解析业务月，`getCards` 不再把 `Array#map` 的下标当作该瞬间）在生产路径仍为 `demoNow()`，行为必须与旧提交一致。
本轮的通过即是对「卡片瞬间修正对 `lE` 行为无变化」的生产证据。

## 2. 执行的命令

```powershell
# 环境准备（.env.local 只复制、不显示、不修改）
cmd /c copy /Y d:\projects\banking-agent\.env.local .env.local
cmd /c "pnpm install --frozen-lockfile > logs\install.log 2>&1"      # INSTALL_EXIT=0，584 packages
cmd /c "pnpm db:generate > logs\prisma-generate.log 2>&1"            # Prisma Client 7.10.0 → ./lib/db/generated

# 取证提交
git rev-parse HEAD
git merge-base --is-ancestor 1e337ae HEAD

# 本轮唯一一次运行（单进程，未重试）
$env:LIVE_SCENARIOS='lE'; cmd /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lE-7a7a4d3-round1.log 2>&1; echo EXIT=%ERRORLEVEL% >> logs\live-lE-7a7a4d3-round1.log"
```

运行开始 `周六 2026/10/17 14:17:03.91`，全程约 52 秒（`logs/live-lE-7a7a4d3-round1.log` 共 21 行）。
isolated DB：`file:D:/projects/banking-agent/.genesis/workers/worker_T5_A44/prisma/live-acceptance.db`（入口自行 `db push` 阶梯 → probe → `tsx prisma/seed.ts`）。
未触碰 `prisma/dev.db`、`prisma/test.db`、任何用户备份，未编辑 `.env.local`。
未与本轮并行运行任何其他套件或第二个 e2e 进程。

## 3. 结果

退出码（日志第 20 行，逐字）：

```
EXIT=0
```

汇总行（日志第 19 行，逐字）：

```
== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==
```

场景明细（日志第 13 行，逐字，与 DB 交叉核对一致）：

```
PASS lE-live-virtual-card-replace-continuity — lE 实际发送（开卡）：「请帮我新开一张虚拟卡，月消费限额设为100元」 → MFA 123456 → 新虚拟卡 cardidem_f2bc0e9d9ea121252ec04ade0d059ee6（monthlyLimitMinor=10000、linkedAccountId=acct_checking）；挂失前消费 30.00（购物/虚拟卡挂失前消费验证）= 新增 CARD/DEBIT 流水 -3000（cmvc08n8r004zksf824dy8sw0）+ 1 条 CardConsumption（cmvc08n8s0050ksf8roir6l2e），活期余额 23580.00 → 23550.00；挂失实际发送：「我刚才新办的那张虚拟卡（尾号5706，月限额100元）丢失了，请帮我正式挂失这张卡」 → MFA 123456 → RAW status=LOST、资金零变化；补办实际发送：「请为我刚才挂失的虚拟卡（原卡尾号5706）补办一张新卡」 → MFA 123456 → cardidem_f2bc0e9d9ea121252ec04ade0d059ee6.replacedByCardId=cmvc08x8s00m6ksf8ynzd66z5（恰新增 1 张 VIRTUAL/ACTIVE 卡）；补办卡 RAW：linkedAccountId=acct_checking（= 原卡 acct_checking，继承修复生效）、monthlyLimitMinor=10000、卡号 ****8108 ≠ 原卡 ****5706、无信用额度；家庭月限额连续：已用 3000 → payableAmount=70.00（=70.00，不是 100.00），卡片渲染 {"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}；补办卡消费 70.00（购物/虚拟卡补办续限验证）= 新增 CARD/DEBIT 流水 -7000（cmvc08yeq00mmksf88mlcbbxu）+ 1 条 CardConsumption（cmvc08yer00mnksf8brw23mal），活期余额 23550.00 → 23480.00（恰扣一次）→ payableAmount=0.00；额度用尽后 1.00（虚拟卡超限拒绝验证）被拒绝：「超出本月消费限额」，流水/余额/CardConsumption 零变化，payableAmount 仍 0.00；截图 …\output\playwright\live\01-lE-replacement-card.png / …\02-lE-exhausted-refusal.png；证据 JSON …\logs\lE-evidence.json
```

网络副作用计数（日志第 14–15 行）：`累计网络 4xx/5xx：1，console error：1，pageerror：0`。
唯一一条非 2xx 是超限拒绝本身：

```
POST 422 http://localhost:58617/api/cards/cmvc08x8s00m6ksf8ynzd66z5/consume — {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}
```

## 4. 真实模型证明（无 mock、无响应拦截）

- 启动应用的 `/api/health`（日志第 9 行，逐字）：
  `{"ok":true,"data":{"status":"ok","time":1792217851528,"llmMode":"live"}}`
- 浏览器真实二进制（日志第 10 行）：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 持久化 `AgentRunEvent(eventType='provider_request_payload')` 的 `payloadJson.payload.model`（logs/lE-providercheck-7a7a4d3-round1.txt）：

  | 项目 | 值 |
  | --- | --- |
  | `provider_*` 事件总数 | 303（`provider_request_payload` 7 / `provider_response_event` 289 / `provider_response_headers` 7） |
  | `payload.model` | `"deepseek-flash"`（7 条 distinct payload 全部一致） |
  | `payload.stream` | `true`（7 条） |
  | `payload.max_tokens` | `384000` |
  | inner payload keys | `max_tokens,messages,model,stream,stream_options,thinking,tools` |
  | `provider_response_headers` | 7 条，全部 `payload.status=200`、`content-type: text/event-stream; charset=utf-8` |
  | `model_request_started` / `model_request_completed` | 7 / 7 |
  | `AgentRun` 行 | 6（3 × `waiting_verification` + 3 × `completed`） |

  `tests/e2e/live-acceptance.e2e.ts:155` 的 `configureLiveEnv()` 强制 `LLM_MODE='live'`、`LLM_PROVIDER='deepseek'`、`DATABASE_URL=LIVE_DB_URL`、`DEMO_USER_ID='user_liming'`；未设置 `LIVE_FORCE_MODEL`，因此模型来自 `.env.local` 的 live 配置，不是 mock 脚本。
  (`ModelRequest` 行数 = 0、`AgentSession.messages` = 0，状态实际存放在 `AgentSession.stateJson` 与其 `agentState.messages`/`transcript`，不构成 mock 证据的反例。)
## 5. 逐轮提示词（逐字）

本轮共 3 个业务轮次，每轮一条自然语言提示，无需催促（`VC_APPLY_TURNS`/`vcReportLostTurns`/`vcReplaceTurns` 各只用掉第 1 条）：

| 轮 | 腿 | 提示词（逐字） |
| --- | --- | --- |
| 1 | 新开虚拟卡 | `请帮我新开一张虚拟卡，月消费限额设为100元` |
| 2 | 挂失新开卡 | `我刚才新办的那张虚拟卡（尾号5706，月限额100元）丢失了，请帮我正式挂失这张卡` |
| 3 | 补办该卡 | `请为我刚才挂失的虚拟卡（原卡尾号5706）补办一张新卡` |

## 6. 工具调用与参数（`AgentSession.stateJson.agentState.messages` 逐字）

```
[turn 1] describe_turn {"purpose":"operation","operations":["apply_virtual_card"]}
[turn 1] apply_virtual_card {"monthlyLimit":"100.00"}
[turn 2] describe_turn {"purpose":"operation","operations":["get_cards"]}
[turn 2] get_cards {}                                   # GREEN 查询定位目标卡
[turn 2] describe_turn {"purpose":"operation","operations":["report_lost_card"]}
[turn 2] report_lost_card {"cardId":"cardidem_f2bc0e9d9ea121252ec04ade0d059ee6","reason":"客户反馈虚拟卡（尾号5706）丢失，申请正式挂失"}
[turn 3] describe_turn {"purpose":"operation","operations":["replace_card"]}
[turn 3] replace_card {"cardId":"cardidem_f2bc0e9d9ea121252ec04ade0d059ee6"}
```

每次 RED 写入都被安全网关以 `__SECURITY_BLOCK__{"decisionKind":"require_mfa", ...}` 停放（`tool_end.status=blocked` + `mfa_required` 事件），只有在真实 MFA 面板输入 `123456` 后才执行：三轮都是 `tool_execution_end.isError=true` 的网关拦截紧接着 `MFA 123456` 通过，没有任何一轮是模型散文直接宣称成功。

## 7. 面板来源：`PendingAction` + `MfaChallenge`（全部真实，全部 `123456`）

| # | actionId | toolName | argsJson | action status | decision / tier | MfaChallenge | verifiedAt |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `cmvc08jsa0046ksf8zg85ftby` | `apply_virtual_card` | `{"monthlyLimit":"100.00"}` | `executed` | `require_mfa` / RED（`banking-policy-v3`） | `status=verified attempts=0/3` | `2026-10-17T06:17:37.623Z` |
| 2 | `cmvc08tq100fnksf8tkl8s70f` | `report_lost_card` | `{"cardId":"cardidem_f2bc0e9d9ea121252ec04ade0d059ee6","reason":"客户反馈虚拟卡（尾号5706）丢失，申请正式挂失"}` | `executed` | `require_mfa` / RED | `status=verified attempts=0/3` | `2026-10-17T06:17:48.743Z` |
| 3 | `cmvc08x0t00lsksf8cudxfxtx` | `replace_card` | `{"cardId":"cardidem_f2bc0e9d9ea121252ec04ade0d059ee6"}` | `executed` | `require_mfa` / RED | `status=verified attempts=0/3` | `2026-10-17T06:17:52.961Z` |

配套证据：
- `MfaChallenge.consumedAt` 依次 `…37.644Z` / `…48.754Z` / `…52.976Z`。
- `ExecutionReceipt` 3 条：`rcpt_f2bc0e9d9ea121252ec04ade0d059ee6`（apply_virtual_card）、`rcpt_41e2234511796d29e793aba188593e3f`（report_lost_card）、`rcpt_c12f89de3c706d7b0efaec0196540719`（replace_card），`key` 分别等于对应 actionId。
- `AuthorizationDecision` 4 条：3 × `require_mfa`/RED + 1 × `allow`/GREEN（`get_cards`），policy `banking-policy-v3`。
- `AuditLog` 3 条，全部 `confirmationRequired=true, confirmed=true, mfaRequired=true, mfaResult="success"`，`userRequest` 与第 5 节提示词逐字一致。
- `SecurityEvent` 计数 = 0（无伪造、无熔断、无越权）。

结论：3 个确认/MFA 面板全部由真实工具调用经 `security/security-gateway.ts` 持久化的 `PendingAction` 产生。本轮不存在「散文声称面板但无 `PendingAction`」的情形，`assertNoFabricatedConfirmationPanel` 未触发。

## 8. RAW `Card` 行（数据库权威值）

种子 3 张 ACTIVE（`card_credit` CREDIT / `card_debit` DEBIT / `card_virtual` VIRTUAL），运行后共 5 行。

```
id=card_credit type=CREDIT status=ACTIVE network=UnionPay numberMasked=****6688 monthlyLimitMinor=1800000 creditLimitMinor=1800000 availableLimitMinor=1800000 linkedAccountId=null replacedByCardId=null
id=card_debit  type=DEBIT  status=ACTIVE numberMasked=****8821 monthlyLimitMinor=null creditLimitMinor=null availableLimitMinor=null linkedAccountId=null replacedByCardId=null
id=card_virtual type=VIRTUAL status=ACTIVE numberMasked=****7788 monthlyLimitMinor=500000 creditLimitMinor=null availableLimitMinor=null linkedAccountId=acct_checking replacedByCardId=null
id=cardidem_f2bc0e9d9ea121252ec04ade0d059ee6 type=VIRTUAL status=LOST   numberMasked=****5706 monthlyLimitMinor=10000 creditLimitMinor=null availableLimitMinor=null linkedAccountId=acct_checking replacedByCardId=cmvc08x8s00m6ksf8ynzd66z5
id=cmvc08x8s00m6ksf8ynzd66z5                 type=VIRTUAL status=ACTIVE numberMasked=****8108 monthlyLimitMinor=10000 creditLimitMinor=null availableLimitMinor=null linkedAccountId=acct_checking replacedByCardId=null
```

对照 `lE` 的断言：

| 断言 | 观察值 | 结论 |
| --- | --- | --- |
| 源卡保持 `LOST` | `status=LOST` | 通过 |
| `replacedByCardId` 指向新卡 | `cardidem_… → cmvc08x8s00m6ksf8ynzd66z5` | 通过 |
| 恰新增 1 张 `VIRTUAL`/`ACTIVE` | 新增仅 `cmvc08x8s00m6ksf8ynzd66z5` | 通过 |
| `linkedAccountId` 继承 | 源 `acct_checking` = 新 `acct_checking` | 通过 |
| 卡号不同 | `****5706` ≠ `****8108` | 通过 |
| 月限额相同 | `monthlyLimitMinor=10000`（100.00）= 源卡 | 通过 |
| 虚拟卡无信用额度 | `creditLimitMinor=null`、`availableLimitMinor=null` | 通过 |
| 资金零变化（挂失腿） | 挂失前后 `acct_checking` 均为 `2355000`；`CardConsumption` 无新增 | 通过 |

## 9. 月限额连续性（核心：补办后不重置）

`min(账户可用余额, 剩余月限额)` 的四个数字（`/cards` 渲染 + DB 交叉核对）：

| 阶段 | 已用（family 累计） | 剩余月限额 | 账户可用余额 | `payableAmount` | 来源 |
| --- | --- | --- | --- | --- | --- |
| 新开卡后 | 0 | 100.00 | 23580.00 | **100.00** | `apply_virtual_card` 返回 `{"accountAvailableBalance":"23580.00","monthlyLimit":"100.00","payableAmount":"100.00"}` |
| 挂失前消费 30.00 后 | 30.00 | 70.00 | 23550.00 | **70.00** | `get_cards` 中源卡 `{"accountAvailableBalance":"23550.00","payableAmount":"70.00","status":"ACTIVE"}` |
| 挂失后（补办前） | 30.00 | 70.00 | 23550.00 | **70.00** | `report_lost_card` 返回 `{"payableAmount":"70.00","status":"LOST"}` |
| **补办后（关键）** | 30.00 | 70.00 | 23550.00 | **70.00（不是 100.00）** | `replace_card` 返回 `{"id":"cmvc08x8s00m6ksf8ynzd66z5","monthlyLimit":"100.00","payableAmount":"70.00","status":"ACTIVE"}`；`/cards` 卡片行 `{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}` |
| 补办卡消费 70.00 后 | 100.00 | 0.00 | 23480.00 | **0.00** | `payableAfterExhaustion="0.00"` |
| 超限 1.00 被拒后 | 100.00 | 0.00 | 23480.00 | **0.00** | `payableAfterRefusal="0.00"` |

`cardFamilyMonthSpend` 等价的 DB 求和（业务月窗口 `[2026-08-31T16:00:00.000Z, 2026-09-30T16:00:00.000Z)`，UTC+08:00 月界）：

```
card_virtual (ACTIVE)                    family=[card_virtual]                          familyMonthSpend=0
cardidem_f2bc0e9d… (LOST)                family=[cardidem_f2bc0e9d…, cmvc08x8s00m6…]    familyMonthSpend=10000  rows=cardidem_f2bc0e9d…:3000:虚拟卡挂失前消费验证 | cmvc08x8s00m6…:7000:虚拟卡补办续限验证
cmvc08x8s00m6ksf8ynzd66z5 (ACTIVE)       family=[cardidem_f2bc0e9d…, cmvc08x8s00m6…]    familyMonthSpend=10000  rows=同上
```

源卡与补办卡共享同一 family（双向遍历 `replacedByCardId`），累计已用 `10000`（100.00）= 月限额，历史 `CardConsumption` 归属未被改写（`3000` 仍属源卡，`7000` 属新卡）。
**限额确实没有重置**：补办后剩余仍是 70.00，而不是 100.00。

## 10. 补办卡上恰好一次成功消费

`CardConsumption`（全表 2 条，各 1 条挂在对应卡上，新卡恰 1 条）：

```
id=cmvc08n8s0050ksf8roir6l2e cardId=cardidem_f2bc0e9d9ea121252ec04ade0d059ee6 accountId=acct_checking amountMinor=3000 category=购物 merchant=虚拟卡挂失前消费验证 occurredAt=2026-09-25T04:00:00.000Z executionKey="2edbc45e-7d5d-44fc-902f-897829507879"
id=cmvc08yer00mnksf8brw23mal cardId=cmvc08x8s00m6ksf8ynzd66z5                 accountId=acct_checking amountMinor=7000 category=购物 merchant=虚拟卡补办续限验证 occurredAt=2026-09-25T04:00:00.000Z executionKey="f1857248-86e7-49fd-ad46-2f5afbf68097"
```

`channel='CARD'` / `direction='DEBIT'` 的流水（仅此两笔为本轮新增，金额精确）：

```
tx cmvc08n8r004zksf824dy8sw0 account=acct_checking amountMinor=-3000 direction=DEBIT channel="CARD" merchant=虚拟卡挂失前消费验证 occurredAt=2026-09-25T04:00:00.000Z
tx cmvc08yeq00mmksf88mlcbbxu account=acct_checking amountMinor=-7000 direction=DEBIT channel="CARD" merchant=虚拟卡补办续限验证 occurredAt=2026-09-25T04:00:00.000Z
```

账户余额（`acct_checking`，Prisma `BigInt` 分）：

| 阶段 | `balanceMinor` | 变化 |
| --- | --- | --- |
| 起点（seed） | `2358000`（¥23,580.00） | — |
| 挂失前消费 30.00 后 | `2355000`（¥23,550.00） | −3000（恰一次） |
| 挂失后 | `2355000` | 0（资金零变化） |
| 补办后 | `2355000` | 0（不移动资金） |
| 补办卡消费 70.00 后 | `2348000`（¥23,480.00） | −7000（**恰一次**） |
| 超限 1.00 被拒后 | `2348000` | 0（拒绝不移动资金） |

超限拒绝：`POST /api/cards/cmvc08x8s00m6ksf8ynzd66z5/consume`（新卡 id）→ `422 {"ok":false,"error":{"code":"LIMIT_EXCEEDED","message":"超过虚拟卡月限额。"}}`，对话框文案 `超出本月消费限额`，`Transaction` / `CardConsumption` / 余额零变化。

记账时间由服务端拥有：两条 `CardConsumption.occurredAt` 与两条 `Transaction.occurredAt` 均为 `demoNow()` 的 `2026-09-25T04:00:00.000Z`，本轮未向请求体发送任何 `occurredAt`。
## 11. 证据文件

截图（本轮固定命名产物已复制到独立目录，不覆盖历史轮次）：

- `output/playwright/live/lE-head7a7a4d3-round1/01-lE-replacement-card.png`（88,728 字节）— 补办后新卡 `****8108`，卡片显示 `当前可支付金额 ¥70.00`
- `output/playwright/live/lE-head7a7a4d3-round1/02-lE-exhausted-refusal.png`（105,487 字节）— 额度用尽后的 `超出本月消费限额` 拒绝

原始产物（仅在 `logs/`，gitignored，不提交）：

- `logs/live-lE-7a7a4d3-round1.log`（运行 stdout，含 `EXIT=0` 与汇总行）
- `logs/lE-evidence-7a7a4d3-round1.json`（harness 场景证据）
- `logs/lE-dbcheck-7a7a4d3-round1.txt`（DB 权威 dump）
- `logs/lE-providercheck-7a7a4d3-round1.txt`（live/无 mock 证明）
- `logs/lE-transcript-7a7a4d3-round1.txt`（逐字提示词 + 工具调用）
- `logs/install.log`、`logs/prisma-generate.log`
- 清理证明：`logs/cleanup-check.txt`（58617 / 3000 无监听：`findstr` 退出码 1）、`logs/own-procs-match.txt`、`logs/own-procs-match2.txt`（无任何 node/chrome 进程引用本工作区、`next-server`、`playwright` 或 `live-acceptance`）

## 12. 资源清理

- dev server（`next dev`，pid 65064，`http://localhost:58617`）与浏览器已由 harness `teardown()` + `process.on('exit')` 兜底 `cleanup()` 结束；场景后诊断与证据读取位于主 `try` 内，未影响退出码。
- 原生命令核对（`logs/cleanup-check.txt`）：`netstat -ano | findstr :58617` → 无输出（`ERRORLEVEL=1`）；`:3000` → 无输出（`ERRORLEVEL=1`）。
- 进程核对（`logs/own-procs-match.txt` / `own-procs-match2.txt`）：系统内其余 `node.exe` 全部是 Codex 运行时自身进程，没有任何进程的命令行引用 `worker_T5_A44`、`next-server`、`playwright` 或 `live-acceptance`。

## 13. 判定：卡片瞬间修正对 `lE` 是生产行为等价的

在生产路径该瞬间仍是 `demoNow()`，本轮 HEAD 的实测与旧提交一致：账户余额、`payableAmount`、`CardConsumption`、`Transaction`、`AuditLog` 与 `PendingAction` 全部符合 `lE` 的既有断言，且没有出现「补办后剩余额度被重置为 100.00」这类由错误业务月瞬间引入的回归签名。

同时确认：`getCards` 不再把 `Array#map` 的下标当作瞬间后，`get_cards` 返回的 `card_virtual` 与源卡 `payableAmount` 都是真实值（`5000.00` / `70.00`），不是被下标错算的数值。

## 14. 未验证项（NOT verified）

明确未验证，不得据本报告推断：

1. 集群并发或多进程/多浏览器并发下的行为（本轮为单进程单浏览器）。
2. 真实银行/清算接入（本项目仅模拟）。
3. 浏览器渲染质量本身，仅核对了两张截图所覆盖的补办卡与拒绝态画面；未逐像素或逐交互验证其余 UI。
4. MFA `attempts > 0`（错误验证码）路径：本轮三轮都只提交正确码 `123456`，`MfaChallenge.attempts` 恒为 `0/3`；未触达尝试上限，也未验证锁定持久化。
5. `Array#map` 下标瞬间泄漏修正的其他影响面：本轮只有 7 次模型请求、4 张卡的视图渲染，未覆盖其他场景或更多卡片组合。
6. 除 `lE` 之外的任何场景在本 HEAD 的通过情况（未运行其他场景）。
7. 模型非确定性：本轮 3 条腿都在第 1 条自然轮次内发起受控工具调用，不需要催促，但单轮通过不能证明该模型长期稳定。
8. 生产构建验收（`next build`）与部署路径。