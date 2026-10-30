# 术语表

[English](../en/terms.md) | **简体中文**

中文说明使用下表名称。
代码标识、接口名和状态值保留英文原文。

| 中文名称 | 英文或代码标识 | 含义 |
| --- | --- | --- |
| 银行智能体 | Agent | 理解请求并提出银行工具调用的运行组件 |
| 微信通道 | `channels/weixin/` | 把扫码绑定用户的文字私聊交给银行智能体的通信进程 |
| 回复队列 | outbox | 发送前保存的回复及发送进度，用于失败重发 |
| 运行 | `AgentRun` | 一次已登记输入的执行过程 |
| 模型请求 | `ModelRequest` | 一轮已保存上下文的模型服务请求 |
| 工具调用 | `ToolInvocation` | 具有服务端身份的单次工具执行 |
| 事件日志 | `AgentRunEvent` | 按运行内序号保存的事件 |
| 操作记录 | `ActivityRecord`、`/activity` | 普通用户查看的业务事件，包含类型、时间、状态和验证事实 |
| 操作审计 | `AuditEntry`、`/audit` | 开发者模式中的风控决策与执行证据，包含技术详情 |
| 开发者模式 | developer mode | 演示诊断与维护的显示偏好，不构成生产管理员认证 |
| 检查点 | checkpoint | 能恢复执行的完整持久化状态 |
| 执行租约 | lease | 有时限的执行所有权 |
| 提交校验 | fence | 提交时检查执行者仍持有所有权 |
| 执行键 | operation key | 用于识别和去重业务操作的服务端键 |
| 输入摘要 | request digest | 规范输入的摘要，用于识别参数变化 |
| 身份判定 | identity、`phoneIdentityMatches` | 用完整号码逐字符相等确定唯一对象，可以绑定执行对象 |
| 候选筛选 | candidate、`phoneCandidateMatches` | 用脱敏号码或数字片段收窄候选，不绑定执行对象 |
| 身份解析 | resolution | 服务端在 park 阶段把选择器解析为唯一资源 id |
| 澄清 | clarification | 请求缺少必需信息时的拒绝结果，要求补齐字段，不套用默认值 |
| 信息完整性 | `needsInput` | 是否还需补充本轮办理信息；`false` 不代表已授权 |
| 模型调用预算 | `ModelBudgetState` | 单轮模型调用的总次数、预留 token 与总时长上限 |
| 完整号码 | `Contact.phoneFull`、`Card.numberFull` | 仅供服务端精确匹配的虚构完整手机号或卡号 |
| 掩码 | mask、`lib/mask.ts`、`numberMasked` | 展示用脱敏号码，只保留末 4 位 |
| 卡尾号 | `cardTail` | 卡号末 4 位，只用于收窄候选 |
| 执行回执 | `ExecutionReceipt` | 已提交业务的完整原结果 |
| 重放 | replay | 读取并返回已保存的原结果 |
| 重试 | retry | 重新执行同一调用，并增加尝试次数 |
| 恢复 | recovery | 从持久化状态继续原运行或工作流 |
| 人工核对 | reconciliation | 结果不能证明时，由人工核对证据 |
| 待确认操作 | `PendingAction` | 等待用户确认或认证的原操作 |
| 多因子认证 | MFA | 高风险操作的强化身份认证机制 |
| 验证码挑战 | `MfaChallenge` | 绑定原操作和命令摘要的一次验证记录 |
| 挑战已消费 | `consumed` | 挑战已被一次判断用掉的形态；再验证按终态拒绝处理，不重发挑战 |
| 挑战已过期 | `expired`、`command_changed` | 挑战超出有效期或命令已变化的形态；网关据此重签挑战 |
| 拒绝原因判定 | `mfa.attemptState`、`mfa.challengeInvalidation` | 本操作是否用尽尝试、挑战为何不可用的唯一来源 |
| 冲突 | `CONFLICT` | 状态已变化或快照不再匹配时的拒绝结果，本次不写入 |
| 结构化安全失败 | `SecurityFailure` | 拒绝时由服务端给出的类型化字段，调用方据此渲染文案 |
| 锁定 | `locked` | 验证码失败达上限后操作进入的终态；账户解锁不改变该状态 |
| 安全熔断 | circuit breaker、`security/circuit-breaker.ts` | 连续失败达上限后按账户所有者（`user:<userId>`）实施的限制，覆盖该所有者的每个工具调用 |
| 封存 | seal、`sealReason` | 计划层把节点判为不可继续驱动的处理，原因是锁定拒绝或操作已离开开启状态 |
| 对外文案收口 | `lib/public-text.ts`、`lib/tool-feedback.ts` | 内部诊断转成用户可见文本的唯一出口 |
| 内部标记 | internal diagnostic、`lib/internal-text.ts#isInternalDiagnostic` | 协议载荷、JSON 片段与堆栈等诊断文本，不进入公开文本 |
| 工作流 | workflow | 由节点及依赖组成的业务执行过程 |
| 有向无环图 | DAG | 没有循环依赖的任务图 |
| 预算额度 | budget envelope | 记账预算，不冻结可提现资金 |
| 入账金额 | booked amount | 已提交账本的整数分金额 |
| 估值 | valuation | 尚未舍入为入账金额的价值估计 |
| 结算 | settlement | 把未取整估值按 `HALF_UP` 舍入一次到分的写入口径 |
| 年化收益率 | `annualYieldRate` | 无量纲比例，展示时转换为百分数 |
| 净值 | `latestNetValuePerUnit` | 每份持仓的价格，规范十进制文本，保留 4 位小数 |
| 份额 | `shares` | 持有份数，规范十进制文本，保留 6 位小数 |
| 净值日期 | `latestNetValueDate` | 净值对应的业务日期，按 UTC+08:00 展示 |
| 持仓市值 | `marketValue` | `份额 × 净值` 的未取整估值 |
| 剩余持仓成本 | `principalAmountMinor` | 赎回后剩余的持仓成本，按份额比例扣减 |
| 持仓收益 | unrealized profit | 未实现收益，等于持仓市值减剩余持仓成本 |
| 已实现收益 | `realizedProfitMinor` | 每次赎回的到账金额与其消耗成本之差，可为负 |
| 累计收益 | cumulative profit | 已实现收益与持仓收益之和 |
| 全额赎回 | full redemption、`ALL` | 赎回全部份额并关闭持仓 |
| 部分赎回 | partial redemption、`SHARES`、`AMOUNT` | 赎回部分份额，剩余份额与成本继续持有 |
| 赎回模式 | redemption mode、`mode` | `SHARES`、`AMOUNT` 或 `ALL`；缺失或混用按澄清拒绝 |
| 追加申购 | `addedToExisting` | 对已持有产品再次申购，并入现有持仓 |
| 银行业务工具库 | SDK、`banking-sdk/` | 执行所属用户的模拟银行业务 |
| 借记卡 | `DEBIT` | 绑定本人活期账户、消费扣减账户现金的银行卡 |
| 信用卡 | `CREDIT` | 使用授信额度、不绑定结算账户的银行卡 |
| 虚拟卡 | `VIRTUAL` | 由卡片页或智能体申请、绑定本人活期账户的虚拟借记卡 |
| 结算账户 | settlement account、`Card.linkedAccountId` | 借记卡与虚拟卡消费所扣减的本人活期账户 |
| 关联状态 | `linkedAccountStatus` | 卡片与结算账户的关联结果：`LINKED`、`MISSING`、`UNTRUSTED`、`NOT_APPLICABLE` |
| 账户余额 | `accountAvailableBalance` | 结算账户的可用现金 |
| 可用余额 | `payableAmount` | 本卡当前可消费金额，取账户余额与剩余月限额的较小值 |
| 可用状态 | `usable` | 卡片当前能否消费，等于 `status` 为 `ACTIVE` |
| 挂失 | `LOST` | 卡片终态，不能冻结、解冻或再次挂失，只能补办 |
| 补办 | replacement、`replaceCard` | 用新卡替代已挂失卡片，原卡保持 `LOST` |
| 月限额 | `monthlyLimit` | 卡片当月累计消费上限，按补办前后各卡合并计算 |
| 卡消费 | `CardConsumption` | 一笔成功的本地模拟消费记录，含金额、类别、商户与服务端消费时刻 |
| 有符号 64 位整数 | INT64 | 当前已入账金额的数据库存储范围 |
| 绿色权限 | GREEN | 当前策略允许自动执行 |
| 黄色权限 | YELLOW | 执行前需要用户确认 |
| 红色权限 | RED | 执行前需要多因子认证 |
| 模拟模型 | mock | 使用脚本回复，不联系模型服务商 |
| 在线模型 | live | 请求已配置的模型服务商 |

MFA 的全称是 Multi-Factor Authentication。
DAG 的全称是 Directed Acyclic Graph。
SDK 的全称是 Software Development Kit。
当前 MFA 使用模拟验证码，能力边界见[当前限制](known-risks.md)。
