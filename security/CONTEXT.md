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

## 已知问题

MFA 验证码连续错误达到上限时，`mfa.ts#verify` 只把 `MfaChallenge.status` 置为 `locked`，`PendingAction.status` 不会离开 `awaiting_mfa`。
本层没有任何代码写入 `PendingAction.status = 'locked'`，`'locked'` 仅作为结果状态存在于契约中，从不落库。
因此 `app/api/actions/route.ts` 仍把该操作当作待决策项返回，客户端 MFA 弹窗被反复恢复。
`authorizeAction` 熔断分支返回 `{ok:false, status:'locked', code:'CIRCUIT_OPEN'}` 且不带 `mfaResult`；错误验证码分支返回 `mfaResult:'failed'`。
修复归属 `./agent`（`confirmation.ts`、`confirmation/outcomes.ts#blockedOutcome`）与 `app/api/actions/[id]/verify/route.ts`；服务端没有事件通知客户端关闭 MFA 弹窗。
