# 微信通道

`/帮助` 按功能分组，组间留空行，每条命令单独一行。
业务列表逐项编号，项目之间留空行；交易备注必须保留原文和换行。
确认命令与业务详情之间留空行。
`SCHEDULED` 仅表示“待执行”，不得据此判断任务尚未到期。
已执行、已取消及等待验证等状态缺少 `message` 时，不得补入失败提示。
待人工核对状态复用公开结果核对提示，不能显示为执行成功。

确认提示的标题、字段名和固定字段值必须复用 `lib/i18n/display.ts` 的翻译函数。
风险等级只按 `summary.tier` 显示一次；与标题相同的操作字段不再重复。
备注等用户原文和金额必须保持原样。
确认提示默认显示当前操作详情和无编号命令。
银行 API 和审计仍使用完整原编号。
`action-references.ts` 保存短编号与原编号的固定映射。
`/确认 1`、`/取消 1`、`/验证 1 六位验证码` 和 `/恢复操作 1` 均复用该映射。
完整原编号继续可用；未知或有歧义的编号不得提交给银行 API。
`nextActionNumber` 持久化递增；退出登录、重新绑定及录制重置必须保留计数。
短编号不得重新分配给另一笔操作；普通聊天中的“确认”不构成授权。
无编号的 `/确认`、`/取消` 和 `/验证 六位验证码` 必须实时读取服务端待办。
命令仅指向 `activeActionId` 对应且已展示的当前操作。
当前操作失效或尚未展示时，必须先展示详情，等待下一次显式确认。
`confirmationQueue` 保存多笔 decision 的顺序，每次仅展示一笔。
新事件按出现顺序入队，其余服务端待办按创建时间入队。
当前操作完成或取消后展示下一笔，不得自动确认下一笔。
`awaiting_mfa` 必须保留当前操作，验证通过后才能继续。
读取待办失败时不得改用本地缓存确认。
订阅查询仍须确认，展示层不得降低权限要求。

`pi-weixinbot@1.0.5` 协议模块负责扫码、长轮询和回复。
`banking-client.ts` 只调用本机银行 HTTP API，不导入业务 SDK。
`presentation.ts` 将全部公开 ChatCard 转成文字；不得展示原始参数、output 或 debug 字段。
理财持仓按“净值 + 份额”展示份额、最新净值与净值日期、市值、剩余持仓成本、持仓收益、持仓收益率与累计收益，并标注收益为模拟估算；派生估算标注“估算”，历史数据不足标注“历史数据不足”，缺失事实不补数。
`banking-client.ts` 对失败与拒绝复用网页公开提示，不将内部模型纠错诊断转发给微信。
`commands.ts` 处理多步计划、到期检查与待办，所有控制复用原 HTTP 权限和执行器。
`bridge.ts` 只接受扫码绑定用户的完整文字私聊。
消息串行处理，稳定消息键绑定银行 requestId，outbox 在发送前保存。
确认、验证码和取消为显式命令，目标操作详情必须已由本通道展示。
`/待办` 可展示网页创建的当前账户操作；任务控制后重新读取关联确认入口。
非 decision 的待办只展示处理中或待核对状态，不称为未执行。
验证码不进入模型和本地消息正文。
本地 state.json 含凭据，目录被 Git 忽略；不得输出原文。
`worker.ts` 在整个消息批次处理完成后提交游标。
`scripts/weixin.ts` 管理登录、运行、状态和本地退出。
操作和测试边界见 `docs/cn/weixin.md`。

## 命令面（bridge.ts / commands.ts）

`commands.ts handleChannelCommand` 先于结算命令执行：`/帮助`、`/help`、`/待办`、`/任务`、`/定时任务`、`/检查到期`、`/任务|暂停|继续|重试|取消任务|回退记录 <id>`。
结算正则为 `^\/(确认|验证|取消|恢复操作)\s+([A-Za-z0-9_-]{1,128})(?:\s+(\d{6}))?$`（`bridge.ts:58`）；不匹配且以 `/` 开头时回 `命令格式不正确。\n${HELP}`（`bridge.ts:69`），因此 5 位验证码、含空格或其它字符的操作编号都落到该通用错误。
`确认`→`confirm`、`验证`→`verify`、`恢复操作`→`recover`、`取消`→`cancel`（`bridge.ts:65`）；`/取消` 是操作取消，`/取消任务` 才是计划取消。
`/确认` 或 `/取消` 带 6 位码时拒绝：`确认和取消命令不接收验证码。`（`bridge.ts:64`）。
`/验证` 缺少验证码，或该编号尚未通过本通道 `/确认`，回 `请先发送 /确认 {id}，再发送 /验证 {id} 六位验证码。`（`bridge.ts:63`）。
未由本通道展示过的编号（含 `/恢复操作`）回 `该操作不是本通道提供的操作，请核对编号，或在网页处理。`（`bridge.ts:62`）。
非文字消息回 `目前仅支持文字消息，请输入银行需求。`（`bridge.ts:36`）；正文超过 4000 字回 `消息过长，请将银行需求缩短至 4000 字以内。`（`bridge.ts:70`）。

## 结算回复契约（bridge.ts settleReply，79-98）

回复只由服务端权威字段驱动：`ActionResult.status`、`code`、`failure.{code,reason,attemptsLeft,maxAttempts}`；通道内不做文案匹配。
第一段恒为状态块，当前队列操作仅显示 `状态：{label(outcome.status)}`。
通过兼容编号办理的非当前操作，状态块仍包含操作编号。
`status === 'locked'`（`bridge.ts:85-91`）依次拼接：状态块 → `securityNotice(outcome.failure ?? {code: outcome.code})` → `当前状态：该操作已锁定，不再提供验证码入口，也不会执行。` → `解除方式：请在网页安全中心解除限制；解除后需要重新发起这笔操作，系统不会自动执行原操作。` → 事件文本。
锁定回复不出现 `继续验证：`、不出现 `/验证 {id}` 提示、不暗示可再次提交验证码，也不追加任何成功/处理语。
仅 `status === 'awaiting_mfa'` 在状态块后追加验证入口。
当前队列操作使用 `/验证 六位验证码`，非当前操作使用带编号的兼容命令。
`awaiting_mfa` 与其它终态：状态块（含续接行）→ 拒绝文案 → 事件文本。
拒绝文案（`bridge.ts:93-96`）：`failure.reason` 为 `mfa_code_invalid` 或 `mfa_session_locked` 时用 `securityNotice(outcome.failure)` 覆盖服务端 message；其余用 `channelText(outcome.message, t, 'chat.error.toolFailed')`。错码重试的 `failure` 必为 `mfa_code_invalid`（`MFA_LOCKED` 只出现在锁定分支），`{count}` 由本操作 challenge 的 `attemptsLeft` 渲染；`awaiting_mfa` 的签发提示不带 `code`/`failure`，其句子已由服务端 `agent/confirmation/outcomes.ts#blockedOutcome` 经 `safePublicText(..., 'chat.display.safetyHint')` 收口。
`settleReply` 经 `present(outcome.events, { emptyNotice: false })` 渲染。
多步任务产生的新确认项必须入队，仅展示当前操作并登记授权入口。
该路径不追加 `本次请求已处理…` 兜底句，该句与锁定终态矛盾。
已知边界：自由聊天路径 `present()`（`bridge.ts:100-105`）仍保留该兜底句，因为聊天轮次的 assistant 正文不在 `renderEvents` 的返回值内。
`label()` 词表（`presentation.ts:13-23`）：`pending`=等待确认、`awaiting_mfa`=等待验证码、`executed`=已执行、`cancelled`=已取消、`locked`=已锁定、`failed`=失败、`needs_reconciliation`=结果待人工核对。
`/确认` 得到 `awaiting_mfa` 后仅置 `state.offered[id].confirmed = true`（`bridge.ts:66`）；`offered` 条目从不删除或失效，已执行/已锁定/已取消的编号仍可继续发送并被服务端按幂等或冲突处理。

## 锁定文案的服务端来源（settleReply 第 2 段）

锁定回复第 2 段只由 `outcome.failure` 的类型化字段决定（`lib/public-text.ts#securityNoticeKey`，不做文案匹配），来源不同则文案不可混淆：
本操作自己的验证码次数用尽：`security/mfa.ts#attemptState(actionId)` 只看该 action 的 `MfaChallenge`（`attempts >= maxAttempts` 或 `status === 'locked'` 才算 `exhausted`），只有 `exhausted` 时 `security/security-gateway.ts:1010-1023` 回 `status:'locked'`、顶层 `code:'CIRCUIT_OPEN'`、`failure{code:'MFA_LOCKED',reason:'mfa_attempts_exhausted',attemptsUsed,attemptsLeft,maxAttempts}` → `chat.error.actionLocked`，并把该行 CAS 成 `locked`。
账户级熔断（本操作或其它操作触发）不是次数用尽：`security-gateway.ts:1025-1038`（`verify` 回 `locked:true` 但本操作未 `exhausted`）与 `security-gateway.ts:1271-1273`（会话已熔断、行仍未决）都回 `status:'locked'`、`code:'CIRCUIT_OPEN'`、`failure{code:'CIRCUIT_OPEN',reason:'circuit_open'}` → `chat.error.securityLocked`，并同样把行 CAS 成 `locked`；`security/mfa.ts#verify` 对锁定账户的每个操作都回 `locked:true`，因此“本操作从未错码”只能是 `circuit_open`，绝不写成 `mfa_attempts_exhausted`。
行已持久化为 `locked` 后再 `/确认`、`/验证`、`/取消`、`/恢复操作`，由 `security-gateway.ts:1239-1242`（`lockedOutcome`）或 `app/api/_lib/locked-action.ts:57-69` 回 `status:'locked'`、`code:'CIRCUIT_OPEN'`、`failure{code:'CIRCUIT_OPEN',reason:'mfa_session_locked'}`（附 `attemptsLeft:0`、`maxAttempts:MFA_MAX_ATTEMPTS`）→ `chat.error.securityLocked`；两条路径都不写行、不签发挑战、不消耗次数、不执行。
`locked` 是终态（`lib/contracts/security.ts:47-54`）：`security/mfa.ts#issueChallenge` 拒绝为 `locked` 行签发新验证码，`verify` 对 `locked` 行回 `ok:false, locked:true, attemptsLeft:0`；`app/api/security/reset` 的解锁只清账户熔断与失败计数、写恰好一条 `SECURITY_RESET` 事件、只续签仍 `awaiting_mfa` 的挑战，绝不把 `locked` 行写回 `pending`/`awaiting_mfa`、不重开验证入口、不自动执行（回 `lockedActionsReopened:false`），恢复只能重新发起并重新确认。
`outcome.failure` 缺失时退回 `{code: outcome.code}`（本操作次数用尽时顶层 `code` 也是 `CIRCUIT_OPEN`，会渲染成熔断文案），两者都缺失则 `chat.error.securityDenied`（`bridge.ts:87`）。
`locked` 走 200 域结果；`app/api/_lib/http.ts:19-32` 的 423 只对应路由抛出的错误信封（`CIRCUIT_OPEN` 与 `MFA_LOCKED` 都映射 423），此时微信收到的是 `服务端提示（CODE）：…` 而非锁定结构。
`/待办` 不再列出 `locked` 行（`app/api/actions/route.ts:77-81`），但 `state.offered` 条目仍在，编号仍可发送并触发上述锁定回复。
挑战本身失效走类型化分支（`security/mfa.ts#challengeInvalidation`）：已消费 → `security-gateway.ts:946-968` 把行 CAS 成 `cancelled`、`code:'CONFLICT'`、`failure{code:'CONFLICT',reason:'denied'}`、`events:[]`，状态块为 `已取消` 且不附 `继续验证：`；已过期或命令摘要变化 → 重新签发挑战并回 `status:'awaiting_mfa'`（无 `code`/`failure`，是提示而非拒绝），仍附 `继续验证：`。两者都不进锁定分支，拒绝句由 `channelText(outcome.message)` 透出服务端已收口的中文业务句（`bridge.ts:96`）。
settle 结果不含 `security_event`；聊天轮次中模型写调用被拒绝才由 `agent/turns/events.ts:89-94` 产出 `kind:'locked'`（只带 `code`/`reason`/`attemptsLeft`/`maxAttempts`/`actionId`），网页侧另由 `components/chat/actions.ts:645-658` 从 `failure`/`code` 合成 `kind:'locked'` 或 `'denied'`。
计划节点的锁定回复还会追加 `withPlanUpdate` 产生的 plan 文本（第五段）。

## 文本收口（presentation.ts + lib/public-text.ts）

聊天正文与事件提示经 `channelText(message, t, fallback)`：`isInternalDiagnostic(message)` 为真回 fallback 词条，`chat.` 前缀键经 `safePublicText` 本地化，其余业务原文原样透传。HTTP 错误另经共享的 `publicToolError` 转为公开业务提示。
判定与 i18n 映射全部复用 `lib/public-text.ts`（`isInternalDiagnostic` / `safePublicText` / `securityNotice`），通道内不另写字符串清洗。
`securityNotice` 把 `MFA_LOCKED` / `mfa_attempts_exhausted` 映射为 `chat.error.actionLocked`，`MFA_FAILED` / `mfa_code_invalid` 映射为 `chat.error.verificationRemaining {count}`，`MANUAL_REVIEW_HOLD` / `manual_review_hold` 映射为 `chat.error.manualReviewHold`，`CIRCUIT_OPEN` / `circuit_open` / `mfa_session_locked` 映射为 `chat.error.securityLocked`，其余为 `chat.error.securityDenied`；判定按 `code` 优先（`code === 'MFA_LOCKED'` 时即使 reason 是 `mfa_session_locked` 也走 `actionLocked`）。
`label(value)`（`presentation.ts:26-27`）不再原样透出未知值：仅当匹配 `^[A-Za-z][A-Za-z0-9_]{0,63}$` 且非内部诊断时输出原枚举，否则为 `未知状态`。
`case 'error'`（`presentation.ts:171`）经 `channelText` 渲染为 `业务提示：…`，SDK 原文只在非内部诊断时透出。
因此 `__SECURITY_BLOCK__…`、`{"decisionKind":…}`、堆栈关键字都不可能经 `channelText` 进入微信回复。
未收口路径：`message_end` 的 assistant 正文（`banking-client.ts:119`）与 `BankingApiError.message`（`bridge.ts:37`，仅按 `status<500` + `^[A-Z_]+$` 过滤，不做诊断判定）原样透出。

## 事件渲染（banking-client.ts renderEvents，85-151）

`renderEvents` 只读取 `message_end` 的 assistant 正文、公开 card、plan、gate、`publicToolSummary` 与 `security_event` 的类型化字段；`text_delta`、`tool_start`、`args`、`debugDetail`、`debugArguments`、`mfaHint` 一律不进入文本。
`security_event` 仅 `kind === 'locked'`（`banking-client.ts:135-142`）参与渲染：`securityNotice({code,reason,attemptsLeft,maxAttempts})` 生成公开拒绝句，并撤销该 `actionId` 的 gate，服务端拒绝过的操作不会再出现验证入口。
其它 `security_event`（如 `kind:'injection'` 携带 `message: scan.note`）仅审计，不产生任何文本。
`action_settled` 只用 `actionId` 撤销 gate（`banking-client.ts:134,145`），其 `message` 被忽略。
`type:'error'` 事件经 `channelText` 进入 notices（`banking-client.ts:143`），不再原样上屏。
工具失败文本统一经 `lib/tool-feedback.ts publicToolSummary` 映射成 i18n 键（`chat.error.*` 不外泄）；`plan.results[].output` 只在 `commands.ts` 取 `pendingActionId`，不渲染。
`deny` 类拦截变成 `ToolEventView{status:'blocked'}` 且无 `actionId`、无 `summary`，`publicToolSummary` 走 `chat.error.operationNotStarted` → “操作未发起。请核对需求和原操作卡片。”。
notices 与 feedback 在拼接前 `new Set` 去重（`banking-client.ts:148`），同一拒绝只出现一行。
`body` 为空时才使用兜底句（`banking-client.ts:149`），`emptyNotice:false` 回空串；默认仍回 `本次请求已处理，请在网页查看业务详情；没有确认或验证的业务不会执行。`。
`renderBusinessCard` 用 try/catch 兜底为 `服务端结果字段不完整，请在网页核对；未据此推断业务成功或余额。`；列表渲染前 `Array.isArray` 校验；电话按 11 位掩码。

## 百分比与符号契约（presentation.ts）

本目录唯一的 `lib/decimal` 引用是 `presentation.ts:8`（`formatDecimalCNY`、`multiplyDecimal`、`rateRatioToPercent`）；全目录没有调用 `signedRateToPercent`、`nonNegativeDecimal`、`addDecimal`、`addMoney`。
产品“预期年化”：`presentation.ts:151` 用 `rateRatioToPercent(row.annualYieldRate)`；该函数是 `signedRateToPercent(nonNegativeDecimal(ratio))`（`lib/decimal.ts:76-78`），负值抛 `AppError('VALIDATION')`。
`ProductView.annualYieldRate`（`banking-sdk/types.ts:413`）在创建（`lib/db/repositories/investment.ts:33`）与投影（`banking-sdk/investment.ts:219`）两处被 `nonNegativeDecimal` 上闸，负值到不了本行；万一出现，抛错被 `renderBusinessCard` 的 try/catch（`presentation.ts:109-112`）吞掉，降级的是整张理财卡，不是单个字段。
持仓收益率：`presentation.ts:88` 用本文件 `percentText`（`presentation.ts:70-72`），只做 `multiplyDecimal(ratio,'100')` + `formatDecimalCNY`，不过非负门禁，因此亏损持仓正常显示负号（种子持仓 `holding_wenjib` 即负）。
`HoldingView.profitRate` 是有符号业务事实（`banking-sdk/net-value.ts#profitRateOf` 保留 `profit` 符号，零成本时缺省）：不能改用 `rateRatioToPercent`，否则亏损持仓渲染抛错；网页端对应出口是 `components/banking/HoldingFacts.tsx` 的 `signedRateToPercent`。
精度差异：微信 `percentText` HALF_UP 到 2 位小数（`3.26%`），网页 `signedRateToPercent` 保留 4 位（`3.2575%`）；同一事实两端位数不同是已知差异。

## HTTP 错误通道

`banking-client.ts` 不做运行时 schema 校验（网页侧才用 `components/chat/transport-validation.ts` 的 zod）。
HTTP 错误或 `ok:false` 时，若 `status<500` 且 `error.code` 匹配 `^[A-Z_]+$`，必须用 `publicToolError` 映射为公开业务提示。内部英文、路径和原始诊断不得直接回传。其余错误提示为 `银行服务暂未完成请求，请在网页核对操作记录后再处理。`。
`bridge.ts:37` 把 `BankingApiError.message` 直接作为整条回复，其它异常与网络失败回 `银行请求结果暂时无法确认。请在网页核对操作记录，不要据此判断已成功或资金未变。`。
错码与锁定不经过该错误通道：动作路由始终回 HTTP 200 的 `{ok:true,data:{ok:false,status,code?,failure?,attemptsLeft?,maxAttempts?,message,…}}`，通道只按 `outcome.status` 与类型化失败字段分支。
`ActionResult`（`banking-client.ts:11-20`）声明 `actionId/ok/status/message/requiresMfa/events` 与可选 `code/attemptsLeft/maxAttempts/failure`；服务端 `sessionId`、`tier`、`mfaResult` 被丢弃，`ok` 不参与判断。
`SecurityFailure`（`lib/contracts/security.ts:21-33`）在本目录只以类型形式出现：`banking-client.ts:2` 导入、`banking-client.ts:18` 作为 `ActionResult.failure`；`failure.actionId`/`attemptsUsed` 从未被读取，`reason` 只用于挑拒绝文案（`bridge.ts:93`），`attemptsLeft`/`maxAttempts` 只经 `securityNotice` 影响文案。
本目录不使用网关的 `AuthorizationResult`（`security/security-gateway.ts:102-122`）：通道自带 `ActionResult`，其 `code` 是 `string`、`failure` 可选，因此锁定分支用 `outcome.failure ?? { code: outcome.code }` 兜底（`bridge.ts:87`）。
验证码只出现在本次 verify 请求体，不写 state、不回显、不进模型。

## 待办展示（commands.ts:18 / presentation.ts renderAttention）

`GET /api/actions` 返回的 `attention === 'decision'`（`pending`/`awaiting_mfa`）走 `renderAction`，两者唯一差异是末行 `状态：等待验证码` 与 `状态：等待确认`。
其余 attention（`processing`/`recoverable`/`reconciliation`）走 `renderAttention`：`状态：` + `label(attention)`，可恢复时附 `/恢复操作 {id}`，并声明 `该记录不能重新确认；结果不明时请核对操作记录，不要重复办理。`。
空列表回 `没有待处理的操作。`；`/任务` 无计划回 `没有多步任务。`；未展示的计划不控制，回 `请先发送 /任务 查看服务端任务和编号，再控制指定任务。`。
`/待办` 仅为当前展示的 decision 登记 `offered[id] = {confirmed:false, shortId}`。
尚未展示的后续 decision 不得登记授权入口。
已有记录必须保留原短编号和确认状态。
首次登记的 `awaiting_mfa` 操作必须先走一次 `/确认` 才能提交验证码。
服务端 `GET /api/actions` 只返回未结算行，`locked` 操作不会出现在 `/待办`。

## 持久化、去重与 outbox

去重键 `key = sha256(botId\0ownerId\0messageId)`（`bridge.ts:12,32`），银行请求 `requestId = weixin:<key>`，发送 `client_id = bank-<key>-<sent>`（`bridge.ts:36,48`）。
`state.deliveries[key] = { replies[], sent }` 在首次发送前写入并 `save()`。`message-chunks.ts` 每段最多保留 1600 个 Unicode 码点，优先在段落或换行处分段，超长单行才按码点切开。拼接所有分段必须还原原文，完整命令行长度允许时不得从中间切开。每段发送成功后 `sent++` 并保存，重投复用相同 `client_id`，不再进入模型。
已发完的旧 delivery 在超过 2000 条时被淘汰（`bridge.ts:42`）；`offered`/`plans` 无淘汰。
state 包含 `version/auth/cursor/deliveries/offered/plans/nextActionNumber`。
`confirmationQueue` 和 `activeActionId` 保存队列及当前操作。
`offered` 保存确认状态和可选短编号；旧状态文件自动补入计数初值。
结算结果不另存结构化状态；`locked`/`failed` 存在于已持久化的回复正文中。
outbox 只存服务端已定稿的回复；锁定回复本身即终态说明，其中不含任何后续成功或处理语。
`worker.ts` 只在整批消息处理完后提交 `cursor`，中途停止不提交，靠去重继续；`-14`/401/403 判定登录失效并要求重新扫码，其它错误只报 `微信通道请求暂时失败，5 秒后重试；未提交消息游标。`

## 测试覆盖

本目录的行为由 `tests/unit/weixin-channel.test.ts`、`tests/unit/weixin-presentation.test.ts`、`tests/integration/weixin-protocol.test.ts` 与 live e2e 覆盖（`tests/` 节点，本目录只读）。
`tests/integration/weixin-confirmation-queue.test.ts` 经真实银行 HTTP 处理器验证逐笔确认。
该测试必须验证订阅查询完成后，分类限额仍等待下一次确认。
已覆盖：非受信消息丢弃、`message_state` 省略与 uint64 编号、`text_delta` 不外发、去重与 clientId 复用、outbox 保存后重发、未展示编号拒绝、先确认再验证、验证码不落盘、`locked` 显示 `已锁定`、网络失败不推断、`renderEvents` 各 card 与 gate 撤销、计划五个控制动词、`/待办` 与 `/检查到期`、pi-weixinbot 线协议、live e2e 的确认/错码/正码/取消。
缺口：锁定回复的三类文案（本操作次数用尽 / 账户熔断 / 行已 `locked` 后的重试）、`继续验证：` 续接行、非 `locked` 状态的 `label()` 输出、`security_event{kind:'locked'}` 的渲染与 gate 撤销、内部标记/JSON/堆栈不上屏、`emptyNotice:false` 与默认兜底句的差异。
缺口：`/验证` 缺少验证码的分支、`确认和取消命令不接收验证码。`、`命令格式不正确。`+HELP 全文、超 4000 字、非文字消息回执。
缺口：`BankingApiError`→`服务端提示（CODE）：…` 的转发（含 423 CIRCUIT_OPEN、404、409）；`/待办` 与 `/任务` 的空列表文案；`/定时任务`、`/帮助`；`/恢复操作` 经 `bridge` 的 verb→`recover` 分派。
`weixin-message-chunks.test.ts` 与 `weixin-channel.test.ts` 覆盖分段边界、Unicode 完整性、多段续传及稳定发送编号；续传不得重复调用银行接口。
缺口：2000 条 delivery 淘汰、`offered` 不失效后的重复 `/确认`。
缺口：`worker.ts runWeixinWorker`（游标提交时机、`-14`/401/403 分类、5 秒重试、`health().llmMode` 播报）、`login.ts` 扫码流程、`transport.ts createWeixinTransport`、`state.ts` 损坏锁文件与损坏 state.json 分支、`config.ts weixinConfig` 默认值。
