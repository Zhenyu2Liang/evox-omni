# 真实浏览器验收

## 入口与隔离

`charcoal-and-security-state` 验证中性导航、帮助入口、柔和默认图表与朱红选中项。
场景通过前端连续输入 3 次错误验证码，再从安全中心验证解除限制。
核对正常、当前受限、正常且有历史锁定记录三种状态。
解除限制后原操作仍锁定，余额与流水均不变。
`charcoal-security-live.e2e.ts` 使用真实模型执行同一场景，并验证融序自我介绍。
该入口使用 `prisma/e2e.db`，不能与其他浏览器套件同时运行。

`rongxu-brand-and-responsive-pages` 核对融序名称、标语、Logo、浏览器图标与品牌色。
场景检查对话、帮助、资产、卡片和理财页，以及 390/320 像素手机导航。
  卡片页还检查三类浅色卡面有不同配色，并检查手机端的详情展开与页面宽度。
  账单页检查暖色分类图一致、键盘聚焦提示保留精确金额、Escape 关闭提示，以及手机端宽度。
浏览器直接测量原始 X 的路径边界，确认 18 条路径没有裁切。
该场景不发送业务请求，并核对账本不变。

`assistant-help-first-visit-and-reopening` 使用首次访问的空浏览器偏好。
场景检查自动打开、关闭记忆、刷新、手动重开、键盘焦点、草稿保留、
示例只填入不发送、中英文切换、手机与短窗口布局，以及 Cookie 后备。
其他 `withPage` 场景设置已关闭引导的偏好，保持原有业务断言。
`firstVisit: true` 保留真实首次访问行为，不自动关闭引导。
`assistant-help-live.e2e.ts` 复用这些检查，并从前端发送一次真实模型余额查询。
运行命令为 `pnpm exec tsx tests/e2e/assistant-help-live.e2e.ts`。
该入口使用隔离的 `prisma/e2e.db`，不能与其他浏览器套件同时运行。

`chat-layout-and-date-separators` 使用隔离库中的三天历史消息检查布局。
场景核对桌面和手机的外层滚动、消息区滚动、单卡宽度、多卡网格、
手机标题、日期分页、草稿保留及其他页面的正常滚动。
测试只替换隔离库的对话档案，并检查账本没有变化。

live 场景 `lB` 验证持仓与交易详情的默认收起和手动展开。
剩余成本、份额、净值及到账结果仍与数据库逐项核对。
该场景还在手机宽度下检查唯一授权面板及验证码入口。
`lF` 核对三类银行卡的主要金额、卡片详情及手机页面宽度。
新卡号必须先查看才能复制，隐藏或刷新后不再显示完整号码。

`issuance-receipt.e2e-helper.ts` 用于 live 补卡场景 `lF`。
验收核对新卡完整卡号、复制结果与刷新恢复。
同时检查完整卡号没有进入模型请求和会话历史。
理财场景 `lB` 检查确认栏只显示产品名称。
赎回结果不得包含持仓内部 ID 或重复句号。

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
`LIVE_SCENARIOS` 可指定场景标识列表（`lA`/`lB`/`lC`/`lD`/`lE`/`lF`/`lG`/`lH` 等）。
`LIVE_FORCE_MODEL` 仅在显式配置时覆盖模型。
`E2E_SERVER_MODE=production` 使用 `next start`，读取 `.next-build`。
先设置 `BANKING_NEXT_DIST_DIR=.next-build` 并执行 `pnpm build`。
未设置时仍使用独立的 `.next-e2e` 开发服务。
live 场景必须每轮独立起进程、独立重置隔离库。

`pnpm exec tsx tests/e2e/date-tamper-boundary.e2e.ts`
运行消费入账时间的 HTTP 边界用例（无模型、无浏览器）。

`E2E_BROWSER_PATH` 可指定 Chrome 或 Edge 路径。
找不到浏览器时，入口记录跳过。
必须检查 PASS、FAIL 与 SKIP，不能只看退出码。
`E2E_SKIP_DB_RESET=1` 保留库，不保证场景起点一致。

## live 场景与辅助模块

`lL` 验证切换话题后，用户仍可明确续办旧转账。
闲聊不提及旧收款人；续办生成新的确认入口，确认前不扣款，确认后仅入账一次。

`lK` 位于 `live-schedule-clock.e2e-helper.ts`，通过真实模型创建未来提醒。
页面检查不提前分发，也不推进无关种子任务。
测试仅把新建隔离记录设为到期，再通过页面证明通知与审计只提交一次、资金不变。

`live-acceptance.e2e.ts` 的 `SCENARIOS` 标识：`lL,lK,15,14,13,12,11,10,9,8,0,1,2,2p,3,5,6,4,lA,lB,lC,lD,lE,lF,lG,lH,lJ,lI`（数组顺序）。
`lF`/`lG` 是「卡片挂失 → 补办」链路场景，id `lF-live-credit-report-lost-and-replace-new-session` 与 `lG-live-full-card-loss-replace-chain-single-session`。
`lH` 是「MFA 尝试上限 → 终态锁定」场景，id `lH-live-mfa-attempt-limit-lock-terminal`，body 在 `live-mfa-lock.e2e-helper.ts` 的 `scenarioMfaAttemptLimitLock`（注入 `{ page, baseUrl, captureShot }`），链路为 🔴 转账停泊 → 三次错码 `000000` → 锁定 → 刷新 `/agent` → `/security`。
`lI` 是「号码与尾号身份解析」场景，id `lI-live-identity-resolution-by-number`，body 在 `live-identity.e2e-helper.ts`：腿 1 精确手机号转账确认卡（取消后金额不变）、腿 2 近号 `13911110002` 被拒不产生 `PendingAction`、腿 3 尾号 `6688` 定位卡、腿 4 脱敏渲染。四条腿都只读 `Contact.phone`/`Card.numberMasked` 形态，完整号码仅作为用户气泡与工具参数出现。
`lI` 必须**单独成轮**（同 session 内重复同一 prompt 会被真模型拒绝，`2p,lI` 同轮产生伪失败）；需要回归 `2p` 时换金额/措辞并另起一轮。
`lI` 的脱敏断言口径：`search_contact` 摘要会回显调用方自己的 `query`（`agent/tools/contact.ts#summarizeContacts`），因此先抹掉工具参数中的字符串（`\d{12,}` 形状的完整卡号**不豁免**）再判泄漏；回显完整号码的结果必须同时含脱敏候选行（`\d{3}\*{4}\d{3,4}`）才通过。
`lI` 的卡定位参数既接受 `cardTail`（含尾号）也接受 `cardId`（须形如 `^card_`），两者都不得等于尾号或完整卡号。
`lJ` 验证借记卡展示结算账户余额。
场景 id 为 `lJ-live-debit-card-linked-account-balance`。
实现在 `live-debit-card.e2e-helper.ts#scenarioDebitCardLinkedAccount`，注入 `{ page, baseUrl, drive, captureShot }`。
卡片页面展示关联账户、账户余额与可用余额。
转账后，绑定同一账户的多卡余额同步更新。
冻结或挂失保留真实余额，同时禁用消费入口。
信用卡仅显示信用额度，不显示账户余额或消费按钮。
正常借记卡与虚拟卡的消费入口仍可用。
选择 `2` 会同时选中 `2p`。
场景 `7`（`scenarioCommittedContinuationFailed`）不在 `SCENARIOS` 中，恒为最后阶段。
场景契约为 `{ id, name, run(ctx): Promise<string>, skipReason? }`，`run` 返回一条证据串。
新增场景：定义 `run`、加入 `SCENARIOS` 并使用唯一 `id`/`name`。当前没有任何场景实现 `skipReason`：跳过只发生在找不到真实浏览器时（整批所选场景统一 SKIP，仍打印汇总与退出码）；需要「测试数据不满足即不认证」前置条件的新场景，才是第一次用 `skipReason` 的场合。
`driveRedTool`（`live-acceptance.e2e.ts:534`）用有界自然中文轮次驱动 RED 工具并提交 MFA `123456`。
`lA`（`scenarioCreditReplace`）经 `/agent` 挂失并补办信用卡，断言真实 `/cards` 页与 `GET /api/cards`。
`lA` 的二次补卡腿只用确定性 `GET /api/cards` 核对（仍恰 4 张 = 1 张补办 ACTIVE 信用卡 + 1 张 LOST 源卡 + `card_debit` + `card_virtual`、唯一 ACTIVE 信用卡 id 不变），允许模型重放、返回既有结果或明确拒绝，不要求再次生成 MFA。
`lA` 同时断言可用信用额度不得翻倍：非 `LOST` CREDIT 合计前后恒为 `18000.00`，朴素全 CREDIT 合计 `36000.00` 作为 bug 签名被显式排除。
`lB`（`scenarioInvestmentPartialRedemption`，id `lB-live-investment-partial-redemption`）经 `/agent` 追加申购再部分赎回理财，断言 `/investments`、账本与 `holding_wenjiana` 的 `principalAmountMinor`/`estimatedMarketValue`。
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

## `/cards` 定位与断言的现状约定（新增卡片渲染用例前必读）

`/cards` 的正规导航是 `gotoCards`（`live-virtual-card.e2e-helper.ts:526-529`）：`page.goto(\`${baseUrl}/cards\`, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS })` 后 `waitForElementHydration(page, '[data-card-add] button')`。
重复的裸导航仍存在（`live-acceptance.e2e.ts:1267-1268`、`:1716-1717`、`card-management.e2e-helper.ts:21-22`）；刷新后等 `waitForElementHydration(page, \`[data-card-id="${cardId}"]\`)`。
卡片定位只有一条通道：`[data-card-id="<cardId>"]`，且一律 `.first()`；没有 `aria-label`、标题层级或掩码卡号选择器。
`data-card-id` 由页面包裹层 `app/cards/CardManager.tsx` 发出，`components/banking/CardTile.tsx` 自身不输出任何 `data-*`。
本目录用例只依赖语义 `data-*` 属性，未使用 `data-testid`；不按 `nth()` 或卡类型选卡片，tile 边界就是带 `data-card-id` 的那个元素。
`readCardTileRows` 只收集 `dl dt` 的 `dt → dd`（`账户余额`/`可用余额`/信用额度/分类限额），`<span>` 渲染的 `关联账户`/`月限额` 只能经 `readCardTileText`（整块 innerText 折叠空白）用 `includes` 断言；`未关联账户`/`账户暂不可用` 是 `<p>`，状态与不可用提示是 `Badge`。
本目录没有 `@playwright/test`：无 `expect`/`toBe`/`toContainText`，断言一律 `if (...) throw new Error(...)`，`run` 返回一条证据串。
金额两端都用 `formatCNY`；现存硬编码字面量只有 `live-acceptance.e2e.ts:1273` 的 `'¥18,000.00'` 与 `:1733` 的 `'****8821'`。
状态徽标文案（`正常`/`已挂失`/`已补卡`）在 `live-acceptance.e2e.ts:1276-1281` 是硬编码中文，未走 `CARD_LABEL` 的目录取值；改 `CardTile` 文案不会被任何目录读取捕获。
`VirtualCardProjection.linkedAccountText` 无任何调用点传入，因此“关联账户显示账户名/脱敏账号”的渲染断言当前不存在，只断言 `关联账户` 标签本身出现。
`assertLinkedAccountTileLabels` 的 `MISSING`/`UNTRUSTED` 分支（只渲染 `未关联账户`/`账户暂不可用` 且零金额行）在本目录从未执行：唯一调用点 `card-replace-chain.e2e-helper.ts:1021` 用默认 `LINKED` 且不传 `tileText`；这两种绑定态只在服务端投影用例（`tests/unit`、`tests/integration`、`tests/app`）里覆盖。
FROZEN/LOST 的 tile 断言只覆盖 CREDIT 卡（`card-replace-chain.e2e-helper.ts:704-710`：LOST 源卡仍渲染真实 `可用额度`）；DEBIT/VIRTUAL 的 `usable === false` 渲染无任何用例。
`GET /api/cards` 读模型断言的字段名以 `LiveCardRecord`（`live-virtual-card.e2e-helper.ts:109-127`）为准：`linkedAccountName`/`linkedAccountNumber`/`linkedAccountStatus`/`usable` 都是可选字段，只有 `linkedAccountStatus === 'LINKED'` 才带金额串。

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

## 号码 / 尾号 / 脱敏断言的现状

种子掩码是唯一真值来源：`card_credit` `****6688`、`card_debit` `****8821`、`card_virtual` `****7788`（`card-freeze.e2e-helper.ts:13-17` 的 `SEEDED_CARDS`、`card-replace-chain.e2e-helper.ts:108`），联系人 `contact_zhangwei` 的 `Contact.phone` 已是掩码 `139****0002`。
live 入口只读 `contact.phone`（`live-acceptance.e2e.ts:265-271`），从不读 `phoneFull`；真实号码以常量 `RAW_RECIPIENT_PHONE = '13900000002'`（`:772`）出现。
手机号掩码只在确认卡 `收款手机号` 字段被断言，判定为正则 `/^\d{3}\*{4}\d{3,4}$/`（`live-acceptance.e2e.ts:503-511`）；字段读取走 `readConfirmFields`（`:427-442`，只取最后一个含 `收款人` 的 `[data-approval-request="true"] dl`）。
卡片号掩码只经读模型断言：`GET /api/cards` 的 `LiveCardRecord.numberMasked`（`live-virtual-card.e2e-helper.ts:109-127`）与 SQLite `Card.numberMasked`；`helpers.ts#CardView`（`:1244-1252`）不含 `numberMasked`，`RAW_CARD_FIELDS`（`live-virtual-card.e2e-helper.ts:200`）不选 `numberFull`。
需要完整卡号或 `Card.numberFull` 的新场景必须自行扩展 select，不要假设现成读取器带该字段。
`/cards` 上被断言的号码掩码是账户号 `****8821`（消费弹窗 `CARD_LABEL.linkedAccount` 行，`live-acceptance.e2e.ts:1733-1734`），不是卡号。
mock 入口只有两处脱敏断言：`banking-pages.e2e-helper.ts:23` 的联系人页文本 `138****5678` 与 `card-freeze.e2e-helper.ts:34-36` 的三张种子卡 `numberMasked`（读 `/api/cards`，非页面）。
既有「按尾号/号码定位对象」的用例只有两类：`2p`（转账按手机号，掩码形与真实形各一条腿）与 `lA`/`lC`/`lD`/`lE`/`lF`/`lG`（按尾号挂失/补办/消费）。
尚无「查询类解析结果」（如 `search_contact` 命中后回复里的脱敏号码、卡片查询返回的卡号掩码）在 live 入口的 DOM 断言形态；`weixin-capabilities.e2e-helper.ts:40` 的 `135****0005` 是微信通道的同类断言，可作写法参考。

## MFA 验证码与熔断覆盖

`acceptance.e2e.ts` 的 `j-circuit-breaker-lock` 在同一会话内连续提交 3 次错误验证码（每次 `submitMfa('000000')`），
断言 `cards.terminal.locked`（「已锁定」，实际命中只读回执阶段行而非停泊区，见「锁定终态：尝试次数与面板消失」）且验证码输入框 `SELECTORS.mfaInput` 消失，
随后切换到 `/security` 核对已熔断并在该页刷新验证持久化；三次尝试之间不刷新页面。
`e2-refresh-mfa`（journey e）断言挂起但未锁定的红档转账刷新后 MFA 卡片恢复。
`live-acceptance.e2e.ts` 的 S4 只提交一次错误码并断言卡片保留，正确码在独立页面执行；live 侧的尝试次数上限只由 `lH` 校验。
`lA`/`lD`/`lE`/`lF`/`lG` 的 live 腿只提交正确码 `123456`（`MfaChallenge.attempts=0`）；`lH` 是唯一提交错误码（三次 `000000`）并触达尝试上限的 live 腿。
锁定后刷新 `/agent` 再断言弹窗保持消失由 `lH` 覆盖：刷新后停泊区与验证码输入框计数仍为 0、只读回执停在 `[data-status="locked"]`、`PendingAction.status` 仍为 `locked`。
`driveRedTool`（`live-acceptance.e2e.ts:575-636`）是卡片链路共用的 RED 驱动，在 `:591`/`:634` 硬编码正确码 `123456`，因此错码链路在它之外另写：`lH` 的 `ensureMfaDock`（`live-mfa-lock.e2e-helper.ts`）只催泊停靠区、从不提交验证码，错码阶梯由场景自己连发三次 `000000`。
它的类型 `RedToolDriver` 定义在 `live-virtual-card.e2e-helper.ts:471`，入口以 `(turns) => driveRedTool(page, ctx.baseUrl, turns)` 注入 `applyVirtualCardViaAgent`（`:1902-1910`）与 `lF`/`lG`（`:2342`/`:2343`）。
live 入口文件没有 `data-testid`/`getByTestId`：DOM 断言只靠 `data-*` 选择器（`data-approval-request`、`data-card-id`、`data-card-consume*`、`data-investment-holdings`）与 `getByRole` 的中文可及名（`确认`/`取消`/`验证`/`提交消费`）。
`helpers.ts#waitForMfaSettled` 在 live 入口未被引入：它在 `验证` 按钮计数为 0 时即返回 true，无法区分「锁定」与「验证成功」，锁定断言不能用它。

MFA／锁定的 DOM 驱动接缝全部在 `helpers.ts`，入口不复刻：
`SELECTORS.mfaInput` = `[data-approval-request="true"] input[aria-label="验证码"]`（只匹配动作停靠区，历史回执不带输入框）。
`waitForMfaCard(page, timeoutMs, minCount)` 等 `count >= minCount` 再等 `.last()` 可见；`submitMfa` 填 `.last()` 输入框并点 `[data-approval-request="true"]` 内的 `验证` 按钮；`mfaCardPresent` 只数输入框数量，锁定后归零即「卡片关闭」。
`waitForStatusText` 对全页 `[role="status"]` 去空白后做**子串**匹配，因此断言串可省略空格与句末标点（断言 `验证失败，已尝试1次`，目录原值为 `验证失败，已尝试 {attempts} 次。`）。
目录原值：`cards.terminal.locked` = `已锁定`、`cards.mfa.locked` = `已锁定，请到安全中心处理。`、`cards.mfa.failedAttempts` = `验证失败，已尝试 {attempts} 次。`、`security.breaker.locked` = `已熔断`、`security.breaker.failureCount` = `失败 {count} / {max} 次`、`security.reset.success` = `已解除限制，当前失败 {count} / {max} 次。`。

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

mock 的 `j` 仍只把锁定事实表达为 `waitForStatusText(..., t('cards.terminal.locked'))`（全页 `[role="status"]` 去空白子串，见下节）加 `SELECTORS.mfaInput` 计数为 0；只读回执与叙述锚点由 `lH` 断言（见「`lH` 锁定的可复用锚点」）。`[data-mfa-locked]` 在本目录仍无任何断言。

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
停泊区在锁定时已整体卸载，因此 `SELECTORS.mfaInput` 与「验证」按钮计数都归 0。
`submitMfa` 取 `SELECTORS.mfaInput` 的 `.last()` 填码再点「验证」（`helpers.ts:1168-1173`）；`waitForStatusText` 扫全页 `[role="status"]` 做去空白子串匹配（`helpers.ts:1194-1202`）。
正确验证码是常量而非环境变量：`lib/constants.ts:7` `MFA_CODE = '123456'`、`:10` `MFA_MAX_ATTEMPTS = 3`；错误码惯例为 `'000000'`。
`data-status` 由 `assertApprovalExecuted`（`approval-ux.e2e-helper.ts`）核对 `executed`、`card-freeze.e2e-helper.ts` 核对 `awaiting_mfa`。
`queryPendingActionStatus` 被 journey f 与 `lH` 使用；`lH` 断言 `PendingAction.status === 'locked'`、`resultJson === null`、`GET /api/actions` 不再含该 id、`MfaChallenge.attempts=3`/`status='locked'`、`CircuitBreakerState key='user:user_liming' failures=3 locked=true`，`j` 仍不核对这些。
「验证码错误次数过多」与 `chat.error.securityLocked` 在本目录无任何断言（覆盖在 `tests/unit/security`、`tests/scenarios`、`tests/integration`、`tests/app`）。

锁定终态的只读回执与叙述钩子由 `lH` 断言：`components/chat/cards/ApprovalRecord.tsx:50` 的 `data-status="locked"`、`:61` 的 `[data-approval-stage="current"][data-stage-status="locked"]`、`:70` 的 `<div data-approval-locked="true">`，以及刷新后全页可见文本里的 `chat.error.actionLocked` 与 `role="status"` 里的徽章「验证已锁定」（`chat.approval.status.locked`）。
`MfaCard.tsx:51` 的 `readOnly` 在 `terminal !== undefined` 时成立，但停泊区能带上终态之前就已卸载，所以锁定后 `SELECTORS.mfaInput` 计数归零证明的是停泊区卸载，而不是终态块渲染。
错码时停泊区徽章渲染剩余次数文案（`chat.error.verificationRemaining`「验证码错误。还可尝试 N 次。」）；`p[role="status"]` 计数行是更稳的锚点，细节见下文「停泊区错码提示」。
**LIVE 入口永远渲染不出 `MfaCard` 的锁定终态 DOM**：live dock 的 `PendingHumanDecision.status` 只来自 `pickPendingAction`（`components/chat/agent-stream-reducer.ts:554-559`，只收 `pending`/`awaiting_mfa`），`asTerminalStatus` 因此恒为 `undefined`；第 3 次错码走 `settleAction`（`:319-343`）清空 `pendingAction` 并整块卸载 dock。所以 `tests/e2e` 的 live 场景若要断言锁定，只能靠服务端叙述 `chat.error.actionLocked`（system 气泡与 `li[data-tool-status="error"]` 行）+ `queryPendingActionStatus(...).status === 'locked'` + `fetchPendingActions` 不再含该 id + `SELECTORS.mfaInput` 计数 0；`[data-mfa-locked]`/`cards.terminal.locked` 只可能在刷新后的只读历史回执（`[data-approval-history][data-status="locked"]` + `[data-approval-locked="true"]`）里出现。`lH` 是走到终态锁定的 live 场景（见「`lH` 锁定的可复用锚点」）；其余 live 腿只提交正确码，`4-live-large-transfer-mfa` 只提交一次 `000000` 后停住。
`tests/e2e` 的错误码与正确码都是本地字面量：`acceptance.e2e.ts:662` 的 `const MOCK_MFA_CODE = '123456';`（注释指向 `lib/constants.MFA_CODE` 但不 import）、锁定腿提交 `'000000'`；不要为本目录新增 `lib/constants` 导入。
比 `waitForStatusText` 更精确的锁定锚点：`queryPendingActionStatus(actionId).status === 'locked'`、`fetchPendingActions(baseUrl)` 不再包含该 id、`page.locator('[data-approval-history][data-status="locked"] [data-approval-locked="true"]')` 存在、`page.locator('[data-approval-request="true"] button').count() === 0`。
服务端锁定事实另有 `GET /api/security` 的 `circuitBreaker{failures,max,locked}`、`lock`（`{code:'CIRCUIT_OPEN',reason:'circuit_open'}`）与 `lockedActions[].actionId`（`app/api/security/route.ts:56-84`）；`/security` 页面侧是 `[data-unlock-panel][data-unlock-locked="true"][data-unlock-failures="3"][data-unlock-max-attempts="3"][data-unlock-locked-actions="N"]`（`app/security/UnlockPanel.tsx:134-139`）。

## `lH` 锁定的可复用锚点

`lH` 的三次 `POST /api/actions/[id]/verify` 都是 HTTP 200 域结果，不要断言 423/409：#1/#2 `status='awaiting_mfa'` + `code='MFA_FAILED'` + `failure={code:'MFA_FAILED',reason:'mfa_code_invalid',attemptsUsed:1|2,attemptsLeft:2|1,maxAttempts:3}`；#3 `status='locked'` + 顶层 `code='CIRCUIT_OPEN'` + `failure={code:'MFA_LOCKED',reason:'mfa_attempts_exhausted',attemptsUsed:3,attemptsLeft:0}`。
锁定后停泊区整块卸载，`SELECTORS.mfaInput` 计数 0 只能证明卸载；锁定事实必须同时靠 `PendingAction.status === 'locked'`、`GET /api/actions` 不再含该 id 与服务端叙述。
刷新 `/agent` 后的锚点：`[data-approval-history="true"][data-status="locked"] [data-approval-locked="true"]`、`[data-approval-stage="current"][data-stage-status="locked"]`（当前验证阶段行，文案「当前验证已锁定。」）、徽章「验证已锁定」（`chat.approval.status.locked`）。
`/security` 锚点：`[data-unlock-panel][data-unlock-locked="true"][data-unlock-failures="3"][data-unlock-max-attempts="3"][data-unlock-locked-actions="N"]`、`[data-lock-reason="CIRCUIT_BREAKER_TRIPPED"]`、`section[data-locked-actions] li[data-locked-action-id]`、`[data-security-event-kind="CIRCUIT_BREAKER_TRIPPED"]`；读模型是 `GET /api/security` 的 `circuitBreaker{failures,max,locked}` / `lock.code` / `lockedActions[]`。
DB 侧由 `helpers.ts#queryPendingActionStatus`（`status`/`resultJson`）、`withDb`（`PendingAction`/`MfaChallenge`/`CircuitBreakerState` 行）与 `querySecurityEvents({ sessionId })`（`MFA_FAILURE` ≥ 3、`CIRCUIT_BREAKER_TRIPPED` 恰 1）交叉核对。
三次错码之间账本零新增（`fetchLedger` + `diffLedger`），全页可见文本与 `verify` 响应原文都不含 `__SECURITY_BLOCK__`/`decisionKind`/原始 JSON/堆栈。

## 停泊区错码提示

一次错码时停泊区徽章渲染剩余次数文案 `chat.error.verificationRemaining`「验证码错误。还可尝试 N 次。」（`count` 取服务端 `attemptsLeft`）。
链路：`components/chat/cards/MfaCard.tsx:116` 的徽章渲染 `localizeChatError(error, t)`，`error` 由 `components/chat/ChatWindow.tsx:237-238` 的 `error={localizedError}` 传入，而 `ChatWindow.tsx:77` 的 `localizedError = publicToolError(stream.error, t, 'chat.error.request', stream.errorCode)`。
`stream.error` 是服务端 `data.message`「验证码错误。还可尝试 N 次。」（`lib/public-text.ts:67-73` 把 `mfa_code_invalid`/`MFA_FAILED` 映射到 `chat.error.verificationRemaining`），由 `components/chat/actions.ts:640-643` 包成不带 `code` 的 `{type:'error', message}` 推进事件流。
因此 `components/chat/agent-stream-reducer.ts:507` 写入的 `errorCode` 为 `undefined` 不影响徽章文案：`lib/tool-feedback.ts:51-61` 的原文分支先于 `:63` 的 `errorCode` 分支命中。
`lib/tool-feedback.ts:60` 的闭集正则同时接受「验证码错误。还可尝试 N 次。」与旧的持久化句「验证码错误，请重试。剩余尝试次数：N。」，两者都映射到 `chat.error.verificationRemaining`（`:61`）。
徽章文案完全取决于该正则是否接受服务端原文，不接受时 `publicToolError` 退化为兜底句 `chat.error.request`「请求失败，请检查网络后稍后重试。」。
更稳的错码断言是停泊区计数行 `p[role="status"]`「验证失败，已尝试 N 次。」（`cards.mfa.failedAttempts`，`MfaCard.tsx:108-114`），第 3 次因停泊区卸载而不可达。
`role="alert"` 横幅在停泊期间被抑制（`components/chat/ChatWindow.tsx:189` 的 `showNotice={!pending}`），错码同样不产生横幅断言点。
`lH` 在 live 侧复核同一链路：错码后停泊区徽章读到「验证码错误。还可尝试 N 次。」（`output/playwright/live/lH-headd26b263-round2-mfa-copy-fix/` 观测到 `还可尝试 1 次`），`p[role="status"]` 的计数行「验证失败，已尝试 N 次。」同时成立（第 1、2 次各一档）；服务端始终直传 `attemptsLeft` 2/1/0，`lib/public-text.ts#securityNotice` 的单一 `?? 0` 在这条链路上未被触发，页面从未出现「还可尝试 0 次」。

## 熔断复位的可重复性

熔断按 OWNER（`user:user_liming`）持久化，同一用户的新会话不复位，所以重复运行必须显式复位。
轮次之间由 `reseedDemoDatabase()`（`helpers.ts:799-816`）删除 `circuitBreakerState` 在内的 15 张表后重播种，库固定为 `useIsolatedDatabase()` 的 `prisma/e2e.db`；`E2E_SKIP_DB_RESET=1` 跳过。
单场景内的确定性起点由开发者维护按钮建立：`[data-developer-toggle]`（`:visible`）开启开发者模式 → `SELECTORS.developerResetButton`（`button[data-developer-breaker-reset]`）→ `POST /api/developer/security/reset`；成功文案 `t('security.reset.success',{count:0,max:3})` 经 `app/security/ResetBreakerButton.tsx:64` 的 `role="status"` 出现，可直接用 `waitForStatusText` 等。
普通模式必须先断言两条负例：按钮计数为 0，且同一 POST 返回 403（`app/api/_lib/developer.ts#requireDeveloperMode`）。
运行期解锁是另一条路径：`POST /api/security/reset` 在锁定时无正确码返回 423 `CIRCUIT_OPEN` 且锁保持不变，成功返回 `lockedActionsReopened:false`（`app/api/security/reset/route.ts:52`/`:87-95`）；`tests/e2e` 只用开发者按钮，从未调用该路由。
解锁永不把 `'locked'` 行写回 `pending`/`awaiting_mfa`，断言锁定持久性不应期待它被解除。
`lH` 不按开发者按钮、也不重置熔断：它依赖 live 入口每轮重建的 `prisma/live-acceptance.db`（`db push` + seed），同一库上连跑第二轮会从已熔断状态开始。
`PendingAction` 状态的 DB 接缝：live 入口用本地 `readPendingAction`（`live-acceptance.e2e.ts:254-262`，`withDb` + `pendingAction.findUnique({ where: { id, sessionId } })`）；mock 入口用 `helpers.ts#queryPendingActionStatus`（`:220-234`，只按 `id`，走 `createDatabaseClient()` 的当前 `DATABASE_URL`），`lH` 也用它直读锁定行。
`scenarioLargeTransferMfa` 的单次错码腿在 `live-acceptance.e2e.ts:1005` 用裸字面量 `input[aria-label="验证码"]` 计数（未走 `SELECTORS.mfaInput`）；两者当前等价，改选择器时两处都要看。

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
harness 的截图文件名固定，下一轮会覆盖，因此每轮截图需复制到 `output/playwright/live/<场景>-head<产品树提交前7位>-round<N>-<标签>/`（如 `lB-head3ba488a-round1-merged/`、`lH-headd26b263-round2-mfa-copy-fix/`）；每套证据含 PNG 截图 + `*-evidence.json` + `*-run-log.txt`。
目录名带上被认证的产品树提交，不同提交的证据因此不会互相覆盖。
每轮的结论文本证据写 `output/playwright/live/REPORT-<场景>-head<产品树提交>-round<N>.md`（含命令、退出码、汇总行、逐字提示词、工具调用与参数、`PendingAction`/`MfaChallenge` 行、DB 数字、截图路径）。
mock 与日期边界报告写 `output/playwright/REPORT-mock-suite.md`、`output/playwright/REPORT-date-tamper-boundary.md`。
`output/playwright/` 与 `logs/` 都在 `.gitignore` 中：提交证据需 `git add -f` 指定具体文件，惯例只提交上述文本报告与选定的截图。
原始 stdout、evidence JSON、DB dump 只放仓库 `logs/`，不提交；不得提交 `.env.local` 或任何 `*.db`。

## 可复用断言原语（新增场景时先读本节）

`/cards` 页面没有冻结/解冻控件：`app/cards/CardManager.tsx` 卡片底部只有 `data-card-consume` 与 `data-card-delete`，头部只有 `data-card-refresh`/`data-card-add`。
冻结/解冻只能经 `/agent` 的 `freeze_card`/`unfreeze_card`（均为 RED 写工具），因此 `card-freeze.e2e-helper.ts` 只导出 `journeyMultiCardFreeze`，不含页面级冻结助手。
`card-management.e2e-helper.ts` 只导出 `journeyCardManagement`，覆盖人工新增/注销实体卡。
`banking-pages.e2e-helper.ts` 只导出 `journeyBankingPages`，无 `/overview` 与 dashboard 断言。

`readCardTileRows(page, cardId)` 返回 `Record<去全部空白的渲染标签, 去首尾空白的 dd 文本>`（遍历 `dl > dt`，值取 `dt.nextElementSibling`）：只覆盖 `<dl>` 行，故 `关联账户`/`月限额` 这类 `<span>` 标签取不到。
标签键把连续空白**删除**（`replace(/\s+/g,'')`，不是 trim），调用点必须按目录原文取值，且比较金额前先断言该行存在，否则目录改名会静默空通过。
`readCardTileText(page, cardId)` 返回容器 `innerText`（空白折叠为单空格），是读取 `<span>` 标签、状态 `Badge`（`已冻结`/`已挂失`）与不可用提示的唯一途径。
`CARD_LABEL` 只有 8 个键；`未关联账户`/`账户暂不可用`/`卡片不可用` 与 `卡片已冻结，暂不可用于消费（余额仍可查看）`/`卡片已挂失，暂不可用于消费（余额仍可查看）` 不在其中，须直取 `lib/i18n/messages/business.zh-CN.json` 或读 tile 文本。

FROZEN/LOST 的 `LINKED` 卡照常渲染真实 `账户余额` + `可用余额`（`banking-sdk/card.ts#toCardView` 只看 `settlement.status`），不可用性只由状态与提示 `Badge` 表达。
`assertLinkedAccountTileLabels(rows, label, status = 'LINKED', tileText?)` 不检查 `usable`，因此对冻结/挂失卡仍通过；`assertCreditTileLabels` 断言信用额度行存在且无账户余额行；`assertNoRetiredCardLabels` 断言废弃标签缺席。
`readCardChainMoneySnapshot(baseUrl)` 是唯一的 `/api/dashboard` 原语（`Promise.all([fetchDashboardSummary, fetchLedger])` → `{ checkingBalance, ledger }`），配合 `assertCardChainMoneyUnchanged(before, after, label)`。
`helpers.ts#fetchDashboardSummary` 返回 `getJson` 的 `envelope.data`，其 `DashboardView` 只是路由 `DashboardSummary` 的收窄子集；三方核对需就地放宽类型而不是依赖该别名。

`completeConfirmationPanel(page, label, code='123456')`：无 MFA 卡时先 `clickConfirm(page, 90_000)`，再 `waitForMfaCard(page, 120_000)`，最后 `submitMfa(page, code, 60_000)`。
`openConsumeDialog` 对 `usable === false` 的卡必然超时（按钮 `disabled`），不得用于冻结/挂失卡。

`/cards` 的全部页脚按钮（`data-card-add`/`data-card-refresh`/`data-card-consume`/`data-card-delete`）在 `CardManager` 首帧客户端刷新完成前被同一个 `disabled = busy || refreshing || !loaded`（`app/cards/CardManager.tsx:181`）整体禁用；`gotoCards` 只等水合，因此该帧读到的按钮状态描述的是刷新而非卡片，判定按钮状态前必须等到 `[data-card-add] button` 解除 `disabled`。
逐卡入口复用 `cardSupportsConsumption` 与 `cardCanConsume`。信用卡不渲染 `data-card-consume`，并显示暂不支持的说明。借记卡与虚拟卡需卡片可用且账户关联为 `LINKED` 才能消费。
`live-debit-card.e2e-helper.ts#assertConsumeEntry` 就是这个模式（先 settle 再读，`consumeButtonEnabled` 在按钮未渲染时直接失败），同一张卡要求「启用 → 停用」翻转才算非空断言。

新场景注册：加入 `live-acceptance.e2e.ts` 的 `const SCENARIOS`（现止于 `lI`），`run` 用 `withPage(ctx.browser, …, { label })` 包裹并注入 `drive: (turns) => driveRedTool(page, ctx.baseUrl, turns)`、`captureShot: captureLive`。
`LIVE_SCENARIOS` 过滤 id；选 `2` 连带 `2p`；场景 `7` 不在数组内且恒最后运行。
`E2E_BROWSER_PATH` 在 `helpers.ts#resolveBrowserExecutable` 中优先命中（路径存在即用），否则回退常见 Chrome/Edge 路径。

## 结果解释

`LIVE-ACCEPTANCE-REPORT.md` 记录当前工作周期的逐轮结果（每场景每轮的 PASS/FAIL、提示词、DB 数字、截图路径与退出码）；历史结果留在 Git 历史。
必须记录实际提交、模式、场景与本次运行结果。
每套证据必须声明它认证的**产品树提交**，因为记录证据本身的提交会让 HEAD 前移。
等价性一律在仓库根用排除文档的 pathspec 魔法形式测量：`git --no-pager diff --stat <产品树提交> HEAD -- ':(exclude)*.md' banking-sdk agent security planner lib app components prisma scripts` 输出为空，即证明该提交与 HEAD 的产品树相同（例：`88d38550` 对 `cab32956` 为空；单个 `*` 同时覆盖仓库根与任意深度的 `.md`，而 `**/*.md` 只覆盖至少带一层目录的路径、漏掉根级 `CONTEXT.md`——实测漏项在 `88d38550` 对 HEAD 为 24 个文件、本写法为 23 个，`d26b2636` 对 HEAD 由 86 降为 85）。漏项数字取自不带产品路径列表的整树 diff；带上 `banking-sdk … scripts` 后两种写法输出完全相同（根级 `.md` 本就不在这些路径里），因此该写法只收紧排除式的覆盖面，不改变任何已记录的等价性结论。
不带 `:(exclude)*.md` 的同一命令不构成等价性证明：这些产品路径下本身就住着 `CONTEXT.md`，任何只动文档的合并都会让它非空（`88d38550` 对 `cab32956` 列出 22 个文件，全部是 `*/CONTEXT.md`）。
排除文档后仍有差异时必须逐文件点名，并声明该证据「不外推到 HEAD」：旧提交上的通过只认证旧提交的产品树（例：`d26b2636` 对 HEAD 是 2 个文件，`agent/tools/card.ts` 与 `agent/tools/consume-virtual-card.test.ts`）。
产品代码改动后，旧提交上的证据不再认证 HEAD，必须在新产品树上重跑并声明新的被认证提交。
某场景在某产品树上的通过只认证该产品树，不得外推到其它提交或其它场景。
live 超时或未发起业务必须按实际失败记录。
逐轮如实记录：不得跑绿一轮后抹去前次失败，也不得删除断言或跳过失败来宣称通过。
模型非确定性（只作散文、不发受控工具）按模型行为记录，并给出与产品缺陷的区分证据；但「散文声称面板却无 `PendingAction`」属用户可见缺陷，不得归因于模型波动。

本地浏览器测试不证明集群并发或真实银行接入。
测试命令也不会自动完成生产构建验收。
