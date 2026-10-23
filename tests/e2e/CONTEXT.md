# 真实浏览器验收

## 入口与隔离

| 入口 | 模型与数据库 |
| --- | --- |
| `acceptance.e2e.ts` | mock 模型，`prisma/e2e.db` |
| `live-acceptance.e2e.ts` | live 模型，`prisma/live-acceptance.db` |
| `date-tamper-boundary.e2e.ts` | 无模型无浏览器，纯 HTTP，`prisma/live-acceptance-date-tamper.db` |
| `weixin-live.e2e.ts` | live 模型、Chrome、本地微信协议服务器，每轮新建 `prisma/weixin-live-<UUID>.db` |

`WEIXIN_LIVE_EXTENDED=1` 扩展微信业务矩阵。
场景位于 `weixin-capabilities.e2e-helper.ts`，覆盖查询、理财、卡片、订阅、工作流控制、取消后的对话状态和完整归档搜索。
测试只在隔离库中把新建的提醒设置为到期，不修改实际微信演示库。

除日期边界入口外，其余入口通过 playwright-core 驱动真实浏览器。
各入口均启动独立服务、准备隔离数据库并清理子进程。
不得指向用户正在使用的数据库。
凭据通过运行环境加载，不写入日志或测试报告。
`live-acceptance.e2e.ts` 用 Next 的 `loadEnvConfig` 载入运行环境。
live 数据库文件为 `prisma/live-acceptance.db`（含 `-wal`/`-shm`/`-journal` 侧车），先 `prisma db push` 再 probe 再 `tsx prisma/seed.ts`。
`withDb` 通过 `lib/db/database.ts#createDatabaseClient` 打开一次性 Prisma 客户端做权威 DB 交叉核对（连接时设 `PRAGMA journal_mode = WAL`）。

## 运行

`pnpm exec tsx tests/e2e/acceptance.e2e.ts`
运行离线浏览器场景。
`E2E_JOURNEYS` 可指定场景名称列表。
实际场景以入口的 `JOURNEYS` 为准。

`pnpm exec tsx tests/e2e/live-acceptance.e2e.ts`
运行真实模型场景。
`LIVE_SCENARIOS` 可指定场景标识列表（`lA`/`lB`/`lC`/`lD`/`lE`/`lF`/`lG` 等）。
`LIVE_FORCE_MODEL` 仅在显式配置时覆盖模型。
live 场景必须每轮独立起进程、独立重置隔离库。

`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts`
运行消费入账时间的 HTTP 边界用例（无模型、无浏览器）。

`E2E_BROWSER_PATH` 可指定 Chrome 或 Edge 路径。
找不到浏览器时，入口记录跳过。
必须检查 PASS、FAIL 与 SKIP，不能只看退出码。
`E2E_SKIP_DB_RESET=1` 保留库，不保证场景起点一致。

## live 场景与辅助模块

`live-acceptance.e2e.ts` 的 `SCENARIOS` 标识：`15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB,lC,lD,lE,lF,lG`。
`lF`/`lG` 是「卡片挂失 → 补办」链路场景，id `lF-live-credit-report-lost-and-replace-new-session` 与 `lG-live-full-card-loss-replace-chain-single-session`。
选择 `2` 会同时选中 `2p`。
场景 `7`（`scenarioCommittedContinuationFailed`）不在 `SCENARIOS` 中，恒为最后阶段。
场景契约为 `{ id, name, run(ctx): Promise<string>, skipReason? }`，`run` 返回一条证据串。
新增场景：定义 `run`、加入 `SCENARIOS` 并使用唯一 `id`/`name`。
`driveRedTool`（`live-acceptance.e2e.ts:534`）用有界自然中文轮次驱动 RED 工具并提交 MFA `123456`。
`lA`（`scenarioCreditReplace`）经 `/agent` 挂失并补办信用卡，断言真实 `/cards` 页与 `GET /api/cards`。
`lA` 的二次补卡腿只用确定性 `GET /api/cards` 核对（仍恰 4 张 = 1 张补办 ACTIVE 信用卡 + 1 张 LOST 源卡 + `card_debit` + `card_virtual`、唯一 ACTIVE 信用卡 id 不变），允许模型重放、返回既有结果或明确拒绝，不要求再次生成 MFA。
`lA` 同时断言可用信用额度不得翻倍：非 `LOST` CREDIT 合计前后恒为 `18000.00`，朴素全 CREDIT 合计 `36000.00` 作为 bug 签名被显式排除。
`lB`（`scenarioPartialRedeem`）经 `/agent` 追加申购再部分赎回理财，断言 `/investments`、账本与 `holding_wenjiana` 的 `principalAmountMinor`/`estimatedMarketValue`。
`lC`（`scenarioVirtualCardConsume`，id `lC-live-virtual-card-consumption`）经 `/agent` 确认既有虚拟卡 `card_virtual`，经 `/cards` 消费对话框在限额内消费；断言恰好一笔 `channel=CARD`/`direction=DEBIT` 的 `Transaction`（精确金额）、一条 `CardConsumption`、检查账户余额仅扣减一次、虚拟卡可支付金额更新为 `min(账户余额, 剩余月限额)`；并用 `helpers.ts#assertNoFabricatedConfirmationPanel` 守卫 RED 驱动腿，同时断言卡片总数不变（不重复生成虚拟卡）。
`lD`（`scenarioVirtualCardApplyAndLimit`，id `lD-live-virtual-card-apply-and-limit`）自然语言新开一张月限额 `100.00` 的虚拟卡并完成真实确认/MFA 面板，再经 `/cards` 对话框消费：断言 RAW `Card` 为 `VIRTUAL`/`ACTIVE`、`linkedAccountId=acct_checking`、信用额度列全为 null（`/cards` 只渲染 `账户余额` 与 `可用余额`，不出现信用额度）、恰好一笔 `channel=CARD` 借记 + 一条 `CardConsumption`、可支付金额 = `min(账户余额, 剩余月限额)`，超限消费以 `422 LIMIT_EXCEEDED` 拒绝且不移动资金。
`lE`（`scenarioVirtualCardReplaceContinuity`，id `lE-live-virtual-card-replace-continuity`）自然语言挂失 → 补办（两腿均完成真实确认/MFA 面板）后在新卡上真实前端消费：断言源卡保持 `LOST` 且 `replacedByCardId` 指向新卡、恰一张新 `VIRTUAL`/`ACTIVE` 卡继承同一 `linkedAccountId`、新卡号、月限额连续不重置（可支付 `100.00` → `70.00` → 补办后仍 `70.00` → `0.00`），新卡消费恰好成功一次。
`lD`/`lE` 共用 `applyVirtualCardLeg`（含 RAW `Card` 行断言）、`awaitPayable`、`vcMaskTail`。
「不变」以场景开始时 `GET /api/cards` 的卡片数为基线：`lA` 会在同一进程内先新增补办信用卡，硬编码种子值会让 `lC` 在合并运行中失败。
种子含 3 张 ACTIVE 卡：`card_credit`（CREDIT）、`card_debit`（DEBIT）、`card_virtual`（VIRTUAL，绑定 `acct_checking`，月限额 `5000.00`，无信用额度）；`lA`/`lC`/`lD`/`lE`/`lF`/`lG` 与 mock 的 `multi-card-freeze-audit-history` 均据该集合按类型/状态断言。
`live-virtual-card.e2e-helper.ts` 集中定义 live 虚拟卡助手：`VC_*` 常量（账户、月限额、各笔金额、商户、拒绝文案）、有界自然轮次 `VC_APPLY_TURNS`/`vcReportLostTurns`/`vcReplaceTurns`、DB 读取与断言（`readRawCard`、`readCardSpendState`、`assertSingleSpend`、`assertNoSpend`、`expectedPayableMinor`、`assertVirtualCardView`/`assertVirtualCardTile`）以及 `/cards` 对话框驱动（`consumeSuccessfully`、`attemptConsumeExpectingRefusal`）。
`card-replace-chain.e2e-helper.ts` 集中定义挂失 → 补办链路：`lF` = 新会话内信用卡挂失 → 补办，`lG` = 单会话内虚拟卡开卡 → 消费 → 挂失 → 补办 → 信用卡挂失 → 补办，含逐字 6 轮失败链复演；并定义 `LF_*`/`LG_*` 常量、`MAX_TURNS_PER_LEG`、`certifiedHead`、`nonLostCreditAvailableTotalMinor`/`renderedCreditAvailableMinor` 与卡片基线断言。
`/cards` 没有页面级可用额度汇总，因此可用信用额度按每张非 `LOST` CREDIT 卡（`creditLimitMinor`/`availableLimitMinor`）核对，朴素全 CREDIT 合计作为 bug 签名排除。
`driveRedTool` 留在入口并以 `RedToolDriver` 注入，`assertNoFabricatedConfirmationPanel` 守卫因此保持单一实现。

消费记账时间由服务端拥有：`app/cards/CardConsumeDialog.tsx` 只提交 `amount`/`category`/`merchant`，
`banking-sdk/card.ts#consumeCard` 用 `demoNow()`（UTC+08:00 月窗口）落账，没有 `occurredAt` 入参。
因此 `tests/e2e` 中没有任何调用向 `POST /api/cards/[id]/consume` 发送 `occurredAt`（带该响应体键会被 400 `VALIDATION` 拒绝且不移动资金），
消费断言只核对渲染金额、余额、流水与 `CardConsumption`，从不断言客户端指定时间。
`helpers.ts:176` 的 `occurredAt` 是 `seedStandaloneWedge` 内 `tx.executionReceipt.create` 的 `resultJson` 持久化字段（`f-wedge-refresh-recover` 夹具），不是请求体。

场景覆盖业务决定、刷新、恢复、人工接管与对话历史。
还覆盖本地化、移动布局、卡片管理和开发者模式。
还覆盖理财申购与赎回（离线入口 `h-investment-flow`）以及理财页面（`journeyBankingPages` 访问 `/investments`）。
涉及资金变化时，同时核对页面、余额与流水。
具体辅助模块使用 `*.e2e-helper.ts` 命名。
`LiveCardRecord`、`cardById`、`fetchLiveCards`、`readCardTileRows`、`readDialogRows`、`withDb` 只在 `live-virtual-card.e2e-helper.ts` 定义一次，`live-acceptance.e2e.ts` 直接导入复用：无本地副本、无 `V2` 别名、无例外。

`helpers.ts` 提供服务启动、数据库准备与 DOM 操作。
交互前等待水合完成。
读取共享演示会话使用 `readDemoSessionId`（读 `[data-demo-session-id]` 属性）。
不得等待不存在的认证 Cookie。
当前授权面板与历史授权记录必须分别定位。

## 卡片渲染标签契约（断言按渲染标签取值）

`/cards` 的卡片区块（`components/banking/CardTile.tsx`）与消费弹窗摘要（`app/cards/CardConsumeDialog.tsx` 的 `data-card-consume-summary`）都用同一组标签，断言必须从单一来源 `card-labels.e2e-helper.ts` 取值，不得硬编码中文标签。
`CARD_LABEL` 经 `createTranslator('zh-CN')` 读取 `lib/i18n/messages/business.zh-CN.json`，即组件实际渲染的同一份目录：

| 键 | i18n 键 | 渲染文本 | 承载的值 |
| --- | --- | --- | --- |
| `CARD_LABEL.linkedAccount` | `business.cards.linkedAccount` | `关联账户` | 账户名 + 脱敏账号（`<span>`，不是 `<dt>` 行） |
| `CARD_LABEL.accountBalance` | `business.cards.accountBalance` | `账户余额` | `CardView.accountAvailableBalance`（结算账户现金） |
| `CARD_LABEL.usableBalance` | `business.cards.usableBalance` | `可用余额` | `CardView.payableAmount` = `min(账户现金, 剩余月限额)` |
| `CARD_LABEL.monthlyLimit` | `business.cards.monthlyLimit` | `月限额` | 卡自身月限额（`<span>` 标签） |
| `CARD_LABEL.creditLimit` / `availableLimit` | `business.cards.limit` / `business.cards.available` | `信用额度` / `可用额度` | 仅 CREDIT 卡渲染；出现在 VIRTUAL/DEBIT 上是 bug 签名 |
| `CARD_LABEL.linkedAccountMissing` / `linkedAccountUntrusted` | `business.cards.linkedAccountMissing` / `business.cards.linkedAccountUntrusted` | `未关联账户` / `账户暂不可用` | 仅提示文案（无金额） |

`CARD_LABEL_RETIRED`（`business.cards.accountAvailable` / `business.cards.payableAmount` = `账户可用余额` / `当前可支付金额`）已无组件渲染，但键仍在目录里，因此断言可以**证明**这两个标签缺席，而不是仅仅忘记它们。

`readCardTileRows` / `readDialogRows` 把 DOM 里渲染出的标签当作 `Record<renderedLabel, renderedValue>` 的键，所以调用点写成 `rows[CARD_LABEL.accountBalance]`。
硬编码字面量的真实故障不是「取到旧值」，而是目录改名后比较两侧同时变成 `undefined` 而静默空通过；因此每处金额比较前都先断言该标签行确实存在。
`card-replace-chain.e2e-helper.ts` 集中提供三个标签契约断言：`assertNoRetiredCardLabels`（任何卡片行都不得含废弃标签）、`assertCreditTileLabels`（CREDIT 必须有 `信用额度` + `可用额度`，且不得有 `账户余额`/`可用余额`）、`assertLinkedAccountTileLabels`（按 `linkedAccountStatus` 断言：`LINKED` 必须有 `账户余额` + `可用余额`，`MISSING`/`UNTRUSTED` 必须一行金额都不渲染且只出现提示文案；两者都不得有信用额度行）。

`linkedAccountStatus` 四态决定金额行：`LINKED` 渲染账户名 + 脱敏账号 + `账户余额` + `可用余额`；`MISSING`/`UNTRUSTED` 只渲染提示文案（`未关联账户`/`账户暂不可用`），**完全不渲染任何金额行**，绝不以 `0.00` 冒充；`FROZEN`/`LOST`（`usable === false`）追加提示但照常渲染真实且非零的余额——「不可用 ≠ 余额为零」；CREDIT 恒为 `NOT_APPLICABLE`。
`LiveCardRecord` 与 `helpers.ts#CardView` 是 `GET /api/cards` 的读模型子集：服务端契约（`banking-sdk/types.ts#CardView`）中 `linkedAccountStatus` 与 `usable` 必填，`accountAvailableBalance`/`payableAmount` 仅在 `LINKED` 出现；测试侧只按 JSON 读取使用，从不构造 `CardView` 字面量。

## 消费入账时间边界（独立于前端流程）

`date-tamper-boundary.e2e.ts` 对运行中的应用发真实 HTTP 请求，自带隔离库 `prisma/live-acceptance-date-tamper.db`（≠ `e2e.db`/`test.db`/`dev.db`），不驱动 UI、不经过模型。
用例：`s0` 经真实路由创建月限额 `100.00` 的 VIRTUAL 卡（`POST /api/cards` → `POST /api/cards/changes/[id]/verify`，`{"code":"123456"}`）。
`c1` 正常消费 `10.00`；`c2` 以带上一月 `occurredAt` 的 `90.00` 消费 ⇒ `400` `{"ok":false,"error":{"code":"VALIDATION","message":"Consumption time is server-owned: 'occurredAt' must not be sent"}}` 且余额、流水、`CardConsumption` 零变化；`c3` 再正常消费 `1.00` ⇒ 本月入账恰 `11.00`。
`c4` 未来日期、`c5` 畸形日期（`"not-a-date"`）、`c6` `occurredAt: null` 同样 `400` 且零副作用。
`c7` 可支付金额 `89.00` = `min(23569.00, 100.00 − 11.00)`。
`x1`（模型侧 `agent/tools/card.ts` 的 `消费入账时间由服务端决定`）无法经 HTTP 触达，恒为诚实 SKIP。
该入口与浏览器/交互流程是两个独立入口，报告中不得混为一谈。

## LIVE 叙述与确认面板

LIVE 模型偶尔只叙述「请确认」并调用 `search_contact`，却不调用受控工具，因此不产生 `PendingAction`，无确认/MFA 卡片，`/api/actions` 为空。
`live-acceptance.e2e.ts#driveRedTool` 在受限自然轮次内检测「无卡片」并发送下一条自然语言催促。
`panel-claim.e2e-helper.ts#findConfirmationPanelClaim` 是纯文本匹配，判定助手散文是否声称确认/MFA 面板已存在（`确认面板`/`验证面板`/`上方面板`/`已在面板`/`等待你的确认` 等，否定表述不算）。
否定按子句判定：命中短语所在子句内任意位置出现否定词（含命中文本自身、短语之前或之后）即不算声称，`、` 不结束子句，只有 `，`/`,`/`。`/`！`/`？`/`；`/`!`/`?`/`;`/换行才结束子句。
紧跟命中短语的「出现」类动词否定（`不会出现`/`尚未出现`/`未显示` 等）同样不算声称，而标点分隔的独立子句里没有否定词时仍算声称（「如果没有问题，请在上方的确认面板确认」）。
`helpers.ts#assertNoFabricatedConfirmationPanel` 在散文声称面板却 `/api/actions` 无待处理项且 DOM 无确认/MFA 卡片时显式判定失败，错误信息区分 cause=模型未发起受控工具（模型行为）与 cause=UI/测试原因（网关已停放动作但未渲染）。
该守卫接入 `driveRedTool`（散文轮次）与场景 7 的 park 轮询。
普通追问（模型仅问「是否确认…」而未声称已有面板）不触发守卫，仍按现有逻辑继续催促。
`lD`/`lE` 的每一条业务腿都用有界轮次（`VC_APPLY_TURNS` 等）：模型若只作散文，下一轮催促仍不产工具，最终按失败记录，绝不补写面板。
场景 7 用 `PARK_ATTEMPTS`/`PARK_NUDGES` 轮询 `/api/actions` 并催促（见 `LIVE-ACCEPTANCE-REPORT.md` 的 Blockers）。

## MFA 验证码与熔断覆盖

`acceptance.e2e.ts` 的 `j-circuit-breaker-lock` 在同一会话内连续提交 3 次错误验证码（每次 `submitMfa('000000')`），
断言 `cards.terminal.locked`（已锁定）且验证码输入框 `SELECTORS.mfaInput` 消失，
随后切换到 `/security` 核对已熔断并在该页刷新验证持久化；三次尝试之间不刷新页面。
`e2-refresh-mfa`（journey e）断言挂起但未锁定的红档转账刷新后 MFA 卡片恢复。
`live-acceptance.e2e.ts` 的 S4 只提交一次错误码并断言卡片保留，正确码在独立页面执行；live 侧不校验尝试次数上限。
`lA`/`lD`/`lE`/`lF`/`lG` 的 live 腿只提交正确码 `123456`（`MfaChallenge.attempts=0`），live 不接受错误码、不触达尝试上限。
当前没有用例在锁定后刷新 `/agent` 再断言弹窗保持消失。

## MFA 面板的断言锚点（产品侧契约）

`MfaCard` 只由停泊区 `components/chat/ApprovalRequest.tsx:32-34` 挂载；transcript 的 `mfa` 卡由 `components/chat/cards/CardRenderer.tsx:59-70` 交给 `ApprovalRecord` 渲染，两者是不同组件。

断言按产品渲染的属性取值：停泊区锚点在 `components/chat/ApprovalRequest.tsx`、`components/chat/cards/MfaCard.tsx`，只读回执锚点在 `components/chat/cards/ApprovalRecord.tsx`。

- 活动面板根 `[data-approval-request="true"]`（`data-action-id`/`data-kind`，`aria-label` 为 `chat.approval.verification`/`chat.approval.confirmation`）= `SELECTORS.approvalRequest`。
- 验证码输入 `input[aria-label="验证码"]`（`cards.mfa.label`）；`SELECTORS.mfaInput` 已限定在面板内，历史回执不含输入框。
- 按钮用 `getByRole('button', { name: '验证'|'确认'|'取消', exact: true })`；`验证` 仅在 `/^\d{6}$/` 且非 busy/readOnly 时可点。
- 尝试次数行是 `MfaCard.tsx:108-114` 的 `role="status"`：第 1、2 次错码渲染 `cards.mfa.failedAttempts`（`{attempts}`，`chat.zh-CN.json:137`）；`cards.mfa.failedAttemptsLimit`（`:138`）要求同一停泊区渲染到 `attempts >= maxAttempts`，而锁定时停泊区已卸载，本目录无法断言该变体。
- 只读回执是 `[data-approval-history="true"]` + `data-action-id`/`data-status`（`ApprovalRecord.tsx:50-51`），阶段行 `[data-approval-stage="previous"|"current"]` + `data-stage-status`（`:57-63`）；`data-status="locked"` 时另有 `[data-approval-locked="true"]`（`:70`，含 `securityNotice({code:'MFA_LOCKED',reason:'mfa_attempts_exhausted'})` + `pages.security.unlockDescription` + `/security` 链接），徽章文案是 `chat.approval.status.locked`「验证已锁定」（`chat.zh-CN.json:16`）。

`MfaCard` 的终态分支在「连错三次验证码」中不可达，不可作为浏览器锁定断言：`MfaCard.tsx:74` 的 `cards.terminal.*` 标题、`:76-80` 的 `[data-mfa-locked="true"]` 区块、`:85` 的 `cards.mfa.locked` 都只在停泊区收到终态 `status` 时渲染。
`components/chat/agent-stream-reducer.ts#settleAction` 在同一个 fold 里把 transcript 的 `mfa` 卡写成终态（`:277-281`）并清空 `pendingAction`（`:340-342`），停泊区因此与卡片终态在同一渲染内卸载。
恢复路径也只认 `pending`/`awaiting_mfa`（`pickPendingAction`，`:554-559`），`fetchPendingActions` 不会把 `locked` 行变回停泊区。
锁定的可靠锚点（mock 与 live 都成立）：`[data-approval-history="true"][data-status="locked"]` 内含 `[data-approval-locked="true"]`，阶段行是 `[data-approval-stage="current"][data-stage-status="locked"]`。
服务端叙述同时出现于 system 气泡 `[data-message-role="system"] [data-message-content="true"]` 与 `li[data-tool-status="error"]` 的 summary，两者都是 `chat.error.actionLocked`。
面板消失表现为 `[data-approval-request="true"]` 与其 `input[aria-label="验证码"]` 计数为 0。

`[data-mfa-locked]`、`[data-approval-locked]`、`data-status="locked"` 在本目录**没有任何断言**：现行锁定事实只由 `waitForStatusText(..., t('cards.terminal.locked'))`（全页 `[role="status"]` 去空白子串，见下节）与 `SELECTORS.mfaInput` 计数为 0 表达，更强的断言应加在上面列出的回执与叙述锚点上。

## zh-CN 文案取值约定

`createTranslator`（`lib/i18n/shared.ts:41`）是约定：`t('cards.terminal.locked')`、`t('cards.mfa.failedAttempts', { attempts })`、`t('security.reset.success', { count, max })`。
`conversation.zh-CN.json` **不是**期望 UI 文案：它是对话剧本的用户提示词（`draftTransfer`/`completeTransfer`/`amountOnly`…）与断言用正负例子串（`supportedAnswers`/`failurePhrases`/`abandonedDraftPhrases`），只被 `conversation.e2e-helper.ts` 引用；mock 模型回复由 `agent/providers/mock-responder.ts` 决定。
遗留硬编码（不要模仿）：`acceptance.e2e.ts:251` 与 `live-acceptance.e2e.ts:1004` 的 `'验证失败，已尝试1次'`；`live-acceptance.e2e.ts:1005` 的裸 `input[aria-label="验证码"]`；`helpers.ts:1140/1150/1172/1185` 的 `'确认'`/`'验证'`。

## 锁定终态：尝试次数与面板消失

`MFA_MAX_ATTEMPTS = 3`（`lib/constants.ts:10`），由 `ChatWindow.tsx:237-238` 经 `ApprovalRequest` 传给 `MfaCard`。
第 1、2 次错误码服务端回 `awaiting_mfa`：停泊区与输入框保留，计数行显示 `验证失败，已尝试 1 次。`/`…2 次。`（`cards.mfa.failedAttempts`）。
`mfaAttempts` 只在「仍是同一 `mfa` 决策且本轮有 `error`」时自增（`useAgentStream.ts:346-363`），决策变更或清空时归零（`:240-246`）。
第 3 次服务端把 `PendingAction` CAS 为 `locked`，`settleAction` 在同一个 fold 里把 transcript 的 `mfa` 卡写成终态（`agent-stream-reducer.ts:277-281`）并清空 `pendingAction`（`:319-342`），停泊区因此与卡片终态在同一渲染内卸载，**整个弹层消失**，会话内只留只读历史卡。
`pickPendingAction` 只恢复 `pending`/`awaiting_mfa`（`:557-559`），刷新不会重开面板。
`j-circuit-breaker-lock` 因此断言三次后 `SELECTORS.mfaInput` 不存在、余额与流水零变化、`/security` 的 `已熔断` + `失败 3 / 3 次` + `CIRCUIT_BREAKER_TRIPPED`（`severity` `high`，DB 交叉核对）。

锁定终态的断言范围（`j` 的实际覆盖）：`waitForStatusText(page, t('cards.terminal.locked'))` 是对全页 `[role="status"]` 做去空白**子串**匹配，
它不绑定 `MfaCard` 容器：命中来自只读回执的阶段行，`ApprovalRecord.tsx:61-63` 渲染 `div[role="status"][data-approval-stage="current"]`，内容是「当前 验证已锁定」，其中「验证已锁定」（`chat.approval.status.locked`）含子串「已锁定」（`cards.terminal.locked`，`chat.zh-CN.json:128`）。
因此 `j` 通过不构成 `MfaCard` 渲染过锁定分支的证据；`cards.mfa.locked`、`[data-mfa-locked]` 与 `cards.mfa.failedAttemptsLimit` 在锁定后都不存在于 DOM。
锁定态的 DOM 钩子（写锁定断言时唯一可信的来源）：可操作停泊区 `data-approval-request="true"` + `data-action-id` + `data-kind`（`components/chat/ApprovalRequest.tsx:23-25`）；
`MfaCard.tsx:74` 的 `<p role="status">已锁定</p>` 与 `:76-80` 的 `[data-mfa-locked="true"]` 只在停泊区收到终态 `status` 时渲染，而停泊区在终态到达的同一渲染内卸载，因此二者都不是可断言的锁定钩子；
锁定文案 `chat.error.actionLocked` 由只读回执、system 气泡与工具行承载，停泊区在锁定时已不存在；
`cards.mfa.failedAttemptsLimit` 要求同一停泊区活到 `attempts >= maxAttempts`，锁定路径上不可达，停泊区可见的尝试次数只有「验证失败，已尝试 N 次。」（`cards.mfa.failedAttempts`）；
只读回执钩子 `data-approval-history="true"` + `data-action-id` + `data-status`（`components/chat/cards/ApprovalRecord.tsx:50-51`）与 `data-approval-locked="true"`（`:70`），`data-status="locked"` 时徽章是 `chat.approval.status.locked`「验证已锁定」（`:16`）；
锁定后 `MfaCard.tsx:59`/`:71`/`:90-106` 同时撤掉 footer 与输入框，因此 `SELECTORS.mfaInput` 与「验证」按钮计数都归 0。
`submitMfa` 取 `SELECTORS.mfaInput` 的 `.last()` 填码再点「验证」（`helpers.ts:1168-1173`）；`waitForStatusText` 扫全页 `[role="status"]` 做去空白子串匹配（`helpers.ts:1194-1202`）。
正确验证码是常量而非环境变量：`lib/constants.ts:7` `MFA_CODE = '123456'`、`:10` `MFA_MAX_ATTEMPTS = 3`；错误码惯例为 `'000000'`。
本目录没有任何 `'locked'` 字符串字面量断言：`data-status` 只核对 `executed`（`approval-ux.e2e-helper.ts#assertApprovalExecuted`）与 `awaiting_mfa`（`card-freeze.e2e-helper.ts`），
`queryPendingActionStatus` 只在 journey f 使用，`j` 不核对 `PendingAction.status === 'locked'`，也不核对锁定后 `/api/actions` 为空。
「验证码错误次数过多」与 `chat.error.securityLocked` 在本目录无任何断言（覆盖在 `tests/unit/security`、`tests/scenarios`、`tests/integration`、`tests/app`）。

锁定终态已实现但本目录尚未断言的钩子是只读回执与叙述：`components/chat/cards/ApprovalRecord.tsx:50` 的 `data-status="locked"`、`:61` 的 `[data-approval-stage="current"][data-stage-status="locked"]`、`:70` 的 `<div data-approval-locked="true">`，以及 system 气泡与 `li[data-tool-status="error"]` 行里的 `chat.error.actionLocked`。
`MfaCard.tsx:51` 的 `readOnly` 在 `terminal !== undefined` 时成立，但停泊区能带上终态之前就已卸载，所以锁定后 `SELECTORS.mfaInput` 计数归零证明的是停泊区卸载，而不是终态块渲染。
错码时停泊区徽章渲染的不是剩余次数文案，而是通用兜底句，细节见本节末「停泊区错码提示的已知缺口」。
**LIVE 入口永远渲染不出上述锁定态 DOM**：live dock 的 `PendingHumanDecision.status` 只来自 `pickPendingAction`（`components/chat/agent-stream-reducer.ts:554-559`，只收 `pending`/`awaiting_mfa`），`asTerminalStatus` 因此恒为 `undefined`；第 3 次错码走 `settleAction`（`:319-343`）清空 `pendingAction` 并整块卸载 dock。所以 `tests/e2e` 的 live 场景若要断言锁定，只能靠服务端叙述 `chat.error.actionLocked`（system 气泡与 `li[data-tool-status="error"]` 行）+ `queryPendingActionStatus(...).status === 'locked'` + `fetchPendingActions` 不再含该 id + `SELECTORS.mfaInput` 计数 0；`[data-mfa-locked]`/`cards.terminal.locked` 只可能在刷新后的只读历史回执（`[data-approval-history][data-status="locked"]` + `[data-approval-locked="true"]`）里出现。当前没有任何 live 场景走到锁定：live 腿只提交正确码，唯一错误码腿是 `4-live-large-transfer-mfa` 的一次 `000000`。
`tests/e2e` 的错误码与正确码都是本地字面量：`acceptance.e2e.ts:662` 的 `const MOCK_MFA_CODE = '123456';`（注释指向 `lib/constants.MFA_CODE` 但不 import）、锁定腿提交 `'000000'`；不要为本目录新增 `lib/constants` 导入。
比 `waitForStatusText` 更精确的锁定锚点：`page.locator('[data-mfa-locked="true"]')`、`queryPendingActionStatus(actionId).status === 'locked'`、`fetchPendingActions(baseUrl)` 不再包含该 id、`page.locator('[data-approval-request="true"] button').count() === 0`。
服务端锁定事实另有 `GET /api/security` 的 `circuitBreaker{failures,max,locked}`、`lock`（`{code:'CIRCUIT_OPEN',reason:'circuit_open'}`）与 `lockedActions[].actionId`（`app/api/security/route.ts:56-84`）；`/security` 页面侧是 `[data-unlock-panel][data-unlock-locked="true"][data-unlock-failures="3"][data-unlock-locked-actions="N"]`（`app/security/UnlockPanel.tsx:134-139`）。

## 熔断复位的可重复性

熔断按 OWNER（`user:user_liming`）持久化，同一用户的新会话不复位，所以重复运行必须显式复位。
轮次之间由 `reseedDemoDatabase()`（`helpers.ts:799-816`）删除 `circuitBreakerState` 在内的 15 张表后重播种，库固定为 `useIsolatedDatabase()` 的 `prisma/e2e.db`；`E2E_SKIP_DB_RESET=1` 跳过。
单场景内的确定性起点由开发者维护按钮建立：`[data-developer-toggle]`（`:visible`）开启开发者模式 → `SELECTORS.developerResetButton`（`button[data-developer-breaker-reset]`）→ `POST /api/developer/security/reset`；成功文案 `t('security.reset.success',{count:0,max:3})` 经 `app/security/ResetBreakerButton.tsx:64` 的 `role="status"` 出现，可直接用 `waitForStatusText` 等。
普通模式必须先断言两条负例：按钮计数为 0，且同一 POST 返回 403（`app/api/_lib/developer.ts#requireDeveloperMode`）。
运行期解锁是另一条路径：`POST /api/security/reset` 在锁定时无正确码返回 423 `CIRCUIT_OPEN` 且锁保持不变，成功返回 `lockedActionsReopened:false`（`app/api/security/reset/route.ts:52`/`:87-95`）；`tests/e2e` 只用开发者按钮，从未调用该路由。
解锁永不把 `'locked'` 行写回 `pending`/`awaiting_mfa`，断言锁定持久性不应期待它被解除。

## 退出码与资源清理

正常结束时退出码由 `reporter.failures` 决定：入口在场景结束后打印汇总并执行 `process.exitCode = failures > 0 ? 1 : 0`。
只有「场景断言 + 证据落盘 + 资源清理全部成功」的正常路径才 exit 0，退出码与真实通过/失败一致。
因此每轮必须同时核对汇总行与退出码：打印 PASS 但退出码非 0 记为失败。

退出码的**测量方法**本身必须可信，否则「exit 0」不构成证据。
`cmd /c "…"` 之后再单独 `cmd /c "echo EXIT=%ERRORLEVEL%"` 是无效方法：`%ERRORLEVEL%` 在解析期展开，带的是程序运行之前的值，实测 `process.exit(7)` 仍打印 `EXIT=0`。
可用方法是延迟展开并把子进程码传播为调用自身的退出码：`cmd /v:on /c "pnpm exec tsx <入口> > <log> 2>&1 & set EC=!ERRORLEVEL! & echo EXIT=!EC! >> <log> & exit !EC!"; exit $LASTEXITCODE`。
它给出两个独立信号：工具报告的进程退出码与日志里的 `EXIT=` 行；缺 `; exit $LASTEXITCODE` 时工具报告的是 PowerShell 宿主码 `0`，所以两个信号都要取。
采用前先用 `process.exit(7)` 与 `process.exit(0)` 对照程序证明该方法既报得出非零、也不会永远非零。
入口在 `finally` 中 `await browser.close()`（捕获异常）。
live 入口拆出可 await 的 `teardown()`（先停 `server.current ?? devServer`，再关浏览器），`process.on('exit')` 与信号处理器使用同步兜底 `cleanup()`。
live 入口的场景后诊断与 TASK-A 证据读取位于主 `try` 内、`cleanup` 之前，并用 try/catch 包裹（仅告警、不改退出码），证据读取失败不会把通过的运行变成 exit 1。
`uncaughtException`/`unhandledRejection` 处理器仍是真正的失败路径（exit 1）。

## 截图、日志与证据

截图目录由 `SCREENSHOTS_DIR` 指定，当前为 `output/playwright`；live 截图写入其 `live/` 子目录。
harness 的截图文件名固定，下一轮会覆盖，因此每轮截图需复制到 `output/playwright/live/<场景>-head<产品树提交前7位>-round<N>/`。
目录名带上被认证的产品树提交，不同提交的证据因此不会互相覆盖。
每轮的结论文本证据写 `output/playwright/live/REPORT-<场景>-head<产品树提交>-round<N>.md`（含命令、退出码、汇总行、逐字提示词、工具调用与参数、`PendingAction`/`MfaChallenge` 行、DB 数字、截图路径）。
mock 与日期边界报告写 `output/playwright/REPORT-mock-suite.md`、`output/playwright/REPORT-date-tamper-boundary.md`。
`output/playwright/` 与 `logs/` 都在 `.gitignore` 中：提交证据需 `git add -f` 指定具体文件，惯例只提交上述文本报告与选定的截图。
原始 stdout、evidence JSON、DB dump 只放仓库 `logs/`，不提交；不得提交 `.env.local` 或任何 `*.db`。

## 结果解释

`LIVE-ACCEPTANCE-REPORT.md` 记录当前工作周期的逐轮结果（每场景每轮的 PASS/FAIL、提示词、DB 数字、截图路径与退出码）；历史结果留在 Git 历史。
必须记录实际提交、模式、场景与本次运行结果。
每套证据必须声明它认证的**产品树提交**，因为记录证据本身的提交会让 HEAD 前移：用 `git diff --stat <产品树提交> HEAD -- banking-sdk agent security planner lib app components prisma scripts` 为空来证明等价。
产品代码改动后，旧提交上的证据不再认证 HEAD，必须在新产品树上重跑并声明新的被认证提交。
某场景在某产品树上的通过只认证该产品树，不得外推到其它提交或其它场景。
live 超时或未发起业务必须按实际失败记录。
逐轮如实记录：不得跑绿一轮后抹去前次失败，也不得删除断言或跳过失败来宣称通过。
模型非确定性（只作散文、不发受控工具）按模型行为记录，并给出与产品缺陷的区分证据；但「散文声称面板却无 `PendingAction`」属用户可见缺陷，不得归因于模型波动。

本地浏览器测试不证明集群并发或真实银行接入。
测试命令也不会自动完成生产构建验收。
