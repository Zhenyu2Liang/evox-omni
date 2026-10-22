# 微信通道

`pi-weixinbot@1.0.5` 协议模块负责扫码、长轮询和回复。
`banking-client.ts` 只调用本机银行 HTTP API，不导入业务 SDK。
`presentation.ts` 将全部公开 ChatCard 转成文字；禁止展示原始参数、output 或 debug 字段。
`banking-client.ts` 对失败与拒绝复用网页公开提示，不将内部模型纠错诊断转发给微信。
`commands.ts` 处理多步计划、到期检查与待办，所有控制复用原 HTTP 权限和执行器。
`bridge.ts` 只接受扫码绑定用户的完整文字私聊。
消息串行处理，稳定消息键绑定银行 requestId，outbox 在发送前保存。
确认、验证码和取消为显式命令，操作编号必须已由本通道展示。
`/待办` 可展示网页创建的当前账户操作；任务控制后重新读取关联确认入口。
非 decision 的待办只展示处理中或待核对状态，不称为未执行。
验证码不进入模型和本地消息正文。
本地 state.json 含凭据，目录被 Git 忽略；不得输出原文。
`worker.ts` 在整个消息批次处理完成后提交游标。
`scripts/weixin.ts` 管理登录、运行、状态和本地退出。
操作和测试边界见 `docs/cn/weixin.md`。

## 命令面（bridge.ts / commands.ts）

`commands.ts handleChannelCommand` 先于结算命令执行：`/帮助`、`/help`、`/待办`、`/任务`、`/定时任务`、`/检查到期`、`/任务|暂停|继续|重试|取消任务|回退记录 <id>`。
`bridge.ts:56` 的结算正则为 `^\/(确认|验证|取消|恢复操作)\s+([A-Za-z0-9_-]{1,128})(?:\s+(\d{6}))?$`；不匹配且以 `/` 开头时回 `命令格式不正确。\n${HELP}`（`bridge.ts:69`），因此 5 位验证码、含空格或其它字符的操作编号都落到该通用错误。
`确认`→`confirm`、`验证`→`verify`、`恢复操作`→`recover`、`取消`→`cancel`（`bridge.ts:63`）；`/取消` 是操作取消，`/取消任务` 才是计划取消。
`/确认` 或 `/取消` 带 6 位码时拒绝：`确认和取消命令不接收验证码。`（`bridge.ts:62`）。
`/验证` 缺少验证码，或该编号尚未通过本通道 `/确认`，回 `请先发送 /确认 {id}，再发送 /验证 {id} 六位验证码。`（`bridge.ts:61`）。
未由本通道展示过的编号（含 `/恢复操作`）回 `该操作不是本通道提供的操作，请核对编号，或在网页处理。`（`bridge.ts:60`）。
非文字消息回 `目前仅支持文字消息，请输入银行需求。`（`bridge.ts:34`）；正文超过 4000 字回 `消息过长，请将银行需求缩短至 4000 字以内。`（`bridge.ts:70`）。

## 结算回复的组装（bridge.ts:63-67）

统一模板：`操作编号：{id}\n状态：{label(outcome.status)}` +（仅 `status==='awaiting_mfa'` 时）`\n继续验证：/验证 {id} 六位验证码`，再依次拼接 `outcome.message` 与 `renderEvents(outcome.events)`，用空行分隔、空串过滤。
`label()`（`presentation.ts:12-22`）只做词表翻译：`pending`=等待确认、`awaiting_mfa`=等待验证码、`executed`=已执行、`cancelled`=已取消、`locked`=已锁定、`failed`=失败、`needs_reconciliation`=结果待人工核对；词表外的状态原样输出英文枚举。
`outcome.message` 原样转发，通道不重写、不短接、不套 i18n：锁定提示即网关两条原文（`当前会话已触发安全熔断…`、`验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。`），错码提示即网关 `验证码错误，请重试。剩余尝试次数：N。`。
`awaiting_mfa` 的失败结果携带 `mfa_required` 事件，因此会重复展示完整操作详情与 `/确认`、`/验证` 入口；`locked` 与其它终态不产生事件（`agent/confirmation/CONTEXT.md`），此时 `renderEvents` 兜底句 `本次请求已处理，请在网页查看业务详情；没有确认或验证的业务不会执行。`（`banking-client.ts:122-123`）一定会追加。
第 3 次错码的完整回复依次为：`操作编号：{id}`、`状态：已锁定`、网关锁定原文、该兜底句。
由此微信明确告知「已锁定」（网页同一场景只剩通用兜底），但末行「没有确认或验证的业务不会执行」与锁定语义自相矛盾；这是当前回复的真实组成，不是推断。
第 4 次起的 `/验证` 换用另一句原文 `当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。`，可见回复原文随尝试次数变化。
`/确认` 得到 `awaiting_mfa` 后仅置 `state.offered[id].confirmed = true`（`bridge.ts:64`）；`offered` 条目从不删除或失效，已执行/已锁定/已取消的编号仍可继续发送并被服务端按幂等或冲突处理。

## 待办展示（commands.ts:15-20、presentation.ts:113-118）

`GET /api/actions` 返回的 `attention==='decision'`（`pending`/`awaiting_mfa`）走 `renderAction`，两者唯一差异是末行 `状态：等待验证码` 与 `状态：等待确认`（`commands.ts:18`）。
其余 attention（`processing`/`recoverable`/`reconciliation`）走 `renderAttention`：`状态：` + `label(attention)`，可恢复时附 `/恢复操作 {id}`，并声明 `该记录不能重新确认；结果不明时请核对操作记录，不要重复办理。`
空列表回 `没有待处理的操作。`；`/任务` 无计划回 `没有多步任务。`；未展示的计划不控制，回 `请先发送 /任务 查看服务端任务和编号，再控制指定任务。`。
`/待办` 只登记 `offered[id] = {confirmed:false}`，因此重启后已处于 `awaiting_mfa` 的操作必须再走一次 `/确认` 才能提交验证码。

## 净化边界

`renderEvents`（`banking-client.ts:70-124`）只读取 `message_end` 的 assistant 正文、公开 card、plan、gate 与 `publicToolSummary`；`text_delta`、`tool_start`、`args`、`debugDetail`、`debugArguments`、`mfaHint` 一律不进入文本。
工具失败文本统一经 `lib/tool-feedback.ts publicToolSummary` 映射成 i18n 键（`chat.error.*` 不会外泄）；`plan.results[].output` 只在 `commands.ts:28` 取 `pendingActionId`，不渲染。
`security_event`（含 `kind:'locked'` 与原始 `__SECURITY_BLOCK__…`）在通道内被忽略，不产生任何文本；`action_settled.message` 也被忽略，只用其 `actionId` 撤销 gate。
`deny` 类拦截由此变成 `ToolEventView{status:'blocked'}` 且无 `actionId`、无 `summary`（`agent/turns/events.ts:58`），`publicToolSummary` 走 fallback 键 `chat.error.operationNotStarted` → 「操作未发起。请核对需求和原操作卡片。」，故 deny 既不静默也不外泄标记。
`presentation.ts:106` 的 `case 'error'` 原样输出 `业务提示：{card.message}`，不经 `lib/tool-feedback` 映射（网页 `components/chat/cards/ErrorCard.tsx` 才做映射）；此类卡片只在非 block 分支产生（`agent/turns/events.ts:50-56`），因此不会携带 `__SECURITY_BLOCK__`，但 SDK 工具错误原文会直接出现在微信里。
`renderBusinessCard` 用 try/catch 兜底为 `服务端结果字段不完整，请在网页核对；未据此推断业务成功或余额。`；列表渲染前 `Array.isArray` 校验；电话按 11 位掩码（`presentation.ts:29`）。
`banking-client.ts:31-44` 不做运行时 schema 校验（网页侧才用 `components/chat/transport-validation.ts` 的 zod）：HTTP 错误或 `ok:false` 时，仅当 `status<500` 且 `error.code` 匹配 `^[A-Z_]+$` 才抛 `服务端提示（CODE）：{message 前 400 字}\n请核对操作记录后处理。`，否则抛 `银行服务暂未完成请求，请在网页核对操作记录后再处理。`；`bridge.ts:35` 把 `BankingApiError.message` 直接作为整条回复，其它异常与网络失败回 `银行请求结果暂时无法确认。请在网页核对操作记录，不要据此判断已成功或资金未变。`
验证码只出现在本次 verify 请求体（`banking-client.ts:51`），不写 state、不回显、不进模型。

## 持久化、去重与 outbox

去重键 `key = sha256(botId\0ownerId\0messageId)`（`bridge.ts:12,30`），银行请求 `requestId = weixin:<key>`，发送 `client_id = bank-<key>-<sent>`（`bridge.ts:34,46`）。
`state.deliveries[key] = { replies[], sent }` 在首次发送前写入并 `save()`（`bridge.ts:37-43`），回复按 1600 字切块；每块发送成功后 `sent++` 并保存，重投只重发相同 `client_id`，不再进入模型。
已发完的旧 delivery 在超过 2000 条时被淘汰（`bridge.ts:39-42`）；`offered`/`plans` 无淘汰。
结算结果不在通道状态里留痕：state 只有 `version/auth/cursor/deliveries/offered/plans`（`state.ts:9-14`），`locked`/`failed` 仅存在于已持久化的回复正文与 `offered` 条目中。
`worker.ts` 只在整批消息处理完后提交 `cursor`，中途停止不提交，靠去重继续；`-14`/401/403 判定登录失效并要求重新扫码，其它错误只报 `微信通道请求暂时失败，5 秒后重试；未提交消息游标。`

## 测试覆盖缺口

已覆盖：非受信消息丢弃、`message_state` 省略与 uint64 编号、`text_delta` 不外发、去重与 clientId 复用、outbox 保存后重发、未展示编号拒绝、先确认再验证、验证码不落盘、`locked` 显示 `已锁定`、网络失败不推断、`renderEvents` 各 card 与 gate 撤销、计划五个控制动词、`/待办` 与 `/检查到期`、pi-weixinbot 线协议、live e2e 的确认/错码/正码/取消。
无测试：`bridge.ts:67` 的整条回复模板（`操作编号：` + `状态：` + 空行拼接）对任何状态都无断言；`继续验证：` 续接行无断言；`awaiting_mfa` 与 `cancelled`/`executed`/`failed`/`needs_reconciliation` 的 `label()` 输出无断言（仅 `locked` 有）。
无测试：`/验证` 缺少验证码的分支、`确认和取消命令不接收验证码。`、`命令格式不正确。\nHELP` 与 HELP 全文、超 4000 字、非文字消息回执。
无测试：`BankingApiError`→`服务端提示（CODE）：…` 的转发（含 423 CIRCUIT_OPEN、404、409）；`/待办` 与 `/任务` 的空列表文案；`/定时任务`、`/帮助`。
无测试：`/恢复操作` 经 `bridge` 的 verb→`recover` 分派（只有 `renderAttention` 文案与 HTTP URL 被覆盖）。
无测试：1600 字切块与多块 `sent` 递进、2000 条 delivery 淘汰、`offered` 不失效后的重复 `/确认`。
无测试：`worker.ts runWeixinWorker`（游标提交时机、`-14`/401/403 分类、5 秒重试、`health().llmMode` 播报）、`login.ts` 扫码流程、`transport.ts createWeixinTransport`、`state.ts` 损坏锁文件与损坏 state.json 分支、`config.ts weixinConfig` 默认值。
无测试：`security_event` 被忽略后仅剩兜底句的行为。
