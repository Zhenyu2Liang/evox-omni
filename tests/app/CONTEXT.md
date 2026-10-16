# HTTP 路由集成测试

## 范围与工具

测试直接调用真实 Next.js 路由处理器。
请求使用 `NextRequest`，动态参数使用异步上下文。
这是进程内集成测试，不启动真实浏览器。

`harness.ts` 提供请求构造、结果读取与 SSE 解析。
`postJson`、`postRaw`、`getJson` 接收实际处理器。
动态路由使用 `idCtx(id)`。
`readSse` 返回结构化流事件。
辅助模块复用生产权限判断。

## 身份与断言

Web 路由固定使用配置的演示用户与会话。
Cookie 或查询参数不能选择其他工作区。
辅助模块保留 Cookie 参数，用于验证身份伪造不生效。
不能因没有认证 Cookie 就断言请求必为 403。
跨用户或会话资源仍需验证所有权拒绝。

核心断言包含输入校验、封装格式、SSE 和持久化结果。
HTTP 200 不等于业务成功。
错误验证码与终态拒绝需检查 `data.ok` 和实际状态。
`CIRCUIT_OPEN` 在写入检查处可映射为 HTTP 423。

覆盖对话、确认、验证、取消、恢复和任务控制。
也覆盖业务记录、联系人、卡片、安全与开发者入口。
开发者偏好与金融授权分别断言。

解锁入口必须区分：
- `/api/security/reset` 使用验证码或冷却策略。
- `/api/developer/security/reset` 使用开发者模式重置策略。

执行命令：`pnpm exec vitest run tests/app`。

## 覆盖与缺口

面板、`confirmation_required`、`mfa_required` 断言只来自真实工具调用被网关拦截并持久化 `PendingAction`。
`nl-entry-http.test.ts` 是唯一读取助手散文文本的用例（`assistantText`），仅覆盖“缺参数→澄清”。
没有任何用例断言“散文声称需确认/等待确认，但未发出工具调用”的回合。
关键词 `panel`、`prose`、`hallucinat` 在本目录无匹配。
`waiting` 多指 `waiting_confirmation` 状态；`claim` 指 DB 执行 claim。

数据库隔离与顺序执行见 [../CONTEXT.md](../CONTEXT.md)。
