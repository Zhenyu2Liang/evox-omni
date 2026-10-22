# Security Center (`/security`)

## Intent

安全中心只**读**地消费 `@/security` 与 `@/audit` 的权威状态（熔断状态、失败计数、安全事件），
并向固定演示用户提供一个显式的运行时解锁入口。
本目录不判定任何银行授权、不计算风险、不筛选 `AgentStreamEvent`：页面只呈现服务端事实。

## 组件职责

| 文件 | 类型 | 职责 |
| --- | --- | --- |
| `page.tsx` | Server Component | 读取熔断状态、安全状态、事件与已锁定操作，组合全部区块；负责事件文案清洗 |
| `UnlockPanel.tsx` | Client Component | 运行时解锁：6 位验证码 → `POST /api/security/reset`，任何身份（含非开发者）可见 |
| `ResetBreakerButton.tsx` | Client Component | 仅开发者可见的演示维护入口：无凭证 `POST /api/developer/security/reset` |

`ResetBreakerButton` 与运行时解锁是两条独立路径：前者是演示维护，后者是用户的受控解锁。

## 锁定终态的呈现契约

- 锁定状态与连续失败次数**只**来自 `security.circuitBreaker.getState(sessionId)`（DB 持久、按 owner 共享）
  返回的 `{ locked, failures, max, lockedAt }`。`max` 缺失时回退到 `MFA_MAX_ATTEMPTS`。
- 锁定**原因**只来自结构化来源：`breaker.locked` 决定是否呈现，
  `SecurityEvent.kind === 'CIRCUIT_BREAKER_TRIPPED'`（其 `detail` 携带 `{ failures, max, result: 'session_locked' }`）
  决定原因标签与记录时间，`breaker.lockedAt` 作为时间回退值。
  禁止用中文文案正则或字符串匹配判断原因——文案可变，`kind` 是契约。
- 锁定区块内依次呈现：`CircuitBreakerStatus`（状态条 + 失败计数）→ 结构化锁定原因
  （`security.events.kind.CIRCUIT_BREAKER_TRIPPED` + `security.breaker.failureCount` + 时间）
  → `UnlockPanel` → `ResetBreakerButton`。

## 已锁定操作清单

- 数据：`listPendingActions({ sessionId, status: 'locked', limit: 20 })`（`lib/db/repositories/pendingAction`）
  的**只读**查询。本目录永不写 `PendingAction.status`，也不调用 `claimPendingAction` 等写路径。
- `summaryJson` 是序列化的 `PendingActionSummary`，一律经 `safeParse` 解析；解析失败退化为本地化工具名，
  不抛异常、不输出原始 JSON。`title` 与 `fields` 的 `label`/`value` 先过 `isInternalDiagnostic`，
  诊断为真的字段整条不渲染。
- 工具名优先映射到 `chat.tool.<toolName>`（`isMessageKey` 守卫），无对应 key 时显示原始 `toolName`。
- 列表为空时**整块不渲染**；区块标题复用现有 key（`pages.activity.status.locked`），不新增 key。

## 解锁语义

- 入口：`POST /api/security/reset`，body 可选 `{ verificationCode?: string }`（6 位数字 mock 码，
  页面不硬编码、不显示该码）。
- 账户锁定时无正确验证码 → 路由抛 `CIRCUIT_OPEN` → HTTP 423，**锁保持不变**；
  `UnlockPanel` 的「6 位数字」前端校验只是省一次往返，真正的门在服务端。
- 解锁只清除熔断计数（`failures` 归零、`locked` 复位），**不重新打开**已 `locked` 的操作，
  **不自动重试**、**不自动执行**原操作。用户必须重新发起请求并重新确认；被解锁的操作行本身仍是终态。
- 面板无轮询、无自动解锁、无自动重试，也不读写 cookie / `localStorage` 保存验证码。

## 渲染收口

- 来自 HTTP 或异常的文本**从不**直接渲染：结构化拒绝码（`MFA_LOCKED` / `MFA_FAILED` / `CIRCUIT_OPEN`）
  走 `securityNotice({ code })`，其他失败文本走 `safePublicText(message, t, fallback)`，
  成功文案来自消息目录（路由的 `data.message` 散文被忽略）。
- 审计事件行以结构化 `kind` 的 i18n 标签 `security.events.kind.<KIND>` + `severity` 为权威，
  自由文本 `message` 仅在**非空且** `isInternalDiagnostic(message)` 为假时附加显示，否则整行替换为
  `kind` 标签，因此 `__SECURITY_BLOCK__` 载荷、原始 JSON、堆栈与 `decisionKind` 不会进入 DOM。
- 审计散文**不**套 `safePublicText`：该函数只放行白名单/闭合正则的文本，会把合法审计描述替换成
  通用兜底文案，从而丢失审计事实。故本页用 `isInternalDiagnostic` 作闸门，而非白名单渲染。

## 已知边界

- `components/security/SecurityEventList` 原样渲染 `event.message`，因此事件清洗必须在本页完成；
  `components/` 不归本节点，如需改在组件内清洗须另行转派。
- 组件库只导出 `PermissionLegend`、`SecurityEventList`、`CircuitBreakerStatus`；解锁面板是本目录的
  本地客户端组件，不进入 `components/`。
- 文案缺口：没有「解锁后需重新发起并重新确认，原操作不会自动执行」与「当前有 N 个已锁定操作」的
  专用 key，现用 `pages.security.unlockDescription` + `chat.error.actionLocked`（+ `pages.activity.status.locked`
  计数徽章）组合表达。

## 测试与验证（只读参考）

- `tests/app/developer-security-http.test.ts`：开发者重置的模式门、严格审计回滚与无银行副作用。
- `tests/e2e/`：浏览器旅程 `j-circuit-breaker-lock` 覆盖常规可见性、三次失败后持久锁定与重置按钮。
- 依赖：`@/security`（熔断状态与审计解锁）、`@/audit`（安全事件读模型）、
  `@/lib/db/repositories/pendingAction`（只读已锁定操作）、`@/lib/public-text`（文案收口）、
  `@/lib/i18n`（默认中文）、`@/lib/developer-mode`（开发者维护偏好）、`@/app/api/_lib/session`（固定演示身份）。
