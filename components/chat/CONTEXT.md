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

## 已知问题

熔断后（验证码连续错误达 `MFA_MAX_ATTEMPTS=3`）服务端把挑战标为 `locked`，
但 `PendingAction` 行仍停留在 `awaiting_mfa`，`GET /api/actions` 继续返回它为待决定。
实时验证响应 `status:'locked'` 由 `actions.ts` 转为 `action_settled{status:'locked'}`，
`settleAction` 据此清除 `pendingAction` 并关闭弹窗——即单次响应本身会关闭。
环路来自恢复/重建路径：`settledActions` 只在内存，刷新即丢失，
`pickPendingAction` 与 `restoreActionAttention`（`useAgentStream.ts`）在每次挂载/刷新及
`controlTask` 中据仍为 `awaiting_mfa` 的行重建同 `actionId` 的 `kind:'mfa'` 决定。
`mfa_required` 折叠只被 `hasSettledAction` 拦截且从不移除卡片，
故同 `actionId` 的终态一旦未记录，弹窗即可复现。
`ApprovalRequest` 不向 `MfaCard` 传 `status`，实时弹窗因此不显示 `locked` 只读态。

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
