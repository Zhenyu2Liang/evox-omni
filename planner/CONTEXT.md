# 任务图执行器

## 职责与入口

本目录负责 DAG 校验、执行顺序与计划控制。
银行业务、权限与持久化由注入接口负责。

| 模块 | 职责 |
| --- | --- |
| `dag.ts` | 图校验、拓扑排序、就绪节点与条件求值 |
| `executor.ts` | 节点执行、挂起、检查点与通知 |
| `lifecycle.ts` | 暂停、取消、重试与决定后继续 |
| `node-outcome.ts` | 工具结果到节点状态的转换 |
| `failure.ts` | 结构化拒绝契约与「是否可再驱动」判定 |
| `index.ts` | 公共导出 |

`PlanDeps` 注入工具执行、持久化、控制与执行权检查。
`NodeExecutionContext` 携带计划和节点身份。
入口参数以源码类型为准。

## 结构化拒绝契约

`PlanFailure` 与 `SecurityFailure` 语义对齐，`reason` 可缺省（非安全类失败只有 `code`）：

```ts
interface PlanFailure { code: ErrorCode; reason?: SecurityFailureReason; actionId?: string;
  attemptsUsed?: number; attemptsLeft?: number; maxAttempts?: number }
interface PlanNodeResult extends TaskNodeResult { summary?: string; pendingActionId?: string;
  failure?: PlanFailure; actionStatus?: PendingActionStatus }
```

`PlanToolOutcome` 增加两个结构化字段，`agent/tools/planning.ts` 的适配器负责填入：

```ts
failure?: PlanFailure;                  // 错误码 + 可渲染参数，绝不含原始载荷
actionStatus?: PendingActionStatus;     // 该结果所引用 PendingAction 的持久化状态
```

`failure`/`actionStatus` 在 `settleToolNode` 三条分支上原样保留，并经 `results`、`persistNode`、`onNodeUpdate`、计划快照原样传出。
`error`/`summary`/`output` 等可渲染字段只经 `publicFailureText` 投影。
`publicFailureText` 用 `lib/public-text#isInternalDiagnostic` 丢弃 `__SECURITY_BLOCK__` 载荷、原始 JSON、堆栈与 `undefined`，不做 i18n 渲染。
对外文案仍由 `lib/public-text.ts` / `lib/tool-feedback.ts` 投影（`securityNotice` 读 typed 字段）。
planner 不让内部诊断文本进入任何可渲染字段。

## 执行与控制

`runPlan` 按 `topologicalOrder` 顺序执行可运行节点。
已成功节点保留结果，不因恢复重复执行。
待确认或待验证节点会挂起计划。
节点失败不会成为后续成功条件的证据。

暂停计划只有显式恢复后才继续。
暂停期间确认节点可以记录结果，但不能启动后续节点。
取消在检查点阻止后续工作。
已完成业务不因取消而伪装回滚。

`summary` 没有节点列：无 `data` 时才并入 `output`（`node-outcome.ts:20`、`:21`）。
`resumePlan` 不检查被决定节点是否已终结；重写保护来自持久层「终结态不写终结态」的条件更新。
`compensationReport` 描述已执行与已取消节点。
它不执行资金补偿。

## 不可再驱动（已锁定/已终态动作）

判定集中在 `failure.ts`，状态字面量比较只用 `agent/action-status.ts`。
`sealReason(result)` 返回 `'locked_refusal'`（`reason` 为 `mfa_attempts_exhausted`/`mfa_session_locked`/`circuit_open`，或 `code` 为 `MFA_LOCKED`/`CIRCUIT_OPEN`）或 `'action_not_open'`（`actionStatus` 已非 `pending`/`awaiting_mfa`）。
`mayDriveNode(result)`：无记录可推进；`isTerminalStatus` 不可推进；已 sealed 不可推进；其余可推进。
`mayResetNode(result)`：仅要求未 sealed——显式重试本就要重置终态节点。
四条路径都受约束：`runToolNode` 认领前的守卫、`runPlan` 内 `retryRequests` 重置、`lifecycle.retryPlan`、`lifecycle.resumePlan`。
`runToolNode` 不可推进时返回 `'sealed'` 分支：零写入、零 `runTool` 调用。
走查处把 `'sealed'` 收敛为 `failed`（保留 `failure`/`pendingActionId`/`actionStatus`，补 `endedAt`），绝不新造 `pendingActionId`、绝不留 `waiting_confirmation`。
依赖方因依赖 `failed` 被 skip，计划结算为 `failed`。
`actionStatus:'pending'`/`'awaiting_mfa'` 的挂起节点仍可再次驱动，幂等由调用层执行键/收据负责。
对同一快照重复调用 `runPlan`/`retryPlan`/`resumePlan` 都不会重新激活已锁定动作。

## 恢复入口

挂起节点（`waiting_confirmation`/`waiting_verification`）的恢复只有两个入口，都由调用层驱动：
`lifecycle.resumePlan(plan, { nodeId, outcome }, deps, opts)` 先用 `settleToolNode` 记录人工决定，
写节点行后再调用 `runPlan(snapshot, deps, opts)` 继续（`lifecycle.ts` 内 persist → `runPlan`）；
`lifecycle.retryPlan(plan, deps, opts)` 把目标及其传递后继重置为 `pending`，再调用 `runPlan`。
不存在独立的拓扑续跑逻辑：恢复即「重放 `runPlan`」。
`runPlan` 对已终态节点保留记录并跳过，新授权节点以 `success` 记录后其依赖因此解锁。
`runPlan` 只在 `cancelled`、`success` 或未显式恢复的 `paused` 快照上原样返回，不写任何东西。
`waiting_confirmation` 计划可直接被 `runPlan` 推进；未终态的挂起节点会再次认领并再次调用 `runTool`，但 sealed 节点先被守卫拦下。
`resumePlan` 对不可推进节点（锁定/终态动作）不记录决定、不写任何行、不推进计划，原样返回快照。
`resumePlan` 对 `paused` 计划只记录决定、不推进后继，除非 `opts.explicitResume`；重新挂起或失败的决定只返回快照。
`retryPlan` 目标与后继都经 `mayResetNode` 过滤，全部不可重置时原样返回且不写任何东西。

## 执行权与持久化

计划与节点认领必须使用调用层提供的数据库条件更新。
丢失执行权时，执行器停止工具调用与结果发布。
快照写入前的状态检查不代替数据库原子校验。
条件更新匹配 0 行不抛错，因此丢失写入后调用层无法直接感知。

节点行只经 `deps.persistNode` 与 `deps.onNodeUpdate` 写入（类型均为 `PlanNodeResult`）。
完整计划快照只在开始与结束时各写一次，走 `persistPlanSnapshotGuarded`。
`lifecycle` 用无守卫的 `persistPlanSnapshot`。
认领经 `deps.claimNode`/`deps.releaseNode`，所有权探针为 `deps.isRunOwner`。
控制命令在每次检查点经 `deps.controls.pollControls` 读取并清除。
丢失所有权时运行不调用工具、不写计划快照，返回 `status:'running'`。
节点认领失败是零写入分支；所有权探针失败此前已写入过 `running` 节点行，且 `finally` 释放节点认领。

本目录不读写 Prisma `PendingAction`：不导入 prisma 或仓储。
`pendingActionId` 仅作不透明字符串在 `PlanToolOutcome`/`PlanNodeResult` 上透传。
`actionId` → 计划/节点身份的解析在 `agent/workflows/action-continuation.ts`，不在本目录。

执行接口由 `agent/` 接到仓储与安全网关。
`failure`/`actionStatus` 的端到端生效依赖 `agent/tools/planning.ts` 的 `runTool` 适配器填入这两个字段。
完整图的编译校验见 `agent/tools/plan-compiler.ts`。
不得在本目录从用户原句重新推导业务参数。

验证入口见
[tests/unit/planner/CONTEXT.md](../tests/unit/planner/CONTEXT.md)。
