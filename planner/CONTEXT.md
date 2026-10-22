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
| `index.ts` | 公共导出 |

`PlanDeps` 注入工具执行、持久化、控制与执行权检查。
`NodeExecutionContext` 携带计划和节点身份。
入口参数以源码类型为准。

## 执行与控制

`runPlan` 按拓扑顺序执行可运行节点。
已成功节点保留结果，不因恢复重复执行。
待确认或待验证节点会挂起计划。
节点失败不会成为后续成功条件的证据。

暂停计划只有显式恢复后才继续。
暂停期间确认节点可以记录结果，但不能启动后续节点。
取消在检查点阻止后续工作。
已完成业务不因取消而伪装回滚。

`resumePlan` 记录挂起节点的决定后继续。
`retryPlan` 重置可重试节点及其未成功的传递后继。
`compensationReport` 描述已执行与已取消节点。
它不执行资金补偿。

## 恢复入口

挂起节点（`waiting_confirmation`/`waiting_verification`）的恢复只有两个入口，都由调用层驱动：
`lifecycle.resumePlan(plan, { nodeId, outcome }, deps, opts)` 先用 `settleToolNode` 记录人工决定，
写节点行后再调用 `runPlan(snapshot, deps, opts)` 继续（`lifecycle.ts:322`、`:344`、`:366`）；
`lifecycle.retryPlan(plan, deps, opts)` 把目标及其传递后继重置为 `pending`，再调用 `runPlan`（`lifecycle.ts:242`、`:295`）。
不存在独立的拓扑续跑逻辑：恢复即"重放 `runPlan`"。
`runPlan` 对已终态节点保留记录并跳过（`executor.ts:566`），新授权节点以 `success` 记录后其依赖因此解锁。
`runPlan` 只在 `cancelled`、`success` 或未显式恢复的 `paused` 快照上原样返回（`executor.ts:280`、`:285`、`:288`），不写任何东西。
`waiting_confirmation` 计划可直接被 `runPlan` 推进；未终态的挂起节点会再次认领并再次调用 `runTool`，幂等由调用层执行键/收据负责。
`resumePlan` 对 `paused` 计划只记录决定、不推进后继，除非 `opts.explicitResume`（`lifecycle.ts:334`、`:359`）；
重新挂起或失败的决定只返回快照（`lifecycle.ts:362`）。
`settleToolNode` 是初始执行与决定后继续共用的结果映射（`node-outcome.ts:5`），未从 `index.ts` 导出。

## 执行权与持久化

计划与节点认领必须使用调用层提供的数据库条件更新。
丢失执行权时，执行器停止工具调用与结果发布。
快照写入前的状态检查不代替数据库原子校验。

执行接口由 `agent/` 接到仓储与安全网关。
完整图的编译校验见 `agent/tools/plan-compiler.ts`。
不得在本目录从用户原句重新推导业务参数。

验证入口见
[tests/unit/planner/CONTEXT.md](../tests/unit/planner/CONTEXT.md)。
