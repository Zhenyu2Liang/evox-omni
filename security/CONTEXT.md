# 安全层

本层用代码决定权限、确认、验证、风险与锁定状态。
本层不执行业务操作。

## 模块边界

`lib/contracts/tool-catalog.ts` 是名称、效果、默认档位与重放要求的共享来源。
`permission-engine.ts` 推导静态策略。
`risk-engine.ts` 使用精确 bigint 运算并输出十进制字符串。
转账始终需要人工决定。
已入账金额加上在途未入账金额超过 `1000.00` 时需要强验证。
订阅查询为 YELLOW。
`set_card_limit` 只调整分类消费限额，意图标签为「调整卡片分类消费限额」。
`replace_card`、`apply_virtual_card` 与 `consume_virtual_card` 属于 RED 写操作，均要求确认、强验证与幂等重放。

`security-gateway.ts` 校验归属资源、记录确定性授权决定并创建待确认操作。
确认采用原子认领，并重新评估累计风险。
开放的人工接管阻断新的执行认领；已授权的在途命令仍可落地。
`authorization-record.ts` 记录策略版本、命令指纹、原因与脱敏输入。

## 卡片生命周期与 replace_card 前提

`replace_card` 的前提只有两条：源卡属于当前用户，且状态为 `LOST`。
`banking-sdk/card.ts#requireCard` 对不存在的卡片抛 `NOT_FOUND`、对他人卡片抛 `SECURITY_DENIED`；`#replaceCard` 对非 `LOST` 源卡抛 `CONFLICT`「只有已挂失的卡片可以补办，请先办理挂失。」。
本层与 `agent/tools/card.ts` 都没有 CREDIT / DEBIT / VIRTUAL 的类型禁区；RED 档位只来自 `lib/contracts/tool-catalog.ts` 的目录项。
唯一的类型分支在 SDK：VIRTUAL 补办必须重新校验并继承结算账户绑定，CREDIT 补办原样继承 `creditLimitMinor` 与 `availableLimitMinor`，因此代理可以补办挂失的信用卡。
`gatewayCreatePendingAction` 在挂起时只把卡片类型与掩码写进确认摘要（`security-gateway.ts` 的 `summary.fields.unshift`），不做归属或类型裁决。
手工路径只暴露两个工具名：`manual_add_card`（新增 DEBIT/CREDIT/VIRTUAL 记录）与 `manual_delete_card`（删除记录）；没有补办、冻结、解冻或限额操作。
卡片页也没有补办入口，补办只能由代理发起（见 `docs/cn/card-management.md`）。
`agentEnabled === false` 的拒绝分支存在于 `permission-engine.ts`、`agent/confirmation/gated-execution.ts`、`security-gateway.ts`（确认与取消）与 `agent/tools/index.ts`，但当前没有任何目录项设为 `false`；物理卡的创建/删除只能手工，是因为目录里不存在这类工具名，而不是被该开关拦住。
模型对「实体卡只能手工办理」的措辞来自 `agent/system-prompt.ts:38`，服务端无此规则。

## 待处理操作（PendingAction）的创建路径

`PendingAction` 行只由两个创建点产生。
主路径：模型的工具调用 → agent `beforeToolCall`（`agent/banking-agent.ts`）→ `securityGateway.handleToolCall`（`security-gateway.ts`）→ `gatewayCreatePendingAction` → 仓储 `createPendingAction`（`lib/db/repositories/pendingAction.ts#createPendingAction` → `client.pendingAction.create`）。
纯文本回复不经过 `beforeToolCall`，因此不会创建任何 `PendingAction`，也不会出现确认/MFA 面板。
`gatewayCreatePendingAction` 落库状态：`ev.requiresMfa ? 'awaiting_mfa' : 'pending'`；RED 同时铸造 MFA 挑战。
它还可能返回 `{ kind: 'clarify' }`（转账收款人或卡片目标无法唯一解析，不落库）或 `{ kind: 'plan_cancelled' }`（所属计划已取消，不落库）。
计划节点（`submit_plan` 之后）经 `agent/confirmation/gated-execution.ts` 以 `taskId`/`nodeId` 复用同一 `handleToolCall` 路径。
独立路径：`manual-card-management.ts#proposeCardChange`（`POST /api/cards`）直接 `pendingAction.create`，工具名 `manual_add_card`/`manual_delete_card`，被 `app/api/actions/route.ts` 显式过滤，不出现在主确认面板。`addDemoCardSchema` 另接受可选 `linkedAccountId`（VIRTUAL 卡的结算账户绑定），`toChange` 将其透传到 `CardChange`；该绑定的账户归属与类型由 SDK 在服务端校验。

## 收款人与卡片的身份解析

`recipient-resolution.ts` 与 `card-resolution.ts` 在 park 阶段只读调用者本人的数据，把选择器解析为唯一 id。
`resolveTransferRecipient` 接受 `contactId`、`name` 与 `phone`：先用 `phoneIdentityMatches` 做身份判定，脱敏 `phone` 只做候选唯一化；成功时 `canonicalizeTransferArgs` 写入 `contactId` 并删除 `phone` 与 `name`。
`resolveCardTarget` 接受 `cardId`、`cardType`、`cardTail` 与 `cardNumber`：每个字段只匹配自己的面，成功后 `canonicalizeCardArgs` 写入 `cardId` 并删除其余 3 个选择器。
两者都返回 `resolved`、`not_found`、`ambiguous` 或 `invalid`，都不抛错、不写库。
`gatewayCreatePendingAction` 在进入参数归一化之前解析卡片目标，`CARD_TARGET_TOOLS` 的 6 个写工具都走这条路径。
把尾号或完整卡号写进 `cardId` 返回 `invalid`，不退化为按尾号查询。
澄清文本由 `buildRecipientClarifyMessage` 与 `buildCardClarifyMessage` 生成，只含脱敏值。
`Contact.phoneFull` 与 `Card.numberFull` 不离开存储层。
规则见 `docs/cn/identity-resolution.md`。

## 赎回报价

`gatewayCreatePendingAction` 在挂起时用服务端决定铸造赎回报价。
赎回口径必须显式给出：`mode` 取 `SHARES`、`AMOUNT` 或 `ALL`，没有默认口径。
缺少口径、沿用已废止的 `redeemAmount`、或口径与参数混用时抛 `VALIDATION`，并在落库前拒绝。
`SHARES` 用请求份额，`AMOUNT` 用 SDK 的 `sharesFromAmount` 折算份额，`ALL` 用持仓全部份额。
到账金额用 SDK 的 `settlementFromShares` 结算，与 `banking-sdk/investment.ts` 同源，报价与结算不会分歧。
金额口径超过持仓市值时同样拒绝，并提示改用全额或按份额赎回。
持仓未记录份额时抛 `CONFLICT`，产品未发布净值时抛 `VALIDATION`，两者都不铸造报价。
确认摘要固定展示赎回口径、赎回份额、成交净值、净值日期、预计到账金额与费用口径。
摘要金额是预计到账金额，不是本金；费用口径为 `feeAmount: '0.00'` 与 `feeRule: 'SIMULATED_NONE'`。
快照字段为 `expectedShares`、`expectedNetValue`、`expectedNetValueDate`、`expectedSettlementAmount`。
快照字段属于服务端报价，重复挂起时不计入请求身份（`requestArgs`）。
快照字段同时进入命令指纹，口径或金额变化会作废旧授权。
执行时快照与当前净值、份额或重算金额不一致即抛 `CONFLICT`（`净值或持仓已变化，请重新确认`）。
该次执行零写入，`PendingAction` 置为 `failed`，用户必须重新确认。
同身份重放不重新报价，返回原始回执与原净值。
本层只快照报价，不改变余额。

`mfa.ts` 把 5 分钟墙钟挑战绑定到命令，保留有效尝试并记录消费。
`step-up-authenticator.ts` 是明确的演示适配器，不发送短信。
不支持的模式必须失败。
真实短信供应商与已认证的员工或用户身份属于独立的生产工作。

## MFA 尝试限制

`MFA_MAX_ATTEMPTS`（`lib/constants.ts`）= 3，熔断在「第 3 次」失败即触发（`failures >= max`，非第 4 次）。
`security-gateway.ts` 的 MFA 分支以领域结果返回状态（不抛出）：
未达上限 → `status: 'awaiting_mfa'`、消息「验证码错误，请重试。剩余尝试次数：N。」；
达到上限 → `status: 'locked'`、`code: 'CIRCUIT_OPEN'`、消息「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」；
已锁定后的再次提交走提前熔断分支 → `status: 'locked'`、消息「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」。
锁定态返回值仍带 `requiresMfa: true`，但 HTTP 路由由 `status` 推导出的 `mfaResult` 变为 `failed`，且不发出 `mfa_required` 流事件。
真正的终态锁定会以「仅从 `pending`/`awaiting_mfa` 出发」的 CAS 把 `PendingAction.status` 落库为 `'locked'`；该行因此不再作为待决策项返回，也不再发出 `mfa_required`，MFA 弹窗不会重现；对已是 `'locked'` 的行再次授权幂等返回同一拒绝。
`mfa.ts#verify` 返回 `Result` 而非抛错；抛 `CIRCUIT_OPEN` 的只有 `circuit-breaker.resetSession` 与 `execution-policy.assertSessionMayWrite`。
成功验证码重置连续失败计数，但不解除已触发的熔断（「locked 优先」）；仅 `resetSession` 以验证码或 60 秒冷却解除。

`injection-guard.ts` 检测可疑指令。
`incidents.ts` 在一个事务中持久化去重信号、相关安全事件与账户级锁定。
`circuit-breaker.ts` 应用验证失败锁定与已审计的冷却重置。
锁定由该用户的各会话共享。

`execution-policy.ts` 在真实事务客户端上检查写权限。
`recovery-authorization.ts` 只授予当前允许的新恢复效果。
已验证的收据绕过新写入，并在锁定期间保持可恢复。
未知结果不等于失败，不得盲目重试。

模型工具不包含任意代码、SQL、shell、文件与外部 HTTP。
公开日志读取器不包含原始思维与凭据。
资金结论由银行智能体根据 SDK 与收据事实渲染。
见 `docs/cn/security.md` 与 `docs/cn/known-risks.md`。