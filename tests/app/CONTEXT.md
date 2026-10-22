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

## 卡片虚拟卡消费

`card-consume-http.test.ts` 覆盖虚拟卡消费入口：
`POST /api/cards/[id]/consume`（成功 200 与错误码→HTTP 状态映射）与
`GET /api/cards/[id]/consumptions`（服务端用户范围内的消费记录，含 `?limit=` 校验）。

消费入账时间由服务端决定：请求体没有时间参数，命中 `occurredAt` 键即返回 `400 VALIDATION`
（伪造值表格、余额/流水/消费行前后一致、伪造时间不消耗 `executionKey`、月限额不可回溯绕过）。
入账瞬间固定为 `demoNow()`，`CardConsumption.createdAt` 仅秒级精度，
故排序与 `?limit=` 用例用 `seedConsumption` 直接写入不同 `occurredAt`；
真实 POST→GET 链路另有用例覆盖。

## 解锁入口

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

MFA 验证码与锁定事实的分布：
`malicious-input-http.test.ts` 的 `(a)` 是本目录唯一驱动错误验证码的用例，提交 `'000000'`（`MFA_CODE='123456'`）且只验证一次，断言 `mfaResult:'failed'` + `status:'awaiting_mfa'`，不触达三次锁定的终态；同用例的裸 `confirm` 断言 `requiresMfa:true` 重新提示。
`PendingAction.status='locked'` 只作为 `developer-chat-http.test.ts` 的 `it.each` 数据行出现，断言 `POST /api/developer/chat/reset` 返回 409 且会话 revision 与 transcript 不变。
`chat-http.test.ts` 测试 8 是本目录唯一的 MFA 提示文案断言（`toContain('验证码')`）与 `MFA_CODE` 不外泄断言。
`security_event` 断言只有 `kind:'injection'`（`chat-http.test.ts`、`malicious-input-http.test.ts`），没有 `kind:'locked'`，也没有 `message` 内容断言。
`__SECURITY_BLOCK__`、`chat.error.toolFailed`、`publicToolError`、`publicToolSummary`、`CIRCUIT_OPEN`、`/api/security/reset`、`GET /api/actions` 在 `cancel-safety-http.test.ts`、`malicious-input-http.test.ts`、`chat-http.test.ts`、`developer-chat-http.test.ts` 中均无匹配。

锁定（`status:'locked'`）在本目录是 200 域结果：`/api/actions/[id]/{confirm,verify}` 从不返回 423；
`423 CIRCUIT_OPEN` 只来自 `/api/security/reset`（`security-workflow-http.test.ts`）与 `manual-card-management.test.ts` 的代码层 `rejects.toMatchObject`。
本目录不核对锁定的用户可见文案：`securityLocked`、`toolFailed`、「验证码错误次数过多」、「安全中心」、「技能」均无匹配，也没有 `MfaCard`/`publicToolError` 渲染断言；锁定只按 `status`、`mfaResult` 与 DB 行断言。
全目录只有三处断言 `message` 文本：`manual-review-http.test.ts`（`'manual review'`）与 `card-consume-http.test.ts`（`occurredAt` 校验错误）。

数据库隔离与顺序执行见 [../CONTEXT.md](../CONTEXT.md)。
