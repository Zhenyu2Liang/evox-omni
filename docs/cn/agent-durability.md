# 持久化与恢复

[English](../en/agent-durability.md) | **简体中文**

银行智能体使用 Pi Core 驱动对话和工具调用。
Prisma 数据库保存模型请求、事件和执行回执。
恢复继续原运行，并保留原工具调用身份。

## 数据记录

| 记录 | 保存的事实 |
| --- | --- |
| `AgentRun` | 原输入、运行状态、会话版本和执行租约 |
| `ModelRequest` | 模型请求上下文、完整响应、轮次和尝试次数 |
| `AgentRunEvent` | 按运行内序号排列的事件 |
| `ToolInvocation` | 原参数、工具调用状态、重试规则和执行键 |
| `PendingAction` | 原待确认操作与用户授权结果 |
| `ExecutionReceipt` | 已提交业务的完整原结果 |

检查点保存完整的运行状态。
检查点包含消息、会话意图、对话记录和模型配置。
检查点还保存压缩摘要、原消息范围和未完成摘要请求。
模型输入可以使用摘要视图，检查点仍保存完整原始消息。
压缩与归档查询见[上下文压缩](context-compaction.md)。
会话提交同时核验执行租约与会话版本。
旧执行者不能覆盖新会话或提交新的金融变更。

相同 `requestId` 和输入摘要定位原运行。
同一 `requestId` 改传其他输入时，系统报告冲突。
恢复不会创建替代运行来绕过原执行状态。

## 请求与事件的保存顺序

模型请求先提交数据库，再联系模型服务商。
摘要调用 Pi Coding Agent 的公开 `compact()`。
数据库适配层保存独立压缩事件和批次检查点。
摘要请求不占用普通业务模型请求身份。
官方 `compact()` 负责每批摘要，适配层负责中断恢复。
摘要的实际请求上下文先保存，再联系服务商。
重启时复用已保存上下文，保留原摘要请求身份。
`ModelRequest` 保存原模型、端点和工具定义。
完整 `message_end` 保存后，工具才能开始执行。

### 供应商传输与审计

当前 `openai-completions` 使用 Pi 官方 `fetch` 扩展点。
成功的 SSE 响应必须收到 `[DONE]`，才能按协议结束。
仅收到 `finish_reason: stop` 后遇到文件结束（EOF），仍是连接失败。
完整工具参数后缺少 `[DONE]`，也不能创建授权或执行操作。
消息和工具参数仍由官方 Pi SDK 映射。
传输检查不分析正文，也不改写供应商文字。

`withModelAudit` 使用 Pi 官方回调保存传输证据：

| 记录 | 内容 |
| --- | --- |
| `provider_request_payload` | 实际发送的请求正文；保留实际传出的 `max_tokens`、`stop` 等字段。 |
| `provider_response_headers` | HTTP 状态，以及白名单中的内容类型和请求标识。 |
| `provider_response_event` | 供应商响应增量，以及 `transport_end` 结束记录。 |

请求正文来自 `onPayload`，包含调用方修改后的有效值。
响应头来自 `onResponse`，只保留 `content-type`、`x-request-id` 和 `request-id`。
响应增量由 `onProviderStreamEvent` 记录。
结束记录保存 `completed`、累计字节数 `bytes` 和数据帧数 `frames`。
收到结束标记时，同时保存 `terminator: [DONE]`。
这些记录均绑定对应的 `modelRequestId`。
记录写入完成后，模型请求才能完成登记。

工具参数碎片只记录字节数和脱敏标记。
Pi 拼装后的完整工具调用仍按原日志规则脱敏保存。
认证头、密钥和凭据不进入供应商审计记录。
传输完成只证明协议结束，不能证明语言在语义上完整。
供应商审计记录只作传输证据，不判断回复是否可信。

未完成的模型输出只保存为事件证据。
错误、中止和截断响应不能作为可执行决策。
恢复会重新生成未完成的请求。
恢复后的文本可能与原流式输出不同。

原 Pi 事件在转换或发布前保存。
工具开始事件和工具调用记录在同一事务中提交。
日志写入失败时，执行停止。

| 事件通道 | 用途 | 公开范围 |
| --- | --- | --- |
| `raw` | 原 Pi 生命周期、模型增量和工具事件 | 服务端内部 |
| `internal` | 检查点、重试、恢复和供应商传输证据 | 服务端内部 |
| `ui` | 依据业务事实生成的展示事件 | 所属会话可读取 |

密码、可识别令牌和密钥在保存前脱敏。
输入摘要使用脱敏前的规范输入计算。
脱敏后的凭据不能再次作为操作参数执行。

## 工具调用身份

服务端生成工具调用 ID 和运行内序号。
模型给出的 call ID 只用于关联模型消息。
后续模型轮次可以重复使用 call ID。
并发重叠的相同 call ID 会被拒绝。

`origin` 区分 Pi 调用与工作流子调用。
子调用关联模型请求、父调用、任务和节点。
Pi、HTTP 续跑和调度路径共用 `ToolInvocation`。
节点执行键 `nodeExecutionKey` 在重试后保持不变。

工具参数摘要与金融命令摘要各有用途。
前者绑定模型提出的调用。
后者绑定规范化后的业务参数。
核验执行回执时，还需检查用户、工具和执行键。
转账回执还需匹配已入账账本。

`resultJson` 使用 `ToolExecutionResult` 格式。
原 Pi 工具结果仍保存在 `raw` 事件中。
`responseJson` 保存执行回执的完整原结果。
模型文字不能替代这些业务证据。

## 自动重试与结果重放

重放返回已保存的原结果。
重试重新执行同一工具调用。
两种动作均保留原工具调用 ID 和执行键。

| 保存的重放规则 | 自动恢复条件 |
| --- | --- |
| `read_only` | 当前仍允许自动查询，且未超过尝试上限 |
| `idempotent` | 适配器能核验身份和摘要，并原子提交执行回执 |
| `reconcile_only` | 仅恢复已证明的结果，结果不明时转人工核对 |

自动重试同时检查保存规则与当前规则。
代码更新不能把原不安全调用改成可自动重试。
重试使用比较后更新，只有 1 个执行者能领取尝试。

以下情况不会触发自动业务重试：

- 用户确认或多因子认证尚未完成。
- 参数校验、权限检查或认证失败。
- 资金不足、额度超限或业务拒绝。
- 用户取消或结果无法证明。

若金融写入已提交，优先恢复原执行回执。
系统不会因为结束事件丢失就再次扣款。
回执缺失或矛盾时，自动恢复停止。

用户显式重试失败节点时，系统重新检查授权。
系统先证明原失败尝试未提交金融效果。
重试仍使用原节点调用与执行键。
新的待确认操作不能充当旧操作的自动批准。

## 崩溃后的恢复决策

| 中断位置 | 恢复动作 |
| --- | --- |
| 输入已保存，运行时尚未创建 | 从原输入检查点创建运行时 |
| 模型请求已保存，响应未完成 | 按次数上限重新生成原请求 |
| 完整模型决策已保存，工具未开始 | 按原 call ID 和参数检查并执行 |
| 查询已开始，原结果未保存 | 重新检查权限，再重试原调用 |
| 金融写入已提交，返回或结束事件丢失 | 核验回执和账本，恢复原结果 |
| 写操作结果不能证明 | 保存人工核对状态 |
| 确认操作已保存，会话尚未保存 | 重建原调用上下文，等待原授权 |
| 授权写操作已提交，结果展示中断 | 核验原 action 和回执，生成结果文字 |
| 查询已确认，同一建议问题续答中断 | 核验原查询与问题，恢复原分析请求 |
| 工作流前置节点已完成 | 恢复唯一原图，保留已完成节点 |
| 原计划调用已保存，图尚未创建 | 证明没有子调用后，首次创建图 |
| 会话已提交，运行结束状态未保存 | 结束原运行，不再请求模型 |
| 原会话版本、模型或端点改变 | 停止原模型续跑 |
| 未完成模型请求的工具声明改变 | 拒绝重发原模型请求 |

授权结果续讲还核验以下绑定：

- 原用户、会话和待确认操作。
- 原工具调用及父调用。
- 原 task、node 和资金账户。
- 模型上下文里的原工具结果。

仅恢复指定调用时，也检查续跑会使用的其他结果。
已完成金融调用必须有匹配的执行回执。
旧计划结果不能跳过尚未完成的原图。
暂停、取消、失败的图保留原控制状态。

## 已锁定操作的恢复

`locked` 是终态：验证码尝试用尽或账户熔断后，操作已结算为拒绝。
恢复和重连只报告这个事实，不把操作写回待决定状态。
锁定判定与对外文案见[安全设计](security.md#多因子认证)。

`agent/durable/continuation.ts#restoreWaitingCheckpoint` 按持久化的状态投影原停放调用：

| 持久化状态 | 恢复时发布的内容 |
| --- | --- |
| `locked` | 保留原工具行和目录文案，另发类型化 `security_event`。`code` 为 `MFA_LOCKED`，`reason` 为 `mfa_attempts_exhausted`。 |
| `executed`、`failed`、`cancelled`、`needs_reconciliation` | 同一结构，`code` 和 `reason` 取该状态的已结算事实。 |

投影只依据持久化状态，不重新区分锁定来源。
`settledParkedProjection` 不重建确认或验证码面板。
已提交的 `__SECURITY_BLOCK__` 载荷留在工具事件和内部结果中，公开文本改由目录文案生成。
已锁定调用不重新验证、不重试，也不进入人工核对。

`agent/action-status.ts#mayPromptForDecision` 只在 `pending`、`awaiting_mfa` 时返回真。
`agent/turns/authorization-view.ts` 和 `agent/turns/events.ts` 用同一判定发布决定入口。
因此终态行在恢复和重连后都不弹出确认或验证码卡片。

`agent/action-status.ts#isLegalActionSourceStatus` 从不把 `locked` 当作来源状态。
`isClaimableActionStatus` 同样排除 `locked`。
`agent/confirmation-recovery.ts#settlePendingAction` 在事务开始前拒绝非法来源，不写入状态、结果或审计。

用户显式重试锁定操作时，系统新建 `PendingAction`。
`agent/workflows/parked-actions.ts` 以 `MFA_LOCKED` 拒绝原行。
账户解锁不改变该行，见[安全设计](security.md#多因子认证)。

## 回复纠正与建议续答

回复格式检查识别完整协议封套。
发现格式问题时，在原上下文中请求模型纠正一次。
单独出现金额、业务词或旧草稿词，不触发自动重答。
办理状态和余额另经[事实检查](chat-presentation.md#办理状态与余额)。
该检查使用现有证据生成状态，不为替换错误表述新增模型请求。
业务结果由独立工具记录、授权和回执说明。
页面暂缓展示未经校验的候选回复。
原始候选继续保存，纠正不会裁剪归档消息。
撤销候选正文时，只移除该正文的展示事件。
同时发布的工具、结果卡和计划记录继续保留。

`replyRepair` 保存同一运行的纠正预算。
状态包含原候选校验值、纠正指令和问题类型。
`attempt` 固定为 `1`，表示至多 1 次纠正生成。
阶段按以下顺序保存：

| 阶段 | 保存或恢复动作 |
| --- | --- |
| `requested` | 先保存预算和原纠正指令，再请求模型。 |
| `completed` | 纠正响应已完成；继续校验该响应。 |
| `fallback` | 纠正仍有问题；保存具体提示文字。 |

响应已登记，但阶段检查点尚未保存时，恢复识别该响应。
系统更新阶段，不再追加新的纠正请求。
未完成的纠正请求仍按模型重试规则使用原输入。
服务重启不增加新的纠正预算。
用户发出新消息后，系统清除上一运行的纠正状态。
输出截断属于生成失败，不能替代完整回复。
收到 `stop` 和 `[DONE]` 后，不根据句尾词语请求补全。
底层模型流缺少 `done` 或 `error` 时，登记生成失败。
流结束前收到的文字和用量保留。
调用不会继续等待已经缺失的结束事件。

查询、建议和办理准备可能需要确认读取。
查询确认后，可继续处理仍在当前轮次的原问题。
服务端用 `replyContext` 保存原问题及所属模型请求。
该状态只由已验证的查询上下文生成。
浏览器参数和模型文字不能设置续答目的。

恢复查询续答或办理准备时，核对以下条件：

- 原模型请求属于该用户和会话。
- 原问题与保存的问题一致。
- 原模型请求的用途仍与当前声明一致。
- 最新用户消息仍是该问题。
- 已确认工具属于查询，且结果成功。

这些条件不满足时，不能恢复旧问题。
分析续答仍阻止写操作和工作流提交。
办理准备可用查询结果绑定完整操作序列。
每个后续写入仍需自己的授权。
读取确认不能代替写入确认或验证码。
写入序列绑定后不能改变。
金融写操作的结果文字由服务端生成。
新一轮对话清除旧续答目的，保留全部对话归档。

代码见[回复格式检查](../../agent/reply-format.ts)和[回复纠正](../../agent/turns/live-prompt.ts)。
恢复用例见[纠正预算测试](../../tests/unit/agent/durable-reply-repair.test.ts)。
建议目的用例见[建议恢复测试](../../tests/unit/agent/durable-advice-context.test.ts)。

## 声明写入的单次续写

一轮信息完整且声明了写操作，却没有受控工具调用时，运行时至多追加 1 次续写。
代码见 [write-continuation.ts](../../agent/write-continuation.ts)。

声明来自 `describe_turn` 记录的 `ConversationIntent`，属于模型解释，不是授权。
以下条件同时满足时才触发续写：

- `llmMode` 为 `live`。
- 声明中有 `effect` 为 `write` 的工具。
- 声明明确设置 `needsInput:false`。
- 本轮没有确认事件、验证码事件、写操作结果和 `submit_plan` 调用。
- 最后一条助手消息的 `stopReason` 为 `stop`。
- 该回复不需要格式纠正，也不是可渲染的指引信封。

缺少办理对象或其他选择时，保留澄清并等待用户回答。
模型遗漏声明且声称已提交操作时，可使用同一次续写要求重新解释本轮请求。
这一分支的 `declaredTools` 为空，不从旧正文推断操作或授权。
DeepSeek 非思考模式可要求先调用 `describe_turn`。
该约束只要求解释，不强制调用金融写工具。
其他服务商与思考模式保留原有工具选择方式。
适配见 [required-declaration.ts](../../agent/providers/required-declaration.ts)。

预算随检查点保存，结构见 [reply-repair.ts](../../agent/reply-repair.ts) 的 `WriteContinuationState`：

| 字段 | 内容 |
| --- | --- |
| `phase` | `requested` 表示预算和指令已保存，`completed` 表示续写请求已返回。 |
| `attempt` | 固定为 `1`，表示至多一次续写。 |
| `sourceDigest` | 触发续写的原助手消息摘要。 |
| `instruction` | 发给模型的完整纠正指令。 |
| `declaredTools` | 本轮声明的写工具名，只作证据。 |

预算和指令在联系服务商之前提交。
恢复时 `phase` 已是 `completed`，或原消息摘要改变，都不再请求模型。
`phase` 仍为 `requested` 且摘要一致时，恢复复用原指令发出这一次请求。
恢复路径见 [continuation.ts](../../agent/durable/continuation.ts)，不追加第二次续写。

续写先撤销未校验的候选回复，再发布 `repairing` 进度。
前台续写不设置回复纠正标记，否则声明的写入会被 `beforeToolCall` 拒绝。
续写不创建待确认操作，也不确认、执行或绕过安全网关。

续写后仍没有受控写入时，由服务端说明真实状态。
已声明操作由 [financial-response.ts](../../agent/financial-response.ts) 按真实事实生成状态。
遗漏声明的分支由 [reply-safety.ts](../../agent/reply-safety.ts) 说明未提交状态。
纠错后仍需补充信息时，保留具体问题，不用未提交提示替代问题。

## 单轮模型调用预算

[model-budget.ts](../../agent/model-budget.ts)为同一轮调用维护 `ModelBudgetState`。
预算由本轮意图 ID 标识，并随会话检查点保存。
普通生成、上下文压缩、回复修复及 HTTP 重试共用总量。
请求前先保存次数与 token 预留，再联系模型服务。
失败请求保留已用预留量，不因重试或恢复退还。

输入按上下文的 UTF-8 字节数加协议余量预留。
输出按请求或模型的最大输出预留，余额不足时降低输出上限。
实际 HTTP 重试在发出请求前再次预留。
该保守估计用于限制调用量，不代替供应商的计费统计。

总时长从首次模型调用开始，包含重试和恢复之间的时间。
达到时限后，即使供应商忽略取消信号，也终止本轮输出。
新的用户输入开始新预算。
恢复沿用已保存预算，配置变更只能收紧原上限。
默认值和环境变量见[开发指南](development.md#单轮模型调用预算)。

## 独立工作流

HTTP 和调度工作流可以没有外层模型调用。
完整图和恢复来源在同一事务中保存。
来源使用 `requestJson.kind = "workflow"`。
来源阶段使用 `checkpointStage = "workflow_only"`。

独立工作流恢复读取原图，不请求模型。
已完成子调用不会让整张图提前结束。
正常完成时，任务状态与来源运行状态同步提交。

只有满足以下条件的图进入自动恢复：

- 图处于 `pending` 或 `running`。
- 原任务执行租约已过期，或没有执行者。
- 图没有开放的人工处理记录。
- 会话没有有效的其他运行执行租约。

恢复前，查询节点输出需匹配原工具调用结果。
金融前置节点需匹配原参数、回执和账本。
证据缺失时，停止后续节点并转人工核对。
等待授权、暂停、失败和取消仍需原控制入口。

独立图有完整输入，可以跨后续会话版本恢复。
新恢复执行者仍需领取运行与节点执行租约。
模型检查点依赖原会话版本，不能跨版本续跑。

## 恢复服务与公开接口

| 接口 | 内容 |
| --- | --- |
| `GET /api/runs/:id` | 所属会话的运行与工具调用元数据 |
| `GET /api/runs/:id/events` | 按游标读取 `ui` 事件 |
| `POST /api/runs/:id/recover` | 恢复原运行，可指定原工具调用 ID |

公开接口不返回原推理、请求参数或租约令牌。
恢复入口不能批准操作或替用户完成认证。
已取消调用以 `CANCELLED` 结束，不增加工具尝试。

恢复服务需要独立启动，命令见[开发指南](development.md)。
默认每 5 秒发现最多 25 个候选运行。
运行执行租约为 120 秒，存活执行者持续续租。
独立工作流执行租约为 600 秒。
重启不能直接夺取仍有效的执行租约。

每个模型请求最多尝试 3 次，包含首次请求。
每个运行最多获准恢复 3 次。
工具调用另有保存的尝试上限。
暂时性模型失败保留原输入并保存退避时间。
认证和参数错误等永久失败停止自动恢复。

收到 `SIGINT` 或 `SIGTERM` 后，服务停止领取新运行。
服务等待当前恢复结束后退出。
强制终止后，原持久化记录留给后续执行者。
未知结果会暂停自动发现，防止重复空跑。

## Pi Durable 取舍

当前项目固定使用 Pi Core `1.2.0`。
项目采用 Pi Durable 的先保存意图与重放规则。
运行记录和金融执行回执共用 Prisma 数据库。

Pi Durable 的存储接口不提供银行事务句柄。
直接使用 Pi Durable 后，仍需解决金融提交证据。
当前事务同时提交业务变更、审计、回执和调用状态。
因此，项目保留当前事务与日志代码。

Pi Core 的事件订阅等待监听器完成。
日志订阅先于展示订阅注册。
这个顺序保证原事件先保存，再转换或发布。

| 依据 | 对照内容 |
| --- | --- |
| [Pi 事件订阅](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/src/agent.ts) | 等待事件监听器完成 |
| [Pi Durable 工具代码](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/src/harness/tool.ts) | 意图检查点与安全重放 |
| [Pi Durable 存储接口](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/src/types.ts) | 运行记录的存储边界 |

## 代码与测试入口

| 文件 | 职责 |
| --- | --- |
| [journal.ts](../../agent/durable/journal.ts) | 保存原事件、模型请求与检查点 |
| [continuation.ts](../../agent/durable/continuation.ts) | 继续原模型执行 |
| [action-status.ts](../../agent/action-status.ts) | 待确认操作的状态词表、来源守卫与决定入口判定 |
| [write-continuation.ts](../../agent/write-continuation.ts) | 声明写入的单次续写与服务端状态说明 |
| [authorized-checkpoint.ts](../../agent/durable/authorized-checkpoint.ts) | 核验授权结果续讲 |
| [workflow-resumption.ts](../../agent/durable/workflow-resumption.ts) | 恢复外层模型调用的原图 |
| [standalone-workflow.ts](../../agent/durable/standalone-workflow.ts) | 恢复独立图 |
| [recovery-worker.ts](../../agent/recovery-worker.ts) | 发现候选并领取恢复任务 |
| [真实进程测试](../../tests/integration/process-restart.test.ts) | `SIGKILL` 后继续模型和原操作 |
| [独立图进程测试](../../tests/integration/standalone-workflow-restart.test.ts) | 原图、授权、控制状态和回执 |
| [单次续写测试](../../tests/integration/write-continuation.test.ts) | 前台和恢复路径各只续写一次 |
| [续写预算测试](../../tests/unit/agent/write-continuation-durable.test.ts) | 预算先于请求保存，重启不追加预算 |

测试执行方式见[测试指南](test-cases.md)。
