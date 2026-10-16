# 演示场景测试

## 测试入口

`test-01` 至 `test-12` 覆盖最初的演示场景。
`test-13` 至 `test-15` 覆盖补办换卡、虚拟卡申请与类别限额约束。
包括余额、转账、账单、异常、限额、理财与条件计划。
`mock-integration.test.ts` 使用应用的离线模型。

编号场景使用 `tests/helpers/faux-agent.ts`。
两阶段调用由 `tests/helpers/scenario.ts` 驱动。
它们证明网关、工具和 SDK 的业务边界。
不能据此声明生产运行的全部流程均被覆盖。
生产入口的声明、准入与展示另有集成测试。

## 断言方法

业务测试核对操作状态、余额、流水与审计。
用户决定前不能发生未授权资金变化。
注入文本不能降低权限要求。
条件计划必须按实际节点结果决定后续执行。

结果文字可能由测试辅助函数补充。
这类断言不能证明模型不会编造事实。
离线模型也不能代替 live 模型验收。

GREEN 只表示执行策略，不表示没有副作用。
预算等写操作仍需强制审计。
纯读取与写操作的记录方式以执行层为准。

测试数据使用独立夹具，不等同演示库的全部记录。
熔断隔离规则见 [../CONTEXT.md](../CONTEXT.md)。

运行：`pnpm exec vitest run tests/scenarios`。

## 确认与待决面板

确认/MFA 面板只来自被网关拦截的真实工具调用。
`test-02`（YELLOW）与 `test-03`/`test-09`/`test-13`/`test-14`（RED）核对 `PendingAction` 行、`confirmation_required`/`mfa_required` 事件与确认/MFA 卡片。
`test-11`/`test-12` 核对被拦截的计划节点 parked 为 `waiting_confirmation` 并暴露 `pendingActionId`。
`mock-integration.test.ts` 对真实离线模型核对 `pendingAction.status`。

所有编号场景脚本都以一次工具调用开始，因此被断言的面板必然对应一条 `PendingAction`。
没有场景覆盖“模型只用文字声称需要确认、却不发出工具调用”的情形；此时不会产生面板，故不存在正向对照测试。
`test-04` 只证明注入文本不改变权限等级，不核对模型文字与实际工具调用/待决行是否一致。
