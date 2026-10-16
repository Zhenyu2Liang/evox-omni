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
- 本目录所有“确认/面板”断言都以**真实工具调用并持久化 `PendingAction`** 为前提（见 `conversational-turns.test.ts`、`decision-guidance.test.ts`、`live-recovery.test.ts`）。
- 无任何测试覆盖“模型仅在散文里声称已在面板确认／等待用户确认，却不发出任何工具调用、因而没有 `PendingAction`、也不显示面板”的情形。`conversational-turns.test.ts` 的 `fixtures.fabricatedSuccess`／`fabricatedBalance` 只断言这类散文被原样保留且不触发授权，不涉及面板/确认声称。
- `panel`、`hallucinat`、`please confirm`、`waiting for your confirmation` 及中文 `面板`／`确认卡片`／`等待确认`／`请确认` 在本目录均无匹配。
