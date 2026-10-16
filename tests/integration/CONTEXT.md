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
| `refactor-financial-commands.test.ts`、`confirmed-write-authority.test.ts`、`replace-card-replay.test.ts` | 通用写入回执重放：原样返回、不进入写栅栏、不产生新流水（含 `replace_card` 补卡原操作重放） |
| `write-idempotency.test.ts`、`execution-audit.test.ts` | 网关/确认路径去重与强制审计幂等 |
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
- `write-continuation.test.ts` 中参数完整的声明写操作在有界续办里会真实抵达安全网关并打开真实面板（`PendingAction` + 等待中的工具调用），前台与 durable 路径要求一致；只有模型仅用散文声称面板、未发出受控调用时，服务端才发布真实未提交状态。伪造的面板文案绝不进入会话记录。
- `conversational-turns.test.ts` 的 `fixtures.fabricatedSuccess`／`fabricatedBalance` 只断言这类散文被原样保留且不触发授权，不涉及面板/确认声称。
- 真实模型自身的散文化面板声称稳定性由 [../e2e/CONTEXT.md](../e2e/CONTEXT.md) 的 live 验收诊断（`panel-claim.e2e-helper.ts`、`live-acceptance.e2e.ts#driveRedTool` 经 `helpers.ts#assertNoFabricatedConfirmationPanel`），本目录不覆盖真实模型稳定性。
- `report_lost_card`（RED 挂失）尚无“原操作回执重放”回归；`replace-card-replay.test.ts` 只把它当作同一操作键下的“换了工具”冲突用例（`errorCode: 'CONFLICT'`，不进入写栅栏），并不校验其重放。
- 通用回执重放入口为 `createToolRegistry(userId).executeDirect(tool, args, { sessionId, idempotencyKey })`，用同一 key 重发即原样返回（`refactor-financial-commands.test.ts:95`、`confirmed-write-authority.test.ts:136`）。
- 夹具不播种 LOST 卡（`card_credit`/`card_debit` 均 `ACTIVE`，见 `../helpers/fixtures.ts:99`）；`replace_card` 需先 `report_lost_card` 或直接改库把源卡置 `LOST`。
