# 演示场景测试

## 测试入口

`test-01` 至 `test-12` 覆盖最初的演示场景。
`test-13` 至 `test-15` 覆盖补办换卡、虚拟卡申请与类别限额约束。
`test-16` 覆盖虚拟卡补办家族生命周期、限额语义与重放幂等。
`test-17` 覆盖伪造消费入账时间在工具、计划与重放层被拒。
`test-18` 覆盖卡片能力的咨询、歧义澄清与能力指引契约：咨询不产生操作，歧义只产生澄清，指引与系统提示不得否认真实能力。
`test-19` 覆盖 LOST 信用卡补办在生产运行时端到端可达（RED MFA 闸门，验证前不制卡）。
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
`test-02`（YELLOW）与 `test-03`/`test-09`/`test-13`/`test-14`/`test-16`（RED）核对 `PendingAction` 行、`confirmation_required`/`mfa_required` 事件与确认/MFA 卡片。
`test-11`/`test-12` 核对被拦截的计划节点 parked 为 `waiting_confirmation` 并暴露 `pendingActionId`。
`mock-integration.test.ts` 对真实离线模型核对 `pendingAction.status`。

所有编号场景脚本都以一次工具调用开始，因此被断言的面板必然对应一条 `PendingAction`。
没有场景覆盖“模型只用文字声称需要确认、却不发出工具调用”的情形；此时不会产生面板，故不存在正向对照测试。
`test-04` 只证明注入文本不改变权限等级，不核对模型文字与实际工具调用/待决行是否一致。

## 虚拟卡家族与消费入账时间

`test-16` 以一次会话走完「申请 → 消费到限额 → 挂失 → 补办 → 继续消费」的 MFA 闸门路径。
补办卡与原卡共用同一结算账户与同一月限额，已入账的 `CardConsumption` 仍归原卡。
限额跨家族连续：限额 100、补办前已花 30，则补办后仍可花 70，再花 71 被 `LIMIT_EXCEEDED` 拒绝且余额、流水、消费记录均不变。
绑定账户现金不足时报 `INSUFFICIENT_FUNDS`，不产生部分扣款。
月限额 0 拒绝任何消费；未设月限额时 `payableAmount` 等于账户可用现金。
重放同一执行身份只扣一次；同一身份换卡消费为 `CONFLICT`。
模型重新发起补办仍会再次进入 MFA 闸门，这是网关既定行为；幂等只对已授权的执行路径成立。

`test-17` 证明任何调用方时间字段（`occurredAt`、`bookedAt`、`timestamp`、`time`、`date`）都以「消费入账时间由服务端决定」被拒。
首拒层是工具注册表安装的 `prepareArguments` 参数校验，因此不会持久化 `PendingAction`、也不产生 `AuthorizationDecision`。
已持久化动作与计划节点的重放同样被拒；不带时间字段的对照计划可正常提交。
拒绝时不产生扣款、`channel='CARD'` 流水或 `CardConsumption` 记录。

## 已知问题

`tests/helpers/db.ts#truncateAll` 未清理 `prisma.cardConsumption`，同一 `executionKey` 的消费会在重复运行间残留。
`test-16` 因此在 `beforeEach` 中自行清空该表；彻底修复应落在 `tests/helpers`。
