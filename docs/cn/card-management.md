# 卡片管理

卡片页与 Agent 分工管理模拟卡片记录。
添加卡片不向银行申请开户或授信。
删除卡片不注销银行账户，也不冲正交易。
金额单位与结算规则见[金融数值与结算](financial-values.md)。

## 卡片类型与资金来源

存款账户与银行卡是独立记录。
初始数据的储蓄账户尾号为 `3309`，余额为 50000.00 元，没有单独发卡。
资产页和卡片页都展示账户明细；卡片页同时说明是否关联银行卡。
账户查询中的 `numberMasked` 是账户编号，不代表存在同尾号的银行卡。

借记卡和虚拟卡消费时扣减结算活期账户的现金。
信用卡消费使用授信额度，不绑定结算账户。

| 卡片类型 | `type` | 资金来源 | 消费上限 |
| --- | --- | --- | --- |
| 借记卡 | `DEBIT` | 绑定的活期结算账户 | 账户余额与剩余月限额的较小值 |
| 虚拟卡 | `VIRTUAL` | 绑定的活期结算账户 | 账户余额与剩余月限额的较小值 |
| 信用卡 | `CREDIT` | `creditLimit` 授信额度 | `availableLimit` |

借记卡和虚拟卡各绑定 1 个本人的活期账户，作为结算账户。
这两类卡没有自己的余额：账户余额是结算活期账户的现金，永远不是信用额度。
可用余额是本卡当前可消费的金额，即账户现金与剩余月限额的较小值。

月限额（`monthlyLimit`）限制该类卡的当月累计消费。
月限额为空时，仍检查账户余额与适用的分类限额。
当月累计消费按补办前后各卡合并计算。
补办卡继承原卡的分类消费限额，包括 0 元限额。
分类的当月累计消费也按补办前后各卡合并计算。
重复补办返回原补办卡，不覆盖补办后调整的限额。
具体扣款与记账规则见[消费结算](#消费结算)。

## 结算账户绑定

卡片用 `Card.linkedAccountId` 记录结算账户。
该字段映射到 `linked_account_id` 列，是指向 `Account.id` 的真实外键。
该列有索引；外键按 Prisma 默认的 `SetNull` 处理，账户被删除时该列被置为 `NULL`，卡片随之解析为 `MISSING`。

服务端按以下规则解析结算账户：

- 传入 `linkedAccountId` 时，账户必须存在、属于本卡用户且类型为 `CHECKING`。
- 未传 `linkedAccountId` 时，仅当用户恰好有 1 个活期账户，才使用该账户。
- 用户有 0 个或多个活期账户时，创建失败并返回 `VALIDATION`。
- 补办卡从显式指定的前驱卡继承结算账户，并在事务内重新校验。
- `consumeCard` 遇到 `MISSING` 或 `UNTRUSTED` 时返回 `CONFLICT`。

服务端不猜测卡片从哪个账户扣款。
账户不存在、属于其他用户或类型不是 `CHECKING` 时，均解析为不可用。
说明：未绑定结算账户的卡片用补绑定脚本补齐，见[数据升级与回滚](#数据升级与回滚)。

## 卡片视图与余额展示

`CardView.linkedAccountStatus` 是关联状态的唯一来源。
该字段取 4 个值之一，每个 `CardView` 都必须包含该字段。

| 取值 | 含义 | 余额字段 |
| --- | --- | --- |
| `LINKED` | 已记录本人活期账户，且账户可解析 | 返回账户余额与可用余额 |
| `MISSING` | 未记录结算账户 | 不返回 |
| `UNTRUSTED` | 记录的账户不存在、属于其他用户或不是活期账户 | 不返回 |
| `NOT_APPLICABLE` | 信用卡，不使用结算账户 | 不返回 |

`MISSING` 和 `UNTRUSTED` 的卡片不返回任何余额字段。
页面不得把这两种状态显示为 `0.00`，也不得补默认账户。
余额未知与余额为零是两个不同的事实。

`LINKED` 时视图返回以下字段：

- `linkedAccountName`：结算账户名称，如“活期账户”。
- `linkedAccountNumber`：已脱敏的账号，如 `****8821`。
- `accountAvailableBalance`：账户余额，界面文案用 `business.cards.accountBalance`。
- `payableAmount`：可用余额，界面文案用 `business.cards.usableBalance`。

多张卡绑定同一账户时，共用这 1 份账户现金。
每张卡按本卡的剩余月限额计算可用余额。

## 卡片状态与消费入口

模拟消费仅支持借记卡和虚拟卡。
信用卡不显示消费按钮，并提示“信用卡暂不支持模拟消费”。
只有状态正常、结算账户可信且已绑定的借记类卡片才能打开消费表单。
直接挂载弹窗或伪造信用卡消费请求也不能扣款。
服务端拒绝信用卡消费时返回 `409 CONFLICT`。

`CardView.usable` 等于 `status === 'ACTIVE'`。
`FROZEN`、`LOST`、`PENDING` 时该值为 `false`。
此时页面的消费入口禁用，并显示不可用提示。
余额字段仍返回真实值，`LINKED` 的卡片照常显示账户余额与可用余额。
提示文案按状态取 `business.cards.cardFrozenNotice`、`business.cards.cardLostNotice` 或 `business.cards.cardUnavailable`。

## 消费结算

`banking-sdk/card.ts#consumeCard` 在一个事务内完成资格复核、限额判定、扣款与记账。
结算账户和卡片状态在事务内重新校验，不复用事务外的读结果。

事务按以下顺序执行：

1. 按 `executionKey` 读取已提交的消费记录；命中则原样重放保存的结果，不再次扣款。
2. 读取卡片并确认属于本人且状态为 `ACTIVE`；卡片不存在返回 `NOT_FOUND`，状态不是 `ACTIVE` 返回 `CONFLICT`。
3. 重新校验结算账户；`MISSING` 与 `UNTRUSTED` 都返回 `CONFLICT`，并在 `detail.linkedAccountStatus` 标明状态。
4. 在同一个服务端时刻读取补办前后各卡的当月累计消费。
   分别检查月限额和本次类别的分类限额，超出任一上限时返回 `LIMIT_EXCEEDED`。
5. 以带余额下限的原子扣减写账户余额；没有任何行被更新时返回 `INSUFFICIENT_FUNDS`。
6. 写入 `channel='CARD'` 的交易流水和 1 条 `CardConsumption` 记录，再把本次结果快照写进该记录的 `resultJson`。

消费时刻由服务端业务时钟决定，调用方不提供时间参数。
当月窗口是 UTC+08:00 的业务月，限额判定与记账使用同一个时刻。
同一 `executionKey` 的并发调用只产生 1 笔扣款，落败的事务回滚后重读已提交记录并重放。

拒绝码与触发条件如下：

| 错误码 | 触发条件 |
| --- | --- |
| `VALIDATION` | 提交了时间字段、金额不大于零、类别不受支持，或缺用户 id、卡片 id |
| `NOT_FOUND` | 卡片不存在或不属于本人 |
| `CONFLICT` | 卡片状态不是 `ACTIVE`、结算账户 `MISSING` 或 `UNTRUSTED`、重放身份不属于本次消费 |
| `LIMIT_EXCEEDED` | 本次消费会使同一卡片链的当月消费超过月限额或对应分类限额 |
| `INSUFFICIENT_FUNDS` | 结算账户现金不足 |

SDK 对借记卡与虚拟卡使用同一套消费规则，Agent 只注册 `consume_virtual_card` 这 1 个消费工具。
消费入口有 2 个：

- 接口 `POST /api/cards/[id]/consume`：首次提交消费参数只创建待验证操作，不扣款。再次提交原参数、`actionId`、`confirmed:true` 与 `code` 后验证执行。返回 `CardConsumptionResponse`，成功时 `result` 包含 `ConsumeCardResult`。
- Agent 工具 `consume_virtual_card`：RED 操作，参数表没有日期或时间字段。

接口判断原始请求体是否出现 `occurredAt` 键，出现即返回 `VALIDATION`，与取值无关。
工具在调用 SDK 前用 `rejectClientSuppliedTime` 拒绝 `occurredAt`、`bookedAt` 等时间字段。
两种拒绝都发生在任何读写之前，因此不产生扣款、流水或消费记录。

## 资产汇总口径

总资产按账户现金和持仓估值累加，卡片不单独计入余额。
多张卡绑定 1 个账户时，该账户现金只计 1 份。
补办后旧卡为终态 `LOST`，授信额度由替代卡承接。
授信可用总额只累加未挂失的信用卡：`type === 'CREDIT'` 且 `status !== 'LOST'`。

## 脱敏与账户隔离

脱敏函数集中在[lib/mask.ts](../../lib/mask.ts)。
该模块提供 `maskPhone`、`maskAccountNumber` 和 `maskCardNumber`。
账号和卡号只保留末 4 位，长度保持不变。
日志、接口响应和模型工具结果不得出现完整账号或卡号。
卡片视图只读取当前用户的账户。
收款人与卡片的选择规则见[号码与卡片身份解析](identity-resolution.md)。
结算账户不属于当前用户时，视图返回 `UNTRUSTED`，不说明具体原因。

## 展示层渲染

卡片页和对话卡片共用同一套展示判定。

- [card-account-display.ts](../../components/banking/card-account-display.ts)提供 4 态判定函数。
- [CardTile](../../components/banking/CardTile.tsx)和[CardsCard](../../components/chat/cards/CardsCard.tsx)按判定结果渲染金额。
- [卡片页](../../app/cards/CardManager.tsx)按 `usable` 禁用消费按钮。
- [消费对话框](../../app/cards/CardConsumeDialog.tsx)在 `usable` 为 `false`、`MISSING` 或 `UNTRUSTED` 时阻止提交。

未关联账户显示 `business.cards.linkedAccountMissing`。
账户不可用显示 `business.cards.linkedAccountUntrusted`。

## 页面与 Agent 的职责

| 操作 | 入口 | 授权 |
| --- | --- | --- |
| 查询卡片 | 卡片页或 AI 助手 | 查询本人资源 |
| 设置分类消费限额 | AI 助手 | 原操作确认 |
| 冻结、解冻、挂失、补卡 | AI 助手 | 原操作确认和验证码 |
| 申请虚拟卡 | AI 助手或卡片页 | 原操作确认和验证码 |
| 添加、删除卡片记录 | 卡片页 | 页面核对详情和验证码 |

Agent 不注册物理借记卡与信用卡的创建或删除能力。
权限网关和计划编译器也拒绝此类调用。
明确的增删请求只返回卡片页操作说明。
Agent 注册虚拟卡申请与挂失卡补办，两者都是 RED 操作。
模型不能借旧对话中的操作继续执行。

## 页面流程

1. 选择添加卡片，或选择已有卡片的删除按钮。
2. 添加时选择类型，并填写适用的额度。
3. 提交操作预览。
4. 核对详情，确认操作并输入演示验证码。
5. 操作完成后，页面刷新卡片列表。

支持借记卡、信用卡和虚拟卡记录。
系统为每条新卡片同时生成虚构完整卡号与展示用脱敏卡号。
完整卡号存入 `Card.numberFull`，只用于服务端精确匹配。
脱敏卡号由同一完整卡号推导，存入 `Card.numberMasked`，用于展示。
对外只出现脱敏卡号，边界见[完整号码的存放与脱敏边界](identity-resolution.md#完整号码的存放与脱敏边界)。
页面不接收真实卡号、密码或安全码。
额度输入为十进制字符串，数据库使用整数分。

未完成的操作保存在数据库。
页面刷新后可以继续核对或取消。
关闭弹窗只关闭界面，不取消已保存操作。
取消需使用弹窗中的取消按钮。
这些操作不出现在 AI 对话的确认卡片中。

## 提交与重试

每个操作使用稳定请求标识，绑定用户和参数。
参数变化不能复用原请求标识。
验证码挑战绑定原操作，不授权另一张卡片。

实际变更、验证码消费、操作结果、审计和执行回执在同一事务中提交。
审计失败时，该次变更回滚。
重复验证已完成操作时，读取原执行回执，不重复增删。
进程在提交前退出，不产生已提交的卡片变更。
进程在提交后退出，可以读取原结果。

## 删除限制

信用卡存在未还款额度或缺少额度信息时，不能删除。
关联操作仍待确认、执行中或结果不明时，不能删除。
运行中的模型或任务还未明确引用对象时，也不能删除。
删除检查在实际变更事务中再次执行。

删除保留交易流水、操作审计和原执行回执。
已完成操作的历史结果不会因卡片删除而消失。

## 数据升级与回滚

外键列沿用 `linked_account_id` 列名，升级不重命名该列。
变更内容是外键关系和索引，已有数据继续可读。
结算账户允许为空，未绑定的卡片解析为 `MISSING`。

### 升级步骤

1. 停止应用和恢复进程。
2. 停止数据库连接，按[开发指南的备份步骤](development.md#数据库备份与净值份额升级)创建数据库快照。
3. 同步外键和索引。

   ```sh
   pnpm db:push
   ```

4. 演练补绑定计划，不写入数据。

   ```sh
   pnpm exec tsx scripts/card-account-binding.ts --dry-run
   ```

5. 写入绑定。

   ```sh
   pnpm exec tsx scripts/card-account-binding.ts
   ```

6. 核对输出的报告和变更清单。

   清单保存在 `logs/card-account-binding/<时间戳>-applied.json`。

警告：跳过备份会丢失已提交的卡片记录。

### 回滚步骤

只有补绑定脚本写入的值需要回滚。
外键和索引属于兼容式变更，可以保留。

1. 停止应用和数据库连接。
2. 执行回滚命令。

   ```sh
   pnpm exec tsx scripts/card-account-binding.ts --rollback=logs/card-account-binding/<时间戳>-applied.json
   ```

3. 需要恢复更早的数据时，用 `logs/db-backups/` 中的快照覆盖数据库。

回滚只还原仍持有脚本写入值的行，人工改过的行保持不变。

### 补绑定规则

脚本只处理 `linkedAccountId` 为空的借记卡和虚拟卡。
信用卡使用授信额度，脚本跳过。
用户恰好有 1 个活期账户时，脚本绑定该账户。
用户有 0 个或多个活期账户时，脚本跳过并报告 `no-checking-account` 或 `ambiguous-checking-accounts`。
写入使用比较并交换，只更新仍为空的行。
重复执行幂等：已绑定的卡片报告 `already-bound`。
已规划账户会按标识重新读取，核对归属和类型后写入。
脚本输出只包含数据库中已脱敏的账号。

## 代码入口

- [卡片页](../../app/cards/page.tsx)读取卡片列表。
- [页面交互](../../app/cards/CardManager.tsx)管理预览、验证和刷新。
- [消费对话框](../../app/cards/CardConsumeDialog.tsx)提交本地模拟消费。
- [卡片 SDK](../../banking-sdk/card.ts)解析结算账户、扣减现金并生成卡片视图。
- [消费接口](../../app/api/cards/[id]/consume/route.ts)拒绝调用方时间并调用 `consumeCard`。
- [卡片工具](../../agent/tools/card.ts)定义选择器与 `consume_virtual_card` 的时间守卫。
- [卡片 DTO](../../banking-sdk/types.ts)定义 `CardView` 与 `linkedAccountStatus`。
- [数据库 schema](../../prisma/schema.prisma)定义 `linked_account_id` 外键和索引。
- [演示种子](../../prisma/seed.ts)把借记卡和虚拟卡绑定到 `acct_checking`。
- [补绑定脚本](../../scripts/card-account-binding.ts)补齐未绑定的卡片。
- [脱敏模块](../../lib/mask.ts)提供手机号、账号和卡号脱敏。
- [人工卡片变更](../../security/manual-card-management.ts)检查归属、挑战和提交结果。
- [卡片 HTTP 边界](../../app/api/cards/CONTEXT.md)整对象透传 `CardView`。
- [接口测试](../../tests/app/manual-card-management.test.ts)检查授权、重试、隔离和回滚。

验证码仍使用演示适配器，不发送短信。
固定演示身份不提供生产开户或销卡认证。
测试方法与证据范围见[测试说明](test-cases.md)。
权限、验证码和审计见[安全设计](security.md)。
