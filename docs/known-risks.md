# 已知风险与限制 · Known Risks & Limitations

> 本文件诚实地列出演示的局限，并对每条给出「**为何在比赛演示中可接受**」。
> 这些限制大多是**演示沙箱的刻意设计**或**单进程 / SQLite 部署下未经证明**的边界，而非缺陷——
> 它们让系统在无真实资金、无真实银行的前提下，完整展示「智能体 + 代码强制安全模型」的核心价值。
> **测试通过 ≠ 安全模型已封闭**：安全语义的封闭只能来自对**失败路径**的显式验证，而非「测试全绿」；
> 本文件不为任何一条声称「100% 完成」。系统已有一个**真实浏览器验收 harness**（`tests/e2e/`，见第 16 条），
> 但它是**单机、有限 journey** 的验收，**不**证明安全模型已被完全封闭。
> 每条限制都**恰好**归入下列**三个显式分桶**之一（每条的 `性质` 标签即其所属桶）：
>
> - ✅ **【已实现】代码强制（LLM-immutable）** — 该语义由 TypeScript 代码强制执行，LLM / 模型文本无法绕过（可能仍带单进程 / 数据库引擎前提，见【未验证】桶）。
> - 🧪 **【模拟】模拟后端 / 刻意受限** — 后端为模拟实现（无真实银行 / 资金 / 支付 / 短信），或为演示而**刻意受限**的设计（进程内熔断、固定演示时钟、🟢 读取按设计不审计）。
> - ⚠️ **【未验证】本仓库未证明** — 依赖特定运行环境（多进程 / 多实例 / 跨浏览器）或属覆盖缺口，**仅单进程 + SQLite 文件锁的原子性被实际运行过**（详见下节分桶）。

---

## 三类分桶 · Three-Bucket Separation

每一条限制**恰好**归入下面一个桶——其 `性质` 标签即所属桶。

### ✅ 【已实现】代码强制 · LLM-immutable

该语义由 TypeScript 代码强制执行，LLM（及其文本）**无法绕过**：

- **Cookie-only 会话身份**（第 17 条）— 会话 id **仅**取自 `banking_session` HttpOnly Cookie（`lib/constants.ts` `SESSION_COOKIE`、`app/api/_lib/session.ts` `resolveSessionId`）；请求体 `sessionId` 与 Cookie **不一致（含无 Cookie）→ `409 CONFLICT` 且不下发 `Set-Cookie`**（`app/api/chat/route.ts`）——请求体永远无法选择 / 铸造会话。
- **DB 原子执行领取**（第 18 条）— `lib/db/repositories/task.ts#claimTaskExecution`（计划）/ `#claimNodeExecution`（节点）以**单条 `updateMany` CAS** 领取执行槽，并在 **`finally`** 中 `releaseTaskExecution` / `releaseNodeExecution` 释放；并发的 resume / retry **只有一个能运行**。
- **原子取消计划**（第 18 条）— `agent/task-control.ts#cancelTask` 最终在一个 `prisma.$transaction` 内**同时**执行 `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'])`（`lib/db/repositories/pendingAction.ts`，**单条原子 `updateMany`**，一次性把该计划**全部**可执行动作置为 `cancelled`）与计划行 `status='cancelled'` 写入——撤销与取消之间**没有窗口**；节点输出扫描（`revokeParkedActions`）与运行后 `sweepCancelledPlan` 只是**兜底**。此后任何 confirm / verify 均以 `CONFLICT` / `NOT_FOUND` 失败，**已入账的交易保留**（不伪造回滚）。
- **取消计划的授权复核**（第 18 条）— `security/security-gateway.ts` 在 compare-and-set 的**同一个 `$transaction`** 内按 `PendingAction.taskId` 重读所属计划状态：计划已 `cancelled` ⇒ **在事务内反转领取**并返回 `plan_cancelled`（HTTP 200 `{ok:false, status:'cancelled', code:'SECURITY_DENIED'}`）；`gatewayCreatePendingAction` 拒绝在已取消计划下新建 action；`recordActionResult` 绝不把已取消计划下的 action 标为 `executed`。**取消先于执行**由代码强制，LLM 无法复活。
- **统一账本键 · 转账幂等**（第 15 条）— `lib/ledger.ts` 以 `ledgerKeyForAction({id,taskId,nodeId})` 统一派生幂等键（计划节点动作得 `nodeExecutionKey(taskId, nodeId)` = `nxe:<taskId>:<nodeId>`，独立动作得自身 `id`），`ledgerTxIdForAction(userId, action)` 在**同一把键**上派生 / 查找账本行主键——生成端与查找端一致，**已入账的 in-flight 转账在日累计中只计一次**，重复 / 并发确认**重放原行而非二次生效**。
- **计划节点身份去重**（第 18 条）— `nodeExecutionKey(taskId, nodeId)` 为节点副作用去重（`subscribeInvestment` 的 `InvestmentHolding.idempotencyKey`、`redeemInvestment` 的 `REDEEMED` 状态翻转、`applyVirtualCard` 的确定性 card id）；`agent/confirmation.ts#executeGatedToolOnce` 以 `findInFlightPlanActionId(taskId, nodeId)` 返回已停靠结果而非铸造第二个 action。
- 同桶其余条目：第 4 条（启发式异常检测）、第 6 条（消费分析按设计排除异常）、第 14 条（注入守卫不改变授权结论）、第 19 条（工程性说明）。

### 🧪 【模拟】模拟后端 / 刻意受限

后端为模拟实现，或为演示而**刻意受限**（**无真实银行 / 资金 / 支付 / 短信**）：

- **模拟银行 SDK**（第 1、3 条）— `transfer_money` 只写一条模拟 `Transaction` 借贷行并调整余额；系统不连接任何真实银行核心系统、不发起任何真实支付。
- **进程内熔断器**（第 7 条）— `security/circuit-breaker.ts` 为**内存态、按 `sessionId`** 的熔断器，不跨进程 / 不跨实例共享、不持久化（**进程重启即重置**）。
- **固定演示时钟**（第 8 条）— `DEMO_NOW = 2026-09-25 12:00 本地`（`lib/constants.ts`、`lib/clock.ts` `demoNow()`）让本月/上月/今日窗口、消费分析与 system prompt 的「今天」保持一致。
- **🟢 GREEN 读取按设计不审计**（第 9 条）— 审计只覆盖门控动作（YELLOW/RED 的 confirm / verify / cancel）与安全事件；GREEN 自动执行的读取**不写审计行**（`audit/`、`lib/contracts/audit.ts`）。
- 同桶其余条目：第 2 条（固定验证码 MFA）、第 5 条（虚构投资产品）、第 10 条（mock 供应商）、第 11 条（`reserve_budget` 不锁资金）、第 12 条（定时任务不执行）、第 13 条（Test 12 只创建记录）。

### ⚠️ 【未验证】本仓库未证明

依赖特定运行环境，或属测试覆盖缺口——**未在本仓库证明**：

- **多进程 / 多实例集群竞态**未验证 — 上述【已实现】桶的原子性（含**日累计**与**取消**竞态）都建立在**单进程 + 单个本地 SQLite** 之上，**未经压测**（见第 7、15、18 条）。
- **唯一串行化手段是 SQLite 单文件写锁** — `security/security-gateway.ts#authorizeTransfer` 的「先 CAS 领取、后重估有效日累计」与 `agent/task-control.ts#cancelTask` 的原子结算，都在**单个 `prisma.$transaction`** 内完成，其**串行化仅由 SQLite 单文件写锁**提供；在**其他数据库引擎 / 多写入者 / 多实例部署**下**未经证明**（第 15、18 条）。
- **跨浏览器矩阵**未验证（第 16 条）— `tests/e2e/` 只跑系统 Chrome（Edge 兜底未测），亦不含生产构建（`next build` / `next start`）、live LLM、视觉 / a11y、负载 / 性能。
- **验证上限：仅单进程 + DB 事务语义（SQLite 文件锁的原子性）被实际运行过** —— **集群 / 多实例下的【日累计】与【取消】竞态未经压测**，不在本仓库的验证范围内。

---

| # | 限制 | 性质（桶） | 定位（代码 / 常量） |
|---|---|---|---|
| 1 | 仅使用**模拟**银行数据 | 🧪 模拟 | `prisma/`、`prisma/seed.ts` |
| 2 | MFA 是**模拟的固定验证码**（非真实 OTP 服务） | 🧪 模拟 | `lib/constants.ts` `MFA_CODE='123456'`、`security/mfa.ts` |
| 3 | **无真实支付 / 不连接任何银行核心系统** | 🧪 模拟 | `banking-sdk/` |
| 4 | 异常检测是 **Demo 级启发式规则** | ✅ 实现（启发式，非 ML） | `lib/constants.ts` `ANOMALY_AMOUNT_THRESHOLD=5000`、`banking-sdk/transaction.ts` |
| 5 | 投资产品是**虚构样例数据** | 🧪 模拟 | `prisma/seed.ts` |
| 6 | 消费分析**按设计排除异常行** | ✅ 实现（设计取舍） | `banking-sdk/transaction.ts` `analyzeSpending` |
| 7 | 熔断器是**进程内**（按会话，非分布式） | 🧪 模拟 · 刻意受限（单进程） | `security/circuit-breaker.ts` |
| 8 | 演示时钟被**固定**在 `DEMO_NOW` | 🧪 模拟 · 刻意受限（固定时钟） | `lib/constants.ts` `DEMO_NOW=2026-09-25 12:00 本地`、`lib/clock.ts` |
| 9 | 审计覆盖**门控动作 + 安全事件**（🟢 读取**不审计**） | 🧪 模拟 · 刻意受限（按设计不审计 🟢） | `audit/`、`lib/contracts/audit.ts` |
| 10 | live 模式下 LLM 输出**非确定性**（演示/测试用 mock 模式） | 🧪 模拟（mock 供应商） | `agent/providers/`、`LLM_MODE` |
| 11 | `reserve_budget` 只记录预算行，**不锁定 / 不移动资金** | 🧪 模拟 | `banking-sdk/budget.ts` |
| 12 | `create_scheduled_task` 只记录未来动作意图，**无在线调度器执行** | 🧪 模拟 | `banking-sdk/task.ts` |
| 13 | Test 12 生日提醒只创建记录，**不真正下单鲜花 / 蛋糕** | 🧪 模拟 | `tests/scenarios/`、`banking-sdk/budget.ts`、`banking-sdk/task.ts` |
| 14 | 注入守卫只记录事件，**不向模型注入"系统提醒"** | ✅ 实现（防御纵深） | `security/injection-guard.ts`、`agent/run-turn.ts` |
| 15 | 转账的**账本键派生 / 查找统一**（重复确认在 DB 层去重，已入账的 in-flight 只计一次） | ✅ 已实现（统一账本键） | `lib/ledger.ts`、`agent/confirmation.ts`、`security/risk-engine.ts` `computeInFlightTransferTotal`、`banking-sdk/transfer.ts` |
| 16 | 有**真实浏览器验收 harness**，但为**单机、有限 journey** 的验收（非多实例 / 非生产构建 / 非跨浏览器） | ⚠️ 未验证（有限验收，非全覆盖） | `tests/e2e/`、`package.json` |
| 17 | 身份是**普通 Cookie**（`banking_session`，非签名 / HMAC 令牌） | ✅ 实现（fail-closed） | `lib/constants.ts` `SESSION_COOKIE`、`app/api/_lib/session.ts`、`app/api/chat/route.ts` |
| 18 | 计划生命周期的诚实边界（DB 原子执行领取 / 原子取消 / 取消计划授权复核 / 节点幂等 / 无假回滚 / 终态仅靠 CAS 约定） | ✅ 已实现（DB 原子领取 + 原子取消 + 取消复核 + 节点幂等） | `agent/task-control.ts`、`agent/confirmation.ts`、`planner/lifecycle.ts`、`lib/db/repositories/{task,pendingAction}.ts`、`security/security-gateway.ts`、`prisma/schema.prisma` |
| 19 | 其他工程性注意（测试串行、`change_password` 无凭据存储） | ✅ 说明 | `vitest.config.ts`、`banking-sdk/` |

---

## 1. 仅使用模拟银行数据 · Mock Bank Data Only

**性质：🧪 模拟。**

**限制**：所有账户、交易、联系人、卡片、订阅、投资产品都在 SQLite 中模拟（`prisma/seed.ts`），
种子用户为**李明**（活期 ¥23,580、信用卡额度 ¥18,000、本月消费 ~¥5,800，含
Apple Store ¥6,999 @ 2026-09-20 18:32 的异常）。

**为何可接受**：比赛演示证明的是**智能体的规划 / 工具调用 / 安全门控 / 审计**能力，而非接入真实数据；
模拟数据让每一次演示都**可复现、可断言**，且完全不涉及客户隐私与真实资金。

---

## 2. MFA 是模拟的固定验证码 · Simulated Fixed-Code MFA

**性质：🧪 模拟。**

**限制**：强验证使用**固定的模拟码** `MFA_CODE = '123456'`（`security/mfa.ts`），
并非真实短信 / TOTP / 硬件令牌服务。`MFA_MAX_ATTEMPTS = 3`。

**为何可接受**：演示需要**确定性地**展示「RED 操作必须经过强验证」这一**代码强制**的安全语义——
固定码让测试与舞台演示都能稳定复现成功/失败/熔断三条路径。验证码**永不**返回给模型或 UI，
审计与消息字符串也绝不包含它，因此安全展示是真实的、只是验证的后端是模拟的。

---

## 3. 无真实支付 / 不连接银行核心系统 · No Real Payment / Core Banking

**性质：🧪 模拟。**

**限制**：`transfer_money` 只是写一条模拟 `Transaction` 借记行并调整账户余额；
系统**不连接任何真实银行核心系统、不发起任何真实支付**。

**为何可接受**：这既是安全沙箱的**硬约束**，也是演示的**核心承诺**——
「没有真实银行、没有真实资金、没有真实支付」。它让我们可以安全地演示高风险（🔴）资金操作的全流程。

---

## 4. 异常检测是 Demo 级启发式规则 · Heuristic Anomaly Detection

**性质：✅ 实现（启发式，非 ML）。**

**限制**：`detect_anomaly` 采用**规则式启发**（如大额阈值 `ANOMALY_AMOUNT_THRESHOLD = 5000`），
而非统计 / 机器学习模型。

**为何可接受**：演示需要**透明、可解释、可确定复现**的异常结果（如种子里的 Apple Store ¥6,999）。
启发式规则给出清晰、可断言的输出，满足「展示风控能力」的目标，同时避免引入不可控的模型行为。

---

## 5. 投资产品是虚构样例数据 · Fictional Investment Data

**性质：🧪 模拟。**

**限制**：投资产品（如「稳健理财A」）是**虚构的样例数据**，`subscribe_investment` / `redeem_investment`
只调整账户余额与持仓，不涉及任何真实金融产品（且**不写** `Transaction` 行，以保持本月消费锚点）。

**为何可接受**：演示需要展示 RED 级投资操作的门控（MFA）与审计，而非金融产品的真实收益；
虚构产品让流程完整、可断言，且**避免了任何投资建议的合规风险**。

---

## 6. 消费分析按设计排除异常行 · Spending Analysis Excludes Anomalies

**性质：✅ 实现（刻意设计取舍）。**

**限制**：`analyzeSpending` 的消费合计（`total` / `prevTotal` / `byCategory` / `topMerchant` /
`monthlyTrend` / `largest`）**只统计 `direction='DEBIT'` 且 `isAnomaly=false`** 的行。
因此种子里 Apple Store ¥6,999（`isAnomaly=true`）是**独立的九月行**，**不**并入「本月消费」。

**为何可接受**：这是**刻意的设计**——让「本月消费 ≈¥5,800」（娱乐 ¥2,680）与
「异常检测发现 Apple Store ¥6,999」成为**两个独立、清晰**的演示事实，互不干扰，
从而分别对应 Test 6 与 Test 7。种子锚点：本月 = ¥5,800、上月 = ¥6,230。

---

## 7. 熔断器是进程内（按会话） · In-Process, Per-Session Circuit Breaker

**性质：🧪 模拟 · 刻意受限（代码强制，仅进程内）。**

**限制**：`security/circuit-breaker.ts` 是**内存态、键控于 `sessionId`** 的熔断器——
不跨进程 / 不跨实例共享状态，也不持久化（**进程重启即重置**）。多实例部署下每个实例各有一份。

**为何可接受**：演示是**单进程**运行，会话级熔断足以展示「3 次连续 MFA 失败即锁死高风险操作」
这一核心安全语义。它**正是 LLM 无法清除的硬门**；分布式一致性不属于比赛演示的目标范围。

---

## 8. 演示时钟被固定 · Pinned Demo Clock

**性质：🧪 模拟 · 刻意受限（代码强制，固定演示时钟）。**

**限制**：演示把「当前时刻」固定为 `DEMO_NOW = 2026-09-25 12:00 本地`（`lib/constants.ts`），
`lib/clock.ts` 暴露 `demoNow()` 作为所有相对日期逻辑的默认值。

**为何可接受**：这让本月/上月/今日窗口、消费分析、日转账窗口、计划任务日期与 system prompt 的「今天」
**保持一致**，不受真实系统时钟影响——**舞台机器的日期永不破坏演示**。
测试则注入显式 `now` 以保持确定。它是一致性的**刻意选择**，而非对时间处理的欠缺。

---

## 9. 审计覆盖范围有限 · Audit Scope

**性质：🧪 模拟 · 刻意受限（代码强制，🟢 读取按设计不审计）。**

**限制**：审计只覆盖**被门控动作**（YELLOW/RED `PendingAction` 的 confirm / verify / cancel）
与**安全事件**（熔断、注入检测、MFA 失败等）；**🟢 GREEN 自动执行的读取不写审计行**。

**为何可接受**：低风险读取量大且无副作用，逐条审计会淹没信号；
只记录影响资金 / 权限的**门控决策**，让审计轨迹聚焦于真正需要问责的操作。
GREEN 路径可在 `beforeToolCall` 咽喉处被断言验证（见 `test-cases.md`）。

---

## 10. live 模式下 LLM 输出非确定性 · Non-Deterministic Live LLM

**性质：🧪 模拟（mock 供应商）；live 模式仅非确定性。**

**限制**：在 `LLM_MODE=live` 下，模型的自然语言输出是**非确定性**的；因此演示与测试默认使用
**mock 模式**（`registerFauxProvider()` 脚本化模型，`LLM_MODE=mock`）。

**为何可接受**：系统的**安全与正确性不依赖 LLM 文本**——层级、确认、MFA、资金移动全部由代码决定。
mock 模式让整条流水线（Agent + 工具 + 安全）**离线、确定、可断言**，正是自动化测试与稳定演示所需。
即便模型是脚本化的，真实的**工具、安全咽喉与数据库**仍在运行，因此这些测试证明的是真实安全行为。

---

## 11. `reserve_budget` 只记录预算，不涉及资金 · Budget Reservation Moves No Money

**性质：🧪 模拟。**

**限制**：🟢 `reserve_budget` 只在 `Budget` 表写入一条 `status = 'RESERVED'` 的行
（`banking-sdk/budget.ts`）——它**不锁定、不冻结、不移动任何资金**，账户余额不受影响。

**为何可接受**：演示里的"预算"是一个**计划意图的标记**，而非真实的资金锁定；它让 Test 12 能展示
"智能体理解生日场景 → 预留预算 + 定时提醒"的跨能力编排，而无需引入任何真实的资金托管语义。

---

## 12. 定时任务不会被真正执行 · Scheduled Tasks Are Not Executed

**性质：🧪 模拟。**

**限制**：🟡 `create_scheduled_task` 只向 `ScheduledTask` 表写入一条"未来动作"意图
（`banking-sdk/task.ts`）——**当前没有任何在线调度器 / 后台作业会在其 `runAt` 时间真正执行它**。

**为何可接受**：演示聚焦"把一句自然语言拆成受门控的任务"；任务**被正确登记、且需人工确认**即为
演示目标。真实的到期执行属于生产系统职责，不在竞赛范围。

---

## 13. Test 12 只创建记录，不真正下单 · Birthday Plan Only Records

**性质：🧪 模拟。**

**限制**：Test 12（"爱人 11 月 20 日生日，帮我准备 1000 元预算"）的产物是**数据库记录**：
一条 `RESERVED` 预算 + 一条及以上的 `ScheduledTask`（提醒）。它**不会真正下单鲜花 / 蛋糕**，
也不发起任何支付。

**为何可接受**：这正是沙箱边界的体现——"无真实支付"，同时完整演示了跨能力的规划与门控。

---

## 14. 注入守卫不向模型注入提醒 · Injection Guard Adds No Model Reminder

**性质：✅ 实现（防御纵深）。**

**限制**：`security/injection-guard.ts` 对可疑文本**只**写入 `INJECTION_ATTEMPT` `SecurityEvent`
（`agent/run-turn.ts` 另向 UI 发一条 `security_event{kind:'injection'}`）；它**不向模型上下文注入任何
"系统提醒"**，也**绝不**改变授权结论（defense-in-depth only）。

**为何可接受**：授权的唯一权威是网关的策略表；不向模型注入文本反而**缩小**了可被注入利用的表面。

---

## 15. 账本键派生 / 查找统一，残余限制是 SQLite 写锁串行化 · Unified Ledger Key; SQLite Write-Lock Caveat

**性质：✅ 已实现（统一账本键）。**

**限制**：账本键的**生成端与查找端已统一**到 `lib/ledger.ts`：`ledgerKeyForAction({id, taskId, nodeId})` 在 `taskId` 与
`nodeId` **同时存在**（trim 后均非空）时返回 `nodeExecutionKey(taskId, nodeId)` = `nxe:<taskId>:<nodeId>`，否则返回 action 自身 `id`；
`ledgerTxIdForAction(userId, action)` 在该键上派生 / 查找账本主键（`idempotentTransferTxId`，格式 `txidem_` + `sha256("<userId>\0<key>")` 前 32 hex）。
`agent/confirmation.ts` 用该键作为 SDK 的 `idempotencyKey` 下发给 `registry.executeDirect`——因此**重复 / 并发确认**
**重放同一账本行**而非二次扣款（去重由数据库主键完成，账本写入 → 终态之间的窗口**不再需要锁**）。
`security/risk-engine.ts` 的 `computeInFlightTransferTotal` 以 `ledgerTxIdForAction(userId, row)` **排除账本行已存在**的 in-flight action，
所以一条「**已入账但仍为 `confirmed`**」的计划转账在日累计中**只计一次**：其后一笔 ¥100 仍为 🟡、¥1000 仍为 🟡、¥1000.01 升 🔴；**真正尚未入账**的动作仍被计数。

**残余限制（未验证）**：用于抗「过期日累计」的**「先领取、后重估」**（`security/security-gateway.ts` 的 `authorizeTransfer`）
与**取消计划的原子结算**（`agent/task-control.ts` 的 `cancelTask`）都在**单个 `prisma.$transaction`** 内完成，其**串行化仅由
SQLite 单文件写锁**提供；在**其他数据库引擎 / 多写入者 / 多实例部署**下**未经证明**。

**为何可接受**：演示是**单进程 + 单个本地 SQLite**，写锁串行化天然成立，演示所需的保证（两个并发确认
不会各自基于同一份过期日累计同时通过）**已经满足**；幂等键已接线，重复确认在 DB 层去重。
跨引擎一致性与分布式幂等属生产级职责，不在竞赛演示范围内。

---

## 16. 真实浏览器验收是「单机、有限 journey」 · Limited Single-Machine Browser Acceptance

**性质：⚠️ 未验证（有限验收，非全覆盖）。**

**限制**：仓库**已有**真实浏览器端到端 harness（`tests/e2e/`）：它用 `playwright-core` 启动**系统**无头
浏览器（Chrome 优先 / Edge 兜底，无需下载浏览器），启动**真实** `next dev`，在真实 `/agent` 输入框
输入中文，并对**渲染后的 DOM**（卡片 / 按钮 / 徽章 / 文本）断言其覆盖的 5 条 journey。它**只**覆盖：
🟡 转账确认、🔴 转账 MFA（成功 + 错误码）、计划暂停/继续、计划取消、刷新后恢复停靠决策；仅模型被
脚本化（`LLM_MODE=mock`）。它**不**覆盖：live LLM、真实银行 / 网络、生产构建（`next build` /
`next start`）、跨浏览器（仅 Chrome，Edge 兜底未测）、视觉 / a11y、负载 / 性能。它是**单机**验收，**不**证明安全模型已被完全封闭。

**默认命令与自举**：默认命令 `npx tsx tests/e2e/acceptance.e2e.ts` 会**自举 Prisma client**——仅当 `node_modules/.prisma/client/schema.prisma` 缺失时才执行一次 `prisma generate`——因此**干净检出**下**无需** `E2E_SKIP_DB_RESET` 即可运行；它使用**隔离**的 `prisma/e2e.db`，**绝不**触碰 `prisma/dev.db`。
**GREEN 测试全绿 ≠ 安全闭环**：仅靠 🟢 读取路径的测试**不**构成对安全模型的证明——闭环只能来自对失败路径（🟡/🔴 门控、确认 / 验证、取消、熔断、注入）的**显式**验证。

`tests/app/` 下的验收仍独立：它们是**进程内 HTTP 集成测试**（`describe('[integration] …')`），
`import` 并调用**真实的**路由处理器（`app/api/**/route.ts`），传入真实的 `NextRequest`
（`tests/app/harness.ts`）——真实数据库 / 安全网关 / Agent 流水线**全部在跑**，只有模型被脚本化；
但**没有浏览器、没有渲染**，UI 行为只能被**间接**断言（事件 / 卡片 / 响应体的形状）。

**为何可接受**：安全相关的行为位于 UI **之下**——路由处理器 + 安全网关 + Banking SDK——
而这些**确实被真实执行**；浏览器层验收的作用是证明渲染后的交互链路可用，而非封闭安全模型。
演示的验收点是门控、审计、流水线行为（外加若干真实浏览器 journey），而非像素级 UI 或跨浏览器一致性。

---

## 17. 身份是 Cookie，而非签名令牌 · Plain-Cookie Identity

**性质：✅ 实现（fail-closed）。**

**限制**：`banking_session` 是一个**不透明的会话 id cookie**（`HttpOnly; SameSite=Lax`，
由 `POST /api/chat` 下发 —— `app/api/chat/route.ts`；读取与解析见 `app/api/_lib/session.ts`），
它被解析成一条持久化的 `AgentSession` 行——它**不是**签名 / HMAC 令牌。其完整性依赖
「该会话确实存在于数据库中」这一事实。

**为何可接受**：演示范围内的身份语义即「服务端持久化状态」；任何被出示的 id 仍必须
**匹配一条已持久化的会话**且**匹配资源属主**（否则 403 `SECURITY_DENIED`），
因此未知 / 伪造的 id **失败关闭（fail-closed）**。签名令牌与密钥轮换属于生产身份系统职责。

---

## 18. 计划生命周期的诚实边界 · Plan-Lifecycle Honesty Caveats

**性质：✅ 已实现（代码强制：DB 原子执行领取 + 原子取消 + 取消计划授权复核 + 节点幂等）。**

**限制**：

- **DB 原子执行领取**：一个*运行中*的计划由一条 DB 执行领取把守——`claimTaskExecution` 在 `executor.runPlan` **之前**以**单条 `updateMany` CAS** 领取 `AgentTask.executionToken`，并在 **`finally`** 中 `releaseTaskExecution` 释放；节点级同理（`lib/db/repositories/task.ts#claimNodeExecution` / `#releaseNodeExecution`）。因此两个并发 resume / retry **无法同时运行同一计划**——败者因 `executionToken IS NULL` 不再匹配而领取 0 行落败。
- **原子取消计划**：`agent/task-control.ts#cancelTask` 最终在**一个 `prisma.$transaction`** 内**同时**执行 `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'])`（`lib/db/repositories/pendingAction.ts`，**单条原子 `updateMany`**，一次性把该计划**全部**可执行 `PendingAction` 置为 `cancelled`）与计划行 `status='cancelled'` 写入——撤销与取消之间**没有窗口**；节点输出扫描（`revokeParkedActions`）与运行后 `sweepCancelledPlan` 只是**兜底**。此后任何 confirm / verify 均以 `CONFLICT` / `NOT_FOUND` 失败，**已入账的交易保留**（不伪造回滚）。
- **取消计划的授权复核**：`security/security-gateway.ts` 在 compare-and-set 的**同一个 `$transaction`** 内按 `PendingAction.taskId` 重读所属计划状态——计划已 `cancelled` ⇒ **在事务内反转领取**并返回 `{kind:'plan_cancelled'}`（HTTP 200 `{ok:false, status:'cancelled', code:'SECURITY_DENIED'}`）；`gatewayCreatePendingAction` 拒绝在已取消计划下新建 action；`recordActionResult` 绝不把已取消计划下的 action 标为 `executed`。
- **节点身份去重**：`nodeExecutionKey(taskId, nodeId)` = `nxe:<taskId>:<nodeId>`（`lib/ledger.ts`）为节点副作用去重——`subscribeInvestment` 把它写入 `InvestmentHolding.idempotencyKey`（唯一）并在**一个 DB 事务**内以共享的 P2002 处理重放，`redeemInvestment` 以 `REDEEMED` 状态翻转作为重放标记，`applyVirtualCard` 以确定性 card id 幂等；`agent/confirmation.ts#executeGatedToolOnce` 以 `findInFlightPlanActionId(taskId, nodeId)` 返回已停靠结果而非铸造第二个 action；不同计划的相同工具 / 参数因 `taskId` 不同而**不碰撞**。
- **不伪造回滚**：已完成（`success`）的节点**保留其结果**——已执行的副作用在模拟后端下不可逆，**绝不假装被回滚**。
- **取消 vs 确认 = 至多一次**：二者共享同一 `PendingAction` 的 **CAS**（`claimPendingAction`），因此最多一方成功。
- **终态仅由 CAS 约定保证**：`prisma/schema.prisma` 的 `status` 列是**普通字符串、无 CHECK / 唯一约束**——「已取消的计划不能离开终态」只由 `claimTaskStatus` / `claimPendingAction` 的 CAS 约定保证，**没有数据库 / 模式层约束**。

**为何可接受**：演示为**单进程**，DB 原子领取 + 原子取消（撤销与取消同一事务）+ 取消计划授权复核 + 节点幂等足以保证「至多一次」「取消后不可复活」「无假回滚」等在舞台上可断言的语义。**但单进程 ≠ 多实例**：终态保护仅靠 CAS 约定（`status` 列无 CHECK / 唯一约束），**多写入者 / 多实例**下的日累计与取消竞态属【未验证】桶——若迁移到多实例，需把终态保护下沉到数据库约束或跨实例事务边界。

---

## 19. 其他工程性注意 · Engineering Notes

**性质：✅ 说明。**

- **测试文件串行运行**：所有测试共用一个 `prisma/test.db`，`vitest.config.ts` 已设置
  `fileParallelism: false`，因此测试**文件串行**运行（同一文件内的查询仍可并行），无需额外参数。
- **`change_password` 无真实凭据存储**：演示 `User` 不存凭据，该工具返回模拟成功视图，
  **`AuditLog` 行即变更的权威记录**——它的存在是为演示 RED 门控 + MFA + 审计。

> 相关文档：[`architecture.md`](./architecture.md)、[`security.md`](./security.md)、[`test-cases.md`](./test-cases.md)。
