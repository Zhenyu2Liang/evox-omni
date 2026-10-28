# 页面与 HTTP 边界

## 职责

页面读取数据并组合界面。
API 校验输入、调用领域模块并序列化结果。
业务权限、资金计算与恢复逻辑保留在所属模块。

根 `proxy.ts` 在页面、API 与静态请求前检查可信访问地址。
共享规则来自 `lib/request-origin.ts`，不能只比较请求自带的 Host 与 Origin。
API 正文类型、大小和同源检查由 `api/_lib/http.ts` 统一处理。
路由与页面不能自行扩大 `BANKING_ALLOWED_ORIGINS` 的信任范围。

当前使用 Next.js 16、React 19 与 Tailwind CSS 4。
修改框架代码前，必须阅读本地 Next.js 指南。
动态参数与 Cookie 按异步接口读取。
运行包的服务端配置见 `next.config.mjs`。

## 页面入口

| 路径 | 用途 |
| --- | --- |
| `/`、`/agent` | 默认跳转与智能助手 |
| `/overview` | 资产概览 |
| `/bills` | 月度账单与异常记录 |
| `/contacts`、`/cards` | 联系人与手动卡片管理 |
| `/investments`、`/subscriptions` | 理财与订阅 |
| `/schedules` | 定时记录、通知与到期检查 |
| `/activity`、`/security` | 业务记录与安全状态 |
| `/audit`、`/runs`、`/manual` | 开发者审计、运行与人工接管 |

布局与导航由 `layout.tsx` 和 `_components/` 组合。
普通模式隐藏开发者入口。
开发者偏好不是生产认证。
语言偏好仅影响界面显示。
`ThemeSwitcher` 提供浅色、深色和跟随系统，入口位于桌面侧栏与手机导航底部。
`layout.tsx` 读取 `banking_theme` Cookie，在首次 HTML 中设置 `data-theme`。
`lib/theme/ThemeProvider.tsx` 更新 Cookie、文档属性与跨标签页状态，不刷新或重建对话。
`globals.css` 通过 `color-scheme` 和 `light-dark()` 切换颜色，系统主题变化由浏览器处理。
白色容器使用 `banking-surface`，固定深色底使用 `banking-ink`，不得借用文字色充当容器色。
辅助说明使用 `text-banking-caption`（13px），状态徽标保留 12px。
文本输入框使用 `bank-input`，普通边框与聚焦轮廓都有明暗主题颜色。

## 身份与传输

Web 身份与接口表见 [api/CONTEXT.md](api/CONTEXT.md)。
所有浏览器使用服务端配置的同一演示工作区。
对话历史、业务数据与待处理操作在浏览器间共享。

服务端页面通过 SDK、审计模块或仓储读取数据。
客户端通过 API 发出业务请求。
传给客户端的金融值使用精确字符串。

读取数据库的服务端页面按请求渲染。
构建需要已生成的 Prisma 客户端。
构建前不必重置或播种开发库。

## 对话渲染边界

`/agent` 页面只把服务端快照传给 `components/chat/ChatWindow`。
确认/MFA 面板、工具事件与失败文案（含 `chat.error.*` 键）全部在 `components/chat/` 渲染。
`app/` 不筛选、不清洗 `AgentStreamEvent`：`api/chat/route.ts` 的 SSE 帧与 `api/actions/[id]/verify/route.ts` 的 `events` 都原样转发。
本层没有任何计时器、心跳帧、`maxDuration`/`runtime`/`dynamic` 段配置或重试/超时包装：`app/` 内 `setTimeout`/`setInterval`/`new Promise` 均为 0 处，`POST /api/chat` 的墙钟时间全部来自下游轮次，等待期间没有任何计时逻辑。
浏览器客户端实际落在 JSON 分支：`wantsStream` 在 `Accept` 含 `application/json` 时返回 false，而 `components/chat/actions.ts` 同时声明 `text/event-stream` 与 `application/json`，因此演示中的一轮对话是一个 `{ ok, data }` 响应体，SSE 只服务仅接受 `text/event-stream` 的调用方。
详见 [api/CONTEXT.md](api/CONTEXT.md) 的 “Chat mode selection and edge timing”。
排查聊天文案、`security_event` 或面板显隐时进入 `components/chat/`，不得在 `app/` 内继续搜索。
`app/` 对 `PendingAction` 只读，读取点为 `agent/history.ts`、`agent/plan-history.ts`、`security/page.tsx`（经 `listPendingActions`）、`api/actions/route.ts`（`listPendingActions({ sessionId })`，无状态参数，状态由 `attentionFor` 在内存判定）、`api/security/route.ts`、`api/_lib/task-pending-actions.ts`；写入（含 `status`）全部经 `@/agent`、`@/security` 与 `lib/db/repositories/pendingAction.ts` 完成。
因此本层没有把 `locked` 行改回 `pending`/`awaiting_mfa` 的路径，锁定与否只看仓储与网关。
本层不渲染 `components/chat/` 的任何卡片或文案键：`app/` 内不出现 `MfaCard`，也不出现 `cards.mfa.title|locked|hint|placeholder|processing|failedAttempts|failedAttemptsLimit`、`cards.terminal.locked` 与 `chat.approval.status.locked`；这些全部只在 `components/chat/` 渲染。
`app/` 内只有两处验证码输入：`security/UnlockPanel.tsx`（`name="verificationCode"` + `aria-label` = `security.reset.codeLabel`）与 `cards/CardChangeDialog.tsx`（`input[name="code"]`，无 `aria-label`、无 `placeholder`，标签为 `cards.mfa.label`）。
DOM 钩子约定：`app/` 内没有任何 `data-testid`，全仓用语义化 `data-*` 钩子与 `role`/`aria-*` 定位（见 [investments/CONTEXT.md](investments/CONTEXT.md)、[cards/CONTEXT.md](cards/CONTEXT.md)、[security/CONTEXT.md](security/CONTEXT.md)）；改名会破坏 `tests/e2e/`。

## 锁定终态（MFA 连续失败）

`locked` 在本层是终态，刷新页面或恢复会话都不重新激活，也不提供验证码入口。
`api/actions/route.ts` 只 surfacing `pending`/`awaiting_mfa`/`needs_reconciliation` 与未结算的 `confirmed`；`locked` 永不出现。
`api/actions/[id]/verify|confirm|cancel|recover` 对 `locked` 行返回结构化失败（`CIRCUIT_OPEN` + `reason: 'mfa_session_locked'`），不写库、不执行、不重放。
历史投影卡片的状态恒等于持久化行状态，只有开放态行才可能重建可提交面板。
`/security` 展示锁定原因、已锁定操作与运行时解锁入口；解锁只清除熔断状态与连续失败次数，不重开已锁定的操作行、不自动重试、不自动执行，用户必须重新发起并重新确认。
该语义由 `app/security/UnlockPanel.tsx` 的四条键渲染：`security.reset.lockReason`（`{count}`/`{max}`）、`security.reset.lockedActionState`、`security.reset.reinitiate`（段落带 `data-unlock-reinitiate`）、`security.reset.recovery`；既有 `data-unlock-panel` 等钩子不变，开发者维护面板以 `data-developer-breaker-reset-panel` 为作用域钩子。
契约细节见 [api/CONTEXT.md](api/CONTEXT.md)、[security/CONTEXT.md](security/CONTEXT.md)、[agent/CONTEXT.md](agent/CONTEXT.md)。

## 对外文案收口（内部信息不得外泄）

本层所有经 HTTP 或异常进入浏览器的文本都必须经 `lib/public-text.ts` 收口，判据只来自结构化字段与 `isInternalDiagnostic`，不得复制净化正则。

- `api/security/route.ts` + `api/_lib/public-security-event.ts`：`events` 与 `status.recentEvents` 都经 `publicSecurityEvent` 投影——`kind`/`severity`/`timestamp`/`id`/`userId`/`sessionId` 原样，`message` 为空或诊断为真时置空串（合法审计散文逐字保留），`detail` 非 JSON 安全或任一字符串叶子诊断为真时整字段省略；事件本身不筛选、不删减。
- `security/page.tsx`：审计散文以 `isInternalDiagnostic` 作闸门（不套白名单 `safePublicText`，否则会丢掉合法审计描述），诊断文本替换为 `security.events.kind.<KIND>` 标签。
- `security/UnlockPanel.tsx`、`security/ResetBreakerButton.tsx`：结构化拒绝码走 `securityNotice({ code })`，其他失败文本走 `safePublicText`，成功文案来自消息目录。
- `schedules/page.tsx`：派发错误、提醒正文与页面级错误都经 `schedules/public-task-text.ts#publicScheduleText`（`isInternalDiagnostic` 闸门 + 既有 catalog 兜底，同样不做白名单替换）。

因此对外 JSON 与 DOM 永不出现 `__SECURITY_BLOCK__`、`decisionKind`、原始 JSON 片段、异常堆栈与 `undefined`。
SSE 帧（`api/chat`、`api/runs/[id]/events`、`api/chat/history`）仍原样转发 `AgentStreamEvent`，其文本收口由 `components/chat/` 渲染层承担（见 [api/CONTEXT.md](api/CONTEXT.md)）。

## 金额与收益率换算边界

本层几乎不做算术，`lib/decimal` 的百分比函数（`signedRateToPercent`/`rateRatioToPercent`/`nonNegativeDecimal`）在 `app/` 内**零调用**，排查换算问题不得在本层继续搜索。

- `subscriptions/page.tsx`：唯一金额运算点——`annualCost`/`totalAnnualCost` 用 `moneyToCents` + `centsToMoney` + `addMoney` 以 BigInt 分年化合计（`BILLINGS_PER_YEAR`）；`/app` 内 `addMoney` 只出现在此文件。
- `bills/page.tsx:81`：`compareDecimal(analysis.momChangePct, '0') > 0 ? '+' : ''` 只决定符号前缀，`momChangePct` 原样拼接，不取绝对值、不 `Number()`。
- `app/` 全目录无 `Math.abs`、`Number(`、`parseFloat`、`parseInt`、`toFixed`。
- 持仓收益率 `HoldingView.profitRate` 可为负，渲染在 `components/banking/HoldingFacts.tsx:91`（`signedRateToPercent`）；`rateRatioToPercent` 内含非负闸门、负值抛 `AppError('VALIDATION')`，只用于产品年化 `annualYieldRate`。
- `addDecimal` 在 `app/` 内只出现在 `api/dashboard/CONTEXT.md` 的引文里；`/api/dashboard` 原样透传 SDK 的十进制字符串，不在边界上取整。

## 修改约束

- 客户端不得导入数据库客户端或业务执行模块。
- HTTP 错误与 SSE 格式必须复用 `api/_lib/http.ts`。
- 确认结果必须采用服务端返回的业务状态。
- 页面职责变化时，必须更新对应子目录说明。

界面规则见 [components/CONTEXT.md](../components/CONTEXT.md)。
开发和测试命令见 [development.md](../docs/cn/development.md)。
