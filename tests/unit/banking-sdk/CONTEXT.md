# SDK 不变量测试

## 范围

本目录直接调用模拟银行 SDK。
权限策略另由网关测试覆盖。
SDK 写入仍必须满足可信执行上下文与事务约束。

| 测试 | 内容 |
| --- | --- |
| `transfer.test.ts` | 账户、收款人、金额与余额 |
| `transfer-receipt.test.ts` | 原始回执重放与请求冲突 |
| `investment.test.ts` | 产品、持仓与申购赎回 |
| `investment-flow.test.ts` | 理财资金流水与一次入账 |
| `investment-precision.test.ts` | 申购结果重放与金额精度 |
| `investment-aggregation.test.ts` | 加购聚合与采购历史 |
| `investment-partial-redemption.test.ts` | 部分赎回、单次入账与去重 |
| `atomicity.test.ts` | 写入失败回滚与并发资金约束 |
| `idempotent.test.ts` | 相同执行身份的去重 |
| `subscription.test.ts` | 取消与提醒状态 |
| `anomaly.test.ts` | 收支方向、投资分类与异常筛查 |
| `card-replacement.test.ts` | 冻结/解冻可逆幂等、挂失终态与补办换卡不变量 |
| `card-consumption.test.ts` | 账户绑定虚拟卡：绑定与幂等发卡、消费限额/余额护栏、卡状态与未绑定拒绝、并发不超支、多卡共享账户、付款额同步、执行身份重放与原子性 |
| `card-consumption-time-authority.test.ts` | 消费时刻权威：伪造 `occurredAt`（过去/未来/小数/null/文本/Date/对象）逐项 `VALIDATION` 且账务与记录字节不变、显式 `undefined` 视为未提供、类型层无时间字段、限额恰好用尽与 0/`null` 限额、UTC+08:00 月界归属 |
| `card-replacement-binding.test.ts` | 补办续权：虚拟卡补办继承并持久化结算账户、刷新后仍绑定、仅一次扣款、月限额跨 A→B→C 连续且历史流水不改写、重复补办不二次发行、坏绑定回滚、显式前驱修复与无前驱拒绝、CREDIT 额度继承且总览不重复 |
| `dashboard.test.ts` | 总览信用卡可用额：补卡后不重复计数（旧 LOST 卡排除、仅真 CREDIT 计入） |

具体文件和断言以当前目录为准。
金额使用十进制字符串与整数分。
回执缺失或请求身份冲突不能伪造原结果。
不支持从旧流水补造当前回执。
已持有产品的加购为聚合写入，采购身份存于 `purchaseHistory`。

## 卡消费的时间与限额权威

`consumeCard(input, options)` 的公开入参不含时间字段；记账时刻与 UTC+08:00 计费月都由服务端 `demoNow()` 决定。
唯一时钟缝隙是第二参数 `options.now`（测试专用）。
运行时入参携带已定义的 `occurredAt`（任意值）在任何读写前被拒为 `VALIDATION`；`{ occurredAt: undefined }` 等同于未提供。
月限额按补办家族当月消费计算，`payableAmount` 与强制限额读同一个数字；结果快照报「限额被强制时的那个时刻」所在月的余额（`options.now`），不带缝隙的重新读取按 `demoNow()` 所在月计算。
`truncateAll()` 清除 schema 的每个模型，包括无关系声明的 `CardConsumption`；套件无需自备清理钩子（完整性由 `tests/helpers/db-truncate.test.ts` 校验）。

## 执行与数据

运行：`pnpm exec vitest run tests/unit/banking-sdk`。
数据库和失败注入见
[tests/helpers/CONTEXT.md](../../helpers/CONTEXT.md)。
金融单位规则见
[financial-values.md](../../../docs/cn/financial-values.md)。
