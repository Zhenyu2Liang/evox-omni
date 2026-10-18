# 测试辅助模块

## 模块选择

| 模块 | 用途 |
| --- | --- |
| `db.ts` | 连接、清空、重建夹具与断开测试库 |
| `db-truncate.test.ts` | 逐 model 校验 `truncateAll` 的清空覆盖 |
| `fixtures.ts` | 独立维护的测试数据 |
| `faux-agent.ts` | 原始 Pi Agent 与脚本模型 |
| `scenario.ts` | 网关和工具层的两阶段场景 |
| `scripted-provider.ts` | 注入生产运行入口的模型响应 |
| `prisma-cli.ts` | 客户端准备、隔离库清理与命令诊断 |
| `restart-process.ts`、`standalone-restart-process.ts` | 独立进程恢复探针 |
| `write-failure.ts` | 保留真实事务的写入失败注入 |

## 入口与证据

`faux-agent` 和 `scenario` 验证网关、工具与 SDK。
它们不经过生产的声明、运行准入与展示流程。
辅助函数生成的结果说明不是模型稳定性证据。

验证生产入口时，使用 `scriptedProvider` 注入模型。
它通过真实 `describe_turn` 声明当前目的与业务序列。
声明不提供用户授权。
未声明或声明不完整的拒绝测试需保留该输入条件。

### 脚本化模型驱动生产 `runTurn`

`scriptedProvider(declaration, steps)` 返回 `{ provider, calls() }`；`provider` 即 `RunTurnDeps.provider`
（`{ model, streamFn }`，类型见 `agent/providers/types.ts`），与网关、SQLite、执行器全部保持真实。
首条响应固定是 `turnDeclaration(declaration)` 的 `describe_turn` 工具调用，`steps` 是**其后**的响应序列。
一次模型调用消费一条响应，脚本全部消费时 `calls() === 1 + steps.length`。
调用形如 `runTurn({ sessionId?, message }, { config, provider })`：首轮省略 `sessionId` 由 `getOrCreateSession` 建行，不要传 `requestId`。
返回值只有 `{ sessionId, events }`：助手文本取 `events` 中最后一条 `message_end` 的 `message.content`，
工具与闸门信号取 `tool_end`、`confirmation_required`、`mfa_required` 事件。
`config.llmMode` 决定生产分支：声明写操作却未发出受控工具调用时的一次有界续接
（`agent/write-continuation.ts#pendingDeclaredWrites`）只在 `llmMode === 'live'` 生效；
`tests/setup.ts` 把 `LLM_MODE` 固定为 `mock`，需要续接的用例必须显式传 `llmMode: 'live'`。
指引信封（`{"guidance":{"code":...}}`）的渲染不受 `llmMode` 限制，`groundMessage` 用服务端模板改写最终助手文本。
最完整骨架见 `tests/integration/write-continuation.test.ts`（续接与 `declared_unsubmitted`）
与 `tests/integration/decision-guidance.test.ts`（声明、指引信封、授权后续读）。

## 数据库与事务

`getTestPrisma` 延迟获取测试客户端。
`resetDatabase` 清空记录后加载夹具。
`useFreshDatabase` 注册测试生命周期。
`ensureTestPragmas` 设置测试连接的 WAL 与等待参数。
客户端连接机制见
[lib/db/CONTEXT.md](../../lib/db/CONTEXT.md)。
不得用旧连接池参数解释当前原生适配器行为。

### 清空语义（`truncateAll`）

`truncateAll` 删除 `prisma/schema.prisma` 中**每一个** model 的全部记录，
顺序按外键子表→父表，且**不**重新播种；`resetDatabase` 在其后加载夹具。
清空完成后整个库为空：任何 delegate 的 `count()` 都是 0。
除夹具外没有“合法残留”，测试与相邻运行之间不共享业务记录。

省略一张表就是缺陷，`onDelete: Cascade` 不能替代显式删除。
无关系表（`ExecutionReceipt`、`CircuitBreakerState`、`AuthorizationDecision`、
`RiskSignal`、`CardConsumption`）没有任何外键驱动删除，必须显式列出。
`CardConsumption` 只带索引与唯一 `executionKey`：
漏删会让消费行与重放身份跨 `resetDatabase` 存活，
既污染卡家族当月消费，又让重复运行以旧卡 id 重放而报 `CONFLICT`。
`ScheduledNotification` 与 `ModelRequest` 同属易漏项，已与其父表一并显式删除。

`db-truncate.test.ts` 逐 model 校验覆盖率：
每个 schema model 必须在 `db.ts` 中出现 `prisma.<delegate>.deleteMany(`；
清空列表中不得出现不存在的 delegate；
残留行在 `truncateAll` 后必须为 0；
带唯一 `executionKey` 的消费行不得跨 `resetDatabase` 存活。
新增 model 时必须同时补 `truncateAll`，否则该用例失败。

因此各套件**不需要**在 `useFreshDatabase()`/`resetDatabase()` 之后再手工
`cardConsumption.deleteMany()`，重复的清空钩子是多余的。

Prisma 准备失败时必须保留完整命令诊断。
失败注入必须保留真实事务的回滚行为。
共享库的隔离和执行规则见 [../CONTEXT.md](../CONTEXT.md)。
