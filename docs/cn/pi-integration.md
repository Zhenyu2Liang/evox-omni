# Pi 接口与版本适配

项目锁定 Pi Agent Core、Pi AI 和 Pi Coding Agent 的 `1.2.0` 版本。
银行执行使用 Agent Core，模型调用使用 Pi AI。
上下文压缩调用 Coding Agent 的官方压缩函数。
项目未使用 Coding Agent 的终端界面或扩展事件系统。

## 1.2.0 的影响

Core 的 `1.2.0` 更新条目没有列出新增破坏性改动。
Coding Agent 的破坏性改动涉及配置 schema、扩展启动事件和 MCP。
本项目没有主题配置、自定义扩展或 MCP 连接。
这些接口不需要迁移。
版本记录见 [Core 更新记录](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/CHANGELOG.md)
及 [Coding Agent 更新记录](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/CHANGELOG.md)。

版本升级还需核对已经采用的新接口。
项目依赖以下契约，不能恢复旧调用方式。

| Pi 契约 | 项目处理 |
| --- | --- |
| `AssistantMessageEventStream` | 正常响应、初始化失败和读取失败均返回终止事件。 |
| 系统消息中的工具增删 | 使用 `getCurrentTools()` 重放当前目录，不只合并 `toolsAdded`。 |
| `prepareRequest` | 每个模型请求前准备上下文；恢复时保留原请求。 |
| `finishTurn` | 等待确认或计划提交后结束当前生成，保留正常调度语义。 |
| 顺序等待订阅者 | 等待事件落盘及 `agent_end` 订阅者完成后，才释放运行状态。 |
| `AgentToolResult.isError` | 失败保留结构化结果，不只抛出普通文字错误。 |
| 模型可见 `content` | 业务 JSON 放入内容；界面数据保留在 `details`。 |
| `durationMs`、`usage` | 正常执行和恢复保留已有元数据，未执行调用不虚构耗时。 |

`AssistantMessageEventStream` 的破坏性改动出现在 Pi AI `1.1.0`。
项目已使用此流类型，不采用通用事件流代替。
参考 [Pi AI 更新记录](https://github.com/earendil-works/pi/blob/v1.2.0/packages/ai/CHANGELOG.md)。

## 流和调用结果

流包装器负责处理同步抛错和初始化 Promise 拒绝。
缺少终止事件不能让等待结果的 Promise 永久挂起。
取消与读取超时使用不同状态，不根据文案决定重试。
OpenAI 兼容流还检查 `[DONE]`。
供应商正常结束的文字按原文保存，不用句尾规则判断完整性。

同一个助手回复中的调用 ID 必须非空且唯一。
重复 ID 会使结果归属不明确，必须在执行或授权前拒绝。
跨模型回复复用 ID 使用运行与请求身份区分。
结果匹配同时核对调用 ID 和工具名称。

工具内容可以包含多段文本或图片。
事件日志保存完整 `content`，不能只保存首段摘要。
恢复复用相同内容，并保留用量和耗时。
确认后续答及恢复后重新查询使用相同结果投影。
业务契约见[银行工具契约](tool-contracts.md)。

## 模型配置

配置的模型 ID 必须可以解析。
未注册模型不自动替换为服务商的第一款模型。
显式配置兼容接口时，保留指定的模型 ID。
配置失败必须说明具体模型无法使用。
配置方式见[开发指南](development.md)。

## 回归入口

- [模型流初始化与超时](../../agent/providers/request-options.test.ts)。
- [完整工具日志](../../agent/durable/journal.test.ts)。
- [恢复结果投影](../../agent/durable/tool-result.test.ts)。
- [调用 ID 边界](../../tests/integration/tool-call-identity-boundary.test.ts)。
- [模型配置](../../tests/unit/agent/providers/provider-live.test.ts)。

升级时先检查安装包的更新记录、类型和源代码。
再验证事件时序、工具授权、完整保存和进程恢复。
类型检查通过不能证明这些运行语义保持一致。
