# 智能助手页面

## 数据与入口

`page.tsx` 是按请求渲染的服务端页面。
它通过 `getDemoSession(resolveUserId())` 读取演示工作区。
Web 身份规则见 [../api/CONTEXT.md](../api/CONTEXT.md)。

`history.ts` 提供历史分页读取。
旧定时付款卡片的参数 JSON 经 `security/scheduled-summary.ts` 转为业务字段。
转换只用于展示，不写回摘要、参数或授权状态。
页面向 `ChatWindow` 传入最新历史页和旧页游标。
`historyGeneration` 区分当前历史代次。
当前可恢复任务也通过服务端读取。

`plan-history.ts` 恢复计划与原始消息的归属。
已完成或已取消计划保留在原历史位置。
无法归属的旧计划采用独立的历史记录。
不得将旧计划附加到无关的新回复。

## 决策卡片的状态权威性

`decision-record.ts` 是本目录唯一的 `PendingAction` 行 → 对话卡片投影。
状态权威只来自持久化行，绝不来自已存卡片：`status` 原样复制，摘要与策略按行的当前列重新解析。
`history.ts`（内联 `mfa`/`confirmation` 卡片）与 `plan-approvals.ts`（计划节点卡片）都只经它投影，二者不会各自解读状态。

- `isOpenDecision(status)` 只接受 `pending` 与 `awaiting_mfa`，是“能否重建可提交面板”的唯一判据；`locked`、`executed`、`failed`、`cancelled` 一律为终态记录。
- 每张投影卡片都带上持久化 `status`：`mfa` 卡片用卡片级 `status`，`confirmation` 卡片用 `action.status`。客户端决策坞正是按这两个位置判断能否重建面板，因此终态行不可能再变成可提交的验证码输入。
- 卡片形状沿用实时流用过的形状（验证请求是 `mfa`，普通批准是 `confirmation`），锁定不会让同一操作中途换卡片类型。
- 已结算的验证卡片丢弃 `hint`（不再提示永远不会被接受的验证码），并仅在此状态携带 `message`。
- 行缺失或 `summaryJson` 无法渲染时返回**原样卡片**，不臆造任何状态；`plan-approvals.ts` 还要求摘要的 `toolName` 与行一致才投影。

本层对 `PendingAction` 只读（仅 `findMany`），没有任何写 `status` 的路径。
因此刷新后已锁定操作显示为只读终态卡片，不会重开弹窗（`GET /api/actions` 也不返回 `locked` 行）。
对外文案不在本层产生，状态文案由 `components/chat/` 按 i18n key 渲染。

## 交互边界

页面恢复展示，不执行银行操作。
后续对话、用户决定和计划控制由客户端调用 API。
授权入口和历史记录的区别见
[components/chat/CONTEXT.md](../../components/chat/CONTEXT.md)。

业务值必须使用可序列化的契约。
页面不输出模型思考过程。
对话显示规则见
[chat-presentation.md](../../docs/cn/chat-presentation.md)。

## 相关文件

- `page.tsx`：服务端页面，仅把快照传给 `components/chat/ChatWindow`，不筛选 `AgentStreamEvent`。
- `history.ts`：历史分页与卡片重投影。
- `decision-record.ts`：行 → 卡片的唯一投影（状态、摘要、`hint`/`message` 规则）。
- `plan-approvals.ts`：计划节点的已发出授权记录。
- `plan-history.ts`：计划与消息归属恢复。
