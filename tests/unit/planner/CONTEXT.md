# 计划、对话状态与展示测试

## 范围

本目录包含 DAG 执行器测试，也包含对话展示测试。
名称不表示只验证计划模块。

| 测试组 | 关注点 |
| --- | --- |
| `dag`、`executor`、`lifecycle` | 图校验、执行顺序与控制 |
| `executor-claim-scope`、`executor-execution-right` | 数据库认领与失去执行权 |
| `intent-context`、`plan-compiler`、`plan-parameters` | 目的声明、参数与完整任务图 |
| `chat-stream`、`chat-transport-validation` | 流状态与传输校验 |
| `approval-record`、`action-attention-state` | 历史授权与待处理状态 |
| `chat-plan-history`、`plan-history-page` | 计划的历史归属 |
| `financial-display`、`chart-presentation` | 精确金额与图表显示 |
| `context-compaction`、`conversation-context` | 历史压缩与上下文恢复 |

表内名称对应同名测试文件，扩展名为 `.test.ts`。
其余展示、诊断和条件边界以目录为准。

## 验证约束

纯执行器通过注入接口控制时间与副作用。
执行权测试使用真实数据库条件更新。
展示测试包含服务端渲染与状态转换。
它们不能代替浏览器点击和布局验证。

金额标签必须保留精确值。
图表坐标不能成为金融计算的输入。

运行：`pnpm exec vitest run tests/unit/planner`。
浏览器入口见 [../../e2e/CONTEXT.md](../../e2e/CONTEXT.md)。
