# 测试约定

## 目录与范围

| 目录 | 范围 |
| --- | --- |
| `unit/` | 策略、参数、金额、执行器与展示状态；安全、SDK 与执行权用例使用真实 SQLite |
| `scenarios/` | 编号演示场景 `test-01`…`test-19` 与离线模型场景 |
| `app/` | 进程内真实路由与 SSE 集成 |
| `integration/` | 执行、授权、回执、审计与恢复 |
| `helpers/` | 隔离数据库、夹具、模型脚本与进程恢复探针 |
| `e2e/` | 独立入口的真实浏览器验收与 HTTP 边界用例 |
| `fixtures/` | 共享的 `*.zh-CN.json` 对话与策略剧本，无本地 CONTEXT.md |

本目录根部的 `setup.ts` 准备测试库，`deploy-db-push.test.ts` 覆盖 `scripts/db-push.ts` 的冷库自建。

根 `vitest.config.ts` 收集 `tests/**/*.{test,spec}.ts` 与 `agent/**/*.{test,spec}.ts`。
`.e2e.ts` 与 `.e2e-helper.ts` 不匹配该 include，`pnpm test` 不会运行它们。
浏览器与边界入口一律用 `pnpm exec tsx <入口>` 单独运行。
默认使用 mock 模式，不调用真实模型。

## 入口

| 入口 | 内容 |
| --- | --- |
| `e2e/acceptance.e2e.ts` | mock 模型的真实浏览器验收，场景在 `JOURNEYS`，用 `E2E_JOURNEYS` 选择 |
| `e2e/live-acceptance.e2e.ts` | 真实模型的真实浏览器验收，场景在 `SCENARIOS`，用 `LIVE_SCENARIOS` 选择 |
| `e2e/date-tamper-boundary.e2e.ts` | 消费入账时间的纯 HTTP 边界用例，无模型、无浏览器 |

`SCENARIOS` 的 id 为 `15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB,lC,lD,lE,lF,lG`。
`lA` 补办信用卡、`lB` 理财部分赎回、`lC`…`lE` 虚拟卡场景、`lF`/`lG` 挂失→补办链路场景（`lF` 新会话、`lG` 单会话完整链路）；选择 `2` 会同时选中 `2p`，场景 `7` 恒为最后阶段。
`e2e/helpers.ts` 与 `*.e2e-helper.ts` 是入口共用的驱动与断言模块，自身不运行。
入口细节见 [e2e/CONTEXT.md](e2e/CONTEXT.md)。

## 数据与执行

`setup.ts` 固定使用 `prisma/test.db`。
它检查生成客户端，并按结构哈希准备测试库。
准备失败会抛出完整诊断。
夹具由测试通过 `resetDatabase` 等入口加载。

共享 SQLite 测试必须顺序执行。
不得同时启动多个会重置同一测试库的进程。
浏览器与部署测试也必须单独运行。
隔离库名称与行为见各子目录说明。
不得把开发库或用户备份用于测试重置。

熔断状态按所有者持久化。
同一用户的新会话不能隔离该用户的锁。
需要隔离时重置夹具或创建独立用户。
仅数据库无关测试可使用 `VITEST_SKIP_DB_SETUP=1`。

## 编写测试的不变量

消费入账时间由服务端拥有：`POST /api/cards/[id]/consume` 与 `consume_virtual_card` 工具都不接受时间参数。
请求体含 `occurredAt` 键返回 `400 VALIDATION`，工具参数含 `occurredAt` 等客户端时间字段则在调用 SDK 前抛出 `VALIDATION`。
两种拒绝都不移动资金、不写流水与 `CardConsumption`。
入账瞬间固定为 `demoNow()`（UTC+08:00 月窗口），断言只核对渲染金额、余额、流水与消费行。

补办卡继承源卡的结算账户，缺失绑定只按显式前驱修复，绝不回退默认账户。
补办卡与源卡共享同一连续月度额度（`banking-sdk/card-family.ts` 双向遍历 `replacedByCardId`），历史 `CardConsumption` 保持原卡归属不改写。

卡片集合按 id/type/状态断言，不使用固定卡片总数。
mock 夹具播种 `card_credit`/`card_debit`，演示种子（`prisma/seed.ts`）另有 `card_virtual`。
`lA` 补办后为「补办 ACTIVE 信用卡 + LOST 源卡 + DEBIT + VIRTUAL」，由类型/状态推导而非硬编码。

`tests/helpers/db.ts#truncateAll()` 清空 `prisma/schema.prisma` 的每一个 model（含无关系的 `CardConsumption`）。
套件不得在 `useFreshDatabase()`/`resetDatabase()` 之后再自行逐表清理。
新增 model 必须同时补进 `truncateAll`，否则 `helpers/db-truncate.test.ts` 失败。

## 面板声称的覆盖

确认/MFA 面板只在安全网关从真实工具调用持久化 `PendingAction` 后出现；模型散文不创建面板。
`unit/agent`（`write-continuation*.test.ts`、`system-prompt.test.ts`）与 `integration/write-continuation.test.ts` 覆盖「声明写操作却只用散文声称面板/等待确认、未发出工具调用」的场景：服务端做一次有界续接，仍无写入时以服务端叙述发布真实未提交状态，伪造声称绝不进入会话记录。
同一覆盖断言「参数齐全→续接后真实发起（打开真实网关闸门）或被网关拦截」以及「信息不足→正常澄清，不消耗续接预算」。
`e2e/panel-claim.e2e-helper.ts#findConfirmationPanelClaim` 纯文本判定助手散文是否声称确认/MFA 面板已存在，`unit/panel-claim.test.ts` 覆盖其正/负例；否定表述与普通追问不误判。
`e2e/live-acceptance.e2e.ts#driveRedTool` 与相关场景经 `helpers.ts#assertNoFabricatedConfirmationPanel` 在「散文声称面板 + `/api/actions` 无待处理项 + DOM 无卡片」时显式判定失败，错误区分 cause=模型未发起受控工具与 cause=UI/测试原因。
`unit/planner/mock-amount-clarification.test.ts` 与 `app/nl-entry-http.test.ts` 覆盖「信息不足→澄清，不产生工具调用」，但澄清为结构化 `missing_details` 或纯文本追问，非“面板”声称。
细节见各子目录 CONTEXT.md。

## 卡片生命周期能力契约的覆盖

能力事实以 `lib/contracts/tool-catalog.ts` 与 `lib/contracts/card-management.ts` 为准：
`replace_card` 与 `apply_virtual_card` 是模型可调用的 RED 写工具，只有 `manual_add_card`/`manual_delete_card` 为人工专属。
这些用例只断言服务端事实与持久化行，不使用凭据、不调真实模型、不联网。

| 文件 | 覆盖 |
| --- | --- |
| `unit/card-tool-catalog.test.ts` | 目录真值：`replace_card` 存在、类型中立、RED/requiresReceipt/maxAttempts 3；模型目录内没有任何新建/删除实体卡工具 |
| `unit/agent/card-capability-guidance.test.ts` + `unit/agent/capability-guidance-markers.ts` | 遍历 `agent/messages/*.json` 全部语言目录，按句断言卡片管理指引不得否认 `apply_virtual_card`/`replace_card`，人工规则限定在新建/删除实体卡；`overbroadManualOnlyCardProhibitions` 的必判违规例（`Issuing or deleting physical debit and credit cards remains manual-only … cannot be included in an Agent workflow.` 及其 `Offer replace_card …` 后续句）与合规例 |
| `unit/agent/system-prompt.test.ts`（`system prompt card capability scope`） | 系统提示词的 `manual-only` 语句不得套用到已挂失卡的补办，实体卡人工规则限于新建 |
| `integration/card-replace-capability-contract.test.ts` | 真实网关路径下三种卡类型的 RED + MFA 可达性、验证前无副作用、验证后仅一张新卡与类型继承；非 `LOST` 源卡的 CONFLICT 且不改状态；重复请求落到同一张补办卡并可重放 |
| `integration/card-manual-only-management.test.ts` | `manual_add_card`/`manual_delete_card` 在代理路径上仍被拒绝，用户侧副作用快照不变 |
| `scenarios/test-18-card-capability-consultation.test.ts` | 补办咨询与歧义目标只澄清、不产生动作；指引信封不创建 `PendingAction`；话术不得否认真实能力；生产提示的人工专属规则限于「新建实体卡 + 注销卡片」并声明集合封闭，`replace_card` 覆盖任意类型已挂失卡且从不说成页面专属 |
| `scenarios/test-19-card-replace-credit-runtime.test.ts` | 生产运行时下已挂失信用卡的补办走 RED MFA，验证后仅一张补办卡、源卡仍 `LOST` |

话术断言绑定产品原文：`test-18` 与 `unit/agent/card-capability-guidance.test.ts` 读取目录与提示词的真实渲染结果，
因此改动 `agent/messages/*.json` 的卡片管理条目或 `agent/system-prompt.ts` 的 `manual-only` 语句时必须同时核对这两处。

## 终止锁定（locked）结果的覆盖边界

MFA 次数耗尽与已开熔断都产出终止 `locked` 域结果，本目录按两套入口分别覆盖：

| 入口 | HTTP | 断言位置 |
| --- | --- | --- |
| 写操作的 `verify`/`confirm` 路由 | 恒 `200` + `data.ok:false` + `status:'locked'` | `app/mfa-terminal-lock-http.test.ts`、`app/actions-http.test.ts`（circuit breaker 块） |
| `/api/security/reset` 解锁闸门 | `423` + `error.code:'CIRCUIT_OPEN'` | `app/security-workflow-http.test.ts`、`integration/confirmation-policy.test.ts` |
| 网关/SDK 进程内 | 无 HTTP | `unit/security/gateway.test.ts`、`authorize-hardening.test.ts`、`circuit-breaker-*.test.ts`、`unit/security/mfa-failure-contract.test.ts`、`integration/security-deny-redaction.test.ts`、`unit/agent/turn-security-event.test.ts`、`scenarios/test-10-circuit-breaker.test.ts` |
| 渲染/文案层 | 无 HTTP | `unit/planner/locked-card-rendering.test.ts`、`unit/weixin-lock-presentation.test.ts`、`unit/security/unlock-panel-render.test.ts`、`unit/lib/public-text.test.ts`、`unit/planner/tool-diagnostics.test.ts` |

锁定事实一律按 `status`、`mfaResult`、`PendingAction` 行、`GET /api/actions` 是否再surface 与 `SecurityEvent` 行断言。
写操作路由锁定路径上对 `events` 的断言只有负例（不再出现该 actionId 的 `mfa_required`），没有公开工具事件摘要断言。
`unit/planner/action-contract.test.ts`、`action-attention-state.test.ts` 用桩造的 `message`（如 `'Verification locked'`）断言客户端把服务端锁定消息透传成 `error` + `action_settled`。
渲染层锁定不再是单点用例：`unit/planner/tool-diagnostics.test.ts` 仍唯一断言 `ConfirmationCard` 出 `cards.terminal.locked` 且无 `<button>`；`unit/planner/locked-card-rendering.test.ts:85-107` 断言 `MfaCard` 的 `data-mfa-locked`、目录锁因句、`href="/security"`、无 `<input>`/`<button>`/`123456`/`继续验证：`，`awaiting_mfa` 保留输入面见 `:109-118`，`ApprovalRecord` 见 `:120-132`，`security_event` 折叠见 `:134-155`；`unit/security/unlock-panel-render.test.ts:67-157` 覆盖 `/security` 解锁面板（`data-unlock-*`、真实目录值、单一验证码输入、无内部诊断）。
`e2e/acceptance.e2e.ts` 的 `j-circuit-breaker-lock` 在真实浏览器连错三码，用未限定 `[role="status"]` 的子串匹配断言 `cards.terminal.locked`，并核 `/security` 的「已熔断」「失败 3 / 3 次」与 `CIRCUIT_BREAKER_TRIPPED` 行。

锁定文案既有子串断言也有全等断言：`scenarios/test-10-circuit-breaker.test.ts` 断言 `thirdAttempt.text` 含「锁定」、`auth.message` 含「熔断」；`integration/money-budget.test.ts` 断言执行栅栏的 `CIRCUIT_OPEN` 结果含「熔断」。
完整锁定句由 `unit/weixin-lock-presentation.test.ts:87-92` 的四段模板定义，并以 `:99`/`:112`/`:123`/`:157` 的 `toBe` 全等断言；单次错码的 `状态：等待验证码` + `继续验证：/验证 …` 见 `:134`，该入口只属 `awaiting_mfa` 见 `:144-152`。
`chat.error.securityLocked` 由 `unit/lib/public-text.test.ts:79-87`（zh-CN/en 双语言）、`unit/planner/locked-card-rendering.test.ts:148-186`、`unit/weixin-lock-presentation.test.ts:112-183`、`unit/agent/turn-security-event.test.ts:98` 断言。
`publicToolError` 由 `unit/planner/tool-feedback.test.ts`（通用失败 `chat.error.toolFailed`）与 `unit/lib/public-text.test.ts:33-60` 覆盖。
`publicToolSummary` 被断言到目录锁定句，见 `unit/agent/turn-security-event.test.ts:92-98` 与 `unit/planner/locked-card-rendering.test.ts:176-180`。
`security_event` 的 `kind:'injection'` 由 `app/chat-http.test.ts`、`app/malicious-input-http.test.ts` 断言；`kind:'locked'` 由 `integration/security-deny-redaction.test.ts:132`、`unit/agent/turn-security-event.test.ts:56-67`（`code`/`reason` 为 typed、`message` 必须 `undefined`）、`unit/weixin-lock-presentation.test.ts:170-210` 断言。
被拦下的工具事件带目录句 `summary`，断言在 `unit/agent/turn-security-event.test.ts:77-98` 与 `unit/planner/locked-card-rendering.test.ts:157-194`。
`helpers/scenario.ts:304-308` 复刻生产的投影：只发 `kind/code/reason/actionId/attemptsLeft/maxAttempts`，从不发 `message`，与 `agent/turns/events.ts` 同形；场景用例继承的可观测面已由 `unit/agent/turn-security-event.test.ts:56-67` 断言。
`components/chat/transport-validation.ts:101` 对 `security_event` 校验 `kind` 为 id 串，可选 typed `code`/`reason`。
出站/渲染文本不含 `__SECURITY_BLOCK__` 有多处负例：`unit/agent/turn-security-event.test.ts:38`、`unit/lib/public-text.test.ts:41`、`unit/planner/locked-card-rendering.test.ts:35`+`:106`、`unit/security/unlock-panel-render.test.ts:125`、`unit/weixin-lock-presentation.test.ts:207-246`、`unit/security/mfa-failure-contract.test.ts:101-102`、`integration/security-deny-redaction.test.ts:48`。
`components/chat/transport-validation.ts` 对该帧只校验任意 `kind`/`message` 字符串，拒绝矩阵中没有这一帧。
没有任何用例断言用户可见文本不含 `__SECURITY_BLOCK__`：该字面量在 `tests/` 内只出现在 `unit/agent/providers/provider-mock.test.ts`（mock responder 的 block 前缀）。
`lib/tool-feedback.ts` 的 `PUBLIC_BUSINESS_ERRORS`/`PUBLIC_ERROR_CODES` 不是导出契约，测试只经 `publicToolError` 逐条命中，登记表无完整性断言；其中锁定句→`chat.error.securityLocked` 与 `PUBLIC_ERROR_CODES.CIRCUIT_OPEN` 两条无用例。
已开熔断时模型无法解锁：`resetSession` 需验证码或冷却，见 `unit/security/circuit-breaker-reset.test.ts`。
空 `blockedOutcome`/`conflictOutcome`/`withLiveConfirmation` 无测试直接引用；`executeGatedTool` 由 `helpers/faux-agent.ts`、`integration/refactor-security-runtime.test.ts` 从 `@/agent/confirmation` 引入，`confirmAction` 由 `integration/conversational-turns.test.ts` 引入。

## 微信通道覆盖

通道代码在 `channels/weixin/`（回复模板、`label()` 词表、命令正则、outbox 键以其 CONTEXT.md 为准），本目录只从外部断言，不复刻渲染逻辑。
用例分散在 `unit/`、`integration/`、`e2e/` 三处，没有单独的子目录。

| 文件 | 覆盖 |
| --- | --- |
| `unit/weixin-presentation.test.ts` | `renderEvents`/`renderBusinessCard`/`renderAttention`：17 种 `ChatCard` 的金额与掩码（`it.each` 参数化）且不回显 `NEVER_DISPLAY`/完整手机号、card 与 `message_end.cards` 去重、`action_settled` 后旧 gate 不复活、写操作成功后不再输出旧余额、已取消订阅不提下次扣费、`plan_update` generation 防回退、`processing/recoverable/reconciliation` 不称「尚未执行」、畸形字段兜底「字段不完整」、`blocked` 工具事件只发公开提示（不回显 `chat.error.`/`debugDetail`）、五个计划控制动词与 `/待办`、`/检查到期` 的银行调用参数 |
| `unit/weixin-channel.test.ts` | 非受信/不完整消息丢弃、`message_state` 省略与 uint64 编号、`text_delta` 不外发、同消息重投与重启去重（`requestId` 形如 `weixin:<64 hex>`）、发送失败保留 outbox 且 `client_id` 不变、未展示编号「不是本通道」、先 `/确认` 后 `/验证`（验证码不落 state）、`status:'locked'` 回执含「已锁定」且不伪造「状态：executed」、网络异常「暂时无法确认」、verify 路由与请求体、URL 白名单、`WeixinStore` save/load 与双 worker 互斥 |
| `integration/weixin-protocol.test.ts` | 固定版本 `pi-weixinbot` 线协议：轮询 Bearer+游标+uint64 编号、发送固定收件人/上下文/幂等 `client_id`、`ret:-14` 不视为已发送 |
| `e2e/weixin-live.e2e.ts`、`e2e/weixin-capabilities.e2e-helper.ts` | live 模型 + Chrome + 本地微信协议服务器（非手机实测，每轮新建 `prisma/weixin-live-<UUID>.db`）：陌生人隔离、余额查询回复含真实金额、转账确认前不动账且重复投递不重复扣款、RED 确认→错码 `000000` 不改卡→正码执行、`/取消` 与网页待办一致；`WEIXIN_LIVE_EXTENDED=1` 追加 `runWeixinCapabilities` 的工具矩阵与 `/任务` 控制流 |

### 微信通道已知缺口

- 无任何用例断言 `locked` 的完整微信回复：只断言含「已锁定」与不含「状态：executed」，未断言 `状态：已锁定` 行、未断言不回显 `继续验证`、也未断言服务端 `outcome.message`（如「验证码错误次数过多……安全中心」）原样透传。
- `awaiting_mfa` 回复的 `状态：等待验证码` + `继续验证：/验证 …` 从未断言，只核对 `settle` 调用参数。
- 微信入口无「第三次错误验证码→锁定」用例；`scenarios/test-10-circuit-breaker.test.ts` 走代理路径，不经通道。
- 无 `/验证 <id>`（缺码）、`/取消 <id>` 回执、`/恢复操作 <id>` 的 bridge 分派、`命令格式不正确`、非文字/超长消息、`BankingApiError`（`服务端提示（CODE）：…`，含 `CIRCUIT_OPEN` 信封）的用例。
- 无断言出站文本不含 `__SECURITY_BLOCK__`：`renderEvents` 忽略 `security_event` 仅由代码保证；`__SECURITY_BLOCK__` 在 `tests/` 内只出现在 `unit/agent/providers/provider-mock.test.ts`（mock responder 的 block 前缀，与通道无关）。
- 无 `worker.ts` 的游标提交与 `-14` 重扫码、outbox 1600 字切块与 2000 条淘汰的用例。

## 常用命令

`pnpm test` 运行全部 Vitest 测试。
`pnpm exec vitest run tests/unit` 运行指定目录。
`pnpm typecheck` 检查类型。
`pnpm exec tsx tests/e2e/acceptance.e2e.ts` 运行浏览器验收。

## 证据范围

原始 Pi 场景与生产运行入口必须区分。
测试模型输出不证明真实模型的稳定性。
路由处理器测试不证明浏览器渲染或点击行为。
业务断言必须核对余额、流水、状态与审计。
展示断言必须区分模型原文与服务端金融结果。

不得将历史通过数量写成当前验证结果。
不得删除断言或跳过失败来宣称通过。

完整测试方法见
[test-cases.md](../docs/cn/test-cases.md)。
