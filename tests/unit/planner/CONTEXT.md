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

## 回复修复与语义缺口

`reply-format.test.ts` 与 `reply-repair.test.ts` 只验证协议信封。
`inspectReplyFormat` 只识别 guidance、reasoning、assistant、tool envelope。
普通散文一律放行，不检查语义含义。
本目录没有断言"无工具调用的散文确认声明应被拒绝或纠正"。
模型用散文声称"请在面板确认"却不发出工具调用时无测试覆盖，也无修复路径。
服务端确认面板只在该工具调用持久化 `PendingAction` 后出现。
会话策略测试只覆盖 mock 分类器，不覆盖真实模型散文。
`conversation-evidence.test.ts` 只拒绝散文作为查询证据，不涉及确认声明。

## 相关但不在本目录

模型提案与逐轮声明测试位于 [../agent/providers/CONTEXT.md](../agent/providers/CONTEXT.md)。
包含 `mock-plan-proposals.test.ts` 与 `mock-turn-declaration.test.ts`。
完整参数写入产生真实工具调用，信息不足才走 clarification。
