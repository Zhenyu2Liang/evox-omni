# 操作记录页面

`page.tsx` 按请求读取所属演示工作区的业务记录。
入口为 `audit.listOperationHistory({ userId, sessionId })`。
`ActivityRecord` 只包含允许公开的业务字段。
`ActivityHistory.tsx` 展示名称、时间、状态与验证结果。
记录使用带分隔线的紧凑列表，时间与验证结果并排排列，窄屏允许换行。
压缩留白不减少记录条目，也不隐藏原始记录时间或验证结果。

这是事件历史，不是当前待确认列表。
旧状态表示该事件发生时的状态。
当前确认或验证在助手的授权面板处理。

本页面不展示原始工具参数、提示词与诊断。
技术详情由开发者页面 `/audit` 提供。
内部记录标识仅作 React 键，不作为可见内容。

验证入口：
- `tests/unit/lib/activity-presentation.test.ts`。
- `tests/e2e/activity.e2e-helper.ts`。
- `tests/e2e/card-freeze.e2e-helper.ts`。
