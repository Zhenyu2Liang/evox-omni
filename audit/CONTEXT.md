# 审计与业务记录

## 职责与入口

本目录负责审计写入、查询与安全事件展示数据。
权限判断由 `security/` 负责。

| 模块 | 职责 |
| --- | --- |
| `audit-logger.ts` | `recordAudit`、`listAudit` 与统计 |
| `security-events.ts` | 安全事件写入、查询与状态读取 |
| `operation-history.ts` | 普通用户可见的业务记录投影 |
| `index.ts` | 公共导出 |

业务记录采用字段白名单。
技术参数与原始执行诊断不进入普通记录。
查询必须保留所有者与会话范围。

## 写入语义

审计和安全事件写入默认记录错误后返回。
关键业务调用必须显式使用 `strict: true`。
严格模式失败必须传给事务调用方。

`recordAudit` 可接收事务客户端与 `dedupeKey`。
重复键只有在业务结果与身份匹配时才视为重放。
冲突结果不能覆盖既有成功事实。
安全事件写入没有同样的唯一键去重接口。

业务写入、强制审计和回执的事务组合由执行层负责。
规则见 [agent/CONTEXT.md](../agent/CONTEXT.md)。

## 安全状态

`getSecurityStatus` 优先使用注入的锁定查询。
缺少该查询时，使用近期事件推导状态。
这不能代替熔断模块的持久化判断。
安全事件未显式传时间时使用 `demoNow()`。
锁定与冷却时间由安全调用方使用真实时钟。

审计测试见 `tests/integration/execution-audit.test.ts`、
`tests/integration/write-audit.test.ts` 与 `tests/app`。
