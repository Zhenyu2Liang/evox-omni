# 测试约定

## 目录与范围

| 目录 | 范围 |
| --- | --- |
| `unit/` | 策略、参数、金额、执行器与展示状态；安全、SDK 与执行权用例使用真实 SQLite |
| `scenarios/` | 编号演示场景 `test-01`…`test-19` 与离线模型场景 |
| `app/` | 进程内真实路由与 SSE 集成 |
| `integration/` | 执行、授权、回执、审计与恢复 |
| `helpers/` | 隔离数据库、夹具、模型脚本与进程恢复探针 |
| `e2e/` | 独立入口的真实浏览器验收与 HTTP 边界用例 |
| `fixtures/` | 共享的 `*.zh-CN.json` 对话与策略剧本，无本地 CONTEXT.md |

本目录根部的 `setup.ts` 准备测试库，`deploy-db-push.test.ts` 覆盖 `scripts/db-push.ts` 的冷库自建。

根 `vitest.config.ts` 收集 `tests/**`、`agent/**`、`security/**`、`planner/**` 下的 `*.{test,spec}.ts`。
`.e2e.ts` 与 `.e2e-helper.ts` 不匹配该 include，`pnpm test` 不会运行它们。
浏览器与边界入口一律用 `pnpm exec tsx <入口>` 单独运行。
默认使用 mock 模式，不调用真实模型。
`unit/security/redemption-position-version.test.ts` 覆盖持仓变化后拒绝旧赎回授权。
`unit/scripts/database-maintenance.test.ts` 覆盖配置读取、备份不覆盖与份额回填。
`unit/scripts/demo-reference-backfill.test.ts` 覆盖显式补齐、归属隔离与历史估值保留。
`integration/credit-consumption-entry.test.ts` 覆盖信用卡入口、直接挂载弹窗和伪造消费请求。

## 入口

| 入口 | 内容 |
| --- | --- |
| `e2e/acceptance.e2e.ts` | mock 模型的真实浏览器验收，场景在 `JOURNEYS`，用 `E2E_JOURNEYS` 选择 |
| `e2e/live-acceptance.e2e.ts` | 真实模型的真实浏览器验收，场景在 `SCENARIOS`，用 `LIVE_SCENARIOS` 选择 |
| `e2e/date-tamper-boundary.e2e.ts` | 消费入账时间的纯 HTTP 边界用例，无模型、无浏览器 |

`SCENARIOS` 的 id 为 `15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB,lC,lD,lE,lF,lG,lH,lJ,lI`。
`lA` 补办信用卡、`lB` 理财部分赎回、`lC`…`lE` 虚拟卡场景、`lF`/`lG` 挂失→补办链路场景（`lF` 新会话、`lG` 单会话完整链路）、`lH` 连错三次验证码→终态锁定、`lI` 号码与尾号身份解析、`lJ` 借记卡/虚拟卡只展示绑定活期账户的现金；选择 `2` 会同时选中 `2p`，场景 `7` 恒为最后阶段。
`e2e/helpers.ts` 与 `*.e2e-helper.ts` 是入口共用的驱动与断言模块，自身不运行。
入口细节见 [e2e/CONTEXT.md](e2e/CONTEXT.md)。

## 数据与执行

`setup.ts` 固定使用 `prisma/test.db`。
它检查生成客户端，并按结构哈希准备测试库。
准备失败会抛出完整诊断。
夹具由测试通过 `resetDatabase` 等入口加载。

共享 SQLite 测试必须顺序执行。
不得同时启动多个会重置同一测试库的进程。
浏览器与部署测试也必须单独运行。
隔离库名称与行为见各子目录说明。
不得把开发库或用户备份用于测试重置。

熔断状态按所有者持久化。
同一用户的新会话不能隔离该用户的锁。
需要隔离时重置夹具或创建独立用户。
仅数据库无关测试可使用 `VITEST_SKIP_DB_SETUP=1`。

## 编写测试的不变量

消费入账时间由服务端拥有：`POST /api/cards/[id]/consume` 与 `consume_virtual_card` 工具都不接受时间参数。
请求体含 `occurredAt` 键返回 `400 VALIDATION`，工具参数含 `occurredAt` 等客户端时间字段则在调用 SDK 前抛出 `VALIDATION`。
两种拒绝都不移动资金、不写流水与 `CardConsumption`。
入账瞬间固定为 `demoNow()`（UTC+08:00 月窗口），断言只核对渲染金额、余额、流水与消费行。

补办卡继承源卡的结算账户，缺失绑定只按显式前驱修复，绝不回退默认账户。
补办卡与源卡共享同一连续月度额度（`banking-sdk/card-family.ts` 双向遍历 `replacedByCardId`），历史 `CardConsumption` 保持原卡归属不改写。

卡片集合按 id/type/状态断言，不只数总数：`lF`/`lG` 的补办后预期按「基线 + 1」推导（`e2e/card-replace-chain.e2e-helper.ts:749`、`:1115`），`lA` 在类型/状态之外仍固定断言补办后共 4 张（`e2e/live-acceptance.e2e.ts:1323-1325`）。
mock 夹具播种 `card_credit` 与 `card_debit`，其中 `card_debit` 绑定 `acct_checking`（`linkedAccountId: 'acct_checking'`），演示种子（`prisma/seed.ts`）另有绑定同一账户的 `card_virtual`。
`lA` 补办后为「补办 ACTIVE 信用卡 + LOST 源卡 + DEBIT + VIRTUAL」；`lC` 与 `lF` 的验证前基线要求卡片总数不变（`e2e/live-acceptance.e2e.ts:1477`、`e2e/card-replace-chain.e2e-helper.ts:531`）。

`tests/helpers/db.ts#truncateAll()` 清空 `prisma/schema.prisma` 的每一个 model（含无关系的 `CardConsumption`）。
套件不得在 `useFreshDatabase()`/`resetDatabase()` 之后再自行逐表清理。
新增 model 必须同时补进 `truncateAll`，否则 `helpers/db-truncate.test.ts` 失败。

## 面板声称的覆盖

确认/MFA 面板只在安全网关从真实工具调用持久化 `PendingAction` 后出现；模型散文不创建面板。
`unit/agent`（`write-continuation*.test.ts`、`system-prompt.test.ts`）与 `integration/write-continuation.test.ts` 覆盖「声明写操作却只用散文声称面板/等待确认、未发出工具调用」的场景：服务端做一次有界续接，仍无写入时以服务端叙述发布真实未提交状态，伪造声称绝不进入会话记录。
同一覆盖断言「参数齐全→续接后真实发起（打开真实网关闸门）或被网关拦截」以及「信息不足→正常澄清，不消耗续接预算」。
`e2e/panel-claim.e2e-helper.ts#findConfirmationPanelClaim` 纯文本判定助手散文是否声称确认/MFA 面板已存在，`unit/panel-claim.test.ts` 覆盖其正/负例；否定表述与普通追问不误判。
`e2e/live-acceptance.e2e.ts#driveRedTool` 与相关场景经 `helpers.ts#assertNoFabricatedConfirmationPanel` 在「散文声称面板 + `/api/actions` 无待处理项 + DOM 无卡片」时显式判定失败，错误区分 cause=模型未发起受控工具与 cause=UI/测试原因。
`unit/planner/mock-amount-clarification.test.ts` 与 `app/nl-entry-http.test.ts` 覆盖「信息不足→澄清，不产生工具调用」，但澄清为结构化 `missing_details` 或纯文本追问，非“面板”声称。
细节见各子目录 CONTEXT.md。

## 投资净值与份额口径的覆盖

`unit/banking-sdk/net-value-redemption.test.ts` 覆盖份额折算、按份额／金额／全额赎回的结算与成本守恒。
`unit/security/redemption-stale-authorization.test.ts` 覆盖确认快照不一致时的 `CONFLICT`：本次零写入、`PendingAction` 为 `failed`，同身份重放返回原回执与原净值。
`unit/banking-sdk/atomicity.test.ts:116-140` 覆盖同一持仓的并发赎回：两个 `Promise.allSettled` 的 `mode:'ALL'` 赎回恰一个成功、另一个抛 `CONFLICT`，账户只入账一次（不是排队，也不是部分成交）。
单进程内两次事务由 `lib/db/serialized-connection.ts` 的单连接 FIFO 串行化，失败方随后在「已平仓」或旧 `shares` 的条件写处被拒；该用例只覆盖进程内竞态，不覆盖跨进程写者。
`integration/node-recovery.test.ts` 覆盖同一 `idempotencyKey` 的并发重放返回同一结果、不同 key 的重复赎回被拒（后者是串行调用，不构成竞态）。

## 亏损持仓（负收益 / 负收益率）的覆盖

收益率是有符号展示：唯一渲染入口 `components/banking/HoldingFacts.tsx:89-91` 走 `signedRateToPercent(profitRate)`，对话卡 `components/chat/cards/InvestmentsCard.tsx:95` 与 `/investments` 的 `InvestmentProductTile` 复用同一入口。
`profit`/`cumulativeProfit` 走 `DecimalMoney(..., signed)`，`realizedProfit`/`marketValue`/`amount` 不带 `signed`；组件不随盈亏切换颜色 class（统一 `text-banking-deep`）。
比例层分工由 `unit/financial-values.test.ts:64-84` 固定：`signedRateToPercent` 保留符号与全部精度（`'-0.0123'`→`'-1.23'`，`:74`），正值与 `rateRatioToPercent` 结果全等（`:76`），而比率非负门禁 `nonNegativeDecimal`/`rateRatioToPercent('-0.032575')` 抛 `{code:'VALIDATION'}`（`:79`/`:83`）。
因此 `profitRate` 绝不可走 `rateRatioToPercent`：那会让亏损持仓在渲染期抛错、卸载整棵客户端树。

| 文件:行 | 断言 |
| --- | --- |
| `unit/planner/decimal-format.test.ts:44-96` | 唯一直接渲染 `HoldingFacts` 的用例：亏损持仓（4199.864825 份 × 净值 0.9407 → 市值 3950.80，`profit`/`cumulativeProfit` 均 `'-49.20'`）；`profitRate: '-0.0123'` 不抛错且渲染 `-1.23%`（`:77-78`），全精度 `-2.9726666666666667%`（`:87`），`tile` 布局同为负（`:88`），`-¥49.20`（`:90`），缺 `profitRate` 时不出 `%`（`:93-94`），正/零收益率仍为 `3.2575%`/`0%`（`:81-84`） |
| `unit/planner/decimal-format.test.ts:37-41` | `DecimalMoney({signed:true})` 只在严格为正时前置 `+`：`'+¥118.91'` vs `'-¥118.91'` |
| `unit/planner/financial-display.test.ts:48-53` | 极小负收益 `-0.0000000001` 经 `DecimalMoney(signed)` 渲染 `'-¥0.00'`：符号不被舍入吃掉 |
| `unit/financial-values.test.ts:96-97` | `formatDecimalCNY('-0.000001')` 为 `'-¥0.00'` |
| `unit/banking-sdk/net-value.test.ts:153-161` | `profitRateOf` 产出带符号比率（`'-23.45'/1000.00`→`'-0.02345'`，`'-1.00'/3.00`→`'-0.333333333333333333'`），零成本返回 `undefined` |
| `unit/banking-sdk/net-value-redemption.test.ts:366-403` | 净值下跌仓位的负值口径：`profit` `'-0.000000928'`/`'-192.3076932'`、`realizedProfit` `'-192.31'`、`realizedProfitMinor` `-19_231n`（只断 SDK 数值） |
| `unit/banking-sdk/net-value.test.ts:164-191`、`unit/banking-sdk/investment.test.ts:110-112`/`:124-129` | 负净值/负份额/负金额/负成本的 `VALIDATION` 拒绝 |
| `e2e/live-investment.e2e-helper.ts:695-706` | B0 聊天卡：持仓收益与 `signedDecimalCNY(市值 − 剩余持仓成本)` 全等（`signedDecimalCNY` 见 `:229-231`，只对正值加 `+`），`持仓收益率` 匹配 `/^[+-]?\d+(\.\d+)?%$/`（失败文案写明「负收益率必须正常显示」），并断言本步零 pageerror |
| `e2e/live-investment.e2e-helper.ts:441-473` | `/investments` 页逐行全等：金额 `/^[+-]?¥[\d,]+\.\d{2}$/` 允许负号且拒绝未结算高精度，持仓收益/累计收益按带符号 CNY 全等，已实现收益按不带符号 `formatDecimalCNY` 全等，并按「市值 − 持有金额」「已实现 + 持仓」双向自洽 |

已覆盖的层级：符号换算（`lib/decimal`）、SDK 数值（`banking-sdk/net-value.ts`）、组件两种布局（`HoldingFacts` 的 `card`/`tile`）、工具摘要（`agent/tools/redeem-investment.test.ts:375-399`：mock `listHoldings` 返回 `profit: '-60'`/`profitRate: '-0.012'`/`cumulativeProfit: '-60'`，断言 `持仓收益 -¥60.00`、`持仓收益率 -1.20%`、`累计收益 -¥60.00`）。

已知缺口：

- 夹具无亏损持仓：`helpers/fixtures.ts:427-431` 只有 `holding_wenjiana`（5050.000000 份 × 1.0000 = 5050.00，成本 5000.00，+50）；亏损持仓只在演示种子 `prisma/seed.ts:377-381` 的 `holding_wenjib`（10000.000000 份 × 0.9880 = 9880.00，成本 10000.00 → −¥120.00，收益率 −1.2%）。
- 真实浏览器的亏损渲染只由演示种子的 `/investments` 顺带产生，没有任何断言读取它：`assertInvestmentsPage` 的行清单不含「持仓收益率」（`e2e/live-investment.e2e-helper.ts:424-433`），且 `lB` 步骤持仓是盈利的 `holding_wenjiana`，带符号正则同样接受正值。
- `holdingProfitRate` 文案（`business.investments.holdingProfitRate`）只有 e2e 断言（`e2e/live-investment.e2e-helper.ts:90-91`、`:681`、`:699-700`），unit 层只断言百分比文本。
- 微信通道是另一套渲染（`channels/weixin/presentation.ts` 的 `percentText`，`multiplyDecimal` 后 HALF_UP 到 2 位），`unit/weixin-presentation.test.ts:25`/`:87-104`/`:111` 只有非负或缺失收益率，无亏损用例。
- 没有负 `HoldingView.cumulativeProfit`/`realizedProfit` 断言：负已实现收益只落在 `InvestResult` 层（`unit/banking-sdk/net-value-redemption.test.ts:394`/`:400`）。
- `tests/` 内 `get_investment_holdings` 只有 4 处引用（`e2e/live-investment.e2e-helper.ts:633` 注释、`e2e/weixin-capabilities.e2e-helper.ts:44` 工具名矩阵、`unit/agent/providers/mock-turn-declaration.test.ts:155` 声明矩阵、`unit/security/permission-engine.test.ts:27` 只读白名单），没有一条经真实工具路径断言负百分比。
- 没有组件级用例把负 `annualYieldRate` 喂给 `InvestmentProductTile`/`InvestmentsCard`；`rateRatioToPercent` 的负值行为只在 `unit/financial-values.test.ts:83` 以抛错覆盖，负净值/负 `marketValue` 的仓储拒绝在 `unit/banking-sdk/investment-precision.test.ts:257-274`（`rejects.toBeDefined()`，不校验错误码）。
- `amount` 为 0 时 `profitRate` 缺省只有函数级覆盖（`unit/banking-sdk/net-value.test.ts:160-161`）。
- `InvestmentsCard` 的渲染覆盖只有 4 个文件（`unit/planner/investment-purchase-display.test.ts`（`HOLDING` 夹具 `:43`、`describe('InvestmentsCard')` `:119`）、`unit/planner/financial-display.test.ts:25-46`、`unit/planner/chat-read-results.test.ts:55-86`、`integration/frontend-review-fixes.test.ts:75-85`），其夹具或为旧口径（无 `valueBasis`/`shares`/`latestNetValue`/`profitRate`，只出市值与收益两行）或 `profit` 为正，覆盖不到收益率行与汇总行负值。
- `tests/` 内没有 `app/api` 直出 holdings 卡的测试；`agent/card-emitter.ts` 的 holdings 投影只经 `unit/agent/providers/mock-turn-declaration.test.ts:152-159` 间接覆盖。
- `integration/`、`app/`、`scenarios/` 完全没有 `profit`/`profitRate`/`cumulativeProfit`/`realizedProfit` 断言，负值口径只落在 `unit/`。

## 卡片生命周期能力契约的覆盖

能力事实以 `lib/contracts/tool-catalog.ts` 与 `lib/contracts/card-management.ts` 为准：
`replace_card` 与 `apply_virtual_card` 是模型可调用的 RED 写工具，只有 `manual_add_card`/`manual_delete_card` 为人工专属。
这些用例只断言服务端事实与持久化行，不使用凭据、不调真实模型、不联网。

| 文件 | 覆盖 |
| --- | --- |
| `unit/card-tool-catalog.test.ts` | 目录真值：`replace_card` 存在、类型中立、RED/requiresReceipt/maxAttempts 3；模型目录内没有任何新建/删除实体卡工具 |
| `unit/agent/card-capability-guidance.test.ts` + `unit/agent/capability-guidance-markers.ts` | 遍历 `agent/messages/*.json` 全部语言目录，按句断言卡片管理指引不得否认 `apply_virtual_card`/`replace_card`，人工规则限定在新建/删除实体卡；`overbroadManualOnlyCardProhibitions` 的必判违规例（`Issuing or deleting physical debit and credit cards remains manual-only … cannot be included in an Agent workflow.` 及其 `Offer replace_card …` 后续句）与合规例 |
| `unit/agent/system-prompt.test.ts`（`system prompt card capability scope`） | 系统提示词的 `manual-only` 语句不得套用到已挂失卡的补办，实体卡人工规则限于新建 |
| `integration/card-replace-capability-contract.test.ts` | 真实网关路径下三种卡类型的 RED + MFA 可达性、验证前无副作用、验证后仅一张新卡与类型继承；非 `LOST` 源卡的 CONFLICT 且不改状态；重复请求落到同一张补办卡并可重放 |
| `integration/card-manual-only-management.test.ts` | `manual_add_card`/`manual_delete_card` 在代理路径上仍被拒绝：`executeGatedTool` 的拒绝结果由精确 `toEqual` 固定为 `{ok:false,errorCode,error,failure:{code:'SECURITY_DENIED'}}`，用户侧副作用快照不变 |
| `scenarios/test-18-card-capability-consultation.test.ts` | 补办咨询与歧义目标只澄清、不产生动作；指引信封不创建 `PendingAction`；话术不得否认真实能力；生产提示的人工专属规则限于「新建实体卡 + 注销卡片」并声明集合封闭，`replace_card` 覆盖任意类型已挂失卡且从不说成页面专属 |
| `scenarios/test-19-card-replace-credit-runtime.test.ts` | 生产运行时下已挂失信用卡的补办走 RED MFA，验证后仅一张补办卡、源卡仍 `LOST` |

话术断言绑定产品原文：`test-18` 与 `unit/agent/card-capability-guidance.test.ts` 读取目录与提示词的真实渲染结果，
因此改动 `agent/messages/*.json` 的卡片管理条目或 `agent/system-prompt.ts` 的 `manual-only` 语句时必须同时核对这两处。

## 卡片-结算账户绑定的覆盖

`Card.linkedAccountId` 是真实外键（可选关系，未写 `onDelete` → 默认 `SetNull`）。
`CardView` 用 `linkedAccountStatus`（`LINKED`/`MISSING`/`UNTRUSTED`/`NOT_APPLICABLE`）与 `usable`（= `status === 'ACTIVE'`）表达绑定状态。
`accountAvailableBalance` 是**账户**余额，`payableAmount = min(账户余额, 家庭本月剩余限额)`，两者都只在 `LINKED` 出现。
`MISSING`/`UNTRUSTED` 不得带任何余额字段，也绝不以 `0.00` 冒充。
`FROZEN`/`LOST` 保留真实余额而 `usable === false`；`CREDIT` 恒 `NOT_APPLICABLE`。
UNTRUSTED 的可构造来源只有「他人账户」与「非 CHECKING 账户」；「账户不存在」在真外键下不可表示（删除账户走 `SetNull` → `MISSING`）。
`MISSING`/`UNTRUSTED` 只由直接写库构造（`db().card.create/update` 写 `linkedAccountId: null`、造他人或非 CHECKING 账户、删除已绑定账户触发 `SetNull`）；演示种子（`prisma/seed.ts`）与任何 API 路径都不产生这两种状态，因此相关覆盖是合成夹具而非可复现的用户流程。
单账户多卡共享同一份余额，一张卡的消费同步反映到同账户的其它卡，资产汇总额只计该账户一次。

| 文件 | 覆盖 |
| --- | --- |
| `unit/lib/mask.test.ts` | `lib/mask` 为唯一脱敏实现：末 4 位保留且长度不变、幂等、过短原样不抛错、`maskPhone(null) === ''`；`lib/phone.ts#maskPhone` 与 `lib/mask.ts#maskPhone` 是同一函数引用 |
| `unit/banking-sdk/card-linked-account.test.ts` | LINKED 的名称/掩码/账户余额/应付金额、月限额截断、MISSING 与 UNTRUSTED 无余额字段、FK `SetNull` 后读为 MISSING、FROZEN/LOST 真实余额、CREDIT `NOT_APPLICABLE`、创建即绑定与 0 或多个活期账户时的 `VALIDATION`/`SECURITY_DENIED` |
| `integration/card-linked-account-projection.test.ts` | 他人账户的 owner 隔离与消费拒绝、多卡共享同一账户的余额同步与汇总只计一次、转账/消费/投资申购三条路径的卡视图余额与账户余额同口径 |
| `app/card-links-http.test.ts` | `GET /api/cards` 报文层：只出现脱敏账号、他人余额/账号/户名不出现在 JSON、FROZEN/LOST 不序列化成 `0.00`、MISSING 与 CREDIT 无余额字段 |
| `integration/card-dashboard-assets.test.ts` | 绑定借记卡仍不计入可用额度，资产汇总不重复计入 |
| `integration/card-replacement-transaction.test.ts`、`card-replace-capability-contract.test.ts` | 补办继承结算账户；漂移只可能是「存在但不可信」或删除后 `SetNull`；写入无行 id 被外键拒绝 |
| `scenarios/test-13/14/16/19` | 借记卡补办、虚拟卡申请与重放、家族限额、CREDIT 补办的绑定与 `NOT_APPLICABLE` 投影 |

## 号码与卡片身份解析的覆盖

身份判定与候选筛选必须分开断言：身份用例只接受完整号码，候选用例必须同时断言「候选不唯一即不执行」。
解析用例必须断言三件事：参数被规范化为唯一 id、澄清时不写 `PendingAction`、对外文本不含完整号码。
涉及完整号码的用例读取 `Contact.phoneFull` 与 `Card.numberFull`，断言对象只到脱敏值。

| 文件 | 覆盖 |
| --- | --- |
| `unit/lib/phone-identity.test.ts` | 形状判定、`phoneIdentityMatches` 只认相等完整号码（中间四位参与比较）、候选筛选的可见端与片段、只保留脱敏值的历史行、`maskAwarePhoneMatch` 与 `searchPhoneMatch` 不得互换、号码层只回答布尔值 |
| `unit/security/phone-identity.test.ts` | 收款人身份判定对片段、脱敏值与位数错误的拒绝；搜索片段仍可用于候选 |
| `unit/security/recipient-identity.test.ts` | 每个选择器只匹配自己的字段，跨字段别名与片段被拒；多字段必须指向同一联系人；掩码冲突报 `ambiguous` 且候选全部脱敏 |
| `unit/security/recipient-phone-identity.test.ts` | 完整号码精确解析、可见端相同而中间四位不同的号码不解析、只保留脱敏值的历史行不可识别、脱敏值仅作唯一候选、完整号码不降级为候选、他人的 id 与号码不解析且不回显 |
| `unit/security/recipient-resolution.test.ts` | 网关 park：姓名、完整号码与 `contactId` 均规范化为 `contactId` 并生成脱敏摘要；无法解析时返回澄清，不落库 |
| `unit/lib/contact.search.test.ts` | `searchContacts` 用完整号码或脱敏号码收窄候选；掩码冲突返回全部候选；返回行不含完整号码 |
| `unit/scripts/number-backfill.test.ts` | 复制完整值并以 `lib/mask` 规范化展示列、重复执行幂等、脱敏值报 `unrecoverable-masked`、已有完整值的行不被改写、回滚只清空仍持有写入值的行、报告只含脱敏值、CLI 参数严格 |
| `unit/security/card-resolution.test.ts` | `resolveCardTarget` 直连：`cardId`、`cardType`、`cardTail`、`cardNumber` 各自命中，多个选择器必须指向同一张卡，`cardNumber` 只与 `numberFull` 精确相等；没有候选为 `not_found`、多个为 `ambiguous` 且候选只有 `id`/`type`/`numberMasked`；他人的 `cardId`、`cardTail`、`cardNumber` 均为 `not_found` 且不投影候选；尾号或完整卡号写进 `cardId` 为 `invalid`；`canonicalizeCardArgs` 只留 `cardId`，`buildCardClarifyMessage` 不含 12 至 19 位数字 |
| `unit/security/card-selector-gateway.test.ts` | 网关 park 阶段：解析成功时持久化参数只有 `cardId`，确认摘要用脱敏尾号；`ambiguous`、`invalid` 与组合冲突只在 `blockReason` 给出纯文本澄清，`PendingAction` 与 `mfaChallenge` 计数不变 |
| `scenarios/card-selector-consumption.test.ts` | 生产运行链路下 `consume_virtual_card` 分别用 `cardType: "VIRTUAL"` 与 `cardTail: "7788"` 解析到同一张虚拟卡，MFA 后扣减其绑定活期账户并写入 `channel` 为 `CARD` 的流水与 `CardConsumption` 行；完整卡号写进 `cardId` 在 park 前被拒；park 参数、确认摘要与叙述都不含 12 至 19 位数字 |
| `scenarios/test-17-consumption-time-guard.test.ts` | `consume_virtual_card` 的参数键集合含 `cardId`、`cardType`、`cardTail` 与 `cardNumber` |
| `app/contacts-http.test.ts` | `POST /api/contacts` 的完整号码只写入 `Contact.phoneFull`，响应与审计行只有脱敏值；同一完整号码重复提交返回 `409`，脱敏值或带符号号码返回 `400`；他人联系人不可删除 |

卡片选择器语法见 [identity-resolution.md](../docs/cn/identity-resolution.md)。
## 终止锁定（locked）结果的覆盖边界

MFA 次数耗尽与已开熔断都产出终止 `locked` 域结果，本目录按入口分别覆盖：

| 入口 | HTTP | 断言位置 |
| --- | --- | --- |
| 写操作的 `verify`/`confirm` 路由 | 恒 `200` + `data.ok:false` + `status:'locked'` | `app/mfa-terminal-lock-http.test.ts`、`app/actions-http.test.ts`（circuit breaker 块）、`app/mfa-lock-http-contract.test.ts`（逐次 `code`/`failure.code`/`failure.reason`/`attemptsUsed`/`attemptsLeft`/`maxAttempts`，锁定后重试落到 `mfa_session_locked`）、`app/mfa-lock-refresh-unlock-http.test.ts`（锁定后重复 verify/confirm 惰性） |
| 锁定行的 `cancel`/`recover` 路由 | 恒 `200` + `ok:false` + `status:'locked'` + `code:'CIRCUIT_OPEN'` + `failure.reason:'mfa_session_locked'` + `events:[]` | `app/mfa-lock-http-contract.test.ts`（行 `status`/`updatedAt` 不变、无新审计、无流水、无回执） |
| 读模型刷新 | 无写 | `app/mfa-lock-http-contract.test.ts`（`GET /api/security` 的 `lock`/`lockedActions`）、`app/mfa-lock-refresh-unlock-http.test.ts`（`/api/actions`、`/api/security`、`/api/tasks`、`/api/tasks/[id]`、`/api/chat/history` 两次读一致；`pendingActionStatus:'locked'`；`mfa` 与 `confirmation` 卡片均 `status:'locked'`） |
| `/api/security/reset` 解锁闸门 | 错码 `423` + `error.code:'CIRCUIT_OPEN'`；正确码 `200` | `app/security-workflow-http.test.ts`、`integration/confirmation-policy.test.ts`；`lockedActionsReopened:false`、旧行仍 `locked`、重新发起产生新 actionId 见 `app/mfa-lock-refresh-unlock-http.test.ts` |
| 网关/SDK 进程内 | 无 HTTP | `unit/security/gateway.test.ts`、`authorize-hardening.test.ts`、`circuit-breaker-*.test.ts`、`unit/security/mfa-failure-contract.test.ts`、`integration/security-deny-redaction.test.ts`、`unit/agent/turn-security-event.test.ts`、`scenarios/test-10-circuit-breaker.test.ts` |
| 会话/租约恢复入口 | 无 HTTP | `integration/locked-action-recovery.test.ts`（`recoverOwnedRun`、`resumeTask`、`retryTask`、`recoverAction` 均不得把 `locked` 变回 `pending`/`awaiting_mfa`） |
| 渲染/文案层 | 无 HTTP | `unit/planner/locked-card-rendering.test.ts`、`unit/weixin-lock-presentation.test.ts`、`unit/security/unlock-panel-render.test.ts`、`unit/security/unlock-panel-notice.test.ts`（四段 `security.reset.*` 语义 + `data-unlock-reinitiate`）、`unit/security/developer-reset-panel-hook.test.ts`（`data-developer-breaker-reset-panel` 仅开发者模式）、`unit/lib/public-text.test.ts`、`unit/planner/tool-diagnostics.test.ts` |

`GET /api/security` 的 `lock` 是账户级常量 `{ code:'CIRCUIT_OPEN', reason:'circuit_open' }`（`app/api/security/route.ts:72-77`）：只报告熔断原因，且刻意不带 attempts 计数（熔断按账户计，attempts 属该动作自己的 challenge）。per-action 的 `mfa_attempts_exhausted` 只出现在第 3 次错码的写操作响应里；两处分别由 `app/mfa-lock-http-contract.test.ts` 的读模型组与逐次阶梯组固定，不要把它们互相“对齐”。
解锁审计写的是 `SecurityEvent`（`SECURITY_RESET`，`security/circuit-breaker.ts#commitAuditedReset`），不是 `AuditLog`：`app/mfa-lock-refresh-unlock-http.test.ts` 断言 `SECURITY_RESET` 增量恰 1 且 `AuditLog` 增量为 0。
`SecurityEventKind`（`lib/contracts/audit.ts`）没有 `mfa_required` 成员，所以“锁定后不新增 `mfa_required` 事件”是空断言；真正的保证是会话 `SecurityEvent` 总数冻结，见 `app/mfa-lock-http-contract.test.ts`。
锁定事实一律按 `status`、`mfaResult`、`PendingAction` 行、`GET /api/actions` 是否再surface 与 `SecurityEvent` 行断言。
写操作路由（都在 `tests/app`）锁定路径上对 `events` 的断言只有负例（不再出现该 actionId 的 `mfa_required`）；锁定行的 `cancel`/`recover` 断言 `events` 为 `[]`；公开摘要断言在 agent turn 路径，见 `unit/agent/turn-security-event.test.ts:92-98`。
`unit/planner/action-contract.test.ts`、`action-attention-state.test.ts` 用桩造的 `message`（如 `'Verification locked'`）断言客户端把服务端锁定消息透传成 `error` + `action_settled`。
渲染层锁定不再是单点用例：`unit/planner/tool-diagnostics.test.ts` 仍唯一断言 `ConfirmationCard` 出 `cards.terminal.locked` 且无 `<button>`；`unit/planner/locked-card-rendering.test.ts:85-107` 断言 `MfaCard` 的 `data-mfa-locked`、目录锁因句、`href="/security"`、无 `<input>`/`<button>`/`123456`/`继续验证：`，`awaiting_mfa` 保留输入面见 `:109-118`，`ApprovalRecord` 见 `:120-132`，`security_event` 折叠见 `:134-155`；`unit/security/unlock-panel-render.test.ts:67-157` 覆盖 `/security` 解锁面板的钩子与输入形态（`data-unlock-*`、单一验证码输入、无内部诊断），`unit/security/unlock-panel-notice.test.ts:59-156` 覆盖四段 `security.reset.*` 语义与 `data-unlock-reinitiate`（字面量 `REINITIATE` 全等夹住整句），`unit/security/developer-reset-panel-hook.test.ts` 覆盖开发者模式下的 `data-developer-breaker-reset-panel`（非开发者渲染空串）。
`e2e/acceptance.e2e.ts` 的 `j-circuit-breaker-lock` 在真实浏览器连错三码，用未限定 `[role="status"]` 的子串匹配断言 `cards.terminal.locked`，并核 `/security` 的「已熔断」「失败 3 / 3 次」与 `CIRCUIT_BREAKER_TRIPPED` 行；注意 `/security` 的解锁面板在两种状态都渲染常驻 `role="status"` live region（`unit/security/unlock-panel-render.test.ts:117` ↔ `app/security/UnlockPanel.tsx:213`），未限定范围的扫描会连带面板文本。

锁定文案既有子串断言也有全等断言：`scenarios/test-10-circuit-breaker.test.ts` 断言 `thirdAttempt.text` 含「锁定」、`auth.message` 含「熔断」；`integration/money-budget.test.ts` 断言执行栅栏的 `CIRCUIT_OPEN` 结果含「熔断」。
完整锁定句由 `unit/weixin-lock-presentation.test.ts:87-92` 的四段模板定义，并以 `:99`/`:112`/`:123`/`:157` 的 `toBe` 全等断言；单次错码的 `状态：等待验证码` + `继续验证：/验证 …` 见 `:134`，该入口只属 `awaiting_mfa` 见 `:144-152`。
`chat.error.securityLocked` 由 `unit/lib/public-text.test.ts:79-87`（zh-CN/en 双语言）、`unit/planner/locked-card-rendering.test.ts:148-186`、`unit/weixin-lock-presentation.test.ts:112-183`、`unit/agent/turn-security-event.test.ts:98` 断言。
`publicToolError` 由 `unit/planner/tool-feedback.test.ts`（通用失败 `chat.error.toolFailed`）与 `unit/lib/public-text.test.ts:33-60` 覆盖。
`publicToolSummary` 被断言到目录锁定句，见 `unit/agent/turn-security-event.test.ts:92-98` 与 `unit/planner/locked-card-rendering.test.ts:176-180`。
`security_event` 的 `kind:'injection'` 由 `app/chat-http.test.ts`、`app/malicious-input-http.test.ts` 断言；`kind:'locked'` 由 `integration/security-deny-redaction.test.ts:132`、`unit/agent/turn-security-event.test.ts:56-67`（`code`/`reason` 为 typed、`message` 必须 `undefined`）、`unit/weixin-lock-presentation.test.ts:170-210` 断言。
被拦下的工具事件带目录句 `summary`，断言在 `unit/agent/turn-security-event.test.ts:77-98` 与 `unit/planner/locked-card-rendering.test.ts:157-194`。
`helpers/scenario.ts:304-308` 复刻生产的投影：只发 `kind/code/reason/actionId/attemptsLeft/maxAttempts`，从不发 `message`，与 `agent/turns/events.ts` 同形；场景用例继承的可观测面已由 `unit/agent/turn-security-event.test.ts:56-67` 断言。
`components/chat/transport-validation.ts:101` 对 `security_event` 校验 `kind` 为 id 串，可选 typed `code`/`reason`。
出站/渲染文本不含 `__SECURITY_BLOCK__` 有多处负例：`unit/agent/turn-security-event.test.ts:38`、`unit/lib/public-text.test.ts:41`、`unit/planner/locked-card-rendering.test.ts:35`+`:106`、`unit/security/unlock-panel-render.test.ts:125`、`unit/weixin-lock-presentation.test.ts:207-246`、`unit/security/mfa-failure-contract.test.ts:101-102`、`integration/security-deny-redaction.test.ts:48`。
`lib/tool-feedback.ts` 的 `PUBLIC_BUSINESS_ERRORS`/`PUBLIC_ERROR_CODES` 不是导出契约，测试只经 `publicToolError`/`publicToolSummary` 逐条命中，登记表无完整性断言。
内部诊断上屏边界的逐文件行锚点与纯度（12 个文件，含 `unit/agent/turn-security-event.test.ts`、`unit/lib/public-text.test.ts`、`unit/weixin-lock-presentation.test.ts`、`unit/security/unlock-panel-render.test.ts`、`unit/security/unlock-panel-notice.test.ts`、`unit/security/developer-reset-panel-hook.test.ts`）见 [unit/CONTEXT.md](unit/CONTEXT.md)。
`__SECURITY_BLOCK__` 字面量本身只作为反面输入出现在 6 个测试文件（`unit/agent/providers/provider-mock.test.ts:47` 是 mock responder 的 block 前缀）。
已开熔断时模型无法解锁：`resetSession` 需验证码或冷却，见 `unit/security/circuit-breaker-reset.test.ts`。
空 `blockedOutcome`/`conflictOutcome`/`withLiveConfirmation` 无测试直接引用；`executeGatedTool` 由 `helpers/faux-agent.ts`、`integration/refactor-security-runtime.test.ts` 从 `@/agent/confirmation` 引入，`confirmAction` 由 `integration/conversational-turns.test.ts` 引入。

## 微信通道覆盖

通道代码在 `channels/weixin/`（回复模板、`label()` 词表、命令正则、outbox 键以其 CONTEXT.md 为准），本目录只从外部断言，不复刻渲染逻辑。
用例分散在 `unit/`、`integration/`、`e2e/` 三处，没有单独的子目录。

| 文件 | 覆盖 |
| --- | --- |
| `unit/weixin-presentation.test.ts` | `renderEvents`/`renderBusinessCard`/`renderAttention`：17 种 `ChatCard` 的金额与掩码（`it.each` 参数化）且不回显 `NEVER_DISPLAY`/完整手机号、card 与 `message_end.cards` 去重、`action_settled` 后旧 gate 不复活、写操作成功后不再输出旧余额、已取消订阅不提下次扣费、`plan_update` generation 防回退、`processing/recoverable/reconciliation` 不称「尚未执行」、畸形字段兜底「字段不完整」、`blocked` 工具事件只发公开提示（不回显 `chat.error.`/`debugDetail`）、五个计划控制动词与 `/待办`、`/检查到期` 的银行调用参数 |
| `unit/weixin-channel.test.ts` | 非受信/不完整消息丢弃、`message_state` 省略与 uint64 编号、`text_delta` 不外发、同消息重投与重启去重（`requestId` 形如 `weixin:<64 hex>`）、发送失败保留 outbox 且 `client_id` 不变、未展示编号「不是本通道」、先 `/确认` 后 `/验证`（验证码不落 state）、`status:'locked'` 回执含「已锁定」且不伪造「状态：executed」、网络异常「暂时无法确认」、verify 路由与请求体、URL 白名单、`WeixinStore` save/load 与双 worker 互斥 |
| `unit/weixin-lock-presentation.test.ts` | 锁定终态四段回复全文（`toBe`）、熔断/解锁后仍锁、单次错码的 `等待验证码`+`继续验证：/验证 …`+剩余次数、`it.each` 七种 status 只 `awaiting_mfa` 给入口、locked 缺 `code`/`failure` 的兜底、`security_event{kind:'locked'}` 撤销 gate 且不可复活、`injection/audit/note` 静默、四类敌意 payload 不上屏、卡片/状态词兜底与去重 |
| `integration/weixin-protocol.test.ts` | 固定版本 `pi-weixinbot` 线协议：轮询 Bearer+游标+uint64 编号、发送固定收件人/上下文/幂等 `client_id`、`ret:-14` 不视为已发送 |
| `e2e/weixin-live.e2e.ts`、`e2e/weixin-capabilities.e2e-helper.ts` | live 模型 + Chrome + 本地微信协议服务器（非手机实测，每轮新建 `prisma/weixin-live-<UUID>.db`）：陌生人隔离、余额查询回复含真实金额、转账确认前不动账且重复投递不重复扣款、RED 确认→错码 `000000` 不改卡→正码执行、`/取消` 与网页待办一致；`WEIXIN_LIVE_EXTENDED=1` 追加 `runWeixinCapabilities` 的工具矩阵与 `/任务` 控制流 |

### 微信通道的锁定覆盖与剩余缺口

- 锁定终态的四段全文由 `unit/weixin-lock-presentation.test.ts:87-92` 定义并以 `toBe` 全等断言：`状态：已锁定` 行、无 `继续验证：`/`/验证`、不回显服务端 `outcome.message`，见 `:99`/`:112`/`:123`/`:157`；`unit/weixin-channel.test.ts:91-92` 的弱断言仍并存。
- `awaiting_mfa` 的 `状态：等待验证码` + `继续验证：/验证 <id> 六位验证码` + 剩余次数由 `unit/weixin-lock-presentation.test.ts:134` 全等断言，入口只属 `awaiting_mfa` 见 `:144-152`。
- 微信入口无「连错三次验证码→锁定」的端到端用例：三次锁定只在网关层由 `unit/security/mfa-failure-contract.test.ts` 与 `integration/security-deny-redaction.test.ts:184` 覆盖，通道侧把结果桩喂给 `settle` 只断言文案（`unit/weixin-lock-presentation.test.ts:95-98`）。
- 无 `/验证 <id>`（缺码）、`/取消 <id>` 回执、`/恢复操作 <id>` 的 bridge 分派、`命令格式不正确`、非文字/超长消息、`BankingApiError`（`服务端提示（CODE）：…`，含 `CIRCUIT_OPEN` 信封）的用例。
- 出站文本不含 `__SECURITY_BLOCK__` 由 `unit/weixin-lock-presentation.test.ts:200-248` 覆盖；`renderEvents` 对 `kind:'locked'` 渲染 `securityNotice` 并撤销 gate（`channels/weixin/banking-client.ts:135-142`），非 locked 的 kind 才静默。
- 无 `worker.ts` 的游标提交与 `-14` 重扫码、outbox 1600 字切块与 2000 条淘汰的用例。

## 驱动路由与恢复入口

进程内调用 `app/api/*` 路由处理器用 `tests/app/harness.ts`（`invoke:163-180` 构造真实 `NextRequest` 后直接调用导入的处理器），`tests/app` 之外的借用方只有 `integration/request-step-binding.test.ts:10` 与 `integration/task-feature-hardening.test.ts:13`。
`tests/helpers/` 没有租约/时钟/`maxRecoveryAttempts` 辅助：规格内联改写 `agentRun.leaseExpiresAt`、`agentSession.runLeaseExpiresAt`、`agentTask.executionClaimedAt`，取值用哨兵日期 `new Date('2000-01-01T00:00:00Z')`/`new Date(1)` 或真实时钟 `Date.now() - 660000`。
崩溃-重启端到端只有两条真实子进程入口：`helpers/restart-process.ts`（argv `mode scenario runId sessionId`，`recover` 模式调 `recoverOwnedRun`、`worker` 模式调 `tickAgentRecovery`）与 `helpers/standalone-restart-process.ts`（argv `mode scenario`，`start` 走 `createTaskGraph`+`resumeTask`，其余走 `tickAgentRecovery()`）。
`tests/helpers/locked-action.ts` 提供停泊动作与 MFA 阶梯（`parkRedTransferPlan`/`parkConfirmOnlyTransfer`/`submitMfaCode`/`exhaustMfaAttempts`/`lockAction`）与只读探针（`pendingActionRow`/`mfaChallengesFor`/`checkingBalance`/`zhangweiTransfers`/`auditLogCount`/`securityEventsOfKind`/`transactionsCount`），被 `app/mfa-lock-http-contract.test.ts`、`app/mfa-lock-refresh-unlock-http.test.ts`、`integration/locked-action-recovery.test.ts` 共用。
它从不 reset 也不 seed 数据库：熔断按所有者持久化，规格仍须自持 `beforeEach(resetDatabase)`。
阶梯一律走 `securityGateway#authorizeAction`；**绝不**直接调 `security/mfa.ts#verify`——它只锁 challenge，不落 `PendingAction` 终态，正是这些规格要防的弹窗复活路径。
逐文件的恢复/租约驱动方式见 [integration/CONTEXT.md](integration/CONTEXT.md)、[app/CONTEXT.md](app/CONTEXT.md)、[unit/CONTEXT.md](unit/CONTEXT.md)。

## 时间预算与环境放大

显式超时预算的唯一来源是 `tests/helpers/timeouts.ts`：`CHAT_DRIVEN_TEST_TIMEOUT_MS = 60_000` 用于 body 驱动真实 `POST /api/chat` 的 mock 模型 turn，`COLD_DB_PROVISION_TEST_TIMEOUT_MS = 120_000` 用于体内 `spawnSync` 真实 CLI（`scripts/db-push.ts` 冷库自建、`prisma/seed.ts`）的用例。
两者都以 `it(...)` 的第三个参数套用；其余用例沿用根 `vitest.config.ts` 的 `testTimeout: 20000`，该文件 root-owned，`tests/` 侧不能修改。
两条路径都没有内部 deadline，因此 `testTimeout` 是唯一边界：chat turn 的墙钟由串行语句条数决定（与断言条数无关），冷库自建由 `tsx` 启动与 Prisma schema-engine 的磁盘/CPU 延迟决定。
已套用：`tests/app/security-workflow-http.test.ts` 的 it 1–3、9–12（清单见 [app/CONTEXT.md](app/CONTEXT.md)），`tests/deploy-db-push.test.ts` 的两个 spawn 用例（不 spawn 的 `refuses to reset …` 沿用全局预算）。
新写这两类用例必须套用同一常量，不得写裸数字字面量，也不得在 spec 内另起局部常量。

通用判据：经 HTTP 入口的用例墙钟 ≈ 串行语句条数 × 单语句延迟。
一次 chat turn 实测约 1.4s、落库约 101 行 `agentRunEvent`；每个 Pi 事件各开一个交互式事务（`agent/durable/journal.ts:120-123` → `lib/db/repositories/agentRun.ts:118-122`），全部串行排在同一条 native SQLite 连接上（`lib/db/serialized-connection.ts`）。
mock 路径没有内部 deadline：`agent/durable/journal.ts:223-228` 的 20 000ms 心跳已 `.unref()`，live 专属的 `AbortSignal.timeout` 不生效，因此 `testTimeout` 是这类用例的唯一边界。

同一用例（`security-workflow-http.test.ts` it 2）实测：单独 1919ms、完整 `pnpm test` 1622ms、`tests/app`+`tests/integration` 111 文件批次 2639ms，都在 20 000ms 内。
宿主争用下同一文件单跑可达 7081/6710/2397ms（约 3.7–4.4 倍），并出现过 `Test timed out in 20000ms`（实际 24316ms），而当时整套只慢 1.29×。
因此这类超时首先是环境放大信号：不得据此断言业务缺陷，也不得为此放宽或删除断言。

`tests/deploy-db-push.test.ts` 干净机器实测：recreate+seed 27309ms（首次，冷 Prisma 引擎）/18442ms、缺失库自建 17145ms/16954ms（最慢一次分别为全局预算的 137% 与 86%），纯校验用例 1ms；`COLD_DB_PROVISION_TEST_TIMEOUT_MS = 120_000` 相对最慢一次留约 4 倍余量。

已排除的成因（不必重新调查）：无第二个进程写同一 `prisma/test.db`、无锁竞争与 >1s 的可复现停顿、DB 与 WAL 规模正常、`tests/setup.ts` 的 schema 哈希标记匹配因而跑批中途不重建库、子进程只有四处 spawn 点且都在各自用例内 `await` + `kill`（`deploy-db-push` 用自己的库）。
事件持久化当前是每事件一事务，把 ~101 次串行事务压到个位数才能从根上消除 I/O 争用放大；这属于产品代码，测试侧只能抬高预算下限。

## 串行化与时间预算（stall 归因）

全进程只有一条 native SQLite 连接（`lib/db/client.ts:25-27`），所有语句与交互事务经 `lib/db/serialized-connection.ts` 的 FIFO `ConnectionMutex`（`:9-21`）排队；`startTransaction`（`:35-56`）在 `commit`/`rollback`/抛错时才释放（`:49-50`、`:52-55`），因此**一个被 `await` 的 `$transaction` 会在其整个生命周期内独占该锁**。`acquire()` 的 `await previous` 没有超时也没有取消：若存在未 await 的事务（fire-and-forget），后续每条语句都会无声挂死。`lib/` 当前没有任何 fire-and-forget 事务；`tests/integration/database-adapter-isolation.test.ts:67-111` 固定了 `maxWait`/`timeout` 到期后锁确实被释放（`P2028` 在 `maxWait` 阶段就产生，`callbackEntered === false`）。

`$transaction` 一律继承 `lib/db/database.ts:25` 的 `{ maxWait: 10000, timeout: 10000 }`（例外：`agent/command-execution.ts:103`、`agent/scheduled-dispatcher.ts:86` 用 `timeout: 20000`）。测试进程内的挂钟成本 = 语句数 × 单语句延迟，没有内部截止时间：mock 模型（`agent/providers/provider-mock.ts:33` 无 `tokensPerSecond`）不产生任何 timer，`agent/durable/journal.ts:223-228` 的 20 000 ms 心跳在 20 s 内 0 次触发，`withLiveRequestLimits` 只在 live 模式生效。一次 chat turn 里每个 Pi 事件与每个流事件各开一个 `$transaction`（`lib/db/repositories/agentRun.ts:118`、`:140`、`:162`、`:181`、`:191`、`:313`、`:322`、`:341`、`:355`），故 `tests/app` 的「2 次 chat + 2 次 confirm + 1 次 verify」是数千条串行语句；单语句延迟放大 10 倍即从约 2 s 涨到超过 20 s 的 `testTimeout`。mock 模式没有请求级 deadline，所以超时是唯一边界。

PRAGMA 分层：`lib/db/database.ts:12` 每次 `connect()` 只设 `foreign_keys`/`journal_mode=WAL`；`synchronous=NORMAL` 与 `busy_timeout=10000` 是**连接级**且**只**由 `tests/helpers/db.ts:65-78#ensureTestPragmas()` 经 `truncateAll()`（`:98`）施加，即每个进程的第一次 `resetDatabase()` 才生效。因此任何不调 `truncateAll` 而同用 `prisma/test.db` 的执行者（`tests/helpers/restart-process.ts`、`tests/helpers/standalone-restart-process.ts` 的 fork 子进程，`tests/deploy-db-push.test.ts` 的自建文件）跑在默认 `synchronous=FULL`、无 `busy_timeout` 上；`journal_mode=WAL` 写在文件里会被继承，`synchronous`/`busy_timeout` 不会。

`tests/setup.ts:123` 在**每个测试文件进程**执行 `ensurePrismaClientGenerated`（`tests/helpers/prisma-cli.ts:233-239`），其 `prismaClientUsable`（`:215-224`）会 `spawnSync(process.execPath, ['--import','tsx','-e', …])`——一次约 1-2 s 的阻塞子进程，位于 `setupFiles`，不计入 `testTimeout`。`tests/deploy-db-push.test.ts:59-75` 另有两个 `spawnSync`（`db-push.ts`、`seed.ts`）。

子进程清单（排除 `tests/e2e/**`）只有四处 `node:child_process`：`tests/integration/process-restart.test.ts:24-28`（`fork` `restart-process.ts`）、`tests/integration/standalone-workflow-restart.test.ts:22-26`（`fork` `standalone-restart-process.ts`）、`tests/deploy-db-push.test.ts:59-75`（`spawnSync`）、`tests/helpers/prisma-cli.ts:112-120,218-222,409-414`（`spawnSync`）。两个 `fork` 消费者都 `await` 子进程 `exit` 并在 `afterEach` 对其 `SIGKILL`（`process-restart.test.ts:64-70,82-94`、`standalone-workflow-restart.test.ts:60-65`），等待上限各 15 000 ms；`tests/helpers/restart-process.ts` 自身不 spawn，只用 `setInterval`（`:26`）+ `new Promise(() => undefined)`（`:29`）把自己的 `start` 场景永久停住。没有任何子进程能越过其所在文件的最后一个测试继续写 `prisma/test.db`。

## wedge 故障注入的接缝

「副作用已提交、结果+状态落定事务回滚」的 wedge 只能注入生产确认路径实际调用的符号。
生产落定走 `agent/confirmation-recovery.ts#settlePendingAction`（由 `agent/confirmation/authorized-execution.ts:62-73` 调用），事务内顺序为 `claimPendingAction` 的 CAS → `tx.pendingAction.update({ resultJson })`（无 repository 包装，不可 spy）→ strict 执行审计（`audit/audit-logger.ts:102` 的 `auditStore.insertAuditLog`）。
`claimPendingAction` 是多点调用（授权 CAS、`locked`、`cancelled`、`recordActionResult` 都走它）：注入必须按 `actionId` + `from` 含 `'confirmed'` + `to` 非 `confirmed` + 一次性 flag 过滤，否则打偏到授权阶段，wedge 变假。
`lib/db/repositories/pendingAction.ts:181-194` 仍导出 `updatePendingActionStatus` 与其别名 `setPendingActionStatus`，但没有任何生产模块调用它们：`vi.spyOn` 到这两个符号永不命中，期望的 `500` 与 `confirmed` + `resultJson:null` 都不会出现。
因此规则固定为：注入点必须选在真实写入漏斗上（`claimPendingAction`、`auditStore.insertAuditLog`、`settlePendingAction`）。
`security/security-gateway.ts:1268` 的 `recordActionResult` 在落定之后调用，只用于观察时序窗口，不能制造 wedge。
逐文件注入点与 `fired()` 自检见 [integration/CONTEXT.md](integration/CONTEXT.md)。

## 与当前生产契约不一致的既有断言（已知缺口）

- `app/actions-recovery-http.test.ts:301-302` 断言 wedge 恢复后 `plan.status`/`node.status` 为 `success`，实测当前为 `failed`（同用例 `:292` 的 `ok:true` 通过）。期望值权威：`recoverAction`（`agent/index.ts:209-227`）先把计划关联行结清为 `executed`，再 `resumeTask`；`resumeTask`（`agent/workflows/controls.ts:82-89`）经 `sealedParkedNodes` + `sealSettledNodes` 把已结清动作的停靠节点写为 `failed`（`agent/workflows/parked-actions.ts:80-94`、`planner/failure.ts:111-116` 的 `action_not_open`、`planner/executor.ts:481`/`:665`），计划随之为 `failed`；`agent/index.ts:234-235` 仍把「计划 failed + 动作 executed」判为成功。不得把断言改成 `failed`，也不得把「计划 failed」固化成生产契约。

## 组件渲染测试（React SSR，无 DOM 环境）

仓库没有 DOM 环境的组件测试：`@testing-library/react`、`jsdom`、`happy-dom`、`react-test-renderer` 都不在 `package.json`／`node_modules` 里，根 `vitest.config.ts:12` 固定 `environment: 'node'`。
组件回归一律用 `react-dom/server#renderToStaticMarkup` 渲染真实组件成静态 markup，再对字符串 `toContain`/`not.toContain`；`oxc.jsx.runtime: 'automatic'`（`vitest.config.ts:5`）只负责 JSX 转换。
`include` 只收 `tests|agent|security|planner` 下的 `*.{test,spec}.ts`，不收 `.tsx`，所以渲染用例写在 `.ts` 里并用 `createElement(...)` 构造元素。
`@` 别名在测试里可用（`tsconfig.json:21-25` 与 `vitest.config.ts:6-10` 两处都指向仓库根）；`'use client'` 模块可直接导入渲染，指令只是字符串字面量。
`useEffect` 不执行，故依赖 `document`/`cookie` 的副作用不会触发（`LocaleProvider` 的 `document.documentElement.lang` 即属此类）。
i18n 不需要 Provider：`lib/i18n/LocaleProvider.tsx:15` 的默认上下文是 zh-CN；需要显式语言或开发者开关时用 `createElement(LocaleProvider, { initialLocale: 'zh-CN', children })` 包裹（`developer-reset-panel-hook.test.ts:30-40`）。
引用 `next/navigation` 的组件必须 `vi.mock('next/navigation', ...)`（`business-result-cards.test.ts:13`、`unlock-panel-render.test.ts`、`unlock-panel-notice.test.ts`）。
`tests/helpers/` 没有任何 i18n 或渲染辅助，模板是各用例自写的 `render()` 薄封装。

现有渲染用例分布（`react-dom/server` 命中 26 个文件）：

| 文件 | 渲染对象 |
| --- | --- |
| `unit/planner/decimal-format.test.ts` | `components/ui/DecimalMoney` 与 `components/banking/HoldingFacts`（唯一一处，含 `card`/`tile` 两种 layout） |
| `unit/planner/investment-purchase-display.test.ts` | `components/banking/InvestmentProductTile`、`components/chat/cards/InvestmentsCard` |
| `unit/planner/business-result-cards.test.ts`、`chat-presentation.test.ts`、`locked-card-rendering.test.ts`、`tool-diagnostics.test.ts`、`tool-feedback.test.ts`、`approval-record.test.ts`、`transcript-activity.test.ts`、`chart-presentation.test.ts`、`financial-display.test.ts`、`composer-readiness.test.ts`、`chat-read-results.test.ts`、`chat-plan-controls.test.ts`、`chat-history-ui.test.ts`、`manual-review-presentation.test.ts`、`tool-event-lifecycle.test.ts` | 聊天卡、审批/MFA 卡、工具时间线、图表 |
| `unit/security/unlock-panel-render.test.ts`、`unlock-panel-notice.test.ts` | `app/security/UnlockPanel` |
| `unit/security/developer-reset-panel-hook.test.ts` | `app/security/ResetBreakerButton`（`DeveloperModeProvider` + `LocaleProvider`） |
| `unit/lib/activity-presentation.test.ts` | 活动投影展示 |
| `integration/frontend-followup-fixes.test.ts`、`frontend-review-fixes.test.ts`、`decision-guidance.test.ts`、`live-retry-ui.test.ts` | 聊天结果卡与前端修复的渲染形态 |

缺口：`components/banking/CardTile`、`AssetSummaryCard`、`RecentTransactions`、`SubscriptionTile`、`components/banking/card-account-display.ts`、`components/chat/cards/CardsCard.tsx` 都没有任何渲染用例。
`CardTile` 的事实只在浏览器侧断言（`e2e/card-labels.e2e-helper.ts#CARD_LABEL`、`readCardTileRows`、`card-replace-chain.e2e-helper.ts`）。
`CardTile` 不 import `next/navigation`、只用 `useI18n` 默认上下文，因此新增渲染用例只需 `createElement` + `renderToStaticMarkup`。

单文件/单目录执行已文档化：`docs/cn/test-cases.md:23-34` 的常用命令给出 `pnpm test tests/unit` 与 `pnpm test agent/durable tests/integration/process-restart.test.ts`（`pnpm test` = `vitest run`），等价的显式形式是 `pnpm exec vitest run <path>`。

## 货币文案的断言锚点

`formatCNY`（`lib/money.ts`）与 `formatDecimalCNY`（`lib/decimal.ts`）的权威全等字面量只在
`unit/financial-values.test.ts`：`'¥90,071,992,547,409.93'`（`:37`）、`'-¥0.20'`（`:38`）、
`'¥184,467,440,737,095,516.14'`（`:19`）、`'¥90,071,992,547,409.93'` / `'-¥0.00'`（`:73`/`:74`）。
经真实 `DecimalMoney` 组件渲染的形态断言在 `unit/planner/decimal-format.test.ts`
（`'¥0.00'`、`'¥1.01'`、`'¥2.68'`、`'¥10.00'`、`'¥1,234,567,890,123.46'`、`'+¥118.91'`、`'-¥118.91'`）。

`+` 前缀不属于格式化器输出：`components/ui/Money.tsx:19` 与 `components/ui/DecimalMoney.tsx:19` 只在 `signed` 且严格为正时前置。
两个组件把整段金额渲染进同一个 `<span>`，因此浏览器侧 `getByText('¥…', { exact: true })` 可直接命中。

硬编码的渲染字面量仅在这些位置：`integration/frontend-followup-fixes.test.ts:91`（`'¥5,050.00'`）、`:116`（`'¥5,050.51'`，5050×1.0001 HALF_UP）、
`integration/frontend-review-fixes.test.ts:90`（`'¥5,000.25'`，桩输入而非格式化结果）、`integration/task-feature-hardening.test.ts:122`（`'¥1,200.12'`，标签是英文 `Amount`）、
`e2e/acceptance.e2e.ts:622`（`'-¥6,999.00'`）、`e2e/live-acceptance.e2e.ts:1273`（`'¥18,000.00'`）、`e2e/weixin-capabilities.e2e-helper.ts:126`（`'¥87.66'`）、`fixtures/mfa-escalation.zh-CN.json:11`（`'¥500.50'`）。
其余货币断言都由 `formatCNY(centsToMoney(minor))` / `formatDecimalCNY(...)` 现算，没有可抄的字面量。

`tests/app/` 与 `tests/helpers/` 完全没有 `formatCNY`/`formatDecimalCNY`：金额按十进制文本（`'2000.50'`）或 `bigint` 分（`2358000n`）断言，`¥` 只出现在注释、`it()` 标题与 `expect(实际, '提示')` 的失败信息里。
`unit/planner/chart-presentation.test.ts:25-31` 提供另一种形态：`['-¥0.07', '-¥0.04', '¥0.00']` 的坐标轴标签。
缺口：`formatCNY` 的零值与 bigint 分入参没有全等字面量；`-¥0.00` 只有 `formatDecimalCNY`（`unit/financial-values.test.ts:74`）与 `DecimalMoney signed`（`unit/planner/financial-display.test.ts:52`）两处。
微信通道的金额文案模板见 `unit/weixin-presentation.test.ts`（`'持仓市值 ¥5,178.36'` 等）。

## 常用命令

`pnpm test` 运行全部 Vitest 测试。
`pnpm exec vitest run tests/unit` 运行指定目录。
`pnpm typecheck` 检查类型。
它**必须**在 `pnpm db:generate` 之后运行：陈旧 Prisma Client 会让 `tests/` 报出伪造的 TS2305（`has no exported member 'PendingAction'` / `'Prisma'`），并非真实类型错误。

合并后回归集（不含 live e2e、不含全量）：
`pnpm exec vitest run tests/unit/security tests/unit/agent tests/unit/planner tests/unit/lib tests/unit/weixin-lock-presentation.test.ts tests/integration tests/app/mfa-lock-http-contract.test.ts tests/app/mfa-lock-refresh-unlock-http.test.ts tests/app/mfa-terminal-lock-http.test.ts tests/app/security-workflow-http.test.ts tests/app/actions-http.test.ts`
该集合耗时约 16 分钟，需单独占用测试库。
合并后分两批串行的完整回归入口（覆盖 `tests/**` 全目录，且不碰 `tests/e2e`）：
批 A `pnpm exec vitest run tests/app tests/unit`；批 B `pnpm exec vitest run tests/integration tests/scenarios`。
两批各自独占测试库，批间不重叠；`vitest` 的 `fileParallelism:false` 不足以免除「不并行起两个 vitest 进程」。
节点本地三文件：`pnpm exec vitest run security/mfa-lock-reason-authority.test.ts planner/plan-failure-contract.test.ts planner/plan-drive-guard.test.ts`（根 `vitest.config.ts` 已收集 `security/**`、`planner/**`）。
当前预期失败只有上文「已知缺口」一条：`app/actions-recovery-http.test.ts:301-302`，其余全绿。
失败项归因写在「已知缺口」各条内；注入接缝与再驱动入口规则见上文 wedge 小节与 [integration/CONTEXT.md](integration/CONTEXT.md)。
`pnpm exec tsx tests/e2e/acceptance.e2e.ts` 运行浏览器验收。

## 证据范围

原始 Pi 场景与生产运行入口必须区分。
测试模型输出不证明真实模型的稳定性。
路由处理器测试不证明浏览器渲染或点击行为。
业务断言必须核对余额、流水、状态与审计。
展示断言必须区分模型原文与服务端金融结果。

不得将历史通过数量写成当前验证结果。
不得删除断言或跳过失败来宣称通过。

完整测试方法见
[test-cases.md](../docs/cn/test-cases.md)。
