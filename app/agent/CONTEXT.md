# 智能助手页面

## 数据与入口

`page.tsx` 是按请求渲染的服务端页面。
它通过 `getDemoSession(resolveUserId())` 读取演示工作区。
Web 身份规则见 [../api/CONTEXT.md](../api/CONTEXT.md)。

`history.ts` 提供历史分页读取。
页面向 `ChatWindow` 传入最新历史页和旧页游标。
`historyGeneration` 区分当前历史代次。
当前可恢复任务也通过服务端读取。

`plan-history.ts` 恢复计划与原始消息的归属。
已完成或已取消计划保留在原历史位置。
无法归属的旧计划采用独立的历史记录。
不得将旧计划附加到无关的新回复。

## 交互边界

页面恢复展示，不执行银行操作。
后续对话、用户决定和计划控制由客户端调用 API。
授权入口和历史记录的区别见
[components/chat/CONTEXT.md](../../components/chat/CONTEXT.md)。

业务值必须使用可序列化的契约。
页面不输出模型思考过程。
对话显示规则见
[chat-presentation.md](../../docs/cn/chat-presentation.md)。
