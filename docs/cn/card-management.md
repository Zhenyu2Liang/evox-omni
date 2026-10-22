# 卡片管理

卡片页与 Agent 分工管理模拟卡片记录。
添加卡片不向银行申请开户或授信。
删除卡片不注销银行账户，也不冲正交易。
金额单位与结算规则见[金融数值与结算](financial-values.md)。

## 卡片类型与资金来源

借记卡和虚拟卡消费时扣减结算活期账户的现金。
信用卡消费使用授信额度，不绑定结算账户。

| 卡片类型 | `type` | 资金来源 | 消费上限 |
| --- | --- | --- | --- |
| 借记卡 | `DEBIT` | 绑定的活期结算账户 | 账户余额与剩余月限额的较小值 |
| 虚拟卡 | `VIRTUAL` | 绑定的活期结算账户 | 账户余额与剩余月限额的较小值 |
| 信用卡 | `CREDIT` | `creditLimit` 授信额度 | `availableLimit` |

借记卡和虚拟卡各绑定 1 个本人的活期账户，作为结算账户。
月限额（`monthlyLimit`）限制该类卡的当月累计消费。
月限额为空时，消费上限只受账户余额限制。
当月累计消费按补办前的原卡合并计算。
消费在 1 个事务内扣减账户现金，并写入消费流水和消费记录。
账户余额是本卡结算账户的现金，可用余额是本卡当前可消费的金额。

## 结算账户绑定

卡片用 `Card.linkedAccountId` 记录结算账户。
该字段映射到 `linked_account_id` 列，是指向 `Account.id` 的真实外键。
该列有索引，删除账户时置为 `NULL`，卡片随之变为未关联账户。

服务端按以下规则解析结算账户：

- 传入 `linkedAccountId` 时，账户必须存在、属于本卡用户且类型为 `CHECKING`。
- 未传 `linkedAccountId` 时，仅当用户恰好有 1 个活期账户，才使用该账户。
- 用户有 0 个或多个活期账户时，创建失败并返回 `VALIDATION`。
- 补办卡从显式指定的前驱卡继承结算账户，并在事务内重新校验。
- `consumeCard` 遇到 `MISSING` 或 `UNTRUSTED` 时返回 `CONFLICT`。

服务端不猜测卡片从哪个账户扣款。
账户不存在、属于其他用户或类型不是 `CHECKING` 时，均解析为不可用。
说明：未绑定结算账户的卡片用一次性补绑定脚本补齐，见[数据升级与回滚](#数据升级与回滚)。

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
每张卡的可用余额按该账户现金与自身月限额分别计算。

## 卡片状态与消费入口

`CardView.usable` 等于 `status === 'ACTIVE'`。
`FROZEN`、`LOST`、`PENDING` 时该值为 `false`。
此时页面的消费入口禁用，并显示不可用提示。
余额字段仍返回真实值，`LINKED` 的卡片照常显示账户余额与可用余额。
提示文案按状态取 `business.cards.cardFrozenNotice`、`business.cards.cardLostNotice` 或 `business.cards.cardUnavailable`。

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
结算账户不属于当前用户时，视图返回 `UNTRUSTED`，不说明具体原因。

## 展示层渲染

卡片页和对话卡片共用同一套展示判定。

- [card-account-display.ts](../../components/banking/card-account-display.ts)提供 4 态判定函数。
- [CardTile](../../components/banking/CardTile.tsx)和[CardsCard](../../components/chat/cards/CardsCard.tsx)按判定结果渲染金额。
- [卡片页](../../app/cards/CardManager.tsx)按 `usable` 禁用消费按钮。
- [消费对话框](../../app/cards/CardConsumeDialog.tsx)在 `MISSING` 或 `UNTRUSTED` 时阻止提交。

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
卡号由系统生成，并以脱敏形式保存和展示。
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

1. 停止应用、恢复进程和其他数据库连接。
2. 备份数据库。

   ```sh
   mkdir -p logs/db-backups
   sqlite3 prisma/dev.db ".backup 'logs/db-backups/2026-01-01-120000-dev.db'"
   ```

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

警告：跳过备份会丢失已提交的卡片记录。备份前停止数据库连接。

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
