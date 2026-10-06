# 架构文档 · AI Banking Agent Architecture

> 一个**比赛演示（competition demo）**级的 *AI 银行智能体*：用户用自然语言描述一个金融需求，
> 智能体理解意图、规划任务、调用**银行工具**，并在一个**由代码强制、模型不可篡改**的权限与
> 安全模型下完成操作。核心不变式：
>
> **智能体可以决定「下一步做什么（what to do next）」；智能体永远不能决定「它是否有权限去做（whether it is allowed）」。**
> 权限由 TypeScript 代码判定，绝不来自 LLM。

---

## 1. 概述 Overview

系统实现了一个完整的智能体循环：

**理解 → 规划 → 执行 → 风控 → 验证 → 审计**
(understand → plan → execute → risk-control → verify → audit)

它**不是**一个套在银行 App 外层的聊天皮肤，而是一个具备**自主规划、工具调用、安全网关、
任务编排与审计**能力的智能体。范围被严格限制在演示沙箱内：**没有真实银行、没有真实资金、
没有真实支付、没有 shell、模型也不能进行任意代码 / SQL / 文件访问**；所有银行数据都在
SQLite 中模拟。

---

## 2. 分层流水线 · Layered Pipeline

请求自顶向下穿过各层，越往下越接近数据，越往上越接近用户：

```mermaid
flowchart TD
    U["用户 User<br/>自然语言金融需求"] --> W["Next.js Web App<br/>React + Tailwind + Recharts"]
    W --> A["Pi Agent<br/>@mariozechner/pi-agent-core + pi-ai<br/>意图理解 · 规划 · 工具调用"]
    A --> P["Agent Planner (planner/)<br/>DAG 规划与执行"]
    P --> T["Custom Banking Tools (agent/tools)<br/>已注册 · TypeBox 参数校验"]
    T --> G["Security Gateway (security/security-gateway.ts)<br/>beforeToolCall ← 安全咽喉"]
    G --> S["Banking SDK (banking-sdk/)<br/>execute-only 业务能力"]
    S --> DB["Prisma → SQLite<br/>模拟银行数据"]
    G -. 审计 / 安全事件 .-> AU["Audit (audit/)"]
    S -. 审计 .-> AU
```

**各层职责（自顶向下）**

| 层 | 位置 | 职责 | 不做什么 |
|---|---|---|---|
| Web App | `app/`, `components/` | 页面、SSE 聊天、卡片、确认/验证按钮；只做「渲染 + 路由」 | 不含业务逻辑、不直接访问 Prisma |
| Pi Agent | `agent/` | Agent **运行时 + 规划器 + 工具调用器**；意图理解、上下文、自然语言回复 | 不判定权限、不移动资金 |
| Agent Planner | `planner/` | 纯 DAG 逻辑：校验 → 拓扑排序 → 执行 → 条件求值 → 状态流 | 不含银行/安全/DB 行为（副作用全部注入） |
| Banking Tools | `agent/tools/` | 智能体**唯一**的能力面：26 个已注册工具，参数为 TypeBox schema | 不判定权限 |
| Security Gateway | `security/` | 对每个工具调用给出 🟢/🟡/🔴 + 确认 / MFA / 熔断 | **不执行业务操作**（只授权） |
| Banking SDK | `banking-sdk/` | 唯一把银行意图变成 Prisma 写入的层；执行领域校验 | 不做权限 / 确认 / MFA / 限额判定 |
| Persistence | `prisma/`, `lib/db/` | Prisma + SQLite 模拟数据，仓储层 `lib/db/repositories/*` | — |

依赖方向严格单向向下：`lib` ← `banking-sdk` ← `agent`/`planner`/`audit`；`security` 依赖 `lib`
（+ 注入端口）；`app`/`components` 依赖下面的一切。**无跨模块循环依赖。**

**Next.js 表面（HTTP 路由处理器 + 页面）**

- **API 路由处理器**（`app/api/**/route.ts`，共 15 个）：`/api/actions`、`/api/actions/[id]/confirm`、
  `/api/actions/[id]/verify`、`/api/actions/[id]/cancel`、`/api/audit`、`/api/bills`、`/api/cards`、
  `/api/chat`、`/api/dashboard`、`/api/health`、`/api/security`、`/api/security/reset`、
  `/api/subscriptions`、`/api/tasks`、`/api/tasks/[id]`。
- **页面**（`app/**/page.tsx`，共 7 个）：`/`（dashboard）、`/agent`、`/audit`、`/bills`、`/cards`、
  `/security`、`/subscriptions`；另有 Next 生成的 `/_not-found`。

> **构建前置（Build prerequisite）**：`next build`（Next ^15.1.6）会**静态预渲染**依赖数据库的页面
> （`/`、`/cards`、`/subscriptions` 在模块作用域导入 `@/banking-sdk`），因此必须在构建**之前**先推送并
> 填充数据库：`npx prisma generate && npx prisma db push && npm run db:seed`，然后 `npm run build`。
> 按请求动态渲染的页面是 agent / audit / security / bills；`app/api/**` 处理器全部为动态。

> **UI 组件 barrel 中立性（SSR）**：barrel 层**不得**带 `'use client'`；一个带该指令的**中间层** barrel
> 若经中立的 `components/index.ts` 门面星号再导出，SSR 时会解析为 `undefined` 并让消费页崩溃——
> 只有**叶子**客户端组件带该指令。

---

## 3. 空间维度 · Context Tree 目录布局

仓库本身是一棵 **Context Tree**：每个目录都有一份 `CONTEXT.md`，既是文档（Intent / API Surface /
Constraints），也是**路由表**（把领域映射到子目录）。顶层节点职责：

| 节点 | 职责 |
|---|---|
| `./app` | Next.js App Router：页面（dashboard / agent chat / bills / cards / subscriptions / security / audit）+ API 路由处理器（chat SSE、actions confirm\|verify\|cancel、tasks 控制、audit、security、read models） |
| `./components` | React UI：聊天卡片、图表、银行瓦片、UI 原语 |
| `./agent` | Pi Agent 运行时：agent 装配、system prompt、会话存储、工具注册、LLM provider（live + faux）、确认续跑 |
| `./planner` | DAG 任务规划器 + 执行器（`submit_plan` 的后端） |
| `./banking-sdk` | 银行能力（account / transaction / transfer / card / subscription / investment / task / budget），execute-only，基于 Prisma |
| `./security` | 安全网关 + 权限引擎、风险引擎、MFA、熔断器、注入守卫（安全咽喉） |
| `./audit` | 审计日志器 + 安全事件记录器 |
| `./lib` | 共享内核：contracts、errors、money、config、constants、clock、Prisma client + repositories |
| `./prisma` | Prisma schema + 种子数据（无 `migrations/` 目录；schema 由 `prisma db push` 推送） |
| `./tests` | 自动化测试（四层）：纯单元测试（security/planner/sdk/agent/lib）+ `tests/scenarios/` 的 faux-LLM 全流水线场景测试（Tests 1–12）+ `tests/app/*` 与 `tests/review-boundaries.test.ts` 的进程内 HTTP 路由处理器 `[integration]` 测试 + `tests/e2e/` 的**真实浏览器验收 harness**（`playwright-core` 启动系统 Chrome，`tsx` 显式运行，非 Vitest） |
| `./docs` | 本目录：参赛文档（architecture / security / test-cases / known-risks） |

---

## 4. 时间维度 · Git DAG（版本即状态）

代码通过一棵**不可变提交的 Git DAG**演进。一个智能体的状态是
`(node_path, base_commit, current_commit, objective)` 四元组；**部分进展也被接受**——
只要一个版本让代码库变得更好（哪怕仍有部分损坏）即算数。智能体是**瞬态**的：没有持久记忆，
所有持久记忆要么存在 Context Tree 的 `CONTEXT.md`，要么存在 Git 历史（Git 就是变更日志）。
子智能体从父节点提交的 SHA 分支，拥有独立隔离的 worktree，因此**并行智能体互不冲突**。

---

## 5. 深入 · Pi Agent（运行时 + 规划器 + 工具调用器）

Pi Agent 严格地被当作 **Agent Runtime + Planner + Tool Caller** 使用，它是本仓库中**唯一**
与 `@mariozechner/pi-agent-core` / `@mariozechner/pi-ai` 对话的节点（`agent/`）。

- 用**仅注册的银行工具**构造 Agent——**没有** bash / shell / write / edit / file / SQL 工具被注册，
  因此一段要求「给我一个 shell/SQL 工具」的注入攻击**根本没有工具可调**。
- 关键 SDK 事实（对照 pi-agent-core 0.73.1 验证）：
  - `new Agent({ initialState, beforeToolCall, afterToolCall, convertToLlm, transformContext, sessionId, ... })`
  - `AgentTool<TParams>` = `{ name, description, parameters (TypeBox), label, execute(...) }`；
    `execute` 成功返回 `AgentToolResult<T>`，失败时**抛出异常**。
  - `agent.prompt(input)` / `agent.continue()` 在 run 结束时返回；`agent.subscribe(listener)` 流式推送 `AgentEvent`。
  - **`beforeToolCall` 是安全咽喉。** 返回 `{ block: true, reason }` 会阻止执行，并向模型发出一个
    错误工具结果。🟢/🟡/🔴 正是**在代码里**这样被强制的：模型**字面上无法**执行一个被门控的工具。
  - `AgentState`（`systemPrompt` / `model` / `tools` / `messages`）可 JSON 序列化 → 按会话持久化。
  - `registerFauxProvider()`（来自 pi-ai）提供脚本化的内存模型，用于**离线/模拟 LLM 模式**与全部智能体测试：
    同一套 Agent / 工具 / 安全流水线，只有模型被脚本化。

**不变式**：模型提出「下一步做什么」，但每个工具调用都要穿过 `beforeToolCall →
securityGateway.handleToolCall`；被门控的工具会被阻断、其参数被持久化为 `PendingAction`，
**资金只有在人工确认之后才会移动**。模型的文本永远无法触发一次执行。

真实集成类型（`agent/`）包括：`BankingAgentRuntime`、`SessionSnapshot`、`ToolRegistry`、
`ToolExecutionResult`、`runTurn` / `resumeTurn`、`confirmAction` / `verifyAction` / `cancelAction`、
`resolveModel`（live/mock 选择）等。

---

## 6. 深入 · Banking SDK（execute-only 业务能力）

`banking-sdk/` 是**唯一把银行意图变成 Prisma 写入**的层。每个模块都是一组基于共享仓储
（`lib/db/repositories/*`）的普通 `async` 领域函数，读写
`Account`、`Transaction`、`Contact`、`Card`/`CardLimit`、`Subscription`、
`InvestmentProduct`/`InvestmentHolding`、`Budget`、`ScheduledTask`。

- **execute-only（只执行，不决策）**：它强制*领域不变式*（余额充足、产品 `minAmount`、收款人解析、
  状态转移），并执行读写——但**不做任何权限、确认、MFA 或日限额判定**。那些由 Security Gateway 决定。
  **SDK 是机制（mechanism）；`security/` 是策略（policy）。**
- 返回**纯视图模型**（`banking-sdk/types.ts`）——Prisma 模型类型绝不泄漏出 SDK。
- 门面：`banking = { account, transaction, transfer, contact, card, subscription, investment, budget, task, dashboard }`。
- 领域校验：`transfer.createTransfer` 解析收款人（`contactId` | `phone` | `name`）；姓名匹配多个联系人时
  抛 `AppError('CONFLICT')`（携带 `detail.candidates`）；资金不足抛 `INSUFFICIENT_FUNDS` 且**不写任何行**。
- 错误一律抛类型化的 `AppError`；金额一律走 `lib/money`，绝不裸浮点运算。
- **能力边界（诚实说明）**：🟢 `reserveBudget` **只写一条 `Budget` 行（`status = RESERVED`），
  不锁定 / 不冻结 / 不移动任何资金**；🟡 `createScheduledTask` **只持久化一条 `ScheduledTask` 意向行，
  当前没有任何在线调度器会在其 `runAt` 时间真正执行它**。二者都是"计划意图的标记"，而非真实资金/动作。

---

## 7. 深入 · Tool Calling（注册式银行工具）

`agent/tools/` 是智能体**完整且穷尽**的能力集，一个工具族一个模块。每个工具族导出：

1. `create<Name>Tool(userId): AgentTool<typeof <Name>Params>` **工厂**——返回的 `AgentTool` 参数是
   **TypeBox** schema（`Type`/`Static` 由 pi-ai 再导出）；`execute` 调用 Banking SDK 并返回
   `AgentToolResult`，失败时抛 `AppError`；
2. `run<X>(userId, args): Promise<ToolExecutionResult>`——**无模型**路径，供 registry 的
   `executeDirect` 使用；它**捕获**异常并返回 `ToolExecutionResult{ ok:false, error }`。

`index.ts` 通过 `createToolRegistry(userId)` 构建**按用户**的注册表：
`userId` 被**闭包捕获**（模型永不提供它），工具名必须精确等于 `ToolName` 联合类型中的 26 个名字
（缺一个都是编译错误）。

**两条执行路径**（安全模型的关键）：

| 路径 | 触发者 | 用途 |
|---|---|---|
| `AgentTool.execute`（经模型工具调用） | LLM 提议、`beforeToolCall` 授权后 | 运行中的智能体回合，🟢 内联执行 / 🟡🔴 被阻断 |
| `registry.executeDirect` / `executeGatedTool` | **人工决策**（confirm/verify）或 Planner 的 `runTool` | 用**原始已校验参数**经 Banking SDK 执行，**不经过 LLM** |

---

## 8. 深入 · DAG Planner（规划器）

`planner/` 是支撑 `submit_plan` 元工具的**确定性 DAG 引擎**。LLM 提出一个计划（`TaskNodeSpec`
节点组成的 DAG）；规划器**校验**它、计算执行顺序、按拓扑序**执行**节点、**求值**条件分支，
并发出逐节点的状态更新——这正是智能体循环中的**规划（plan）+ 执行（execute）**阶段。

**流水线**：`validate → topological order → execute → condition eval → status stream`。

- `dag.ts`（纯图操作，无 I/O）：`validatePlan` 拒绝重复 id、未知工具、畸形节点、缺失依赖与环；
  `topologicalOrder` 给出确定顺序（按声明顺序稳定）；`getReadyNodes` 选出所有依赖已 `success`/`skipped`
  的就绪节点；`evaluateCondition` 做点路径查表 + `op` 比较；`buildPlan` 组装初始快照。
- `executor.ts`：`runPlan(plan, deps, opts)` 按拓扑序推进并返回最终快照。**副作用全部注入**：
  `PlanDeps.runTool`（由 agent 提供，走网关）、`onNodeUpdate`（转发为 `plan_update` 流事件）、
  可选 `persist`。

**节点状态机**（`TaskNodeStatus`）：

```
pending → running → { success | failed | waiting_confirmation | waiting_verification | cancelled }
```

依赖未成功的节点（`skipped` / `failed` / `cancelled`）会传递性地变为 `skipped`；
条件为 `false` 的分支其后继同样 `skipped`。计划级状态
（`TaskPlanStatus`）：`pending | running | waiting_confirmation | success | failed | cancelled`。

**被门控的节点会「停放」**：`runTool` 返回 `{ ok:false, requiresConfirmation:true, pendingActionId }`
时节点不执行，停在 `waiting_confirmation`（RED 待 MFA 则停在 `waiting_verification`）；人工决策后
智能体通过 `PlanControls.resume()` / `retry(nodeId)` 重新调用 `runTool`。

**示例（对应 Test 11「若本月娱乐>2000则调限额1500」）**：

```mermaid
flowchart LR
    A["analyze_spending<br/>🟢 GREEN"] --> C{"condition<br/>本月娱乐 &gt; 2000"}
    C -- true --> B["set_card_limit<br/>🟡 YELLOW · 需确认"]
    C -- false --> D["跳过 (skipped)"]
```

规划器是**纯 DAG 逻辑**：只导入 `lib/contracts/task` + `lib/errors`，绝不导入 banking-sdk / security /
agent / audit / prisma。单个节点失败**绝不抛出**——记录 `failed` 并继续独立分支。

**持久化任务控制 · Durable DAG Control**（路由在 `app/api/tasks/[id]/route.ts`，逻辑在 `agent/task-control.ts` + `planner/`）：

- `POST /api/tasks/[id]`，body `{ action: 'pause' | 'resume' | 'cancel' | 'retry' }` →
  `pauseTask` / `resumeTask` / `cancelTask` / `retryTask`。
- **PAUSE**：持久化 `AgentTask.status='paused'`；一个**仍在运行**的计划会在**下一个节点边界**停下
  （控制是 DB 驱动：执行器在每个检查点重读持久化行，而非内存标志）。
- **RESUME**：先把状态翻回 `running` 再重跑计划，**跳过**所有既有结果为终态
  （`success | failed | skipped | cancelled`）的节点——已成功节点**绝不重跑**；仍停放的被门控节点继续停放。
  若某门控节点的既有 `PendingAction` 已为 `executed`（副作用已执行并已入账，但节点结果未回写），则**恢复**该节点：
  `agent/confirmation.ts#executeGatedToolOnce` 经 `findInFlightPlanAction(taskId, nodeId)` 识别后调用
  `replayExecutedPlanAction`，以该动作**持久化的原始 toolName/argsJson** 经 SDK 在**同一节点幂等键**
  `nodeExecutionKey(taskId, nodeId)` 下**重放**（SDK 幂等 ⇒ 不重复副作用），把节点补齐为 `success` 并继续后续节点，
  **不重新请求确认、不重复执行**；真正 `pending`/`awaiting_mfa`/`confirmed` 的节点仍继续停放等待人工决策；恢复幂等。
- **CANCEL**：终态。`agent/task-control.ts#cancelTask` 的**原子结算**把「撤销」与「置状态」放进**同一个**
  `prisma.$transaction`：事务内**先撤销**该计划停放的 `PendingAction`——`revokePendingActionsByTask(taskId,
  ['pending','awaiting_mfa'])`（`lib/db/repositories/pendingAction.ts`，**单条 `updateMany`** 一次性取消该计划的
  **每一个**动作），再写入 `AgentTask.status='cancelled'`——两者之间**没有窗口**，撤销与取消**不可能被分别观测到**。
  节点输出扫描（`revokeParkedActions`，读 `node.output.pendingActionId`）与每次运行后的 `sweepCancelledPlan` 只是
  **兜底 / 补充**，用于捕获「运行期间新铸、与并发取消擦肩而过」的动作。
  **授权侧**同样在 `security/security-gateway.ts` 的**比较并写入（compare-and-set）`$transaction` 内部**按
  `PendingAction.taskId` 重读所属计划状态：计划已 `cancelled` ⇒ 事务内**回滚主张**（`status='cancelled'`）并返回
  `{ kind: 'plan_cancelled' }`（HTTP **200** `{ ok:false, status:'cancelled', code:'SECURITY_DENIED' }`，是**返回**而非抛出）；
  `gatewayCreatePendingAction` 亦**拒绝**在已取消的计划下新建动作——因此**资金无法从已取消的计划中流出**。
  已完成的动作被如实保留——**不做虚假回滚**；只有剩余的非终态节点变为 `cancelled`。
- **RETRY**：只重跑失败节点；`success` 节点永不重置。
- **恰好一次（DB 级执行主张，不是进程内状态）**：跨请求的重复执行由**数据库主张**挡住。
  `lib/db/repositories/task.ts#claimTaskExecution` 在 `executor.runPlan` **之前**用**单条原子 `updateMany`**
  （compare-and-set：`executionToken IS NULL` → 本次的 token）主张 `AgentTask.executionToken`，并在 `finally` 中由
  `releaseTaskExecution` 释放；节点级同理：`claimNodeExecution` 主张 `AgentTaskNode.executionToken`、
  `releaseNodeExecution` 在 `finally` 释放，经 planner 的 `PlanDeps.claimNode` / `PlanDeps.releaseNode` 接入
  （`agent/task-control.ts#buildPlanDeps`）。这些领取支持**陈旧接管**：resume / retry 传入
  `staleBefore = staleExecutionClaimBefore()`（`agent/task-control.ts`；`EXECUTION_CLAIM_TTL_MS = 600000` ≈ 10 分钟，
  基于**真实时钟** `Date.now()`，**非**演示时钟），`where.OR = [ executionToken IS NULL, executionClaimedAt < staleBefore ]`：
  **仅当**所有者被证明**陈旧**时才接管；仍**存活**的所有者**不被抢占**；并发接管**只允许一个赢家**；旧所有者的
  `releaseTaskExecution` / `releaseNodeExecution`（`finally` 中调用）按 token CAS **成为空操作**。因此并发的
  resume / retry / 确认续跑中**只有一个**能真正启动执行器，
  其余立即返回已持久化的计划。跨「副作用已发生、结果尚未落库」窗口的幂等由
  **`nodeExecutionKey(taskId, nodeId)` = `nxe:<taskId>:<nodeId>`**（`lib/ledger.ts`）保证：它作为 SDK 的
  `idempotencyKey` 传入，同一 `(task, node)` 的重跑**重放原始副作用**而不会二次施加（如投资 `subscribe_investment` /
  `redeem_investment` 即按此键去重；`redeem_investment` 另在持仓上持久化本次执行的**执行身份**与**原始结果**
  （`InvestmentHolding.redeemExecutionKey` / `redeemResult`）——相同身份的重放**返回原始结果**，身份不同或缺失则抛
  `AppError('CONFLICT')`）。账本行的定位在 `lib/ledger.ts` **统一**：
  `ledgerKeyForAction({ id, taskId, nodeId })` 在 `taskId` 与 `nodeId` **同时存在**时返回
  `nodeExecutionKey(taskId, nodeId)`，否则返回动作自身的 `id`；`ledgerTxIdForAction(userId, action)` 由此派生
  账本行 id——agent 的确认执行路径与 SDK 均据此推导转账流水 id。`agent/confirmation.ts#executeGatedToolOnce`
  另以 `findInFlightPlanAction(taskId, nodeId)` 预检，避免为同一节点重复铸造第二个 `PendingAction`。
- **刷新 / 恢复**：`GET /api/tasks`（按 cookie 限定的列表）与 `GET /api/tasks/[id]`（单计划，其节点结果携带
  `pendingActionId`，UI 可在刷新后恢复确认/MFA 入口）；`GET /api/actions` 列出非终态待处理动作。
  对计划停放动作的成功确认/验证会追加一个 `{type:'plan_update', plan}` 事件。

---

## 9. 两阶段确认模型 · Two-Phase Confirmation

资金类调用**总是**由人工确认触发，绝不由模型文本触发（这正是演示 Test 4 —— prompt injection 所证明的）。

```mermaid
sequenceDiagram
    participant U as 用户
    participant API as API 路由
    participant AG as Pi Agent (LLM)
    participant GW as Security Gateway (beforeToolCall)
    participant SDK as Banking SDK
    U->>API: 「给张伟转5000元」
    API->>AG: prompt(user message)
    AG->>GW: 工具调用 transfer_money(5000)
    GW->>GW: evaluate → 🔴 RED（amount > ¥1000）
    GW-->>AG: { block: true, reason: __SECURITY_BLOCK__… }
    Note over GW,SDK: 未执行；写入 PendingAction(awaiting_mfa)
    AG-->>API: 「需安全验证」文本
    API-->>U: 展示验证码输入
    U->>API: POST /api/actions/:id/verify { code:"123456" }
    API->>GW: authorizeAction(id, { mfaCode })
    GW-->>API: ok（RED + MFA 通过）
    API->>SDK: createTransfer(原始已校验参数)
    SDK-->>API: 真实结果（成功 / 失败）
    API->>AG: continue() 注入真实结果
    AG-->>U: 如实播报事实性结果
```

- **第一阶段（回合 / Turn）**：`POST /api/chat` 跑一个 Agent 回合。🟢 工具在 `execute` 内联执行，
  结果回流给模型；🟡/🔴 工具被 `beforeToolCall` **阻断**，持久化 `PendingAction` 行，并返回结构化原因，
  模型看到「待确认/待验证」后向用户回复。
- **第二阶段（人工决策）**：`POST /api/actions/:id/confirm`（🟡，或 MFA 后的 🔴）· `.../verify`（🔴 MFA 码）
  · `.../cancel`。服务器通过网关的**授权执行路径**（**不是 LLM**）用**原始已校验参数**经 Banking SDK 执行、
  写审计日志、把**真实**工具结果注入会话，并调用 `agent.continue()` 让模型叙述事实性结果。
- **原子性（Atomic Claim + 执行时再风控）**：确认在**一个** `prisma.$transaction` 内完成，其**第一条语句**
  就是 `PendingAction` 的比较并写入（compare-and-set，`pending → confirmed`）；**仍在同一事务内**重新推导
  当日转账累计并**重跑**风险评定（`security/security-gateway.ts` → `authorizeTransfer`）。再风控所用的累计值
  **包含在途**（已确认但尚未落账）的转账动作：`security/risk-engine.ts` 的
  `computeEffectiveTransferTotalWith` = 当日**已执行**转账合计 + `computeInFlightTransferTotal`（对状态
  ∈ `['confirmed','executing']` 且**其账本行尚不存在**的停放 `transfer_money` 动作求和）。账本行的定位在
  `lib/ledger.ts` **统一**：`ledgerTxIdForAction(userId, action)`（基于 `ledgerKeyForAction({ id, taskId, nodeId })`
  ——`taskId` 与 `nodeId` 同时存在时用 `nodeExecutionKey(taskId, nodeId)`，否则用动作 `id`）既标识动作产生的
  账本行，也被 `computeInFlightTransferTotal` 用来**判断该账本行是否已存在**：一笔**已落账但仍为 `confirmed`**
  的计划转账由此恒被计入**恰好一次**（经已执行半边），绝不被「在途」半边重复计——例如其后**再发起 ¥100 仍为 🟡、
  ¥1000 仍为 🟡、¥1000.01 才为 🔴**（`evaluateTransferRisk` 用严格 `>`）。这封死了「先停放多笔小额转账绕过限额」
  的路径。若执行时再风控升级为 🔴 RED，事务内**回滚主张**并持久化 `riskLevel='RED'`、`requiresMfa=true`、
  `status='awaiting_mfa'`，随后下发 MFA（持久化审计用 `LIMIT_EXCEEDED`）。**诚实说明**：主张优先写依赖
  **SQLite 写锁串行化**（SQLite 专属；跨独立数据库引擎 / 多写入者未经验证——演示运行在本地 SQLite 上）。
- **身份（Identity，cookie-only）**：写端点（actions confirm/verify/cancel、tasks `[id]`、security reset）
  与读端点的身份**仅**来自 `banking_session` HttpOnly cookie（由
  `app/api/_lib/session.ts#requireIdentity` 解析）；`?userId=` / `?sessionId=` 查询参数被**忽略**；
  cookie 缺失或对应未知会话 → **403 SECURITY_DENIED**。待处理动作 / 任务的归属被强制（非本人 → 403，未知 id → 404）。
  会话创建路由 `POST /api/chat`（`app/api/chat/route.ts`）的身份规则见下一条。
- **会话身份不可由请求体伪造**：`POST /api/chat` 的会话**只**取自 cookie（`resolveSessionId`），**绝不**取自
  请求体。当 body `sessionId` 与 cookie 值**不一致**时（**包括完全没有 cookie** 的情形）→ **HTTP 409
  CONFLICT** 且**不签发任何 Set-Cookie**；body 与 cookie 相等则接受。首次访问 → 新建会话并 `Set-Cookie`。
  因此请求体永远无法选择或铸造一个会话（也就无法用他人会话 id 换取一张授权 cookie）。
- **有效层级端到端可见**：确认 / 验证响应同时返回有效 `tier` 与 `requiresMfa`，并发出 `mfa_required` 事件
  （回合时来自 `agent/run-turn.ts`，附带 hint + 卡片；确认时来自 `agent/confirmation.ts#blockedOutcome`）。

> **网关只授权，不执行**：`securityGateway.authorizeAction` 只返回授权结果，资金移动由 agent 层的
> `executeGatedTool` 用原始参数执行。

---

## 10. 工具体系 · Tool Catalogue

模型拥有的**唯一**能力面（`lib/contracts/tools.ts` 中的 `ToolName` 联合类型，共 26 个）：

| 层级 | 工具 |
|---|---|
| 🟢 **GREEN**（13，自动执行，无确认） | `get_balance`、`get_transactions`、`search_contact`、`analyze_spending`、`detect_anomaly`、`get_cards`、`list_subscriptions`、`list_investments`、`compare_investments`、`get_investment_holdings`、`get_dashboard_summary`、`list_scheduled_tasks`、`reserve_budget` |
| 🟡 **YELLOW**（需用户确认） | `set_card_limit`、`cancel_subscription`、`freeze_card`、`apply_virtual_card`、`set_subscription_reminder`、`create_scheduled_task` |
| 🔴 **RED**（需强验证 / MFA） | `subscribe_investment`、`redeem_investment`、`report_lost_card`、`unfreeze_card`、`change_password` |
| 🔵 **DYNAMIC** | `transfer_money`：`amount > ¥1000` **或** `当日累计 + amount > ¥1000` ⇒ 🔴，否则 🟡；**总是**需要确认 |
| ⚪ **META** | `submit_plan`：不受风险门控（allow） |

精确层级以 `security/permission-engine.ts` 的策略表为准；`transfer_money` 是动态的。

---

## 11. 关键技术决策 · Key Decisions

- **代码即权限**：🟢/🟡/🔴、确认与 MFA 只由静态策略表 + 确定性动态规则推导，
  模型输出与用户文本**从不**作为判定输入。
- **能力面即安全边界**：工具注册表就是完整能力集；没有 shell/SQL/文件工具，注入攻击无工具可调。
- **两阶段 + 人工决策**：资金移动永远由人工确认触发；网关授权、agent 执行，职责分离。
- **原子主张 + 执行时再风控**：确认在一个 `prisma.$transaction` 内把主张（compare-and-set）与再风控一并完成，
  再风控累计**包含在途转账**（`computeInFlightTransferTotal` 只计入**账本行尚不存在**的动作）；账本行的定位统一在
  `lib/ledger.ts`（`ledgerTxIdForAction` / `ledgerKeyForAction`），一笔**已落账但未终态**的转账恒被计**恰好一次**。
  升级则回滚主张并转 MFA。依赖 SQLite 写锁串行化（演示运行在本地 SQLite）。
- **Cookie-only 身份与归属强制**：身份仅来自 HttpOnly `banking_session` cookie（查询参数被忽略，
  缺失 / 未知 → 403）；`POST /api/chat` 会话只取自 cookie，body `sessionId` 与 cookie 不一致（含无 cookie）
  → `409 CONFLICT` 且不签发 Set-Cookie；动作 / 任务归属强制（非本人 403 / 未知 404）；**没有 demo-user 回退**——
  仅有 actionId 不构成能力。
- **取消与授权的竞态**：`cancelTask` 的**原子结算**把「批量撤销」`revokePendingActionsByTask(taskId,
  ['pending','awaiting_mfa'])`（`lib/db/repositories/pendingAction.ts`，**单条 `updateMany`** 取消计划内的**每一个**动作）
  与 `status='cancelled'` 的写入放进**同一个** `prisma.$transaction`——撤销与取消之间**没有窗口**；节点输出扫描与
  每次运行后的 `sweepCancelledPlan` 只是**兜底**。授权侧的 CAS `$transaction` 内还会按 `PendingAction.taskId` 重读计划
  状态：已 `cancelled` ⇒ 回滚主张并返回 `{ kind: 'plan_cancelled' }`（HTTP 200 `{ ok:false, code:'SECURITY_DENIED' }`），
  `gatewayCreatePendingAction` 亦拒绝在已取消计划下新建动作。取消与确认的竞态由共享的 `PendingAction` 状态 CAS 保证
  **至多一次**（取消后的确认不再执行）；已完成转账原样保留——**无虚假回滚**。
- **去重身份的作用域**：恰好一次的主保证是**DB 执行主张**（`claimTaskExecution` / `claimNodeExecution`，见 §8）。
  `nodeExecutionKey(taskId, nodeId)` = `nxe:<taskId>:<nodeId>`（`lib/ledger.ts`）是计划节点**副作用**的 SDK
  `idempotencyKey`（如 `subscribe_investment` / `redeem_investment` 即按它去重）；`agent/confirmation.ts` 只对
  **自动执行的计划节点**调用按**稳定的节点身份** `nodeExecutionKey(taskId, nodeId)` 合并并发调用，并以
  `findInFlightPlanAction(taskId, nodeId)` 预检、避免为同一节点重复铸造第二个 `PendingAction`；已 `executed` 的计划节点
  动作经幂等 SDK 重放被**恢复**（绝不重新确认）；
  **独立调用**（无计划节点）**没有**合并键——其恰好一次由 DB 的 `PendingAction` 状态 CAS 保证；
  **两个不同计划**即使调用同一工具、传同一参数也各自独立执行（按 `sessionId` + 工具 + args 合并会把一个计划的副作用
  错误地施加到另一个计划）。进程内 `inFlightExecutions` 只是**同进程补充**，且以**节点身份**为键。
- **暂停保持（pause retention）**：在已暂停计划内确认一个停放节点只记录该节点结果，计划保持 `paused`，
  直到显式 resume 才继续。
- **终态保护**：已取消的计划无法经 resume / retry / pause 离开终态；API 响应与 DB 一致（CAS 的 from 集合
  排除终态，`persistPlan` 绝不覆盖 `cancelled`）。
- **DAG 持久化控制**：pause / resume / cancel / retry 由持久化 `AgentTask` 行驱动（状态即真相，跨请求生效）；
  刷新后可从 API 恢复计划与待确认入口。
- **演示时钟（Demo Clock）**：`DEMO_NOW = 2026-09-25 12:00 本地`，让本月/上月/今日窗口、消费分析、
  日转账窗口、计划任务日期与 system prompt 的「今天」保持一致，不受真实系统时钟影响。
- **离线确定性**：`LLM_MODE=mock`（faux provider）+ 可注入的 `now` / `id`，让 agent/security/planner
  测试无需网络。
- **UI 不展示 LLM 思维链**：只显示任务步骤、工具状态与结果。
- **组件 barrel 层必须保持中立（neutral）**：`components/` 的 barrel **不得**携带 `'use client'`——一个带
  `'use client'` 的**中间层** barrel 若经中立的 `components/index.ts` 门面星号再导出，SSR 时会解析为
  `undefined` 并让消费页面崩溃；只有**叶子**客户端组件带该指令。

> 完整安全模型见 [`security.md`](./security.md)；验收场景见 [`test-cases.md`](./test-cases.md)；
> 已知限制见 [`known-risks.md`](./known-risks.md)。
