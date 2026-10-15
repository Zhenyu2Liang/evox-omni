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
`replace_card` 与 `apply_virtual_card` 属于 RED 写操作。

`security-gateway.ts` 校验归属资源、记录确定性授权决定并创建待确认操作。
确认采用原子认领，并重新评估累计风险。
开放的人工接管阻断新的执行认领；已授权的在途命令仍可落地。
`authorization-record.ts` 记录策略版本、命令指纹、原因与脱敏输入。

## 赎回报价

`gatewayCreatePendingAction` 在确认前用服务端决定铸造赎回报价。
请求本金 `redeemAmount` 缺省或等于持仓本金时，按全部赎回报价。
`redeemAmount` 小于持仓本金时，按部分赎回报价。
`redeemAmount` 大于持仓本金时抛出 `VALIDATION`，并在落库前拒绝。
两类赎回复用 SDK 的 `settledRedemptionAmount` 与 `valuationToMinor`。
报价与结算同源，金额不会分歧。
`redeemAmount` 属于请求身份，重复挂起时参与去重。
`expectedRedemptionAmount` 属于服务端报价，重复挂起时沿用原报价。
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