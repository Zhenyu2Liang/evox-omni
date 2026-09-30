# 已知风险与限制 · Known Risks & Limitations

> 本文件诚实地列出演示的局限，并对每条给出「**为何在比赛演示中可接受**」。
> 这些限制大多是**演示沙箱的刻意设计**，而非缺陷——它们让系统在无真实资金、无真实银行的前提下，
> 完整展示「智能体 + 代码强制安全模型」的核心价值。

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

## 11. 其他工程性注意 · Engineering Notes

- **规划器就绪态判定**：`planner/dag.ts` 的 `getReadyNodes` 目前把 `failed`/`cancelled` 依赖当作终态，
  会错误解锁其依赖节点（应为仅在 `success`/`skip` 上就绪）。对应用例暂时为 RED，修复归属 `planner/`。
- **测试需串行运行**：所有测试共用一个 `prisma/test.db`，并行会因 Prisma socket 竞争而不稳；
  请用 `npx vitest run --no-file-parallelism`。
- **`change_password` 无真实凭据存储**：演示 `User` 不存凭据，该工具返回模拟成功视图，
  **`AuditLog` 行即变更的权威记录**——它的存在是为演示 RED 门控 + MFA + 审计。

> 相关文档：[`architecture.md`](./architecture.md)、[`security.md`](./security.md)、[`test-cases.md`](./test-cases.md)。
