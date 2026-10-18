# 单元与局部集成测试

## 目录职责

| 目录 | 内容 |
| --- | --- |
| [security](security/CONTEXT.md) | 权限、累计风险、验证、熔断与安全事件 |
| [planner](planner/CONTEXT.md) | DAG、参数、对话状态与展示 |
| [banking-sdk](banking-sdk/CONTEXT.md) | 金额、账户不变量与事务 |
| [agent](agent/CONTEXT.md) | 确认、会话、计划控制与模型适配 |
| [lib](lib/CONTEXT.md) | 身份键、数据工具与仓储原语 |

目录名称不表示所有测试都无需数据库。

本目录没有脚本化模型驱动生产 `runTurn` 的用例。
`agent/run-turn-failure.test.ts` 替换 `createBankingAgent` 工厂，`write-continuation*.test.ts` 用假运行时且不碰数据库。
需要「`scriptedProvider` → 生产 `runTurn` → SQLite 断言」骨架时用 `tests/integration/write-continuation.test.ts`，说明见 [../integration/CONTEXT.md](../integration/CONTEXT.md)。
安全、SDK 与执行权测试中包含真实 SQLite 用例。
模型适配测试可控制响应，但不得泄露凭据。

## 执行与修改

运行：`pnpm exec vitest run tests/unit`。
按子目录运行时仍使用根 Vitest 配置。
时间边界可注入测试时钟或持久化时间。
安全冷却与租约需覆盖默认真实时钟路径。

必须通过实际模块验证业务规则。
不得在辅助函数中复制被测逻辑。
具体数据库约束见 [../CONTEXT.md](../CONTEXT.md)。
