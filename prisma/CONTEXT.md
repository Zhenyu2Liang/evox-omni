# 数据结构与演示数据

## 入口

- `schema.prisma` 定义 SQLite 表、关系与索引。
- `seed.ts` 重建演示数据，并输出余额核对结果。
- 根目录 `prisma.config.ts` 提供连接地址与种子命令。
- 客户端生成到 `lib/db/generated`。

模型覆盖账户、流水、联系人、卡片、订阅和理财。
本地刷卡消费流水另存于 `CardConsumption`。
`BillReportAnalysis` 保存按用户与报告快照隔离的模型分析、生成租约和调用预算。
分析记录属于派生数据，不修改银行余额或流水。
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
例如 `balanceMinor`、`amountMinor` 和 `realizedProfitMinor`。
比例与未结算估值使用十进制文本。
例如 `annualYieldRate`、`latestNetValuePerUnit`、`shares` 与 `estimatedMarketValue`。
结算与输出规则见
[financial-values.md](../docs/cn/financial-values.md)。

## 没有手续费字段

`schema.prisma` 全文没有任何手续费/管理费/申购费/赎回费/佣金/税列：没有 `fee`、`feeMinor`、`managementFee`、`feeRule`、`feeAmount`、`charge`、`commission`、`tax` 列，也没有这类 `@map` 名。
理财申购与赎回的结算金额只由份额、净值与一次性 HALF_UP 取整决定，不扣减费用。
易被误认为费用列的三处近似项：
`Subscription.amountMinor` 与 `Subscription.nextChargeAt`（第 171–179 行）是订阅扣款金额与下次扣款日，不是手续费；
`InvestmentProduct.latestNetValuePerUnit` / `latestNetValueDate`（第 196、198 行）是单位净值（net value 即净值），与"净额扣费"无关。
`seed.ts` 注释里的 "fees"（第 130、173、350 行）指订阅月费，不是费用列。

## 投资持仓字段

`InvestmentProduct.latestNetValuePerUnit` 是 4 位小数的净值文本，`latestNetValueDate` 是该净值的业务日期。
`InvestmentHolding.shares` 是 6 位小数的持有份额文本。
`sharesEstimated` 是布尔标记，默认 `false`：为真表示 `shares` 由回填脚本按历史账面价值派生，不是原始申购记录。
`sharesEstimated` 只由 `scripts/investment-share-backfill.mjs --apply` 置为真，读取据此把 `valueBasis` 报为 `MIGRATED_ESTIMATE`（估算）。
`principalAmountMinor` 是剩余成本基数，不是已记账现金。
`estimatedMarketValue` 只是未取整快照，读取一律由 `shares × latestNetValuePerUnit` 派生。
`realizedProfitMinor` 累计已实现收益，默认 `0`，可为负。
`purchaseHistory` 与 `redemptionHistory` 按笔保存份额、净值、净值日期与结算金额。
`InvestmentProduct` 与 `InvestmentHolding` 没有手续费/管理费列（无 `feeMinor`、`managementFee`、`serviceFee`、`redemptionFee`），`Transaction` 与 `CardConsumption` 同样没有；`prisma/seed.ts` 也不写入任何手续费。
口径与取整规则见[理财产品](../docs/cn/investments.md)。

## 卡片与账户模型

`Account.type` 取值为 `CHECKING`（活期）或 `SAVINGS`（储蓄），余额存于 `balanceMinor` BigInt 分。
`Transaction` 通过 `accountId` 归属账户，含 `amountMinor`、`direction`（`DEBIT`/`CREDIT`）、
`category`、`merchant`、`channel`、`occurredAt`、`isAnomaly` 等字段。
`Card.type` 取值为 `DEBIT`、`CREDIT` 或 `VIRTUAL`，状态为 `ACTIVE`/`FROZEN`/`LOST`/`PENDING`。
`Card` 的 `creditLimitMinor`、`availableLimitMinor`、`monthlyLimitMinor` 均为可空 BigInt 分。
分类限额存于 `CardLimit`（`category` + `amountMinor`）。
`replacedByCardId` 仅作历史引用，没有外键关系。
`Card.linkedAccountId` 是真实外键，指向该卡消费/展示所依据的结算活期账户（`Account.type = CHECKING`）。
关系为 `Card.linkedAccount`（`Account?`）与反向 `Account.cards`（`Card[]`），并带 `@@index([linkedAccountId])`。
信用卡可不绑定（为空），借记卡与虚拟卡绑定活期账户。
`CardConsumption` 是本地模拟刷卡消费台账，一次成功消费一行；
`executionKey` 为重放与幂等标识（可为空），`resultJson` 保存原始消费结果快照。
`Card` 通过 `userId` 归属用户，并经 `linkedAccountId` 外键关联到结算活期账户（列名 `linked_account_id` 未变）。
该外键由 `db push` 引入，是兼容式变更（列名未变、可回滚），不得把 `linkedAccountId` 回退成无关系的裸字符串。
SQLite 无原生枚举，字符串枚举的允许值见 `schema.prisma` 文件头注释。

## 完整号码列

`Account.number` 只存已脱敏账号（字段注释 `masked, e.g. "****8821"`），没有对应的完整账号列；账号身份只能用 `Account.id` 精确匹配，脱敏值仅作候选过滤。
种子直接写入脱敏串：活期 `****8821`、储蓄 `****3309`。
`Contact.phoneFull` 与 `Card.numberFull` 保存完整的虚构手机号与卡号，仅供服务端精确匹配。
这两列都可空，未补全的行为空值，缺失数字无法从脱敏列恢复。
`Contact.phone` 与 `Card.numberMasked` 只存脱敏值，是唯一对外展示来源。
两列不得出现在日志、工具结果、接口响应或错误消息中。
演示数据与夹具使用虚构号段：手机号中间四位为 `0000`，卡号为 `6222` 加全 `0` 加原尾 4 位。
补全命令见 [scripts/CONTEXT.md](../scripts/CONTEXT.md)。

## 稳定 id 与演示余额

演示用户 id 是 `lib/constants.ts` 的 `DEFAULT_DEMO_USER_ID = 'user_liming'`（`seed.ts` 以 `USER_ID` 引用），姓名 `李明`，`phone` 存脱敏值 `138****0001`。
账户：`acct_checking`（`CHECKING`，名称 `活期账户`，`number` `****8821`）、`acct_savings`（`SAVINGS`，名称 `储蓄账户`，`number` `****3309`）。
卡片 id：`card_credit`（CREDIT）、`card_debit`（DEBIT）、`card_virtual`（VIRTUAL），三者 `status` 均为 `ACTIVE`。
活期存储余额是派生值：`OPENING_CHECKING_CENTS = 2_358_000n - CHECKING_LEDGER_CENTS`，抛错断言 `CHECKING_BALANCE_CENTS === 2_358_000n`（¥23,580.00）守住终点；增删流水只改期初。
储蓄无流水，`OPENING_SAVINGS_CENTS = 5_000_000n`（¥50,000.00）。
`card_credit` 的 `creditLimitMinor` 与 `availableLimitMinor` 均 `1_800_000n`（¥18,000.00）。

## 种子行为

`seed.ts` 使用 `businessDate` 构造北京时间。
金额由 `minorUnits` 转成整数分。
`seed.ts` 只按 `DATABASE_URL`（经 `lib/db/url.ts#resolveDatabaseUrl` 解析，缺省 `file:./dev.db`）播种，验收隔离库同样用它；e2e 库是 `prisma db push` 后跑 `tsx prisma/seed.ts` 得到的全新数据，不是 `dev.db` 的拷贝。
演示数据包含收支、小数交易、异常样例与多类业务记录。
卡片夹具含 `card_credit`、`card_debit` 与虚拟卡 `card_virtual`；
借记卡 `card_debit` 与虚拟卡 `card_virtual` 均通过 `linkedAccountId` 绑定活期账户 `acct_checking`，虚拟卡月限额 ¥5,000.00。
测试夹具位于 `tests/helpers/fixtures.ts`，独立维护。

重复播种会替换演示用户的业务记录。
产品记录按种子产品标识重建。
这不是无损的数据补充操作。
播种前尝试复制数据库到 `<dbFile>.backup.db`。
该备份会覆盖，复制失败不会阻止播种。
不得把这次文件复制视为运行中数据库的一致性备份保证。

## 安全状态表

`schema.prisma` 中**没有任何 `enum` 块**，也没有 `@db.` 原生类型注解，没有 `migrations/` 目录；
所有状态都是 `String` + 注释约定，SQLite 层无 CHECK 约束，
因此新状态值无需改库，但必须同步 `schema.prisma` 文件头注释。
`PendingAction`（`schema.prisma` 第 439 行起）字段：`id`/`sessionId`/`userId`/`toolName`/`argsJson`（参数 JSON）/
`riskLevel`/`requiresMfa`（默认 false）/`status`（默认 `"pending"`）/`summaryJson`/可空 `resultJson`/可空 `userRequest`/`intent`、
可空 `authorizationDecisionId`/`invocationId`/`taskId`/`nodeId`/`executionLeaseOwner`/`executionLeaseExpiresAt`、`createdAt`/`updatedAt`，反向关系 `mfa MfaChallenge?`；索引仅 `@@index([sessionId])` 与 `@@index([taskId])`。
**没有** `requestArgs`（参数列名是 `argsJson`）、锁定原因、错误代码、`failure`/`blockReason`、尝试次数或过期时间字段。
文件头第 25 行列出的 `status` 取值不含 `locked`，
而 `security/security-gateway.ts` 会写入 `locked`，注释落后于实际取值。
`MfaChallenge`（第 471 行起，**不叫** `VerificationChallenge`）：`actionId String @unique`（外键 `action PendingAction`，`onDelete: Cascade`）、明文 `code`、`attempts`（默认 0）、
`maxAttempts`（默认 3）、`status`（默认 `"pending"`，取值见文件头第 26 行）、可空 `expiresAt`、可空 `commandDigest`、
可空 `verifiedAt` 与 `consumedAt`；无 `locked` 列，无 `updatedAt`。
`CircuitBreakerState`（第 491 行起）以所有者键 `key` 为主键，
`failures` 默认 0、`locked` 默认 false、`lockedAt` 可空，无冷却时长列。
没有 `Incident` 与 `AuthorizationRecord` 模型；
对应职责由 `SecurityEvent`（`kind`/`severity`/`detail`）、
`AuthorizationDecision`（`reasonsJson`/`riskInputsJson`）与
`ManualReview`（`reason`/`resolution`）承担。
带错误码或原因的列集中在 `AgentRun`、`ModelRequest`、`ToolInvocation`
（`errorCode`）、`AgentTaskNode.error`、`AuditLog.detail`/`mfaResult`、
`ScheduledTask.dispatchError`。

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
