# 跨模块回归测试

## 范围

测试使用真实运行入口、网关、执行器与隔离 SQLite。
模型响应和并发时序可由测试控制。
文件名中的 live 不代表调用真实模型。
真实模型与浏览器证据见
[../e2e/CONTEXT.md](../e2e/CONTEXT.md)。

| 测试组 | 关注点 |
| --- | --- |
| `live-complete-plan.test.ts`、`request-step-binding.test.ts` | 声明范围、完整任务图与逐步授权 |
| `request-scope-holdings.test.ts` | 持仓身份、所有权与独立操作 |
| `financial-response-boundary.test.ts` | 普通说明、工具结果与授权事实的归属 |
| `message-protocol.test.ts` | Pi 工具调用与结果的协议配对 |
| `write-audit.test.ts`、`execution-audit.test.ts` | 强制审计、去重与回滚 |
| `transfer-receipts.test.ts`、`transfer-replay.test.ts` | 原始回执、请求冲突与资金一致性 |
| `workflow-invocations.test.ts` | 持久化子调用与任务图恢复 |
| `process-restart.test.ts`、`standalone-workflow-restart.test.ts` | 真实进程中断与恢复 |
| `model-checkpoint-boundaries.test.ts` | 模型检查点、租约与提交条件 |
| `write-continuation.test.ts` | 声明写操作未发出受控调用时的单次续办、面板真伪与持久化恢复 |

其他测试覆盖预算、取消、接管、执行权和未知结果。
具体场景以测试源码中的断言为准。
不得保留已删除测试的路径或旧修复轮次清单。

## 断言约束

- 声明与任务图来自结构化输入，不从原句正则补全。
- 成功事实必须核对回执、余额与流水。
- 未知结果必须保留待核对状态。
- 流输出与持久化历史必须保持相同的结果归属。
- 并发测试必须使用可控屏障和持久化断言。

运行：`pnpm exec vitest run tests/integration`。
共享数据库规则见 [../CONTEXT.md](../CONTEXT.md)。

## 已知缺口

- `live-*.test.ts` 中的 `live` 表示使用 live 模式配置，不代表调用真实模型；真实模型证据见 [../e2e/CONTEXT.md](../e2e/CONTEXT.md)。
- 面板/确认断言分两类前提：`conversational-turns.test.ts`、`decision-guidance.test.ts`、`live-recovery.test.ts` 等要求真实工具调用并持久化 `PendingAction`；`write-continuation.test.ts` 覆盖模型仅在散文里声称已确认或等待确认、却不发出任何受控调用、因而不存在 `PendingAction` 也不显示面板的情形。
- `write-continuation.test.ts` 的前台续办中，真实写调用被回复校正拒绝，不会打开面板；打开真实面板的写路径由 `live-complete-plan.test.ts` 等覆盖，其持久化写路径由该文件的 durable 用例覆盖。
- 真实模型自身的散文化面板声称稳定性由 [../e2e/CONTEXT.md](../e2e/CONTEXT.md) 的 live 验收诊断，本目录不覆盖。
