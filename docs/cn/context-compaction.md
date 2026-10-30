# 对话归档与上下文压缩

[English](../en/context-compaction.md) | **简体中文**

完整对话保存在数据库中，不按消息数量裁剪。
压缩直接调用 Pi Coding Agent 的官方 `compact()`。
模型请求超过压缩阈值时，适配层准备归档范围并生成摘要。
模型随后读取摘要和近期的完整对话。
用户页面仍可读取原始消息。

摘要提示词和历史序列化由官方 `compact()` 负责。
数据库适配层负责银行约束、持久化和恢复。

## 官方接口与项目适配

项目从 `@earendil-works/pi-coding-agent` 的公开入口导入函数。
3 个 Pi 直接依赖在 [package.json](../../package.json) 固定为 `1.2.0`。
`pnpm-workspace.yaml` 的 `overrides` 另外固定 5 个 `@earendil-works/*` 传递依赖。
实际解析版本以 [pnpm-lock.yaml](../../pnpm-lock.yaml) 为准。

| 职责 | 负责模块 |
| --- | --- |
| 摘要提示词、历史序列化和摘要生成 | 官方 `compact()`。 |
| 消息 token 估算和压缩触发判断 | 官方 `estimateTokens()`、`shouldCompact()`。 |
| 当前模型、服务商地址和请求函数 | 项目的模型运行时传入 `model` 和 `streamFn`。 |
| 银行记录归档、所属用户及会话 | 项目的数据库和执行身份。 |
| 完整近期轮次和工具配对 | 项目的归档范围与保留策略。 |
| 超长归档分批、事件和检查点 | 项目的银行持久化适配层。 |

Coding Agent 的 `AgentSession.compact()` 是上层会话方法。
该方法还管理编码会话、扩展钩子和恢复流程。
银行会话使用 Prisma 保存状态，因此直接调用底层公开函数。
项目不创建 Coding Agent 的文件会话管理器。
项目也不启动 Coding Agent 命令行会话。
银行工具注册表不注册文件、Shell 或编码工具。

## 保存与模型请求

保存的数据与模型请求视图分别处理。

| 数据 | 保存方式 | 用途 |
| --- | --- | --- |
| 原始用户、助手和工具消息 | 完整保存在会话状态和运行事件中。 | 归档、核对和恢复。 |
| 用户页面消息 | 完整保存在对话记录中。 | 按页读取历史。 |
| 历史摘要与压缩范围 | 保存为会话压缩元数据。 | 构造后续模型请求。 |
| 摘要请求与模型增量 | 保存为独立压缩事件。 | 查询摘要生成过程和恢复中断。 |

压缩只改变发送给模型的视图。
摘要不会覆盖原始消息，也不会截短助手回答。
近期消息按完整用户轮次保留。
工具调用与对应结果保留在同一轮次中。

历史用户原话和完整工具组继续保留。
模型视图只按已登记摘要的覆盖范围压缩。
`projectedMessages` 在摘要后插入一条历史记忆消息。
该消息声明自己不是新指令，也不是授权。
新用户消息开始新的轮次声明。
旧请求和摘要中的金额不能代替本轮声明或授权。
已确认的工具结果仍归属原调用。

投影超出模型预算时抛出 `VALIDATION`。
失败原因写作 `CONTEXT_BUDGET_EXCEEDED`，并带上 token 数与预算。
此时不清空历史，也不截短回答。

## 压缩触发

适配层用 `estimateContextTokens` 估算请求大小。
该函数在官方 `estimateTokens()` 之上补偿中文字符。
估算包含系统消息和工具声明。
`shouldCompact` 比较阈值和模型上下文容量。
`compactionCut` 按完整用户轮次确定可压缩范围。
`compactionCut` 至少保留最新一轮用户消息。
`summaryBatches` 只拆分摘要输入，不拆分归档消息。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `AGENT_COMPACTION_THRESHOLD_TOKENS` | `60000` | 超过该值后尝试压缩历史。 |
| `AGENT_COMPACTION_RESERVE_TOKENS` | `8192` | 为模型响应保留的上下文空间。 |
| `AGENT_COMPACTION_KEEP_RECENT_TOKENS` | `12000` | 保留近期完整轮次的目标大小。 |
| `AGENT_COMPACTION_SUMMARY_TOKENS` | `2048` | 每次摘要请求的最大输出大小。 |

环境变量接受 `128` 到 `1000000` 的整数。
无效配置使用默认值。
模型预算等于上下文容量减去预留空间。
实际阈值不超过该预算。
预留空间不超过上下文容量的四分之一。
近期保留目标不超过实际阈值的一半。
摘要输出上限不超过实际阈值的八分之一，最少 `128`。

原始对话超过单次摘要窗口时，适配层按消息组分批。
每批直接调用官方 `compact()`，并传入上一批摘要。
单条超大消息只在摘要输入中拆成文字片段。
原始消息和金融工具结果继续完整归档。
官方序列化会限制摘要输入中的工具结果长度。
该上限是 `TOOL_RESULT_MAX_CHARS`，取 `2000` 个字符。
数据库中的原始工具结果不受该限制。

正式模型请求的预留空间与摘要输出配额分别处理。
项目的 `AGENT_COMPACTION_RESERVE_TOKENS` 预留回答空间。
官方摘要准备参数的 `reserveTokens` 用于计算摘要配额。
适配层按 `ceil(summaryTokens / 0.8)` 设置该参数。
默认摘要上限 `2048` 个 token 对应准备参数 `2560`。
官方函数还按模型的 `maxTokens` 限制摘要输出。
单批摘要请求超出上下文容量时抛出 `VALIDATION`。
失败原因写作 `COMPACTION_BUDGET_EXCEEDED`。

单个模型请求仍受模型上下文容量限制。
对话归档可以持续增长，摘要不保证记住每个原字。
需要核对原话时，使用归档查询。

## 查询原话

`search_conversation_history` 是绿色只读工具。
工具按服务器绑定的用户和会话查询归档。
模型不能通过参数选择其他用户或会话。
缺少可信会话身份时返回 `SECURITY_DENIED`。
会话不存在或不属于该用户时返回 `NOT_FOUND`。

参数包含以下字段：

- `query`：原话中的查询文字，长度 `1` 到 `256`。
- `limit`：每次最多返回 `20` 条消息，默认 `20`。
- `beforeIndex`：继续查询更早消息的位置，最小 `0`。

结果包含 `matches`、`hasMore` 和可选的 `nextBeforeIndex`。
`beforeIndex` 超过当前消息数时按 `VALIDATION` 拒绝。
查询结果保留原始负号、小数、姓名和纠正文字。
结果只包含用户和助手的消息文字。
历史请求不代表新的授权或执行事实。
需要继续办理业务时，服务端检查本轮声明和权限。

## 生成与恢复

摘要使用当前模型运行时的模型和流式请求函数。
离线模式由 `providers/mock/compaction.ts` 生成固定结构的摘要。
摘要请求不提供银行工具，也不执行工具调用。
适配层通过官方 `customInstructions` 参数传入银行约束。
金额符号、用户纠正、偏好和未决事项需要保留。

摘要事件使用以下名称：

- `compaction_request`：保存摘要请求、输入摘要和尝试次数。
- `compaction_provider_event`：保存摘要模型的原始流式事件。
- `compaction_response`：保存摘要模型的完整响应。
- `compaction_partial`：保存适配层已完成批次的摘要和后续位置。
- `compaction_completed`：保存最终摘要和压缩范围。
- `compaction_failed`：保存本次失败。

每次摘要请求前，系统保存检查点。
首次 SDK 调用保存实际模型上下文。
重启时复用该上下文，保留原消息时间和摘要输入。
模型身份或输入不匹配时抛出 `CONFLICT`。
进程重启后，可以重新执行未完成的只读摘要请求。
已完成批次从原位置继续，不需要重新办理银行业务。
分批恢复由数据库适配层负责。
官方 `compact()` 负责每批摘要，不负责银行检查点恢复。
摘要中断、截断、失败或为空时，系统保留原对话。
中断的摘要即使带文字也不采用。
适配层拒绝 `stopReason` 为 `aborted` 或已取消的结果。
摘要结果不会登记为普通助手回复或业务模型请求。

已登记的普通模型请求恢复时，使用原始请求视图。
恢复不会重新压缩并改变该请求的输入。
业务工具仍根据原调用身份、授权和执行回执恢复。

回复格式纠正预算与压缩元数据分别保存。
检查点记录纠正前的候选、原指令和处理阶段。
纠正已完成时，重启不再生成新的纠正请求。
原候选和纠正回复都继续归档。

查询确认后的分析续答使用服务端保存的原问题。
续答用途绑定原模型请求中的查询或建议声明。
恢复时还需核对最新用户消息和原查询结果。
分析续答不授予银行写操作权限。
具体规则见[持久化与恢复](agent-durability.md#回复纠正与建议续答)。

## 代码入口

Pi Agent Core 提供 `prepareRequest` 和 `transformContext` 2 个钩子。
这 2 个钩子把压缩投影接入银行模型请求。
`compact()` 来自 Coding Agent SDK，不是 Core 实例的方法。
参考 [Pi 官方压缩源码](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/compaction/compaction.ts)。

- [压缩适配层](../../agent/context-compaction/)。
- [Pi 集成](../../agent/banking-agent.ts)。
- [模型请求日志](../../agent/durable/journal.ts)。
- [归档只读搜索](../../agent/conversation-history-search.ts)。
- [压缩单元测试](../../tests/unit/planner/context-compaction.test.ts)。
- [持久化恢复集成测试](../../tests/integration/conversation-compaction.test.ts)。

## 依赖代价与升级

使用公开接口仍需要安装整个 Coding Agent npm 包。
传递依赖包括 `@earendil-works/pi-codemode`、`@earendil-works/pi-mcp` 和 `@earendil-works/pi-tui`。
传递依赖还包括 `@silvia-odwyer/photon-node` 图像库和 `quickjs-wasi`。
这些依赖扩大安装范围，不能视为只有压缩函数的小型包。
安装依赖不代表银行模型已取得编码或文件操作权限。

升级时同时核对 3 个直接依赖、`overrides` 和锁文件。
`overrides` 固定 `@earendil-works` 下的 5 个包版本。
约束保存在 [pnpm-workspace.yaml](../../pnpm-workspace.yaml)。
官方摘要格式、接口和 token 判断可能随版本改变。
升级后需验证归档保留、银行约束和崩溃恢复。
