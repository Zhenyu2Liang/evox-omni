# 术语表

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
| 执行回执 | `ExecutionReceipt` | 已提交业务的完整原结果 |
| 重放 | replay | 读取并返回已保存的原结果 |
| 重试 | retry | 重新执行同一调用，并增加尝试次数 |
| 恢复 | recovery | 从持久化状态继续原运行或工作流 |
| 人工核对 | reconciliation | 结果不能证明时，由人工核对证据 |
| 待确认操作 | `PendingAction` | 等待用户确认或认证的原操作 |
| 多因子认证 | MFA | 高风险操作的强化身份认证机制 |
| 工作流 | workflow | 由节点及依赖组成的业务执行过程 |
| 有向无环图 | DAG | 没有循环依赖的任务图 |
| 预算额度 | budget envelope | 记账预算，不冻结可提现资金 |
| 入账金额 | booked amount | 已提交账本的整数分金额 |
| 估值 | valuation | 尚未舍入为入账金额的价值估计 |
| 年化收益率 | `annualYieldRate` | 无量纲比例，展示时转换为百分数 |
| 全额赎回 | full redemption | 赎回持仓全部本金，持仓状态由持有变为已赎回 |
| 部分赎回 | partial redemption、`partial` | 赎回本金小于持仓本金，剩余本金继续持有 |
| 剩余本金 | `remainingPrincipal` | 赎回本金小于持仓本金时，持仓剩余的本金 |
| 追加申购 | `addedToExisting` | 对已持有产品再次申购，并入现有持仓 |
| 银行业务工具库 | SDK、`banking-sdk/` | 执行所属用户的模拟银行业务 |
| 借记卡 | `DEBIT` | 绑定本人活期账户、消费扣减账户现金的银行卡 |
| 信用卡 | `CREDIT` | 使用授信额度、不绑定结算账户的银行卡 |
| 虚拟卡 | `VIRTUAL` | 由卡片页或智能体申请、绑定本人活期账户的虚拟借记卡 |
| 结算账户 | settlement account、`Card.linkedAccountId` | 借记卡与虚拟卡消费所扣减的本人活期账户 |
| 关联状态 | `linkedAccountStatus` | 卡片与结算账户的关联结果：`LINKED`、`MISSING`、`UNTRUSTED`、`NOT_APPLICABLE` |
| 账户余额 | `accountAvailableBalance` | 结算账户的可用现金 |
| 可用余额 | `payableAmount` | 本卡当前可消费金额，取账户余额与剩余月限额的较小值 |
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
