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
