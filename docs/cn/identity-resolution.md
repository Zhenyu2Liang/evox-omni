# 号码与卡片身份解析

身份判定与候选筛选是两条不同的规则。
身份判定只认完整号码或确切 id，结果可以绑定收款人或卡片。
脱敏值和数字片段只用于收窄候选，调用方必须再要求候选唯一。
解析在服务端的 park 阶段完成，成功后把参数规范化为唯一 id。
金额与结算规则见[金融数值与结算](financial-values.md)。
卡片增删与结算账户绑定见[卡片管理](card-management.md)。

## 身份判定与候选筛选

两个问题由不同函数回答，不得互相替代。

| 问题 | 函数 | 允许的输入 | 结果用途 |
| --- | --- | --- | --- |
| 这个输入是否就是该联系人 | `phoneIdentityMatches` | 完整 11 位手机号 | 可以绑定收款人并转账 |
| 这个联系人是否可能是用户所指 | `phoneCandidateMatches` | 完整号码、脱敏号码、1 至 11 位数字片段 | 只收窄候选，必须再确认唯一 |
| 搜索词是否命中联系人 | `searchPhoneMatch` | 同上 | 只返回搜索候选 |

身份判定按以下规则执行：

- 输入的完整号码必须与联系人保存的完整号码逐字符相等。
- 中间四位参与比较，因此只有可见端相同的号码不能通过身份判定。
- 脱敏号码和数字片段一律返回 `false`。
- 只有脱敏记录的联系人没有完整号码，完整号码输入对这行返回 `false`。

候选筛选按以下规则执行：

- 脱敏输入按前三位和后四位收窄候选。
- 数字片段按去掉掩码字符后的子串命中。
- 候选筛选结果不能直接作为执行对象，调用方必须要求候选唯一。

说明：`maskAwarePhoneMatch` 保留严格身份语义，只比较两个相同形态的号码。
该函数不用于构建搜索列表。

判定位置如下：

- [收款人解析](../../security/recipient-resolution.ts)先做身份判定，再用脱敏候选唯一化。
- [转账执行](../../banking-sdk/transfer.ts)的 `resolveRecipient` 复用同一规则。
- [新增联系人](../../banking-sdk/contact.ts)用身份判定拒绝重复手机号。
- [联系人查询](../../lib/db/repositories/contact.ts)的 `searchContacts` 只用候选筛选。
- [号码语义](../../lib/phone.ts)是身份判定与候选筛选的唯一来源。

## 跨用户隔离

解析只读取调用者本人的数据。
联系人解析只遍历本人联系人，卡片解析只遍历本人卡片。
属于其他用户或不存在的 id 解析为 `not_found`，不说明具体原因。
候选列表只包含本人记录，并以脱敏形式返回。

## 服务端解析与参数规范化

写操作在 park 阶段解析操作对象，早于确认卡生成与执行。
解析结果有 4 种状态：

| 状态 | 含义 | 后续动作 |
| --- | --- | --- |
| `resolved` | 恰好 1 个对象 | 参数规范化后写入待确认操作 |
| `not_found` | 没有对象匹配 | 返回澄清，不写待确认操作 |
| `ambiguous` | 多个对象匹配 | 返回澄清并列出脱敏候选 |
| `invalid` | 选择器缺失或形状不可用 | 返回澄清并说明原因 |

解析成功时执行参数规范化：

- 收款人解析后写入 `contactId`，并删除 `phone` 和 `name`。
- 卡片解析后写入 `cardId`，并删除 `cardType`、`cardTail` 和 `cardNumber`。
- 其他参数（金额、分类、商户、事由）保持原值。
- 确认卡与 SDK 执行使用同一个 id，两者不会指向不同对象。

说明：澄清请求不创建 `PendingAction`，也不发起多因子认证。
模型据此向用户追问，下一轮再提交唯一对象。

解析入口在[权限网关](../../security/security-gateway.ts)的 `gatewayCreatePendingAction`。
工具 runner 侧还有一层兜底：只有选择器时经同一解析器取 id，解析失败返回 `VALIDATION` 与同一条脱敏澄清。

## 卡片选择器

卡片写工具接受 4 个可选选择器，全部可选并可组合。
每个已提供的选择器都必须命中同一张卡。

| 选择器 | 接受的写法 | 匹配依据 | 拒绝情形 |
| --- | --- | --- | --- |
| `cardId` | `get_cards` 返回的确切 id | 与本人卡片 id 完全相等 | 尾号或卡号写进该字段返回 `invalid` |
| `cardType` | `DEBIT`、`CREDIT`、`VIRTUAL`；借记卡、储蓄卡、信用卡、虚拟卡 | 卡片类型，大小写不敏感 | 无法识别的类型返回 `invalid` |
| `cardTail` | `6688`、`尾号6688`、`****6688`、`...6688` | `numberMasked` 或 `numberFull` 的末 4 位 | 取不出恰好 4 位数字返回 `invalid` |
| `cardNumber` | 12 至 19 位数字，可用空格或连字符分隔 | 与 `Card.numberFull` 完全相等 | 形状不符返回 `invalid` |

拒绝规则如下：

- 没有任何选择器时返回 `invalid`。
- 尾号或完整卡号放进 `cardId` 时返回 `invalid`，错误文本由 `CARD_ID_SHAPE_REFUSAL` 提供。
- 放错字段的尾号不会退化成按尾号查询，也不会命中其他卡片。
- 多个候选返回 `ambiguous`，澄清消息按类型和脱敏尾号列出候选，例如 `借记卡 ****6688`。
- 完整卡号只与 `numberFull` 精确比较，该列为空的卡片不能用 `cardNumber` 选择。
- `numberFull` 为空的历史行用 `cardId`、`cardType` 或 `cardTail` 选择。

运行时新建的卡片都带服务端生成的完整卡号。
以下 3 条建卡路径都会写入 `Card.numberFull`：

- 虚拟卡申请：`applyVirtualCard`。
- 补办换卡：`replaceCard`。
- 页面添加卡片记录：`addDemoCard`。

因此 `cardNumber` 对新建卡片同样可用。
完整卡号是 16 位虚构数字：`6222` 加 8 个 `0` 加尾 4 位，形如 `6222000000001234`。
尾 4 位在本人卡片内唯一，完整卡号随之唯一。
`Card.numberMasked` 由同一完整卡号经[脱敏模块](../../lib/mask.ts)推导，形如 `****1234`，两者永远一致。
完整卡号仍不进入任何对外输出，边界见[完整号码的存放与脱敏边界](#完整号码的存放与脱敏边界)。

使用选择器的工具为以下 6 个写工具，集合见 `CARD_TARGET_TOOLS`：

- `set_card_limit`
- `freeze_card`
- `unfreeze_card`
- `consume_virtual_card`
- `report_lost_card`
- `replace_card`

`get_cards` 只查询卡片，不接受选择器。
`apply_virtual_card` 创建新卡，不接受选择器。

选择器参数定义在[卡片工具](../../agent/tools/card.ts)的 `cardSelectorFields`。
解析代码见[卡片选择器解析](../../security/card-resolution.ts)。

## 虚构测试数据号段

演示数据与测试夹具只使用虚构号码。
手机号中间四位固定为 `0000`，形如 `1XX000000NN`。
卡号由 `6222`、全 `0` 和原尾 4 位组成，形如 `6222000000006688`。

| 记录 | 完整值（仅服务端） | 展示值 |
| --- | --- | --- |
| 联系人 | `13900000002` | `139****0002` |
| 卡片 | `6222000000006688` | `****6688` |

[演示种子](../../prisma/seed.ts)与[测试夹具](../../tests/helpers/fixtures.ts)已注明这些号码是虚构数据。
警告：不得使用真实个人手机号或真实银行卡号填充演示数据、夹具或测试。

## 完整号码的存放与脱敏边界

完整号码只存放在 2 个服务端字段：

- `Contact.phoneFull`：完整虚构手机号，可为空。
- `Card.numberFull`：完整虚构卡号，可为空。

展示列只存脱敏值：`Contact.phone` 与 `Card.numberMasked`。
服务端精确匹配读取完整号码列。
以下位置只输出脱敏值：

- 日志。
- 工具结果与模型可见文本。
- 接口响应，包括 `ContactView` 与 `CardView`。
- 错误消息与会话事件。
- 澄清消息：文本里的 12 至 19 位数字先经 `maskCardReferences` 脱敏。

脱敏代码集中在[脱敏模块](../../lib/mask.ts)，提供 `maskPhone`、`maskAccountNumber` 和 `maskCardNumber`。
各层不得自行编写脱敏代码，也不得复制这段代码。

说明：已脱敏的展示值无法还原完整号码，中间四位与前置位永不写入展示列。

## 数据升级与回滚

升级只新增 2 个可空列，已有数据继续可读。
未补全的行保持空值，这类联系人与卡片改用脱敏尾号或 id 选择。

### 升级步骤

1. 停止应用与恢复进程。
2. 按[开发指南的备份步骤](development.md#备份默认数据库)创建数据库快照。
3. 同步 schema 与生成客户端。

   ```sh
   pnpm db:push
   pnpm db:generate
   ```

4. 写入演示种子行。

   ```sh
   pnpm db:seed
   ```

   说明：种子脚本只影响自身写入的演示记录。

5. 演练补全计划，不写入数据。

   ```sh
   pnpm exec tsx scripts/number-backfill.ts --dry-run
   ```

6. 写入补全结果。

   ```sh
   pnpm exec tsx scripts/number-backfill.ts
   ```

7. 核对报告与变更清单。

   清单保存在 `logs/number-backfill/<时间戳>-applied.json`。

警告：跳过数据库备份会丢失已提交的联系人与卡片记录。

### 补全规则

[补全脚本](../../scripts/number-backfill.ts)按以下规则处理数据：

- 只扫描 `phoneFull` 或 `numberFull` 为空的行。
- 唯一允许的补全是从展示列复制。
  展示列已是完整号码时，复制进完整号码列，并把展示列规范化为脱敏形态。
- 脱敏展示值永不还原，缺失数字不会被猜测或推算。
- 写入使用比较并交换：完整号码列仍为空，且展示列未被改动。
- 用户新增的带值记录不在扫描范围内，脚本不会覆盖这些记录。
- 重复执行幂等：第二次运行不补全任何记录。

### 无法补全的记录

报告逐条列出记录 id、脱敏值和原因。

| 原因 | 含义 |
| --- | --- |
| `unrecoverable-masked` | 展示列只有脱敏值，缺失数字无法恢复 |
| `unrecognized-format` | 展示列既不是完整号码，也不是脱敏形态 |
| `already-complete` | 其他写入已先补全该行 |
| `display-changed` | 扫描后展示列发生变化 |

### 回滚步骤

只有本脚本写入的值需要回滚。
新增列属于兼容式变更，可以保留。

1. 停止应用与数据库连接。
2. 执行回滚命令。

   ```sh
   pnpm exec tsx scripts/number-backfill.ts --rollback=logs/number-backfill/<时间戳>-applied.json
   ```

3. 需要恢复更早的数据时，用快照覆盖数据库。

回滚只清空仍持有脚本写入值的行，人工改过的行保持不变。
展示列的脱敏规范化不回滚，该操作只减少暴露。
`--dry-run` 不能与 `--rollback` 同时使用。

## 代码入口

- [号码语义](../../lib/phone.ts)：身份判定、候选筛选与片段搜索。
- [脱敏模块](../../lib/mask.ts)：手机号、账号和卡号的唯一脱敏来源。
- [收款人解析](../../security/recipient-resolution.ts)：解析转账收款人并规范化 `contactId`。
- [卡片选择器解析](../../security/card-resolution.ts)：解析卡片选择器并规范化 `cardId`。
- [权限网关](../../security/security-gateway.ts)：park 阶段调用解析器，返回澄清或规范化参数。
- [卡片工具](../../agent/tools/card.ts)：选择器参数定义与 runner 侧兜底解析。
- [联系人仓库](../../lib/db/repositories/contact.ts)：`contactPhoneFacets` 与候选查询。
- [数据库 schema](../../prisma/schema.prisma)：`phoneFull` 与 `numberFull` 列。
- [补全脚本](../../scripts/number-backfill.ts)：补全、演练与回滚命令。
- [单元测试](../../tests/unit/lib/phone-identity.test.ts)：身份判定与候选筛选的边界。
- [补全脚本测试](../../tests/unit/scripts/number-backfill.test.ts)：幂等、跳过原因与回滚。

测试范围与证据规则见[测试说明](test-cases.md)。
匹配规则在业务决策中的作用见[字符串匹配审查](string-matching-review.md)。
权限、确认与审计见[安全设计](security.md)。
