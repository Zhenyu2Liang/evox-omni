# LIVE 验收证据 — 场景 `lE`（挂失 → 补办 → 补办卡消费与额度连续）— HEAD `0c50e2f` ROUND 3

本文件记录 `lE` 场景在产品树 `7a7a4d3` 上的**第三个独立真实模型轮次**（`LLM_MODE=live`、真实无头 Chrome、真实 `next dev`、独立 SQLite）。
本轮不修改任何断言、不跳过任何步骤，唯一目的是把该产品树上的可认证轮次从 2 轮补到 3 轮。

## 1. 被测提交与产品树等价性

| 项 | 值 |
| --- | --- |
| 分支 | `evogit-agent-T5-A50` |
| HEAD（`git rev-parse HEAD`） | `0c50e2f78681753fe6ec58d922a6beb396906145` |
| 产品树基线 | `7a7a4d3`（card-instant 提交） |
| `git diff --stat 7a7a4d3 HEAD -- banking-sdk agent security planner lib app components prisma scripts` | **空输出** |
| `git diff --stat 7a7a4d3 HEAD -- tests` | 仅 `tests/e2e/CONTEXT.md`、`tests/e2e/LIVE-ACCEPTANCE-REPORT.md`（证据/文档） |

本轮观测到的行为只能来自 `7a7a4d3` 的产品代码；本轮报告认证的是**产品树提交** `7a7a4d3`（等价 HEAD `0c50e2f`），不是把证据写进来之后的 HEAD。

## 2. 环境与运行（独立进程，独立建库）

与同批 `lD` round 3 完全相同的环境准备（`pnpm install --frozen-lockfile` → `INSTALL_EXIT=0`，`pnpm db:generate` → Prisma Client 7.10.0；`.env.local` 只读复制、值从不打印）。
退出码捕获方法在同一 shell 里先做了对照实验（详见 `REPORT-lD-head7a7a4d3-round3.md` 第 3 节）：
被证伪的 `%ERRORLEVEL%` 方法对 `process.exit(7)` 打印 `EXIT=0`；采用的方法对同一程序回报工具退出码 `7` + 日志 `EXIT=7`，对 `process.exit(0)` 回报 `0` + `EXIT=0`。

本轮唯一一次运行（`lD` 结束后另起进程，共享的隔离库文件由入口自行重建）：

```powershell
$env:LIVE_SCENARIOS='lE'; cmd /v:on /c "pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\live-lE-head-round3.log 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> logs\live-lE-head-round3.log & exit !EC!"; exit $LASTEXITCODE
```

| 信号 | 值 |
| --- | --- |
| 信号 1：工具报告的进程退出码 | **`0`** |
| 信号 2：日志末行延迟展开（`logs/live-lE-head-round3.log`） | **`EXIT=0`** |
| 汇总行 | **`== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==`** |

**判定：PASS。** 进程耗时 49.1 s。
`/api/health` → `{"ok":true,"data":{"status":"ok","time":1792220297576,"llmMode":"live"}}`；模型 id `deepseek-flash`（`logs/lE-evidence.json` 的 `model`，读自持久化 `provider_request_payload`；`LIVE_FORCE_MODEL` 未设置）；真实 Chrome `C:\Program Files\Google\Chrome\Application\chrome.exe`；隔离库 `prisma/live-acceptance.db`（`dev.db` / `test.db` 未被触碰）。

## 3. 逐字提示词（三腿，全部首轮命中）

```
开卡 : 请帮我新开一张虚拟卡，月消费限额设为100元
挂失 : 我刚才新办的那张虚拟卡（尾号4348，月限额100元）丢失了，请帮我正式挂失这张卡
补办 : 请为我刚才挂失的虚拟卡（原卡尾号4348）补办一张新卡
```

尾号 `4348` 是 harness 本轮刚创建的真卡号后四位（`****4348`），不是编造值。
三腿都是**首轮即发起受控工具**，未消耗催促（`VC_APPLY_TURNS` / `vcReportLostTurns` / `vcReplaceTurns` 的第 1 条即命中），未触达 `assertNoFabricatedConfirmationPanel`。
消费腿与超限腿是纯 `/cards` 弹窗提交，**0 个模型轮次**。

## 4. 工具调用（权威 DB 逐字，`logs/live-round3-db.json`）

`ToolInvocation` 全部 `status=completed`、`attempt=1`、`origin=pi`；三个受控写入的 `operationKey` **等于**对应 `PendingAction.id`：

| 序 | `toolName` | `argsJson` | `operationKey` |
| --- | --- | --- | --- |
| 1 | `describe_turn` | `{"operations":["apply_virtual_card"],"purpose":"operation"}` | `inv:call_7df11703-...` |
| 2 | `apply_virtual_card` | `{"monthlyLimit":"100"}` | `cmvc1oya8003c6kf8fipf1oe9` |
| 3 | `describe_turn` | `{"operations":["report_lost_card"],"purpose":"operation"}` | `inv:call_a7e87810-...` |
| 4 | `get_cards` | `{}` | `inv:call_288bee53-...` |
| 5 | `describe_turn` | `{"operations":["report_lost_card"],"purpose":"operation"}` | `inv:call_618a8d50-...` |
| 6 | `report_lost_card` | `{"cardId":"cardidem_a0bf16b0dc3c770b43a656c69da38384","reason":"用户表示虚拟卡（尾号4348）丢失，申请正式挂失"}` | `cmvc1p9kc00bm6kf89shvxija` |
| 7 | `describe_turn` | `{"operations":["replace_card"],"purpose":"operation"}` | `inv:call_59c15b95-...` |
| 8 | `replace_card` | `{"cardId":"cardidem_a0bf16b0dc3c770b43a656c69da38384"}` | `cmvc1pc0o00g76kf8x2aikj9o` |

模型这一轮把月限额写成 `"100"`（第 1/2 轮写 `"100.00"`）；网关在 `PendingAction.argsJson` 里落的是规范化后的 `{"monthlyLimit":"100.00"}`，最终 `Card.monthlyLimitMinor=10000`。三种表示一致，无金额漂移。

## 5. 确认/MFA 面板 = 三个真实 `PendingAction` 行

| `PendingAction.id` | `toolName` | `riskLevel` | `requiresMfa` | `status` | `userRequest`（用户原话） |
| --- | --- | --- | --- | --- | --- |
| `cmvc1oya8003c6kf8fipf1oe9` | `apply_virtual_card` | `RED` | `true` | `executed` | `请帮我新开一张虚拟卡，月消费限额设为100元` |
| `cmvc1p9kc00bm6kf89shvxija` | `report_lost_card` | `RED` | `true` | `executed` | `我刚才新办的那张虚拟卡（尾号4348，月限额100元）丢失了，请帮我正式挂失这张卡` |
| `cmvc1pc0o00g76kf8x2aikj9o` | `replace_card` | `RED` | `true` | `executed` | `请为我刚才挂失的虚拟卡（原卡尾号4348）补办一张新卡` |

三条 `MfaChallenge` 一一对应，`code=123456`、`attempts=0/3`、`status=verified`（`verifiedAt` 06:58:22.594Z / 06:58:35.682Z / 06:58:38.851Z）。
没有错误验证码、没有熔断、没有重复弹出；`pageerror: 0`，未出现「散文声称面板却无 `PendingAction`」。## 6. RAW `Card` 交叉核对（权威 SQLite，运行后只读 dump）

| 卡 | `id` | `type` | `status` | 卡号 | `monthlyLimitMinor` | `linkedAccountId` | `replacedByCardId` | 信用字段 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 源卡（本轮新建） | `cardidem_a0bf16b0dc3c770b43a656c69da38384` | `VIRTUAL` | **`LOST`** | `****4348` | `10000` | `acct_checking` | `cmvc1pci500gl6kf8xwue5yfy` | `creditLimitMinor=null`、`availableLimitMinor=null` |
| 补办新卡 | `cmvc1pci500gl6kf8xwue5yfy` | `VIRTUAL` | **`ACTIVE`** | `****5448` | `10000` | **`acct_checking`（继承）** | `null` | `null` / `null` |
| 种子信用卡 | `card_credit` | `CREDIT` | `ACTIVE` | `****6688` | `1800000` | — | `null` | `1800000` / `1800000` |
| 种子借记卡 | `card_debit` | `DEBIT` | `ACTIVE` | `****8821` | — | — | `null` | — |
| 种子虚拟卡 | `card_virtual` | `VIRTUAL` | `ACTIVE` | `****7788` | `500000` | `acct_checking` | `null` | — |

- 源卡保持终态 `LOST`，`replacedByCardId` 指向补办卡；挂失腿资金零变化。
- 补办恰新增 **1 张** `VIRTUAL` / `ACTIVE` 卡，卡号 `****5448` ≠ `****4348`，`linkedAccountId=acct_checking` 从源卡继承（不是回退默认账户）。
- **可用信用额度不翻倍**：唯一的非 `LOST` `CREDIT` 行仍是 `card_credit`（`1800000` minor = ¥18,000.00），`LOST` 源卡贡献 0，虚拟卡不携带信用额度字段。

## 7. 资金移动（恰一次 + 限额连续）

| 时刻 | 输入 | `Transaction`（`channel=CARD` / `DEBIT`） | `CardConsumption` | 活期余额 |
| --- | --- | --- | --- | --- |
| 挂失前在源卡消费 | `30.00` / `购物` / `虚拟卡挂失前消费验证` | `cmvc1p2jh00456kf8rhwxniug`（`-3000`） | `cmvc1p2ji00466kf8u4ze9cfs`（`3000`，`cardId`=源卡） | `2358000` → `2355000` |
| 补办后在**新卡**消费 | `70.00` / `购物` / `虚拟卡补办续限验证` | `cmvc1pdn700h16kf8yu8422d2`（`-7000`） | `cmvc1pdn800h26kf8biovrmpp`（`7000`，`cardId`=补办卡） | `2355000` → **`2348000`** |
| 额度用尽后尝试 `1.00` | `1.00` / `虚拟卡超限拒绝验证` | **无** | **无** | 不变 |

- 全库恰有 2 条 `CardConsumption`（`3000` + `7000`），历史 `CardConsumption` 的 `cardId` 仍归属原卡，未改写。
- 两条消费行 `occurredAt` 都是 `2026-09-25T04:00:00.000Z`（`demoNow()`），各自带唯一 `executionKey`；没有任何请求体携带 `occurredAt`。
- 超限腿 HTTP `422` `LIMIT_EXCEEDED` `超过虚拟卡月限额。`，屏幕文案 `超出本月消费限额`；`assertNoSpend` 通过（余额、流水、消费行零变化）。日志 `[4xx/5xx]` 计数 = 1。

### 7.1 月额度连续（不重置）

| 阶段 | `payableAmount`（服务端投影） | 依据 |
| --- | --- | --- |
| 开卡后 | `100.00` | `min(23580.00, 100.00 - 0.00)` |
| 挂失前消费 `30.00` 后 | `70.00` | 家族已用 `3000` |
| **补办后** | **`70.00`** | `familySpentMinor=3000` 经 `replacedByCardId` 双向遍历继承；`100.00` 重置值被显式排除 |
| 新卡消费 `70.00` 后 | `0.00` | `100.00 - 100.00` |
| 再尝试 `1.00` 被拒后 | `0.00` | 不变 |

补办后 `/cards` 卡片渲染（刷新后实读）：`{"账户可用余额":"¥23,550.00","当前可支付金额":"¥70.00"}`；
若额度被重置，这一格会是 `¥100.00` —— 断言以「不等于即抛错」的方式排除该 bug 签名。

## 8. 截图（本轮新目录）

```
output/playwright/live/lE-head7a7a4d3-round3/01-lE-replacement-card.png     (88,892 B)
output/playwright/live/lE-head7a7a4d3-round3/02-lE-exhausted-refusal.png   (105,333 B)
```

`...-round1/`、`...-round2/` 与其它 `REPORT-lE-*.md` 均未修改。

## 9. 清理与端口

| 检查 | 结果 |
| --- | --- |
| 入口报的端口 / dev-server pid | `64156` / `43036` |
| `netstat -ano` 过滤 `:64156` | 仅 `TIME_WAIT` 客户端套接字，**无 `LISTENING`** |
| `tasklist /FI "PID eq 43036"` | `No tasks are running which match the specified criteria` |
| 命令行提及 `live-acceptance` 的 `node.exe` | **无** |
| 命令行提及 `worker_T5_A50` 的 `chrome.exe` | **无** |

## 10. 本轮未验证的事项（不要据此推断）

- 本轮是同一产品树的**第 3 个样本**；三腿都在首轮命中，不能据此推断其它轮次不需要催促，也不证明长期模型稳定性。
- live 侧只提交正确验证码 `123456`（`attempts=0/3`）；错误码/熔断路径由 mock 套件覆盖，本轮未在 live 模型下触达。
- 「可用信用额度不翻倍」由 RAW `Card` 行求和得出，不是 dashboard API 读回。
- `pnpm test`、`pnpm typecheck`、lint、`next build` 本轮**未运行**。
- 其它场景（`lA`/`lB`/`lC`/`lD` round 3 之外的 live id `0`–`15`、`2p`、`7`）本轮**未运行**。
- 浏览器验收不证明集群并发、真实银行接入或生产构建可用。