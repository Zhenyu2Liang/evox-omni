# 银行 SDK
SDK 校验银行业务不变量，并通过仓储或 `runInTransaction` 执行写入。权限层级、人工确认、MFA 与熔断决策属于安全层。SDK 从不执行模型生成的代码、SQL 或 shell 命令。
## 公开契约
能力从 `banking-sdk/index.ts` 导入；DTO 位于 `types.ts`。金额输入与输出都是十进制字符串。仓储持久化使用 bigint 人民币分保存已记账金额，使用规范十进制 TEXT 保存收益率与估值。`MoneyInput` 只接受字符串。`normalizeMoney` 校验已记账精度；缺省值不等于零。
产品年化收益率是 `annualYieldRate`，为无量纲比例，且恒不为负：创建时 `lib/db/repositories/investment.ts#createProduct` 与投影时 `investment.ts#toProductView` 都经 `nonNegativeDecimal` 上闸，负数会抛 `VALIDATION` 而不是被渲染。因此展示层的 `lib/decimal.ts#rateRatioToPercent`（自带非负门）只适用于产品年化，绝不适用于持仓收益率。投资持仓按净值与份额核算：`latestNetValuePerUnit` 是规范十进制净值，`shares` 是持有份额，`principalAmountMinor` 是剩余成本基数。公开持仓的 `amount` 是剩余持仓成本，`marketValue` 是未取整估值，`profit` 是未实现收益，`realizedProfit` 是已实现收益，`cumulativeProfit` 是累计收益。百分比只在展示层转换。
单个持仓没有 SDK 内的时间累积：净值只取产品发布的 `latestNetValuePerUnit`，SDK 不按时间推导增长。市值一律由 `shares × latestNetValuePerUnit` 派生；`estimatedMarketValue` 只是列上的快照，读取不使用它。持仓收益是未实现收益，等于市值减去剩余成本；追加申购金额不计入收益。
十进制最多 40 位整数与 18 位小数。SDK 使用精确算术、拒绝非法值，只在文档化的结算边界取整。当前赎回策略是 HALF_UP 到人民币分；授权与执行使用同一换算。最终余额与流水仍是有符号 INT64 分。
## 符号性与非负门禁
`ProductView.annualYieldRate` 唯一产自 `investment.ts#toProductView`（投影行 `annualYieldRate: nonNegativeDecimal(row.annualYieldRate)`），后续 `listProducts`、`compareInvestments`、`listHoldings.product` 都复用它。负值因此不是以负数渲染，而是在读取时抛 `VALIDATION`（`Financial value must be nonnegative.`）；展示层 `lib/decimal.ts#rateRatioToPercent` 的同一门禁不会在渲染期触发。
`HoldingView.profitRate` 是带符号比率：`holdingValuation` 调 `net-value.ts#profitRateOf(profit, cost)`，内部 `parseFixed` 保留符号、`halfUpDivide` 向远离零取整，成本为零返回 `undefined`；它绝不进 `nonNegativeDecimal`，展示用 `lib/decimal.ts#signedRateToPercent`。
带符号字段：`profit`（`marketValue − cost`）、`cumulativeProfit`（`realizedProfit + profit`）、`realizedProfit`（`centsToMoney(realizedProfitMinor)`，`lib/money.ts#centsToMoney` 保留符号）、`profitRate`。
非负字段：`shares` 与 `latestNetValue`（`nonNegativeDecimal` + 必须大于零，否则视为缺失）、`marketValue`（份额×净值的精确乘积，或历史不足时回退剩余成本）、`amount`。
`investment.ts` 的 `nonNegativeDecimal` 用途：产品净值（`productNetValue`）、持仓份额（`recordedShares`）、年化收益率（`toProductView`）、历史记录十进制字段（`requireDecimal`）、赎回回执估值（`parseRedeemResult`）、赎回份额输入（`normalizeRequestedShares`）、确认快照 `expectedShares`/`expectedNetValue`（`assertConfirmedSnapshot`）；外加顶部 import 一行。
数据层写入门禁只在仓储：`lib/db/repositories/investment.ts#createProduct` 过 `nonNegativeDecimal(annualYieldRate)`，`createHolding` 过 `nonNegativeDecimal(marketValue)`。`prisma/seed.ts` 直接 `investmentProduct.createMany` 写硬编码正值，绕过该门禁。
## 净值与份额换算
`banking-sdk/net-value.ts` 是无读写的纯函数模块。
常量是 `NET_VALUE_DECIMALS = 4`、`SHARE_DECIMALS = 6` 与 `REDEMPTION_FEE_RULE = 'SIMULATED_NONE'`。
`floorToShares` 与 `sharesFromAmount` 用 FLOOR 折算 6 位小数份额，结果为零抛 `VALIDATION`（`折算份额为零`）。
`marketValueFromShares` 返回未取整的精确乘积。
`settlementFromShares` 只做一次 HALF_UP 结算到人民币分。
`redeemedCostMinor` 按份额比例扣减成本并 HALF_UP 到分，已赎回成本与剩余成本之和恒等于原成本。
`remainingSharesOf` 返回剩余份额，`profitRateOf` 返回 18 位小数比例，成本为零时返回 `undefined`。
`profitRateOf` 保留收益符号：亏损持仓的 `HoldingView.profitRate` 是负数，这是预期状态而不是故障；展示层必须走 `lib/decimal.ts#signedRateToPercent`（仅 `multiplyDecimal`），用 `rateRatioToPercent` 会在渲染期抛 `Financial value must be nonnegative.`。
安全层铸造确认快照与执行结算都调用这些函数，确认金额与执行金额不会分叉。
`holdingValuation` 是 `listHoldings`、仪表盘与赎回共用的唯一估值规则。
`valueBasis` 有三个取值，各自由明确条件产出：
- `NET_VALUE`：`shares` 可用且产品发布了净值，份额来自真实申购记录（`sharesEstimated` 为假）。
- `MIGRATED_ESTIMATE`：`shares` 可用、净值可用，但 `sharesEstimated` 为真——份额由 `scripts/investment-share-backfill.mjs` 按历史账面价值派生，只能算作估算；市值与收益的计算口径与 `NET_VALUE` 完全相同，只是标注不同。
- `HISTORICAL_DATA_INSUFFICIENT`：`shares` 缺失或不合法，或产品没有净值。此时市值回退为剩余成本、收益缺省；`sharesEstimated` 为真也不会凭空估值。
## 十进制符号规则（本目录）
`addDecimal`/`subtractDecimal` 保留符号，专门用于可为负的累加与差；`nonNegativeDecimal`（`lib/decimal.ts`，负数抛 `VALIDATION`）只是「真实非负量」的闸门。
`addDecimal` 调用点：`investment.ts:1316` `cumulativeProfit = addDecimal(realizedProfit, profit)`（已实现 + 未实现收益两者都可为负）、`investment.ts:782` 份额累加（正数）、`dashboard.ts:44` 持仓市值累加（恒非负）。
`nonNegativeDecimal` 调用点：净值 `investment.ts:124`、份额 `investment.ts:145`、产品年化比例 `investment.ts:219`、历史记录十进制字段 `investment.ts:364`、赎回估值 `investment.ts:542`、请求份额 `investment.ts:926`、确认快照 `investment.ts:1001`/`1004`、比例估值入参 `valuation.ts:73`。
`HoldingView.profitRate` 由 `net-value.ts#profitRateOf(profit, cost)` 推导（`investment.ts:197`），`profit = marketValue − 剩余成本` 可为负，因此 `profitRate` 是带符号比例（种子 `holding_wenjib`：成本 10000、净值 0.9880、份额 10000 → 收益 −120、收益率 −0.012）。
本目录绝不把 `profitRate`、`profit`、`realizedProfit`、`cumulativeProfit` 送入 `nonNegativeDecimal`，也不在本目录换算百分比：`listHoldings` 原样投影 `profitRate`（`investment.ts:1314`）。
本目录没有任何 `signedRateToPercent`/`rateRatioToPercent` 调用；带符号比例的百分比换算只发生在展示层 `components/banking/HoldingFacts.tsx`（`signedRateToPercent`），年化比例用 `rateRatioToPercent`。
## 认购：新建或聚合
`subscribeInvestment` 先校验 `userId` 与正金额，再在同一个事务内判断该 (用户, 产品) 是否已有 `HOLDING`。
产品没有净值时抛 `VALIDATION`（`该产品未发布净值，暂不可申购`）。
本次所得份额是 `FLOOR(金额 ÷ 最新净值, 6 位小数)`。
- 没有 `HOLDING`：扣减资金账户余额、创建持仓并写入 `shares` 与成本、写入投资流水 `Transaction`，把原始结果持久化到 `subscribeResult`，并在 `purchaseHistory` 记录本次（创建）认购。
- 已有 `HOLDING`：把本次金额累加到 `principalAmountMinor`，把所得份额累加到 `shares`，保持 `HOLDING`，并向 `purchaseHistory` 追加一条认购记录。
低于 `product.minAmountMinor` 抛 `VALIDATION`；资金不足抛 `INSUFFICIENT_FUNDS`。
扣款使用条件写（`balance >= amount`），并发下不会透支。
余额变动、持仓变动、流水行与结果持久化在同一事务内提交。
`purchaseHistory` 是 JSON 数组，元素形如 `{ at, amount, totalPrincipal, marketValue, shares?, netValuePerUnit?, netValueDate?, totalShares?, newBalance, sourceAccountId, executionKey? }`。
`at` 与 `netValueDate` 是毫秒时间戳，`marketValue`、`totalPrincipal` 与 `totalShares` 是本次认购后的持仓值，首个元素是创建持仓的那笔认购。
缺少份额与净值字段的元素来自更早写入的记录，读取时不补造。
`HoldingView` 暴露 `lastPurchaseAt` 与 `purchases`（从旧到新）；`InvestResult` 暴露 `addedToExisting` 与 `lastPurchaseAt`。
## 赎回：按份额、按金额或全额
`redeemInvestment` 处理单个持仓，`mode` 是运行时必需的显式口径。
缺少或未知的 `mode`、以及已退出的 `redeemAmount` 都在任何读取之前抛 `VALIDATION`（`赎回需要明确口径：请确认按「份额」还是按「金额」赎回`）。
- `SHARES`：按份额赎回，需给出正份额，不得超过持有份额。
- `AMOUNT`：按金额赎回，份额是 `FLOOR(金额 ÷ 最新净值, 6 位小数)`；折算份额为零或金额超过当前市值都抛 `VALIDATION`（`赎回金额超过持仓市值，请改用全额赎回或按份额赎回`）。
- `ALL`：赎回全部份额并关闭持仓，同时给出份额或金额抛 `VALIDATION`。
混用口径一律拒绝，不会静默放大为全额赎回。
产品没有净值时抛 `VALIDATION`（`该产品未发布净值，暂不可赎回`）；持仓没有记录份额时抛 `CONFLICT`（`该持仓尚未记录份额，暂不可赎回`）。
到账金额是 `HALF_UP(赎回份额 × 成交净值, 人民币分)`，只取整一次。
赎回费恒为 `0.00`，`feeRule` 恒为 `REDEMPTION_FEE_RULE`（`SIMULATED_NONE`）。
成本按份额比例扣减：`redeemedCostMinor` 用 `剩余成本 × 赎回份额 ÷ 总份额` 并 HALF_UP 到分，剩余成本等于原成本减去该值，两者相加恒等于原成本。
已实现收益按 `到账金额 − 该次消耗成本` 累加到 `realizedProfitMinor`，可为负，此后不再重算。
`ALL` 把 `HOLDING` 原子地转为 `REDEEMED`，把原始结果持久化到 `redeemExecutionKey` 与 `redeemResult`。
`SHARES` 与 `AMOUNT` 保持 `HOLDING`，扣减 `shares` 与 `principalAmountMinor`，并向 `redemptionHistory` 追加一条记录。
`redemptionHistory` 是 JSON 数组，元素形如 `{ at, redeemedShares, totalShares, netValue, netValueDate?, settledAmount, cost, remainingShares, remainingCost, remainingMarketValue, newBalance, sourceAccountId, executionKey? }`。
`remainingCost` 同时以 `remainingPrincipal` 别名出现，供更早写入的记录复用。
全额赎回的 `redeemResult` 中 `remainingPrincipal` 与 `remainingShares` 都是零。
`HoldingView` 暴露 `shares`、`latestNetValue`、`latestNetValueDate`、`marketValue`、`profit`、`profitRate`、`realizedProfit`、`cumulativeProfit`、`valueBasis`、`purchases` 与 `redemptions`。
## 确认快照与陈旧授权
`redeemInvestment` 接受四个可选的确认快照字段：`expectedShares`、`expectedNetValue`、`expectedNetValueDate` 与 `expectedSettlementAmount`。
执行时在写事务内重新读取产品净值与持仓份额，并重算到账金额。
任一字段与当前事实不一致时抛 `CONFLICT`（`净值或持仓已变化，请重新确认`），本次零写入。
按新净值静默成交永不允许；用户必须重新确认后才能执行。
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
借记卡（`DEBIT`）与虚拟卡（`VIRTUAL`）在创建时都绑定一个结算活期账户：`Card.linkedAccountId` 是 `userId` 的 CHECKING 账户 id（`Card.linkedAccount Account?` 是真实外键，但语义上仍是引用——账户漂移不会被自动改绑或猜补）；信用卡（`CREDIT`）按设计不绑定结算账户，额度只来自 `creditLimit`/`availableLimit`。
`resolveLinkedAccount(tx, userId, requestedId?)` 是 DEBIT/VIRTUAL 共用的绑定规则，显式优先、绝不猜测：显式 id 不存在或不属于该用户抛 `SECURITY_DENIED`，类型不是 `CHECKING` 抛 `VALIDATION`；省略时当且仅当该用户恰好有 1 个活期账户才采用它，0 个或多个都抛 `VALIDATION` 要求显式指定 `linkedAccountId`。没有「按 id 最小挑一个」的回退：选错账户就是替用户花钱。隐式推断只存在于一次性补数据脚本 `scripts/card-account-binding.ts`，SDK 永不猜。
`applyVirtualCard` 与 `addDemoCard`（`type !== 'CREDIT'`）在创建时绑定账户，走同一 `resolveLinkedAccount`。`applyVirtualCard` 的幂等键重放还要求请求的绑定账户与月限额一致，否则抛 `CONFLICT`；确定性 id 与 P2002 并发重放保持不变。信用卡不绑定账户。
`requireSettlementAccount(tx, userId, cardId, linkedAccountId)` 重新校验一条已记录的绑定：账户行必须存在且属于该用户，类型必须是 `CHECKING`，否则抛 `CONFLICT`（错误上下文标注 `linkedAccountStatus: 'UNTRUSTED'`）。已记录的绑定不会被猜测替换。
`resolveSettlementAccount(tx, card)` 返回卡片必须使用的结算账户。绑定缺失时只从显式的补办来源恢复：`replacedByCardId` 等于本卡 id 且已记录绑定的自有卡片。恢复经同一校验后在本事务内写回 `Card.linkedAccountId`；没有显式来源时返回 `null`，由调用方拒绝。不从“用户默认账户”或任何文本推断绑定。
`CardView` 把「关联账户 + 账户余额 + 可用余额 + 卡片可用性」作为同一份投影暴露。`linkedAccountStatus` 是四态且总是存在：
- `LINKED`：`linkedAccountId` 非空，且账户存在、`userId` 相同、`type === 'CHECKING'`。只有这一态填充 `linkedAccountNumber`（库里已脱敏的 `Account.number`）、`linkedAccountName`（如「活期账户」）、`accountAvailableBalance`（账户资金，十进制人民币）与 `payableAmount`。
- `MISSING`：`linkedAccountId` 为空（无绑定），没有任何余额类字段——不填 `0`、不填 `null`。
- `UNTRUSTED`：`linkedAccountId` 非空但账户已删除、属于他人或不是 `CHECKING`，同样没有任何余额类字段：绝不泄漏他人余额，绝不编造 `0`。
- `NOT_APPLICABLE`：`CREDIT` 卡，按设计不解析结算账户，额度仍来自 `creditLimit`/`availableLimit`。
`usable = (status === 'ACTIVE')`，`FROZEN`/`LOST`/`PENDING` 为 `false`；但卡片不可用不等于余额为零，`LINKED` 卡的余额字段照常填充。

`CardView`（`types.ts`）字段是封闭集合：`id`、`type`（`'DEBIT'|'CREDIT'|'VIRTUAL'`）、`network`、`numberMasked`、`status`、`usable`、`limits`，加上可选的 `creditLimit`/`availableLimit`/`monthlyLimit`/`replacedByCardId`/`linkedAccountId`/`linkedAccountNumber`/`linkedAccountName`/`accountAvailableBalance`/`payableAmount`（后四个只在 `LINKED` 时出现）。没有 `balance`、`cardType` 或 `kind`：卡类别只看 `type`，卡片自身从不持有余额。
唯一的投影入口是 `card.ts#toCardView`（经 `loadCardView` 取限额、解析绑定与家族月消费），所有返回 `CardView` 的路径都经过它，因此 `FROZEN`/`LOST` 卡同样带完整绑定状态与余额。
`CardView` 的金额字段是 `lib/money.ts#centsToMoney` 的规范两位小数十进制文本（`1234.50`，无分组、无货币符号）；带 `¥1,234.50` 的 `formatCNY` 只属于展示层。
`accountAvailableBalance` 是账户资金，`payableAmount` 是该卡当前实际可支付额：`payableAmount = monthlyLimitMinor 为空 ? accountAvailableBalance : min(accountAvailableBalance, max(0, monthlyLimitMinor − 当月已消费))`。二者都只来自关联账户，卡片没有自己的独立余额；绑定同一账户的多张卡共享同一份现金。绑定解析在投影的同一读 client（同一 unit-of-work 事务）内一次完成，存在性、owner 与 `CHECKING` 类型一次校验，且只在 `LINKED` 时才去查家族月消费。`linkedAccountId` 只回显记录的引用，是否仍然可信看 `linkedAccountStatus`。
当月已消费是补办家族口径。`banking-sdk/card-family.ts` 的 `cardFamilyMonthSpend(client, cardId, userId, now?)` 先由 `cardFamilyIds` 沿 `replacedByCardId` 双向遍历得到家族，再按 `demoMonthRange(now)` 的 UTC+08:00 业务月汇总 `CardConsumption.amountMinor`。遍历用访问集与 `MAX_CARD_FAMILY = 64` 上限，只纳入同一 `userId` 的卡片，因此多代补办算作一个家族，损坏的环会终止，跨用户指针不会扩大归集。限额强制与 `payableAmount` 读取同一个家族数字，并使用同一个业务时刻：普通读取取 `demoNow()`，`consumeCard` 取本次消费的服务端时刻。
`consumeCard(input, options?)` 是本地模拟刷卡。消费时间由服务端拥有：入账时刻取 `demoNow()`，月限额窗口由同一时刻的 `demoMonthRange()` 推导，二者不可分离；返回快照 `card` 的 `payableAmount` 也按该时刻的家族月消费计算，因此与限额强制描述同一个业务月。`ConsumeCardInput` 没有 `occurredAt`；运行期对象上仍带已定义的 `occurredAt`（过去、未来、非整数、`null`、字符串等）时，在任何读写之前抛 `VALIDATION`，绝不静默忽略；`{ occurredAt: undefined }` 视为未提供。
`ConsumeCardOptions.now` 是唯一时钟缝隙，仅供测试注入整数毫秒时间戳或 `Date`；非整数抛 `VALIDATION`。它是独立的第二个参数，不进入 HTTP 请求体或工具参数，也不提供任何历史补记功能。
`consumeCard` 在同一事务内校验卡（自有、`ACTIVE`，否则 `NOT_FOUND` / `CONFLICT`；`FROZEN`/`LOST`/`PENDING` 一律拒绝消费）、重新校验或恢复结算账户（`MISSING` 与 `UNTRUSTED` 都抛 `CONFLICT`，错误信息与上下文分别标注 `linkedAccountStatus`，绝不退化到「用户默认账户」）、按家族当月月限额校验（超过抛 `LIMIT_EXCEEDED`，限额 `0` 表示不可支付，为空表示仅受账户余额约束）、用条件余额写扣减（`balanceMinor >= amount`，计数为 0 抛 `INSUFFICIENT_FUNDS`），写入 `channel='CARD'`、`direction='DEBIT'`、`amountMinor` 为负的流水行与服务端时刻的 `occurredAt`，并创建一条正的 `CardConsumption`。
`executionKey` 是重放身份（`CardConsumption.executionKey` 唯一）。同键重放校验归属后返回持久化的 `resultJson` 原始快照，不重复扣款；卡或用户不一致抛 `CONFLICT`；并发同键唯一冲突在事务外重读已提交行并重放。缺少快照证据抛 `CONFLICT`，绝不重建成功。
`listCardConsumptions(userId, query?)` 返回自有的消费记录（按 `occurredAt` 从新到旧，可用 `cardId` 过滤，默认 20 条、上限 200）。
仪表盘 `getDashboardSummary` 的 `creditAvailable` 只汇总 `type === 'CREDIT'` 且 `status !== 'LOST'` 的卡：补办会保留 LOST 原卡的可用额度并让新卡继承同一额度，按 `LOST` 过滤避免重复计入。借记卡/虚拟卡与其绑定账户余额不计入信用可用额；资产总额仍按账户余额各计一次，不因卡片重复。
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
`DEBIT` 与 `VIRTUAL` 卡补办都在原卡片的结算账户上重新校验并继承该绑定（同一 `requireSettlementAccount`）：账户行必须存在、属于该用户且为 `CHECKING`；`CREDIT` 不继承任何绑定。
原虚拟卡未绑定结算账户时抛 `CONFLICT`；记录绑定缺失、属于他人或非活期时同样抛 `CONFLICT`，绝不签发无法消费的卡。
原借记卡未绑定时不阻断补办：新卡照常签发并保持 `MISSING`（借记卡无绑定不是致命状态，卡本身就存在），记录绑定而不可信的借记卡按 `UNTRUSTED` 抛 `CONFLICT`。
月限额跨补办连续：当月已消费按家族汇总，因此原卡本月已消费 30、月限额 100 时，新卡只能再消费 70。已记账的 `CardConsumption.cardId` 不改写，这是归集口径而不是历史重写。
数据中已有的破损补办卡（非 `CREDIT` 且 `linkedAccountId` 为空）只在显式补办来源记录有效、自有、`CHECKING` 绑定时恢复，并在事务内写回：补办重放命中旧补办卡时同样修复，消费命中该卡时也恢复并持久化。
原卡片保持 `LOST`；补办不迁移任何历史记账。
补办是幂等的：原卡片已指向补办卡时返回该卡（即使该补办卡本身已 `LOST` 也原样返回），不再签发第二张。
关联的补办卡不存在时抛 `CONFLICT`。
`replacedByCardId` 是历史引用，不是 Prisma 关系。
`CardView.replacedByCardId` 是补办卡 id；没有补办时该字段缺省。所有返回 `CardView` 的读取与写入路径（`getCards`、`addDemoCard`、`assertDemoCardDeletable`、`setCardLimit`、`freezeCard`、`unfreezeCard`、`reportLostCard`、`replaceCard`、`applyVirtualCard`、`consumeCard.card`）都经过同一 `loadCardView` 投影，因此 `FROZEN`/`LOST` 卡同样带完整绑定状态与余额。
## 号码投影（展示脱敏）
公开 DTO 里没有任何完整号码字段：`CardView`、`ContactView`、`TransferRecipient`、`AccountView` 都没有 `numberFull`、`phoneFull`、`last4` 或裸 `full`。
`CardView.numberMasked` 直接回显库里已脱敏的 `Card.numberMasked` 列（`types.ts:224`，`card.ts#toCardView` 行 178 `numberMasked: row.numberMasked,`），投影不做二次脱敏。
`CardView.linkedAccountNumber` 回显库里已脱敏的 `Account.number`，仅在 `linkedAccountStatus === 'LINKED'` 时填充（`card.ts#toCardView` 行 200）。
`ContactView.phone` 与 `TransferRecipient.phone` 是脱敏展示值，由 `lib/phone.ts#maskPhone`（实现位于 `lib/mask.ts`）在投影时算出：`contact.ts#toContactView` 行 28 `phone: maskPhone(row.phone),`、`transfer.ts#toRecipient` 行 60 `phone: maskPhone(contact.phone),`。
`AccountView.numberMasked` 在 `account.ts#toAccountView` 行 19 内联 `` `****${row.number.slice(-4)}` `` 脱敏，不调用 `maskAccountNumber`（等价形状，但绕过了「唯一实现」约定）。
`Card.numberFull` 只在制卡时由 `generateCardIdentity` 生成并写入（`addDemoCard`、`replaceCard`、`applyVirtualCard` 的两个分支），仅用于去重与服务端精确匹配（`security/card-resolution.ts`），绝不进入任何投影、日志或工具结果；`banking-sdk/card.ts` 内的 `maskCardNumber` 调用只有 `generateCardIdentity` 的两行（990、996），投影不脱敏。
`Contact.phoneFull` 由 `lib/db/repositories/contact.ts#createContact` 写入，SDK 只通过 `lib/phone.ts#phoneIdentityMatches` 做精确匹配，不投影。
`ScheduledTaskView.payload`（`types.ts:697`）原样回显已持久化载荷（`task.ts#toScheduledTaskView`）；定时支付/转账载荷里的收款人选择器可能是调用方自己提交过的完整手机号——这是回显调用方输入，不是投影存储的第三方号码。
## 存储生命周期
只支持当前 schema 与契约。`pnpm db:push` 同步 schema；`pnpm db:reset` 重建模拟数据。不要新增旧 schema 迁移、数字金额适配器、旧指纹接受或回执前的重放路径。当前回执、审计与重启恢复是运行时保证，而不是兼容特性。服务端消费时间与补办家族归集不引入 schema 变更。
