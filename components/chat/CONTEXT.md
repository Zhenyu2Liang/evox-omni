# 对话与授权交互

## 职责与入口

`ChatWindow` 组合消息、工具记录、历史和输入框。
`useAgentStream` 管理请求状态与服务端事件。
`actions.ts` 封装对话、操作与计划请求。
`transport-validation.ts` 校验返回的传输结构。
`history.ts` 与 `history-request.ts` 处理分页和恢复。

`AssistantMarkdown` 渲染助手的 Markdown。
用户消息保持原文。
原始 HTML 与图片请求关闭。
链接采用允许的协议与相对路径。

## 消息与历史

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
`MfaCard` 依 `pending.status`/`pending.statusMessage` 渲染只读终态或失败文本（`cards.terminal.*`）。
失败尝试文案按剩余次数选择：`attempts < maxAttempts` 渲染 `cards.mfa.failedAttempts`（`{attempts}`，`次。` 结尾），达到上限（`attempts >= maxAttempts`）渲染 `cards.mfa.failedAttemptsLimit`（`{attempts, maxAttempts}`）。
`maxAttempts` 缺省时回落 `cards.mfa.failedAttempts`。
`ApprovalRequest` 转发之，`ChatWindow` 传 `maxAttempts`（`MFA_MAX_ATTEMPTS`）。

唯一活动面板由 `ChatWindow.tsx:237` 以 `key={pending.actionId}` 挂载 `ApprovalRequest`（`MfaCard` 亦以 `key={pending.actionId}`，`ApprovalRequest.tsx:32`），并写出 `data-approval-request`/`data-action-id`/`data-kind`。
`pendingAction` 只由 `confirmation_required`/`mfa_required`（`useAgentStream.ts:502-550`）或挂起操作恢复（`651-666`）建立，关闭只来自 `settleAction` 的终态/`confirmed`（`402-404`）与 `pull` 的无错误清除规则（`880-882`）。
`tool_start`/`tool_end` 的 `blocked` 只记录 `lastBlockedToolName`（`482-494`），既不关闭也不替换面板；无 `actionId` 时更不会创建新面板。

### 验证响应校验与分支（`actions.ts#postAction`，约 541-617 行）

`status` 须属 `ACTION_STATUSES`（`pending`/`awaiting_mfa`/`confirmed`/`executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`）。
`mfaResult` 仅接受 `undefined`/`'success'`/`'failed'`/`'not_required'`（569 行）。
任一字段不符即以 `failure('', GENERIC_ERROR)` 失败，只折叠出一条 `error` 事件；
`pull` 因 `hasError` 不清除 `pendingAction`，验证卡保持打开。

`awaiting_mfa` 且 `requiresMfa` 且 `tier==='RED'` 且未执行且 `mfaResult!=='failed'` 时合成 `mfa_required`（590-596 行，不追加错误）。
错误码（`mfaResult==='failed'`，或非决定态且 `ok===false`）落到追加 `error` 的支路（598-601 行）。
终态状态（`TERMINAL_ACTION_STATUSES`，含 `locked`）合成 `action_settled`（604-611 行）；
`settleAction` 对匹配 `actionId` 的终态清除 `pendingAction`（`useAgentStream.ts` 402-404 行）。
`pull` 的 `clearPending` 守卫要求 `!hasError`（863-873 行），故带 `error` 的响应不会清除决定，除非 `settleAction` 已清。

## 错误文本与安全事件渲染

`chat.error.toolFailed`（「操作未完成。请核对原操作卡片和账户记录。」）显式出现在 `cards/ErrorCard.tsx:24`（`ChatCard.type==='error'`）。
`publicToolError` 的缺省回落就是该键（`lib/tool-feedback.ts:37`），故不传回落键的站点也会显示它：
`cards/MfaCard.tsx:66`（`status==='failed'` 时的 `statusMessage`）、`cards/ApprovalRecord.tsx:60`（`current==='failed'`）、`cards/ConfirmationCard.tsx:64`（终态 `failed` 的 `reason`）、
`ToolEventList.tsx:85` 经 `publicToolSummary`（`status==='error'` 分支）、`banking/AgentTaskTimeline.tsx:115`（失败计划节点）。
`ChatWindow.tsx:58`/`77` 显式传 `chat.error.request`，不会落到该键。
`status==='blocked'` 且无 `actionId` 时状态标签换成 `chat.activity.status.notExecuted`、摘要换成 `chat.error.operationNotStarted`（`ToolEventList.tsx:81-82`、`lib/tool-feedback.ts:56`）。
`status==='error'` 且错误码未知或缺失（含 `TOOL_FAILED`/`INTERNAL`）时一律落到 `chat.error.toolFailed`。
`ErrorCard` 的 `detail` 属性没有调用方传入——`CardRenderer.tsx:110` 只传 `message` 与 `code`。

`security_event` 仅在 `useAgentStream.ts:552-564` 折叠：追加 `role:'system'` 消息，`content` 原样取 `event.message`（`kind` 未参与渲染）。
`MessageBubble.tsx:67-73` 对 system 角色按普通文本直出，不经消息目录也不经 `sanitizeToolArguments`。
`publicToolSummary` 对 `success`/`started`/`updated`/`cancelled` 及带 `actionId` 的 `blocked` 回落到 `localizeChatError`，
未知字符串原样返回（`lib/i18n/display.ts:5-8`），`ToolEventList.tsx:85` 直接渲染该值。
`sanitizeToolArguments` 只处理凭证、手机号与推理字段，不清洗内部标记。

## 已知问题

整页刷新会丢失内存态：`settledActions` 与内联卡片上的终态标记都不持久化。
若服务端仍把已锁定行当作 `awaiting_mfa` 返回（`toPendingActionRef` 丢弃 `locked` 行，但服务端仅把 `MfaChallenge` 置为 `locked`、未持久化 `PendingAction` 状态），
刷新后客户端无从得知该行已锁定，仍会重建 `kind:'mfa'` 决定。
该刷新情形由服务端侧修复覆盖；客户端在会话内已不再重开终态决定。

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
