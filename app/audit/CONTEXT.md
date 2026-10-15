# 开发者审计页面

## 数据与权限

`page.tsx` 按请求读取审计记录。
读取前先检查 `getServerDeveloperMode()`。
未启用时，只显示 `DeveloperModeRequired`。
审计数据不得进入普通模式的 HTML 或 RSC 输出。
`/api/audit` 独立检查相同偏好。

身份来自固定演示工作区。
`listAudit` 和 `getAuditSummary` 都按用户与会话过滤。
开发者模式是演示偏好，不是生产管理员认证。

## 显示

表格展示权限决定、验证与实际执行证据。
可展开信息包含已保存的参数、结果与计划关联。
上游负责敏感字段过滤，页面不得恢复验证码。

状态和权限标签使用本地化目录。
时间使用业务时区格式化。
普通操作历史位于 `/activity`。
技术表格在窄屏中独立滚动。

审计写入语义见
[audit/CONTEXT.md](../../audit/CONTEXT.md)。
验证入口见
[tests/app/CONTEXT.md](../../tests/app/CONTEXT.md)。
