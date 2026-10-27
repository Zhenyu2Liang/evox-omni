# 对话与授权交互

成功结果的最后一条说明只在最近工具记录具有明确的 executed 授权及结果卡，
且同轮不存在未完成、失败、安全拒绝或待核对信号时默认折叠。
`canCompactResultExplanation` 只读取结构化状态，不通过文字猜测业务结果。
新用户消息、正在处理的授权、缺失的历史上下文均阻止折叠。
原文保留在可展开的说明中；会话存储和金融事实不变。
已完成的授权步骤与字段默认收在详情中；其他状态继续直接显示步骤与错误说明。

## 职责与入口

成功业务的助手回复可携带服务端生成的 `financialSummary`。
默认显示该摘要，完整原文保留在“查看结果说明”中。
失败和待核对结果不生成成功摘要。
`presentation-messages.ts` 只合并相同操作标识的授权展示。
当前授权仅在底部面板中交互，终态保留一张历史记录。
此投影不修改保存的消息，迟到的待验证记录不能覆盖终态。
旧理财回执补充展示字段时更新原卡片，不重复追加金额卡。
`ApprovalProgress` 在活动面板与历史记录中展示同一套阶段。
结算后的授权进度和业务回执在同一张操作卡内展示。

`ChatWindow` 组合消息、工具记录、历史和输入框。
`Composer` 向使用帮助注册示例填入回调。
示例只填入空闲且为空的输入框，不自动发送，也不覆盖草稿。
存在待确认或待核对操作时，帮助示例不可用。
引导偏好与展示规则见 [help/CONTEXT.md](../help/CONTEXT.md)。
`useAgentStream` 是状态化 Hook：持有 `ChatUIState`、发起请求、应用事件批次。
`agent-stream-reducer.ts` 承载纯折叠逻辑（`ChatUIState`、`applyEvent`、`reduceAgentEvents`、`settleAction`、`upsertToolEvent`、`visibleRefs`、`pickPendingAction`、`reconcileInterruptedHistory` 等），`useAgentStream` 重新导出它，调用方与测试不必改导入路径。
`reduceAgentEvents(state, events, t = createTranslator(DEFAULT_LOCALE))` 的第三参可选；两参调用继续可用，缺省使用默认语言 translator。
`actions.ts` 封装对话、操作与计划请求。
`transport-validation.ts` 校验返回的传输结构。
`history.ts` 与 `history-request.ts` 处理分页和恢复。

`AssistantMarkdown` 渲染助手的 Markdown。
`ChatAvatar` 为助手和用户提供本地矢量头像。
每个实例使用独立的渐变标识，不请求外部图片。
用户消息保持原文。
原始 HTML 与图片请求关闭。
链接采用允许的协议与相对路径。

## 消息与历史

消息按记录的时间生成日期分隔，时区为北京时间。
日期使用固定年月日，不以浏览器当前日期覆盖历史时间。
空的授权占位不生成日期分隔，加载旧消息后同日仍只分隔一次。
日期分隔不占用消息身份，历史锚点继续按原消息恢复。
单张银行卡结果在对话中收窄，多张银行卡保留网格布局。

普通助手文字和工具记录分别展示。
每个工具结果保留所属调用与消息身份。
计划快照更新原历史位置。
恢复后的计划不附加到无关的新回复。

历史请求保留分页游标、草稿与滚动位置。
重置与新请求通过代次和修订号排除旧响应。
不得用迟到的历史结果覆盖当前流状态。

## 用户决定

当前确认或验证在 `ApprovalRequest` 中交互。
历史卡片由 `cards/ApprovalRecord` 展示。
历史记录不重复提供确认或验证码入口。
操作完成状态采用服务端 `action_settled` 与返回结果。
错误验证码可以是 HTTP 200 的业务拒绝。

挂起操作从 `GET /api/actions` 恢复。
展示需区分待决定、处理中、可恢复和待核对。
`PlanCard` 的控制请求绑定具体计划标识。
暂停与恢复采用服务端返回的持久化状态。

终态失败时实时弹窗关闭且不再重开：`settleAction` 在终态或 `confirmed` 时清除 `pendingAction`，并把该 `actionId` 记入内存态 `settledActions`。
`controlTask` 与 `restoreActionAttention` 均经 `visibleRefs` 过滤，跳过 `hasSettledAction` 为真的行（命中 `settledActions` 或存在终态内联卡片），`pickPendingAction` 不再为已终态动作重建弹窗，`needs_reconciliation` 行始终保留。
`locked` 属终态，走同一清除与过滤路径：不产生「可继续」提示，也不重建待决策面板。

`MfaCard` 依 `pending.status`/`pending.statusMessage` 渲染只读终态；`failed` 用 `publicToolError` 渲染原因，`locked` 渲染「原因 + 状态 + 解锁入口」三段（见下）。
失败尝试文案按剩余次数选择：`attempts < maxAttempts` 渲染 `cards.mfa.failedAttempts`（`{attempts}`，`次。` 结尾），达到上限（`attempts >= maxAttempts`）渲染 `cards.mfa.failedAttemptsLimit`（`{attempts, maxAttempts}`）。
`maxAttempts` 缺省时回落 `cards.mfa.failedAttempts`。
`ApprovalRequest` 转发之，`ChatWindow` 传 `maxAttempts`（`MFA_MAX_ATTEMPTS`）。

唯一活动面板由 `ChatWindow` 以 `key={pending.actionId}` 挂载 `ApprovalRequest`（`MfaCard` 亦以 `key={pending.actionId}`），并写出 `data-approval-request`/`data-action-id`/`data-kind`。
`pendingAction` 只由 `confirmation_required`/`mfa_required` 或挂起操作恢复建立，关闭只来自 `settleAction` 的终态/`confirmed` 与 `pull` 的无错误清除规则。
`tool_start`/`tool_end` 的 `blocked` 只记录 `lastBlockedToolName`，既不关闭也不替换面板；无 `actionId` 时更不会创建新面板。

### 授权摘要字段（`PendingActionSummary.fields`）的透传

`PendingActionSummary`（`lib/contracts/security.ts`）没有专用费用/手续费/汇率等字段：`amount` 是受控金额，任何附加标注（费用口径、费率、来源说明）只能作为 `fields: Array<{label, value}>` 的一条通用条目传输。
本目录不做字段白名单：`transport-validation.ts` 只要求 `{label: string, value: string}`，`actions.ts#extractSummary` 同样只校验 label/value 为非空字符串，不限制取值。
`agent-stream-reducer.ts` 的 `confirmation_required` 直接 `summary: event.action`；`mfa_required` 与刷新恢复经 `lib/action-summary.ts#withActionPolicy`，它只改写 label 恰为 `'风险等级'` 的那一条，其余条目原样保留。
`ApprovalRequest` 把 `pending.summary` 原样作为 `action` 传给 `ConfirmationCard`/`MfaCard`，不增删或过滤字段；因此服务端下发的任意 `{label:'费用口径', value:…}` 会一路到达卡片渲染。
`decisionKey.ts` 把 `fields` 全量编入决策身份键，故服务端改变某条字段值即改变该决策的身份（影响去重与结算匹配），新增字段同理。

### 验证面板的 DOM 钩子

仓库不用 `data-testid`，只认语义 `data-*`、`role`/`aria-label` 与本地化可访问名。
验证码输入框无 `data-*`，唯一钩子是 `aria-label={t('cards.mfa.label')}`（zh-CN「验证码」），故为 `[data-approval-request="true"] input[aria-label="验证码"]`。
锁定后存活的表面是 `cards/ApprovalRecord`（底部 `ApprovalRequest` 随 `pendingAction` 清除而卸载），其专用钩子为 `data-approval-locked="true"`，`MfaCard` 的 `data-mfa-locked="true"` 相应不可观测。
`data-status`/`data-approval-stage`/`data-stage-status` 给出不依赖文案的状态断言；文案上「已锁定」（`cards.terminal.locked`）是「验证已锁定」（`chat.approval.status.locked`）的子串，包含式断言无法区分两者。

### 验证响应校验与分支（`actions.ts#postAction`）

`status` 须属 `ACTION_STATUSES`（`pending`/`awaiting_mfa`/`confirmed`/`executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`）。
`mfaResult` 仅接受 `undefined`/`'success'`/`'failed'`/`'not_required'`。
任一字段不符即以 `failure('', GENERIC_ERROR)` 失败，只折叠出一条 `error` 事件；
`pull` 因 `hasError` 不清除 `pendingAction`，验证卡保持打开。

`awaiting_mfa` 且 `requiresMfa` 且 `tier==='RED'` 且未执行且 `mfaResult!=='failed'` 时合成 `mfa_required`（不追加错误）。
可重试的错误验证码落到追加 `error` 的支路，且不合成 `security_event`，避免同一拒绝重复上屏。
`securityFacts(record)` 读取 `ActionResponse` 顶层 `code`/`attemptsLeft`/`maxAttempts`（优先）以及嵌套 `failure.code`/`failure.reason`/`failure.attemptsLeft`/`failure.maxAttempts`：`reason` 只取自 `failure` 且须属 `SECURITY_FAILURE_REASONS`，`code` 接受任意非空字符串（无枚举白名单），计数须为非负整数；非法值逐项丢弃，非法组合不让整份响应失败，且不保留任何自由文本。
字段优先级：`code` 顶层优先、缺失才回落 `failure.code`；`attemptsLeft`/`maxAttempts` 顶层优先、回落嵌套。
客户端用局部 `SecurityFacts`（`code?: string`）而非 `SecurityFailure` 契约：`SecurityFailure.actionId` 与 `attemptsUsed` 在本目录从不读取，动作身份一律取响应顶层 `actionId`。
`status` 为 `locked`/`failed` 且 `code` 或 `reason` 存在时，用这些事实合成一条 `security_event`（`{type:'security_event', kind, actionId, ...securityFacts(record)}`，`kind` 取 `status === 'locked' ? 'locked' : 'denied'`，不带 `message`）；`record.events` 已带同 `actionId` 且同 `kind` 或同 `code` 的事件时不重复合成。
只有 `attemptsLeft`/`maxAttempts` 而无 `code`/`reason` 时不合成 `security_event`，该拒绝只留 `error` 事件。终态状态（`TERMINAL_ACTION_STATUSES`，含 `locked`）追加 `action_settled`（`{actionId, status, message?}`；该契约不带 `code`/`reason`/`attemptsLeft`）。
`settleAction` 对匹配 `actionId` 的终态清除 `pendingAction`。
`pull` 的 `clearPending` 守卫要求 `!hasError`，故带 `error` 的响应不会清除决定，除非 `settleAction` 已清。

## 授权/验证面的 DOM 契约（浏览器测试的定位面）

面板是否出现只由 `pendingAction` 决定：`ChatWindow.tsx:237-238` 在 `pending && <ApprovalRequest key={pending.actionId} …/>`，挂在 `[data-chat-composer-dock="true"]`（`ChatWindow.tsx:226`）内、滚动区 `[data-chat-scroll="true"]` 之外。
`pendingAction` 只来自本轮 `confirmation_required`/`mfa_required` 事件，或 `pickPendingAction` 从 `GET /api/actions` 中挑选的 `pending`/`awaiting_mfa`（`decision` attention）行（`agent-stream-reducer.ts:554-573`）。
故「面板存在」⇔ 服务端存在一条未终态的 `PendingAction`，或本轮刚收到 `mfa_required`；模型文字不产生面板。

`ApprovalRequest.tsx:23-25` 的容器是唯一带 `data-approval-request` 的元素：
`<section tabIndex={-1} aria-label={t(pending.kind === 'mfa' ? 'chat.approval.verification' : 'chat.approval.confirmation')} data-approval-request="true" data-action-id={pending.actionId} data-kind={pending.kind}>`，并在 `actionId`/`kind` 变化时 `focus({preventScroll:true})`。
标题行文字与 `aria-label` 同键；`kind === 'mfa'` 渲染 `MfaCard`（另带 `key={pending.actionId}`），否则 `ConfirmationCard`。

`ConfirmationCard` 与 `MfaCard` 都走 `ui/Card layout="request"`：标题区 + 可滚动 body + `footer`（`Card.tsx:45-60`）；`footer === undefined` 时按钮区整块消失。
按钮均为 `ui/Button` → `<button type="button" disabled={disabled || loading} aria-busy={loading || undefined}>`（`Button.tsx:55-79`），文案 `cards.cancel`/`cards.confirm`/`cards.verify`。
`ConfirmationCard`：取消 `disabled={busy || !canCancel}`、确认 `loading={busy} disabled={busy || !canConfirm}`（`ConfirmationCard.tsx:72-92`）。
`MfaCard`：取消 `disabled={busy}`、验证 `loading={busy} disabled={!canSubmit}`，`canSubmit = /^\d{6}$/.test(code.trim()) && !busy && !readOnly`（`MfaCard.tsx:52-68`）。

MFA 输入框（`MfaCard.tsx:90-106`）没有 `maxLength`、`name` 与任何 `data-*`：唯一稳定选择器是 `[data-approval-request="true"] input[aria-label="{cards.mfa.label}"]`（zh-CN 文案「验证码」）。
其余属性：`type="text"`、`inputMode="numeric"`、`autoComplete="one-time-code"`、`placeholder={cards.mfa.placeholder}`、`disabled={busy}`，值是本地受控 state；Enter 触发 `preventDefault()` + 提交。
`hint`（`localizeVerificationHint`，缺省 `cards.mfa.hint`）只在非只读时渲染。

终态（`asTerminalStatus`：`executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`）时 `footer` 被替换：`ConfirmationCard` 换成 `cards.terminal.*` 徽标；`MfaCard` 保留 body 内的 `<p role="status">{cards.terminal.*}</p>` 且不再渲染 footer。
已尝试次数只由 `MfaCard` 输出（`MfaCard.tsx:108-114`）：`attempts > 0` 时渲染 `<p role="status">`，`attempts >= maxAttempts` 用 `cards.mfa.failedAttemptsLimit`（`{attempts, maxAttempts}`），否则 `cards.mfa.failedAttempts`（`{attempts}`）。
`attempts` 是 `useAgentStream.mfaAttempts`（失败的 verify 每次 +1，`pendingAction` 的 `actionId`/`kind` 变化或清除时归零，`useAgentStream.ts:244-246`、`:355-360`），`maxAttempts` 由 `ChatWindow` 传入 `MFA_MAX_ATTEMPTS`（`lib/constants.ts:10` = 3）。

### 锁定后实时 dock 卸载（断言须知）

`status === 'locked'` 的 verify 响应会带 `security_event`（`code`/`reason` 由 `securityFacts` 从顶层或 `failure` 取，`actions.ts:650-658`）与终态 `action_settled`（`actions.ts:661-668`）。
`settleAction` 对终态清除同 `actionId` 的 `pendingAction`（`agent-stream-reducer.ts:319-343`），二者在同一批事件里折叠，故 `MfaCard` 的 `data-mfa-locked` / `cards.terminal.locked` 分支在实时流程中不会上屏——实时可见证据是「dock 整体消失」加一条 `role:'system'` 气泡（`securityNotice` → `chat.error.actionLocked`）。
`data-approval-locked` 只出现在只读 `ApprovalRecord` 上（`data-status="locked"`），来源两处：
实时转录里的内联 `mfa`/`confirmation` 卡（若存在）由 `settleAction` 在同一批事件里打上 `status:'locked'`（`agent-stream-reducer.ts:278-281`），因此**当内联卡存在时它会在实时流程中上屏**；
内联卡是否在实时流程里存在取决于 `mfa_required` 的 `attachPlanDecisionRecord`——只有当某条消息的 `plan` 卡里有节点 `output.pendingActionId === actionId` 时才会附加（`agent-stream-reducer.ts:366-375`），不经过计划的直接工具调用没有内联卡。
刷新/历史路径由 `app/agent/decision-record.ts#verificationCard` 保留 `status` 重建该内联卡，`CardRenderer` 把 `mfa`/`confirmation` 都交给 `ApprovalRecord`，故刷新后一定出现。

## 文本安全与本地化

安全与拒绝类文本的唯一收口点是 `lib/public-text.ts`（`isInternalDiagnostic`、`safePublicText`、`securityNotice`）。
`securityNotice(eventOrFacts, t)` 依服务端权威 `code`/`reason` 映射：锁定与次数耗尽 → `chat.error.actionLocked`；可重试且带 `attemptsLeft` → `chat.error.verificationRemaining {count}`；`circuit_open`/`mfa_session_locked` → `chat.error.securityLocked`；其余（含未登记事件、无 `code`/`reason` 者）→ `chat.error.securityDenied`；返回值恒为非空文本。
`securityNotice` 只读 `code`/`reason`/`attemptsLeft` 三个字段；输入类型声明的 `kind`/`maxAttempts` 从不被读取，传 `kind` 对渲染无影响。
缺 `attemptsLeft` 的 `MFA_FAILED`/`mfa_code_invalid` 按 `count = 0` 渲染，即「剩余 0 次」。
工具行文字只由 `publicToolSummary(event, t)` 生成，其错误分支经 `publicToolError(event.summary, t, 'chat.error.toolFailed', event.errorCode, event.errorParams)`（`lib/tool-feedback.ts`）；原始 `summary`/`debugDetail` 只出现在开发者模式诊断块。
`PUBLIC_ERROR_CODES` 已含 `MFA_LOCKED → chat.error.actionLocked`、`CIRCUIT_OPEN → chat.error.securityLocked`、`MFA_FAILED → chat.error.verificationFailed`；内部标记、原始 JSON 与堆栈在登记表匹配之前被拦下。
`status==='blocked'` 且无 `actionId` 时状态标签换成 `chat.activity.status.notExecuted`、摘要换成 `chat.error.operationNotStarted`。
`error` 事件折叠为 `stream.error`/`stream.errorCode`，经 `publicToolError(stream.error, t, 'chat.error.request', stream.errorCode)` 渲染后下发给 `ApprovalRequest` 与 `ReconciliationCard`。
`publicToolSummary` 对 `success`/`started`/`updated`/`cancelled` 及带 `actionId` 的 `blocked` 回落到 `localizeChatError`，未知字符串原样返回。

### 缺省回落矩阵（`chat.error.toolFailed` vs `chat.error.request`）

识别是逐字相等：只有 `message` 命中 `PUBLIC_BUSINESS_ERRORS` 或验证码正则才给出专用文案；锁定句只由 `MFA_LOCKED`/`CIRCUIT_OPEN` 等错误码映射得到。
`message` 缺失或空串直接走缺省回落，故「没有 message」与「message 未登记」得到同一句通用文案。
能渲染 `chat.error.toolFailed` 的站点是 `cards/ErrorCard`（`ChatCard.type==='error'`）、`cards/MfaCard`（`failed` 的 `statusMessage`）、`cards/ApprovalRecord`（`failed`）、`cards/ConfirmationCard`（终态 `failed` 的 `reason`）、`ToolEventList`（`error` 分支）、`banking/AgentTaskTimeline`（失败计划节点）；`ChatWindow` 顶部错误横幅的回落键是 `chat.error.request`，永远不会显示该句。
`MfaCard` 与 `ConfirmationCard` 的错误徽标使用 `localizeChatError`，未登记字符串原样显示。
`ErrorCard` 的 `detail` 属性没有调用方传入——`CardRenderer` 只传 `message` 与 `code`。

## 安全事件渲染

`security_event` 只在 `agent-stream-reducer.ts` 的 `applyEvent`（`case 'security_event'`）折叠：追加一条 `role:'system'` 消息，`content` 取 `securityNotice(event, t)`（`lib/public-text.ts`）。
折叠不按 `kind` 过滤：`locked`/`denied`/`injection` 三种 kind 都会被渲染。
事件的 `message` 与 `kind` 都不参与正文生成：`lib/contracts/agent.ts` 中 `message` 可选，锁定/拒绝类事件不再携带原文。
仓库内发射点是 `agent/turns/events.ts`（`kind:'locked'`，附 `code`/`reason`/`attemptsLeft`/`maxAttempts`）、`agent/run-turn.ts`（`kind:'injection'`，只带 `message`）与 `actions.ts#postAction`（客户端合成 `kind:'locked'|'denied'`）。
故注入扫描事件没有 `code`/`reason`，落到 `securityNotice` 的缺省分支，最终渲染为可见的 `chat.error.securityDenied` 气泡。
`channels/weixin/banking-client.ts` 只渲染 `kind==='locked'`、其余 kind 仅留审计，因此两端对 `injection` 的可见性不同。
`content` 上的 `|| t('chat.error.securityDenied')` 兜底不可达：`securityNotice` 恒返回非空目录文案。
`MessageBubble` 的 system 分支用 `isInternalDiagnostic(message.content)` 判定：被判定为内部诊断的历史文本改由 `safePublicText(content, t, 'chat.error.securityDenied')` 输出；其余 system 文本已是 reducer 用目录文案生成的正文。
两个收口点都在 `lib/public-text.ts` 内，组件与 reducer 都不做字符串清洗；内部标记 `__SECURITY_BLOCK__…`、原始 JSON 与堆栈因此无法进入可见文本。
`transport-validation.ts` 按白名单校验：`security_event` 要求 `kind` 非空串，`code`/`reason`/`actionId` 可选字符串，`attemptsLeft`/`maxAttempts` 可选非负整数，`message` 可选；`toolEvent` 接受可选 `errorCode`（枚举含 `MFA_LOCKED`）与可选 `errorParams`（值 string 或 number）。
任一字段漏校验会让合法事件被 `isAgentStreamEvent` 丢弃（`postAction` 会因此退化成 `GENERIC_ERROR`），新增事件字段必须同步更新该 schema。
传输校验只按类型与枚举放行，不做内容过滤；文本安全由上述收口点负责。

## 锁定（`status:'locked'`）后的可见状态

`settleAction` 把内联 `mfa` 卡片打成 `{status: event.status, message: event.message}`，`confirmation` 卡片把 `status`（必要时 `message`）写进 `action`——`message` 只经开发者模式诊断块可见。
同一 `actionId` 的工具行被改成 `error`，但不写入结算文本：改为携带结构化事实——保留该行已有 `errorCode`（网关的 `MFA_LOCKED`/`CIRCUIT_OPEN`），缺失时按 `locked` 补 `MFA_LOCKED`；`publicToolSummary` 因此渲染 `chat.error.actionLocked` 或 `chat.error.securityLocked`，而非 `chat.error.toolFailed`。
`upsertToolEvent` 用 `{...previous, ...next}` 合并、`toolActivity` 取每组最新一条，均不裁剪 `errorCode`/`errorParams`。
终态清除 `pendingAction`，底部 `ApprovalRequest` 卸载；内联 `mfa` 卡改由 `cards/ApprovalRecord` 渲染 `chat.approval.status.locked`（验证已锁定）。
锁定态的三段文案在 `MfaCard` 与 `ApprovalRecord` 上一致：原因 `securityNotice({code:'MFA_LOCKED', reason:'mfa_attempts_exhausted'})` → `chat.error.actionLocked`（含「请在安全中心解除限制后重新发起操作」）；状态 `cards.terminal.locked` / `chat.approval.status.locked`；解锁入口 `Link href="/security"`（标签 `pages.security.title`，支持句 `pages.security.unlockDescription`）。
锁定态不渲染验证码输入框、提交按钮或重试入口：`MfaCard` 的 `readOnly` 覆盖终态，`ApprovalRecord` 只渲染文本与安全中心链接。

## 已知问题

`ActionResponse` 携带 `code`/`attemptsLeft`/`maxAttempts`/`failure`，而 `action_settled` 契约不带这些字段；结构化拒绝事实只能由 `postAction` 合成的一条 `security_event` 传递。不经 `postAction` 的路径（直接读历史）只能由状态推导原因。
无结构化事实的 `failed` 终态行仍落到 `chat.error.toolFailed`；可重试的错误验证码不合成 `security_event`，其提示只有一条 `error` 事件。
`security_event` 的本地化依赖 `reduceAgentEvents` 的 `t`；两参调用使用默认语言（`zh-CN`）translator，非默认语言下两参路径产出中文正文。
整页刷新会丢失内存态：`settledActions` 与内联卡片上的终态标记都不持久化。
服务端把锁定 CAS 持久化为 `PendingAction.status='locked'`（`security/security-gateway.ts` 的 `persistLockedAction`），`GET /api/actions` 因此不再返回该行，`toPendingActionRef` 也丢弃 `locked`，`pickPendingAction` 只接受 `pending`/`awaiting_mfa`——刷新后底部弹窗不会重开，会话内已终态的决定也不再重开（`hasSettledAction`/`visibleRefs`）。
历史页仍会返回该内联卡：`app/agent/history.ts` 在行状态非 `awaiting_mfa` 时保留 `{type:'mfa', actionId, action, status: row.status}`，故 `status:'locked'` 的卡片随页面加载重新渲染为只读终态，文案与实时卡片一致。

`cards.mfa.locked`（“已锁定，请到安全中心处理。”）不可达：`locked` 属 `TERMINAL_STATUSES`，`MfaCard` 先走 `terminal === 'locked'` 分支；`readOnly && !terminal` 那行只在状态既非终态又非 `pending`/`awaiting_mfa`（如 `confirmed`）时落到 `cards.mfa.processing`。
`cards.mfa.failedAttemptsLimit` 在实时锁定流程中不可达：第 3 次错误验证码的响应 `status:'locked'` 让 `settleAction` 清除 `pendingAction`，底部 `MfaCard` 卸载，`useAgentStream` 的 `verify` 计数条件（`pendingAction` 仍是同一 mfa 决策）不再成立，`mfaAttempts` 停在上一次的数值。
连续错误验证码的三段可见变化：前两次保留底部面板（顶部 `role="alert"` 因 `showNotice={!pending}` 不渲染），第三次面板整体消失，`chat.error.actionLocked` 改由 system 气泡、工具行 `errorCode:'MFA_LOCKED'` 与可能的只读内联卡承载。

## 客户端请求与计时器

本目录没有轮询：无 `setInterval`、无 `requestAnimationFrame`、无 `EventSource` 或 SSE 重连、无 fetch 重试/退避循环。
唯一的 `setTimeout` 是两处一次性中止上限，不重发请求：
`history-request.ts` 的 `setTimeout(cancel, 5000)`（`requestLatestHistory`），
`actions.ts` 的 `setTimeout(cancel, PENDING_ACTION_READ_TIMEOUT_MS)`（`PENDING_ACTION_READ_TIMEOUT_MS = 5000`，挂载恢复 `GET /api/actions`）。
两处都将「取消」竞态成空结果（`kind:'failed'` / `[]`），不会产生第二个请求。

一次对话回合的请求顺序：`POST /api/chat`（`sendChatTurn`：`Accept: text/event-stream` + `readSseStream` 逐帧折叠）→
仅当流被判定中断（`done` 前缺 `message_end` 或读取抛错）才追加一次 `GET /api/chat/history`（`requestLatestHistory`，上限 5000ms）。
挂载时（服务端已传入 `initialHistory`，客户端不重复拉历史）：`GET /api/actions`（`fetchPendingActions`），有 `taskId` 时另加 `GET /api/tasks/:id`（`fetchTaskPlan`）。
`controlTask` 先 `POST /api/tasks/:id` 再 `GET /api/actions`，共两次。
`confirm`/`verify`/`cancel`/`recover` 各是一次 `POST /api/actions/:id/*`。
分页 `GET /api/chat/history?cursor=…` 只在用户点击「加载更早」时发起。

`POST /api/chat` 与操作类 POST 没有客户端超时，也没有 `AbortController`（`pull` 里传的是 `new AbortController().signal`，永不中止）；
`AbortController` 只用于历史分页与挂载恢复读取，且卸载时只中止这两类读取，不中止正在进行的回合。
`POST /api/schedules/tick` 不由任何组件调用（只由 `app/schedules/page.tsx` 的「检查到期」按钮触发）。

## 测试定位（DOM 标记）

端到端测试只依赖以下标记与目录文案，不依赖样式类名。
- 唯一活动面板：`section[data-approval-request="true"][data-action-id][data-kind="mfa"|"confirmation"]`，`aria-label` 与标题取 `chat.approval.verification` / `chat.approval.confirmation`。
- MFA 输入框：`input[type="text"][inputmode="numeric"][autocomplete="one-time-code"]`，`aria-label` = `cards.mfa.label`，`placeholder` = `cards.mfa.placeholder`；提交按钮文案 `cards.verify`，取消 `cards.cancel`，YELLOW 确认 `cards.confirm`（`ui/Button` 不输出任何 `data-*`）。
- 实时锁定区块：`[data-mfa-locked="true"]`（`MfaCard`），只在活动面板仍渲染已锁定的 mfa 决策时存在。
- 只读授权记录：`section[data-approval-history="true"][data-action-id][data-status]`，内含 `[data-approval-stage="previous"|"current"][data-stage-status]`；`status="locked"` 时另有 `[data-approval-locked="true"]`。
- 安全拒绝气泡：`[data-message-role="system"] [data-message-content="true"]`；工具行 `li[data-tool-call-id][data-tool-status]`；卡片容器 `[data-chat-card-type]`。
- 输入区：`textarea[data-chat-composer="true"][data-chat-ready]`，发送按钮文案 `chat.composer.send`；消息滚动容器 `[data-chat-scroll="true"]`，底部停靠区 `[data-chat-composer-dock="true"]`。

## 显示与诊断

普通模式展示业务名称、状态与结果。
开发者模式可显示经过过滤的调用诊断。
诊断投影使用 `lib/tool-diagnostics.ts`。
隐藏开发者模式时移除诊断内容。

本地化只改变静态显示文字。
历史原文、金额与操作身份保持原值。
组件不能从模型文字推导交易成功。

卡片约束见 [cards/CONTEXT.md](cards/CONTEXT.md)。
事件归属见 [agent/turns/CONTEXT.md](../../agent/turns/CONTEXT.md)。
完整显示规则见
[chat-presentation.md](../../docs/cn/chat-presentation.md)。
