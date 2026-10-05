# 已知风险与限制 · Known Risks & Limitations

> 本文件诚实地列出演示的局限，并对每条给出「**为何在比赛演示中可接受**」。
> 这些限制大多是**演示沙箱的刻意设计**，而非缺陷——它们让系统在无真实资金、无真实银行的前提下，
> 完整展示「智能体 + 代码强制安全模型」的核心价值。没有一条声称系统「100% 完成」，
> 也没有任何一条声称经过真实浏览器验证。

---

| # | 限制 | 定位（代码 / 常量） |
|---|---|---|
| 1 | 仅使用**模拟**银行数据 | `prisma/`、`prisma/seed.ts` |
| 2 | MFA 是**模拟的固定验证码**（非真实 OTP 服务） | `lib/constants.ts` `MFA_CODE='123456'`、`security/mfa.ts` |
| 3 | **无真实支付 / 不连接任何银行核心系统** | `banking-sdk/` |
| 4 | 异常检测是 **Demo 级启发式规则** | `lib/constants.ts` `ANOMALY_AMOUNT_THRESHOLD=5000`、`banking-sdk/transaction.ts` |
| 5 | 投资产品是**虚构样例数据** | `prisma/seed.ts` |
| 6 | 消费分析**按设计排除异常行** | `banking-sdk/transaction.ts` `analyzeSpending` |
| 7 | 熔断器是**进程内**（按会话，非分布式） | `security/circuit-breaker.ts` |
| 8 | 演示时钟被**固定**在 `DEMO_NOW` | `lib/constants.ts` `DEMO_NOW=2026-09-25 12:00 本地`、`lib/clock.ts` |
| 9 | 审计覆盖**门控动作 + 安全事件**（🟢 读取**不审计**） | `audit/`、`lib/contracts/audit.ts` |
| 10 | live 模式下 LLM 输出**非确定性**（演示/测试用 mock 模式） | `agent/providers/`、`LLM_MODE` |
| 11 | `reserve_budget` 只记录预算行，**不锁定 / 不移动资金** | `banking-sdk/budget.ts` |
| 12 | `create_scheduled_task` 只记录未来动作意图，**无在线调度器执行** | `banking-sdk/task.ts` |
| 13 | Test 12 生日提醒只创建记录，**不真正下单鲜花 / 蛋糕** | `tests/scenarios/`、`banking-sdk/budget.ts`、`banking-sdk/task.ts` |
| 14 | 注入守卫只记录事件，**不向模型注入"系统提醒"** | `security/injection-guard.ts`、`agent/run-turn.ts` |
| 15 | 转账确认的原子领取**依赖 SQLite 写锁串行化**（非跨数据库引擎 / 多写入者已证明） | `security/security-gateway.ts` `authorizeTransfer`、`banking-sdk/transfer.ts` |
| 16 | **无真实浏览器端到端测试**（无 Playwright / Puppeteer / Cypress / Selenium） | `package.json`、`tests/app/` |
| 17 | 身份是**普通 Cookie**（`banking_session`，非签名 / HMAC 令牌） | `lib/constants.ts` `SESSION_COOKIE`、`app/api/_lib/session.ts`、`app/api/chat/route.ts` |

---

## 1. 仅使用模拟银行数据 · Mock Bank Data Only

**限制**：所有账户、交易、联系人、卡片、订阅、投资产品都在 SQLite 中模拟（`prisma/seed.ts`），
种子用户为**李明**（活期 ¥23,580、信用卡额度 ¥18,000、本月消费 ~¥5,800，含
Apple Store ¥6,999 @ 2026-09-20 18:32 的异常）。

**为何可接受**：比赛演示的目标是证明**智能体的规划 / 工具调用 / 安全门控 / 审计**能力，
而非接入真实数据；模拟数据让每一次演示都**可复现、可断言**，且完全不涉及客户隐私与真实资金。

---

## 2. MFA 是模拟的固定验证码 · Simulated Fixed-Code MFA

**限制**：强验证使用的是**固定的模拟码** `MFA_CODE = '123456'`（`security/mfa.ts`），
并非真实短信 / TOTP / 硬件令牌服务。`MFA_MAX_ATTEMPTS = 3`。

**为何可接受**：演示需要**确定性地**展示「RED 操作必须经过强验证」这一**代码强制**的安全语义——
固定码让测试与舞台演示都能稳定复现成功/失败/熔断三条路径。验证码**永不**返回给模型或 UI，
审计与消息字符串也绝不包含它，因此安全展示是真实的、只是验证的后端是模拟的。

---

## 3. 无真实支付 / 不连接银行核心系统 · No Real Payment / Core Banking

**限制**：`transfer_money` 只是写一条模拟 `Transaction` 借记行并调整账户余额；
系统**不连接任何真实银行核心系统、不发起任何真实支付**。

**为何可接受**：这既是安全沙箱的**硬约束**，也是演示的**核心承诺**——
「没有真实银行、没有真实资金、没有真实支付」。它让我们可以安全地演示高风险（🔴）资金操作的全流程。

---

## 4. 异常检测是 Demo 级启发式规则 · Heuristic Anomaly Detection

**限制**：`detect_anomaly` 采用**规则式启发**（如大额阈值 `ANOMALY_AMOUNT_THRESHOLD = 5000`），
而非统计 / 机器学习模型。

**为何可接受**：演示需要**透明、可解释、可确定复现**的异常结果（如种子里的 Apple Store ¥6,999）。
启发式规则给出清晰、可断言的输出，满足「展示风控能力」的目标，同时避免引入不可控的模型行为。

---

## 5. 投资产品是虚构样例数据 · Fictional Investment Data

**限制**：投资产品（如「稳健理财A」）是**虚构的样例数据**，`subscribe_investment` / `redeem_investment`
只调整账户余额与持仓，不涉及任何真实金融产品（且**不写** `Transaction` 行，以保持本月消费锚点）。

**为何可接受**：演示需要展示 RED 级投资操作的门控（MFA）与审计，而非金融产品的真实收益；
虚构产品让流程完整、可断言，且**避免了任何投资建议的合规风险**。

---

## 6. 消费分析按设计排除异常行 · Spending Analysis Excludes Anomalies

**限制**：`analyzeSpending` 的消费合计（`total` / `prevTotal` / `byCategory` / `topMerchant` /
`monthlyTrend` / `largest`）**只统计 `direction='DEBIT'` 且 `isAnomaly=false`** 的行。
因此种子里 Apple Store ¥6,999（`isAnomaly=true`）是**独立的九月行**，**不**并入「本月消费」。

**为何可接受**：这是**刻意的设计**——让「本月消费 ≈¥5,800」（娱乐 ¥2,680）与
「异常检测发现 Apple Store ¥6,999」成为**两个独立、清晰**的演示事实，互不干扰，
从而分别对应 Test 6 与 Test 7。种子锚点：本月 = ¥5,800、上月 = ¥6,230。

---

## 7. 熔断器是进程内（按会话） · In-Process, Per-Session Circuit Breaker

**限制**：`security/circuit-breaker.ts` 是**内存态、键控于 `sessionId`** 的熔断器——
不跨进程 / 不跨实例共享状态，也不持久化。多实例部署下每个实例各有一份。

**为何可接受**：演示是**单进程**运行，会话级熔断足以展示「3 次连续 MFA 失败即锁死高风险操作」
这一核心安全语义。它**正是 LLM 无法清除的硬门**；分布式一致性不属于比赛演示的目标范围。

---

## 8. 演示时钟被固定 · Pinned Demo Clock

**限制**：演示把「当前时刻」固定为 `DEMO_NOW = 2026-09-25 12:00 本地`（`lib/constants.ts`），
`lib/clock.ts` 暴露 `demoNow()` 作为所有相对日期逻辑的默认值。

**为何可接受**：这让本月/上月/今日窗口、消费分析、日转账窗口、计划任务日期与 system prompt 的「今天」
**保持一致**，不受真实系统时钟影响——**舞台机器的日期永不破坏演示**。
测试则注入显式 `now` 以保持确定。它是一致性的**刻意选择**，而非对时间处理的欠缺。

---

## 9. 审计覆盖范围有限 · Audit Scope

**限制**：审计只覆盖**被门控动作**（YELLOW/RED `PendingAction` 的 confirm / verify / cancel）
与**安全事件**（熔断、注入检测、MFA 失败等）；**🟢 GREEN 自动执行的读取不写审计行**。

**为何可接受**：这是**刻意的取舍**——低风险读取量大且无副作用，逐条审计会淹没信号；
只记录影响资金/权限的**门控决策**，让审计轨迹聚焦于真正需要问责的操作。
GREEN 路径可在 `beforeToolCall` 咽喉处被断言验证（见 `test-cases.md`）。

---

## 10. live 模式下 LLM 输出非确定性 · Non-Deterministic Live LLM

**限制**：在 `LLM_MODE=live` 下，模型的自然语言输出是**非确定性**的；因此演示与测试默认使用
**mock 模式**（`registerFauxProvider()` 脚本化模型，`LLM_MODE=mock`）。

**为何可接受**：系统的**安全与正确性不依赖 LLM 文本**——层级、确认、MFA、资金移动全部由代码决定。
mock 模式让整条流水线（Agent + 工具 + 安全）**离线、确定、可断言**，正是自动化测试与稳定演示所需。
即便模型是脚本化的，真实的**工具、安全咽喉与数据库**仍在运行，因此这些测试证明的是真实安全行为。

---

## 11. `reserve_budget` 只记录预算，不涉及资金 · Budget Reservation Moves No Money

**限制**：🟢 `reserve_budget` 只在 `Budget` 表写入一条 `status = 'RESERVED'` 的行
（`banking-sdk/budget.ts`）——它**不锁定、不冻结、不移动任何资金**，账户余额不受影响。

**为何可接受**：演示里的"预算"是一个**计划意图的标记**，而非真实的资金锁定；它让 Test 12 能展示
"智能体理解生日场景 → 预留预算 + 定时提醒"的跨能力编排，而无需引入任何真实的资金托管语义。

---

## 12. 定时任务不会被真正执行 · Scheduled Tasks Are Not Executed

**限制**：🟡 `create_scheduled_task` 只向 `ScheduledTask` 表写入一条"未来动作"意图
（`banking-sdk/task.ts`）——**当前没有任何在线调度器 / 后台作业会在其 `runAt` 时间真正执行它**。

**为何可接受**：演示聚焦"把一句自然语言拆成受门控的任务"；任务**被正确登记、且需人工确认**即为
演示目标。真实的到期执行属于生产系统职责，不在竞赛范围。

---

## 13. Test 12 只创建记录，不真正下单 · Birthday Plan Only Records

**限制**：Test 12（"爱人 11 月 20 日生日，帮我准备 1000 元预算"）的产物是**数据库记录**：
一条 `RESERVED` 预算 + 一条及以上的 `ScheduledTask`（提醒）。它**不会真正下单鲜花 / 蛋糕**，
也不发起任何支付。

**为何可接受**：这正是沙箱边界的体现——"无真实支付"，同时完整演示了跨能力的规划与门控。

---

## 14. 注入守卫不向模型注入提醒 · Injection Guard Adds No Model Reminder

**限制**：`security/injection-guard.ts` 对可疑文本**只**写入 `INJECTION_ATTEMPT` `SecurityEvent`
（`agent/run-turn.ts` 另向 UI 发一条 `security_event{kind:'injection'}`）；它**不向模型上下文注入任何
"系统提醒"**，也**绝不**改变授权结论（defense-in-depth only）。

**为何可接受**：授权的唯一权威是网关的策略表；不向模型注入文本反而**缩小**了可被注入利用的表面。

---

## 15. SQLite 写锁串行化依赖 · SQLite Write-Lock Serialization Caveat

**限制**：YELLOW 转账的确认走**「先领取、后重估」**的单个 `prisma.$transaction`
（`security/security-gateway.ts` 的 `authorizeTransfer`）：事务的**第一条语句即 exactly-once 的
CAS 领取**（一个**写**操作 ⇒ 取得 SQLite 的**文件写锁**），随后才在**同一事务内**读取有效日累计
并重跑动态风控规则。因此「两个并发确认（不同 `actionId`）不会各自基于同一份过期日累计同时通过」
这一保证是 **SQLite 特有的**——它依赖单文件写锁的串行化，在**其他数据库引擎 / 多写入者部署**下
**未经证明**。

此外，转账确认路径**未携带幂等键**（`agent/confirmation.ts` 直接以
`registry.executeDirect(action.toolName, action.args)` 执行被网关验证过的原始参数，
未传 `idempotencyKey`），因此在**授权（领取）与 SDK 账本写入（`banking-sdk/transfer.ts`）之间
存在崩溃窗口**：若进程恰在该窗口内崩溃，可能留下一条状态为 `confirmed` 的 `PendingAction`
而**没有对应的账本行**。

**为何可接受**：演示是**单进程 + 单个本地 SQLite** 运行，写锁串行化天然成立，
演示所需的保证（两个并发确认不会同时基于过期日累计通过）**已经满足**。幂等键与崩溃恢复
属于生产级分布式职责，不在竞赛演示范围内。

---

## 16. 无真实浏览器端到端测试 · No Real-Browser E2E

**限制**：仓库中**没有** Playwright / Puppeteer / Cypress / Selenium（见 `package.json`），
也没有任何启动浏览器、渲染页面的端到端测试。`tests/app/` 里的规格是**进程内集成测试**：
它们直接 import 并调用**真实的**路由处理器（`app/api/**/route.ts`），并传入真实的 `NextRequest`
（`tests/app/harness.ts`）——真实数据库 / 安全网关 / Agent 流水线**全部在跑**，但**没有浏览器、
没有渲染**。UI 行为只能被**间接**断言（事件 / 卡片 / 响应体的形状），而非通过渲染后的页面。

**为何可接受**：安全相关的行为位于 UI **之下**——路由处理器 + 安全网关 + Banking SDK——
而这些**确实被真实执行**；被代码强制的安全语义不在浏览器渲染层。演示的验收点是门控、审计与
流水线行为，而非像素级 UI。

---

## 17. 身份是 Cookie，而非签名令牌 · Plain-Cookie Identity

**限制**：`banking_session` 是一个**不透明的会话 id cookie**（`HttpOnly; SameSite=Lax`，
由 `POST /api/chat` 下发 —— `app/api/chat/route.ts`；读取与解析见 `app/api/_lib/session.ts`），
它被解析成一条持久化的 `AgentSession` 行——它**不是**签名 / HMAC 令牌。其完整性依赖
「该会话确实存在于数据库中」这一事实。

**为何可接受**：演示范围内的身份语义即「服务端持久化状态」；任何被出示的 id 仍必须
**匹配一条已持久化的会话**且**匹配资源属主**（否则 403 `SECURITY_DENIED`），
因此未知 / 伪造的 id **失败关闭（fail-closed）**。签名令牌与密钥轮换属于生产身份系统职责。

---

## 18. 其他工程性注意 · Engineering Notes

- **测试文件串行运行**：所有测试共用一个 `prisma/test.db`，`vitest.config.ts` 已设置
  `fileParallelism: false`，因此测试**文件串行**运行（同一文件内的查询仍可并行），无需额外参数。
- **`change_password` 无真实凭据存储**：演示 `User` 不存凭据，该工具返回模拟成功视图，
  **`AuditLog` 行即变更的权威记录**——它的存在是为演示 RED 门控 + MFA + 审计。

> 相关文档：[`architecture.md`](./architecture.md)、[`security.md`](./security.md)、[`test-cases.md`](./test-cases.md)。
