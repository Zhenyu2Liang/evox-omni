# Agent 局部测试

## 范围

本目录覆盖确认、验证、取消与计划控制。
也覆盖工具结果替换、续接失败与模型适配。

- `confirmation-idempotency.test.ts` 检查重复决定与所有权。
- `confirmation.test.ts` 检查决定结果与审计。
- `task-control.test.ts` 检查任务持久化和控制。
- `task-cancel-revokes.test.ts` 检查取消与已执行事实。
- `message-normalize.test.ts` 检查工具结果组与后续历史。
- `run-turn-failure.test.ts` 检查实际结果与失败续接。
- `system-prompt.test.ts` 检查系统提示词与工具目录分级一致并保留幻象规则。
- `read-tool-boundaries.test.ts` 检查读取工具参数校验与模型可见错误信封。
- `durable-reply-repair.test.ts` 检查回复修复的持久续接、崩溃不重复修复与凭据脱敏。
- `durable-advice-context.test.ts` 检查授权恢复时建议用途与来源请求一致性。
- `recovery-worker.test.ts` 检查恢复主机批处理、关闭与参数校验。
- `providers/` 检查离线响应、live 适配配置、流完成证据与模块边界。

## 证据与隔离

确认、验证和任务控制用例使用真实模块与测试库。
只检查模型适配配置不等于完成 live 请求验收。
结果文字必须区分服务端结果与模型输出。

熔断状态按所有者持久化，不是进程内会话计数。
测试隔离规则见 [../../CONTEXT.md](../../CONTEXT.md)。
并发确认与进程恢复还需结合跨模块测试。
不得根据本目录文件数量宣称覆盖完整。

运行：`pnpm exec vitest run tests/unit/agent`。
