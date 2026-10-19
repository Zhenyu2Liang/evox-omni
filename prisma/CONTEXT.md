# 数据结构与演示数据

## 入口

- `schema.prisma` 定义 SQLite 表、关系与索引。
- `seed.ts` 重建演示数据，并输出余额核对结果。
- 根目录 `prisma.config.ts` 提供连接地址与种子命令。
- 客户端生成到 `lib/db/generated`。

模型覆盖账户、流水、联系人、卡片、订阅和理财。
本地刷卡消费流水另存于 `CardConsumption`。
持仓记录附带购买与部分赎回历史的 JSON 文本列
（`purchaseHistory`、`redemptionHistory`），记录结构由 `banking-sdk` 维护。
任务、授权、审计、人工接管与定时通知也在此持久化。
运行恢复使用 `AgentRun`、`ModelRequest`、
`AgentRunEvent` 与 `ToolInvocation`。
权限决定和风险信号分别存于
`AuthorizationDecision` 与 `RiskSignal`。
字段与索引以 `schema.prisma` 为准。

## 金融字段

已入账金额使用 `BigInt` 分。
例如 `balanceMinor`、`amountMinor` 和 `principalAmountMinor`。
比例与未结算估值使用十进制文本。
例如 `annualYieldRate` 与 `estimatedMarketValue`。
结算与输出规则见
[financial-values.md](../docs/cn/financial-values.md)。

## 卡片与账户模型

`Account.type` 取值为 `CHECKING`（活期）或 `SAVINGS`（储蓄），余额存于 `balanceMinor` BigInt 分。
`Transaction` 通过 `accountId` 归属账户，含 `amountMinor`、`direction`（`DEBIT`/`CREDIT`）、
`category`、`merchant`、`channel`、`occurredAt`、`isAnomaly` 等字段。
`Card.type` 取值为 `DEBIT`、`CREDIT` 或 `VIRTUAL`，状态为 `ACTIVE`/`FROZEN`/`LOST`/`PENDING`。
`Card` 的 `creditLimitMinor`、`availableLimitMinor`、`monthlyLimitMinor` 均为可空 BigInt 分。
分类限额存于 `CardLimit`（`category` + `amountMinor`）。
`replacedByCardId` 仅作历史引用，没有外键关系。
`linkedAccountId` 同为历史引用：记录该卡片扣款的用户活期账户 `id`，没有外键关系。
`CardConsumption` 是本地模拟刷卡消费台账，一次成功消费一行；
`executionKey` 为重放与幂等标识（可为空），`resultJson` 保存原始消费结果快照。
`Card` 目前只通过 `userId` 归属用户，没有指向 `Account` 的外键关系。
SQLite 无原生枚举，字符串枚举的允许值见 `schema.prisma` 文件头注释。

## 种子行为

`seed.ts` 使用 `businessDate` 构造北京时间。
金额由 `minorUnits` 转成整数分。
活期余额由期初余额加全部已入账流水核对。
演示数据包含收支、小数交易、异常样例与多类业务记录。
卡片夹具含 `card_credit`、`card_debit` 与虚拟卡 `card_virtual`；
后者通过 `linkedAccountId` 绑定活期账户 `acct_checking`，月限额 ¥5,000.00。
测试夹具位于 `tests/helpers/fixtures.ts`，独立维护。

重复播种会替换演示用户的业务记录。
产品记录按种子产品标识重建。
这不是无损的数据补充操作。
播种前尝试复制数据库到 `<dbFile>.backup.db`。
该备份会覆盖，复制失败不会阻止播种。
不得把这次文件复制视为运行中数据库的一致性备份保证。

## 修改与运行

1. 修改结构后，运行 `pnpm db:generate`。
2. 在已确认的数据库上运行 `pnpm db:push`。
3. 仅在需要重建演示数据时运行 `pnpm db:seed`。

当前使用 db-push 工作流，没有迁移目录。
不得声明旧 Float 数据库可直接兼容当前结构。
重置会删除数据库及其旁文件。
数据库操作与备份步骤见
[development.md](../docs/cn/development.md)。

测试数据库隔离规则见
[tests/CONTEXT.md](../tests/CONTEXT.md)。
