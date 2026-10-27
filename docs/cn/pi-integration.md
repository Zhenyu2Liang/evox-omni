# Pi 接口与版本适配

项目直接依赖 3 个 Pi 包，版本固定为 `1.2.0`。
依赖写在 [package.json](../../package.json)。
[`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) 的 `overrides` 另固定 `pi-agent-core`、`pi-ai`、`pi-codemode`、`pi-mcp` 和 `pi-tui`。
实际解析版本以 [pnpm-lock.yaml](../../pnpm-lock.yaml) 为准。

银行执行使用 Pi Agent Core，模型调用使用 Pi AI。
上下文压缩调用 Pi Coding Agent 的 `compact()`。
项目不启动 Coding Agent 的命令行、终端界面或扩展运行时。
银行工具注册表只注册银行工具。
压缩适配见[对话归档与压缩](context-compaction.md)。

`patchedDependencies` 为 `pi-weixinbot` 打补丁。
补丁文件必须是 LF 换行。
[`.gitattributes`](../../.gitattributes) 强制 `*.patch` 按 LF 检出。
CRLF 检出会让 `pnpm install` 报 `ERR_PNPM_INVALID_PATCH`。

## 采用的接口契约

| Pi 契约 | 项目处理 |
| --- | --- |
| `AssistantMessageEventStream` | 正常响应、初始化失败和读取失败都返回终止事件。 |
| `getCurrentTools()` | 按系统消息逐个重放工具增删，取当前完整工具集。 |
| `prepareRequest` | 每个模型请求前准备投影和请求日志。 |
| `transformContext` | 只把投影后的消息交给本次请求。 |
| `finishTurn` | 已落库的待确认决定或成功的计划提交后结束生成。 |
| 顺序等待订阅者 | `agent_end` 订阅者完成后，运行才算结束。 |
| `AgentToolResult.isError` | 失败返回结构化错误结果，不只抛出文字。 |
| 模型可见 `content` | 业务 JSON 放 `content`，界面数据放 `details`。 |
| `structuredContent` | 供程序调用方读取，不发给模型。 |
| `usage`、`durationMs` | 保留原调用元数据；未执行的调用不带耗时。 |

`prepareRequest` 和 `transformContext` 在 [银行智能体](../../agent/banking-agent.ts) 注册。
`beforeToolCall` 是唯一的授权入口。
`afterToolCall` 不改变已完成的结果。

## 模型请求流

在线模式把 Pi AI 的模型集合包装成流函数。
包装器输出项目自己的 `AssistantMessageEventStream`。
流函数同步抛错和初始化 Promise 拒绝都转成终止事件。
缺少终止事件按传输失败处理，等待结果的 Promise 不会永久挂起。
见 [请求选项](../../agent/providers/request-options.ts)。

请求超时取 `LLM_REQUEST_TIMEOUT_MS`，默认 `30000` 毫秒。
合法范围是 `1000` 到 `120000` 毫秒，越界回落默认值。
超时用 `AbortSignal.timeout` 与调用方信号组合。
调用方取消记为取消，读取超时记为超时，两者不共用重试。
单次请求的重试上限是 `maxRetries: 1`，重试间隔上限是 `maxRetryDelayMs: 1500`。

`openai-completions` 流还要求 SSE 终止符。
终止符是 `data: [DONE]`，响应类型必须是 `text/event-stream`。
缺少终止符或缺少响应体时报传输错误。
供应商正常结束的文字按原文保存，不按句尾判断完整性。
UTF-8 解码失败按致命错误处理。
见 [完成传输](../../agent/providers/completion-transport.ts)。

有运行日志时，流函数再包一层审计。
审计记录 `provider_request_payload`、`provider_response_headers` 和 `provider_response_event`。
响应头只保留 `content-type`、`x-request-id` 和 `request-id`。
分片的工具参数先替换为占位符，等 Pi 组装完成后再脱敏。
见 [模型审计](../../agent/providers/model-audit.ts)。

同一个助手回复中的调用 ID 必须非空且唯一。
`beforeToolCall` 先调用 `validateToolCallIdentities`，不通过就拒绝执行。
结果匹配同时核对调用 ID 和工具名称。

## 工具调用结果

工具内容可以包含多段文本或图片。
事件日志保存完整 `content`，不只保存首段文字。
恢复复用相同内容，并保留用量和耗时。
确认后的续答与恢复后的重新查询使用同一结果投影。
业务契约见[银行工具契约](tool-contracts.md)。

## 模型配置

配置的模型 ID 必须能解析。
已注册模型按服务商注册表原样使用。
未注册模型只在显式配置兼容地址时才接受。
兼容地址先取 `<PROVIDER>_BASE_URL`，再取 `LLM_BASE_URL`。
未注册模型固定用 `openai-completions`，上下文窗口 `128000`，输出上限 `16384`。
项目不替换成服务商的另一款模型，也不把密钥发到无关主机。
配置失败时说明具体哪个模型无法使用。
配置方式见[开发指南](development.md)。

## 回归入口

- [模型流初始化与超时](../../agent/providers/request-options.test.ts)。
- [SSE 终止符](../../tests/unit/agent/providers/completion-transport.test.ts)。
- [模型审计](../../tests/unit/agent/providers/model-audit.test.ts)。
- [完整工具日志](../../agent/durable/journal.test.ts)。
- [恢复结果投影](../../agent/durable/tool-result.test.ts)。
- [调用 ID 边界](../../tests/integration/tool-call-identity-boundary.test.ts)。
- [模型配置](../../tests/unit/agent/providers/provider-live.test.ts)。
