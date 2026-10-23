# Security Center (`/security`)

## Intent

安全中心只**读**地消费 `@/security` 与 `@/audit` 的权威状态（熔断状态、失败计数、安全事件），
并向固定演示用户提供一个显式的运行时解锁入口。
本目录不判定任何银行授权、不计算风险、不筛选 `AgentStreamEvent`：页面只呈现服务端事实。

## 组件职责

| 文件 | 类型 | 职责 |
| --- | --- | --- |
| `page.tsx` | Server Component | 读取熔断状态、安全状态、事件与已锁定操作，组合全部区块；负责事件文案清洗 |
| `UnlockPanel.tsx` | Client Component | 运行时解锁：6 位验证码 → `POST /api/security/reset`，任何身份（含非开发者）可见；同屏呈现解锁语义四要素 |
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

## 解锁面板渲染契约（`UnlockPanel`）

- 面板依次渲染：`pages.security.unlockDescription` → `chat.error.actionLocked`（这两段既有散文恒定保留，
  不得删除或改写）→ 四个 `security.reset.*` 事实 → 锁定影响块 → 验证码表单 → 实时状态区。
- 四个 `security.reset.*` 键的职责（键集与 `business.en.json` 对称，增删键走共享 i18n 文件，不在本层新建）：
  - `security.reset.lockReason`（参数 `{count}` `{max}`）：**只在 `locked=true` 时**渲染，用权威 `failures`/`maxAttempts`
    插值；无锁定时渲染锁定原因即为假事实。模板占位符不得出现在 DOM 中。
  - `security.reset.lockedActionState`：已锁定的操作保持终态，解锁不会把它变回待确认操作。
  - `security.reset.reinitiate`：解锁后必须重新发起并重新确认，原操作不会自动执行——强制提示，两种态都渲染。
  - `security.reset.recovery`：解锁方式（输入 6 位验证码并提交「重置失败计数」）与它实际清除的范围。
- 面板根节点 `data-*` 钩子（两种态恒在，浏览器套件据此定位）：`data-unlock-panel`、`data-unlock-locked`、
  `data-unlock-failures`、`data-unlock-max-attempts`、`data-unlock-locked-actions`、`data-unlock-status`，
  以及强制提示段落上的 `data-unlock-reinitiate`（该钩子元素的直接文本即整句「解锁后需重新发起并重新确认，
  原操作不会自动执行。」）。
  `data-unlock-impact` 仅在 `lockedActionCount > 0` 时出现，值即锁定操作数量。
- 恒为**单一**验证码输入（`name="verificationCode"`，`aria-label` 等于 `security.reset.codeLabel`）+ 单一提交按钮；
  验证码不写入 cookie / `localStorage`，页面不硬编码也不显示 mock 码。
- 开发者维护入口：wrapper 带 `data-developer-breaker-reset-panel`，按钮带 `data-developer-breaker-reset`；
  非开发者模式下整块返回 `null`，两个钩子都不出现——因此 e2e 断言「此处没有开发者重置」必须限定在该面板内。

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
- 解锁**只**清除熔断状态与失败次数（`failures` 归零、`locked` 复位），**不重新打开**已 `locked` 的操作，
  **不自动重试**、**不自动执行**原操作。已锁定操作仍是终态行；用户必须重新发起请求并重新确认，
  面板用 `security.reset.lockedActionState` + `security.reset.reinitiate` 把这条强制要求写在界面上。
- 面板无轮询、无自动解锁、无自动重试，也不读写 cookie / `localStorage` 保存验证码。

## 渲染收口

- 来自 HTTP 或异常的文本**从不**直接渲染，统一经 `lib/public-text.ts`：
  - 结构化拒绝码（`MFA_LOCKED` / `MFA_FAILED` / `CIRCUIT_OPEN`）走 `securityNotice({ code })`（`UnlockPanel`）。
  - 其他失败文本走 `safePublicText(message, t, fallback)`：内部诊断（`__SECURITY_BLOCK__` 载荷、原始 JSON、
    堆栈、`undefined`/`null`/`[object Object]`）一律替换为目录兜底 key，合法业务文案放行。
    `UnlockPanel` 用 `security.reset.failed` 兜底，`ResetBreakerButton` 同样用它，**不复制**净化正则。
  - 成功文案来自消息目录（路由的 `data.message` 散文被忽略）。
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

## 测试与验证（只读参考）

- `tests/unit/security/unlock-panel-render.test.ts`：面板既有渲染契约（`data-*` 钩子、单一验证码输入、两段散文、无泄漏）。
- `tests/unit/security/unlock-panel-notice.test.ts`：四个 `security.reset.*` 事实、`data-unlock-reinitiate`、
  `{count}`/`{max}` 插值、两态钩子齐备、无内部诊断。
- `tests/unit/security/developer-reset-panel-hook.test.ts`：开发者维护面板的 `data-developer-breaker-reset-panel`
  与 `data-developer-breaker-reset`，以及非开发者模式下的空渲染。
- `tests/app/developer-security-http.test.ts`：开发者重置的模式门、严格审计回滚与无银行副作用。
- `tests/e2e/`：浏览器旅程 `j-circuit-breaker-lock` 覆盖常规可见性、三次失败后持久锁定与重置按钮。
- 依赖：`@/security`（熔断状态与审计解锁）、`@/audit`（安全事件读模型）、
  `@/lib/db/repositories/pendingAction`（只读已锁定操作）、`@/lib/public-text`（文案收口）、
  `@/lib/i18n`（默认中文）、`@/lib/developer-mode`（开发者维护偏好）、`@/app/api/_lib/session`（固定演示身份）。
