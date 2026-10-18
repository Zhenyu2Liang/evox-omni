# 银行 SDK

SDK 校验银行业务不变量，并通过仓储或 `runInTransaction` 执行写入。权限层级、人工确认、MFA 与熔断决策属于安全层。SDK 从不执行模型生成的代码、SQL 或 shell 命令。

## 公开契约

能力从 `banking-sdk/index.ts` 导入；DTO 位于 `types.ts`。金额输入与输出都是十进制字符串。仓储持久化使用 bigint 人民币分保存已记账金额，使用规范十进制 TEXT 保存收益率与估值。`MoneyInput` 只接受字符串。`normalizeMoney` 校验已记账精度；缺省值不等于零。

当前产品收益率是 `annualYieldRate`，为无量纲比例。持仓本金是 `principalAmountMinor`；预估人民币市值是 `estimatedMarketValue`。公开持仓的 `amount` 是已记账本金，`marketValue` 与 `profit` 保留估值精度。百分比只在展示层转换。

单个持仓没有 SDK 内的收益累积：市值就是已存储的十进制值。认购按成本价计价（等于本次认购本金），因此时间基准是最近一次认购时刻，不额外计提增长。

十进制最多 40 位整数与 18 位小数。SDK 使用精确算术、拒绝非法值，只在文档化的结算边界取整。当前赎回策略是 HALF_UP 到人民币分；授权与执行使用同一换算。最终余额与流水仍是有符号 INT64 分。

## 认购：新建或聚合

`subscribeInvestment` 先校验 `userId` 与正金额，再在同一个事务内判断该 (用户, 产品) 是否已有 `HOLDING`。

- 没有 `HOLDING`：扣减资金账户余额、创建持仓、写入投资流水 `Transaction`，把原始结果持久化到 `subscribeResult`，并在 `purchaseHistory` 记录本次（创建）认购。
- 已有 `HOLDING`：把本次本金累加到 `principalAmountMinor`，把新增本金按成本价累加到未取整市值，保持 `HOLDING`，并向 `purchaseHistory` 追加一条认购记录。

低于 `product.minAmountMinor` 抛 `VALIDATION`；资金不足抛 `INSUFFICIENT_FUNDS`。扣款使用条件写（`balance >= amount`），并发下不会透支。余额变动、持仓变动、流水行与结果持久化在同一事务内提交。

`purchaseHistory` 是 JSON 数组，元素形如 `{ at, amount, totalPrincipal, marketValue, newBalance, sourceAccountId, executionKey? }`。`at` 是本次认购的毫秒时间戳，`totalPrincipal` 与 `marketValue` 是聚合后的值，首个元素是创建持仓的那笔认购。

`HoldingView` 暴露 `lastPurchaseAt` 与 `purchases`（从旧到新）；`InvestResult` 暴露 `addedToExisting` 与 `lastPurchaseAt`。

## 赎回：全额与部分

`redeemInvestment` 处理单个持仓；`redeemAmount` 是可选的、以本金计价的人民币金额。

- 缺省，或等于持仓本金：全额赎回。`HOLDING` 原子地转为 `REDEEMED`，一次性入账全部已结算估值。
- 小于持仓本金：部分赎回，保持 `HOLDING`。入账该本金部分对应的已结算估值，减少 `principalAmountMinor`，重算未取整的剩余市值，并向 `redemptionHistory` 追加一条部分赎回记录。

超过持仓本金、非正数或格式非法的 `redeemAmount` 都抛 `VALIDATION`（`赎回本金金额不能超过持仓本金` / `赎回本金金额必须大于零`）；非正数在任何写入之前即被拒绝。

按比例估值规则：设 `MV` 为当前 `estimatedMarketValue ?? centsToMoney(principalAmountMinor)`，`T` 为当前本金，`R` 为赎回本金。`portionValuation = MV × R / T` 用有理数做有界小数除法，最多保留 18 位小数（SDK 的小数存储上限），此后只做一次 HALF_UP 结算到人民币分。`remainingMarketValue = MV − portionValuation` 为精确相减，因此 `portionValuation + remainingMarketValue = MV`。`R === T` 时 `portionValuation` 就是 `MV`，全额与部分共用同一套估值与结算代码。

`banking-sdk/valuation.ts` 导出这套比例估值的纯函数：`redemptionPortionValuation`、`settledRedemptionAmount`、`remainingPortionMarketValue`，并由 `investment.ts` 与 `index.ts` 再导出。安全层铸造确认快照时应调用同一函数，使确认金额与执行结算金额无法分叉。

`redemptionHistory` 只记录部分赎回，是 JSON 数组，元素形如 `{ at, redeemedPrincipal, valuation, settledAmount, remainingPrincipal, remainingMarketValue, newBalance, sourceAccountId, executionKey? }`；`valuation` 是单次结算前的未取整估值。全额赎回沿用 `redeemExecutionKey` 与 `redeemResult` 保存原始结果。

`expectedRedemptionAmount` 必须等于本次应入账的已结算金额：部分赎回按当前持仓与 `R` 重算 `portionValuation` 后再比较，不一致抛 `CONFLICT`。

## 幂等与并发

执行键是受信的服务端输入。SDK 键必须是文本；空白键表示未提供重放身份。

创建持仓的认购把键写在唯一列 `InvestmentHolding.idempotencyKey` 上，只在创建时写入且不再覆盖；聚合认购把键写在追加的 `purchaseHistory` 记录的 `executionKey` 上。键查询先匹配唯一列，再扫描该 (用户, 产品) `HOLDING` 的 `purchaseHistory`，因此同键重试重放原始结果，不重复扣款、不重复聚合。创建竞态仍由现有 P2002 唯一冲突重放处理。重放校验以产生该结果的认购记录为准，而不是已经变大的当前本金。

部分赎回的恰好一次由乐观条件写保证：持仓更新以旧本金与 `HOLDING` 状态为条件，先做受保护的持仓写入，成功后才入账。计数为 0 时重新读取，并按同一执行身份从 `redemptionHistory` 或已关闭的 `redeemResult` 重放，否则抛 `CONFLICT`。聚合认购与部分赎回都以计数为 0 表示竞态，抛 `CONFLICT` 让事务（含扣款）整体回滚，因此不会出现重复扣款。

已关闭持仓上的其他或缺失身份仍然抛 `CONFLICT`。同键重放先前的部分赎回时，即使其后已发生全额关闭，也从 `redemptionHistory` 重放。

## 事务与执行上下文

`runInTransaction` 通过 unit-of-work 上下文与已有事务组合。受信的 `BankingExecutionContext` 提供执行栅栏与审计回调，这些检查在写事务内运行。工具输入上没有 Symbol 属性或第二个栅栏载体。

转账在原子事务内扣减自有活期账户、创建流水行并持久化原始回执。重放先校验当前请求摘要、回执与流水，再查询可变联系人。缺失证据是冲突，绝不重建成功。并发同键唯一冲突只重放已校验的已提交证据。

账本与定时意图的创建使用按所有者限定的重放校验。虚拟卡使用确定性执行身份并校验月度限额。卡状态转换与订阅校验归属与状态。预算是记账信封而不是资金冻结。

## 错误与读取

抛 `AppError` 并带领域错误码；Agent 运行器把业务失败转换为类型化工具结果。不得为更早的写入伪造成功或当前余额。读取模型是 DTO 投影，保留估值精度，并在合并现金与持仓时共享同一快照。缺失、空白或损坏的认购历史不产生伪造记录，`purchases` 返回 `undefined`。

投资对比必须至少指定一个产品。每个请求的产品都必须存在；缺失产品使整个对比失败，而不是返回部分成功。重复 ID 只比较一次。风险筛选只接受 R1 到 R5。

业务日期使用显式的 UTC+08:00 演示时钟；安全与租约使用真实时间。金融数字转换只允许用于图表几何，不能用于授权或执行。

## 卡片：账户绑定与消费

虚拟卡在创建时绑定一个结算活期账户：`Card.linkedAccountId` 是 `userId` 的 CHECKING 账户 id（历史引用，不是 Prisma 关系）。

`resolveLinkedAccount(tx, userId, requestedId?)` 只接受自有活期账户：显式 id 缺失或不属于该用户抛 `SECURITY_DENIED`，类型不是 `CHECKING` 抛 `VALIDATION`；缺省时回退到该用户的活期账户，没有则抛 `VALIDATION`。

`applyVirtualCard` 与 `addDemoCard`（仅 `type === 'VIRTUAL'`）在创建时绑定账户。`applyVirtualCard` 的幂等键重放还要求请求的绑定账户与月限额一致，否则抛 `CONFLICT`；确定性 id 与 P2002 并发重放保持不变。非虚拟卡不绑定账户。

`requireSettlementAccount(tx, userId, cardId, linkedAccountId)` 重新校验一条已记录的绑定：账户行必须存在且属于该用户，类型必须是 `CHECKING`，否则抛 `CONFLICT`。已记录的绑定不会被猜测替换。

`resolveSettlementAccount(tx, card)` 返回卡片必须使用的结算账户。绑定缺失时只从显式的补办来源恢复：`replacedByCardId` 等于本卡 id 且已记录绑定的自有卡片。恢复经同一校验后在本事务内写回 `Card.linkedAccountId`；没有显式来源时返回 `null`，由调用方拒绝。不从“用户默认账户”或任何文本推断绑定。

绑定的卡在 `CardView` 中额外暴露 `linkedAccountId`、`linkedAccountNumber`（账户脱敏号）、`accountAvailableBalance`（账户余额，十进制人民币）与 `payableAmount`。`payableAmount = monthlyLimitMinor 为空 ? accountAvailableBalance : min(accountAvailableBalance, max(0, monthlyLimitMinor − 当月已消费))`。未绑定的卡这些字段缺省，不伪造数值。

当月已消费是补办家族口径。`banking-sdk/card-family.ts` 的 `cardFamilyMonthSpend(client, cardId, userId, now?)` 先由 `cardFamilyIds` 沿 `replacedByCardId` 双向遍历得到家族，再按 `demoMonthRange(now)` 的 UTC+08:00 业务月汇总 `CardConsumption.amountMinor`。遍历用访问集与 `MAX_CARD_FAMILY = 64` 上限，只纳入同一 `userId` 的卡片，因此多代补办算作一个家族，损坏的环会终止，跨用户指针不会扩大归集。限额强制与 `payableAmount` 读取同一个家族数字，并使用同一个业务时刻：普通读取取 `demoNow()`，`consumeCard` 取本次消费的服务端时刻。

`consumeCard(input, options?)` 是本地模拟刷卡。消费时间由服务端拥有：入账时刻取 `demoNow()`，月限额窗口由同一时刻的 `demoMonthRange()` 推导，二者不可分离；返回快照 `card` 的 `payableAmount` 也按该时刻的家族月消费计算，因此与限额强制描述同一个业务月。`ConsumeCardInput` 没有 `occurredAt`；运行期对象上仍带已定义的 `occurredAt`（过去、未来、非整数、`null`、字符串等）时，在任何读写之前抛 `VALIDATION`，绝不静默忽略；`{ occurredAt: undefined }` 视为未提供。

`ConsumeCardOptions.now` 是唯一时钟缝隙，仅供测试注入整数毫秒时间戳或 `Date`；非整数抛 `VALIDATION`。它是独立的第二个参数，不进入 HTTP 请求体或工具参数，也不提供任何历史补记功能。

`consumeCard` 在同一事务内校验卡（自有、`ACTIVE`，否则 `NOT_FOUND` / `CONFLICT`）、重新校验或恢复结算账户（缺失抛 `CONFLICT`）、按家族当月月限额校验（超过抛 `LIMIT_EXCEEDED`，限额 `0` 表示不可支付，为空表示仅受账户余额约束），用条件余额写扣减（`balanceMinor >= amount`，计数为 0 抛 `INSUFFICIENT_FUNDS`），写入 `channel='CARD'`、`direction='DEBIT'`、`amountMinor` 为负的流水行与服务端时刻的 `occurredAt`，并创建一条正的 `CardConsumption`。

`executionKey` 是重放身份（`CardConsumption.executionKey` 唯一）。同键重放校验归属后返回持久化的 `resultJson` 原始快照，不重复扣款；卡或用户不一致抛 `CONFLICT`；并发同键唯一冲突在事务外重读已提交行并重放。缺少快照证据抛 `CONFLICT`，绝不重建成功。

`listCardConsumptions(userId, query?)` 返回自有的消费记录（按 `occurredAt` 从新到旧，可用 `cardId` 过滤，默认 20 条、上限 200）。

仪表盘 `getDashboardSummary` 的 `creditAvailable` 只汇总 `type === 'CREDIT'` 且 `status !== 'LOST'` 的卡：补办会保留 LOST 原卡的可用额度并让新卡继承同一额度，按 `LOST` 过滤避免重复计入。虚拟卡/借记卡与其绑定账户余额不计入信用可用额；资产总额仍按账户余额各计一次，不因虚拟卡重复。

## 卡片与定时载荷

卡类别限额只接受支持的消费类别与可用或冻结的卡。状态变更使用条件写；并发变更产生领域冲突，而不是原始数据库错误。取消订阅会停用其续费提醒，提醒变更要求订阅处于可用状态。

定时支付与转账载荷在持久化前校验，并在派发时通过 `lib/contracts/scheduled-command.ts` 再次校验。载荷要求恰好一个收款人选择器与一个正的十进制金额，拒绝未知命令字段与凭据。提醒载荷只能包含惰性文本。日期纪元必须是合法的整数瞬时；到期意图可以被存储，而 Agent 创建独立要求显式的未来时间。服务端推导 `requiresConfirmation`：提醒自动投递，支付与转账在派发时需要授权。调用方不能设置该策略标志。

## 挂失与补卡

卡片丢失有两条独立流程。
`freezeCard` 与 `unfreezeCard` 是可逆的临时锁卡。
冻结的卡片可以恢复为 `ACTIVE`。
`LOST` 卡片不能冻结或解冻。
`reportLostCard` 把卡片置为终态 `LOST`，此后不能复活；重复挂失抛 `CONFLICT`。
`reportLostCard` 不做卡类别过滤：`DEBIT`/`CREDIT`/`VIRTUAL` 中任何非 `LOST` 状态（含 `ACTIVE`、`FROZEN`、`PENDING`）的自有卡片都可挂失；`reason` 已定义但不是文本抛 `VALIDATION`。

`replaceCard(cardId, userId)` 只为当前处于 `LOST` 的自有卡片补办新卡。
它没有输入对象，也不做卡类别过滤（`DEBIT`/`CREDIT`/`VIRTUAL` 一视同仁）。
原卡片不因补办改变状态（保持 `LOST`），新卡创建时状态为 `ACTIVE`。
补办在同一事务内创建新卡，并把新卡 id 写入原卡片的 `Card.replacedByCardId`。
新卡沿用原卡片的 `type`、`network` 与月限额，不复制分类限额，并生成新的脱敏卡号。信用卡补办原样继承原卡片的 `creditLimitMinor` 与 `availableLimitMinor`（不重新授信、不增减）；非信用卡保持为空。
虚拟卡补办在原卡片的结算账户上重新校验并继承该绑定：账户行必须存在、属于该用户且为 `CHECKING`。
原虚拟卡未绑定结算账户时抛 `CONFLICT`；记录绑定缺失、属于他人或非活期时同样抛 `CONFLICT`，绝不签发无法消费的卡。
月限额跨补办连续：当月已消费按家族汇总，因此原卡本月已消费 30、月限额 100 时，新卡只能再消费 70。已记账的 `CardConsumption.cardId` 不改写，这是归集口径而不是历史重写。
数据中已有的破损补办卡（`linkedAccountId` 为空）只在显式补办来源记录有效、自有、`CHECKING` 绑定时恢复，并在事务内写回；消费命中该卡时同样恢复并持久化。
原卡片保持 `LOST`，`CardConsumption` 与历史流水不迁移。
补办是幂等的：原卡片已指向补办卡时返回该卡（即使该补办卡本身已 `LOST` 也原样返回），不再签发第二张。
关联的补办卡不存在时抛 `CONFLICT`。
`replacedByCardId` 是历史引用，不是 Prisma 关系。

`CardView.replacedByCardId` 是补办卡 id；没有补办时该字段缺省。

## 存储生命周期

只支持当前 schema 与契约。`pnpm db:push` 同步 schema；`pnpm db:reset` 重建模拟数据。不要新增旧 schema 迁移、数字金额适配器、旧指纹接受或回执前的重放路径。当前回执、审计与重启恢复是运行时保证，而不是兼容特性。服务端消费时间与补办家族归集不引入 schema 变更。
