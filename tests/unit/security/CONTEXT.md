# 安全策略测试

## 范围

测试覆盖权限表、累计转账、所有权与原子授权。
也覆盖收款人解析、验证码挑战、熔断与注入信号。

权限来自 `lib/contracts/tool-catalog.ts` 与安全策略。
测试必须核对有效权限和实际资金状态。
不同会话的同一用户仍共享累计金额与熔断状态。

## 终止锁定（locked）结果的覆盖边界

网关有两条独立的 `status: 'locked'` 分支，本目录只覆盖第一条：

1. `lockedOutcome()`（`security/security-gateway.ts`）：会话已锁 → 即便提交正确验证码也拒绝。
   `gateway.test.ts`（`locked session (breaker tripped) → refused, status 'locked', even with the correct code`）与
   `authorize-hardening.test.ts`（`a locked session refuses a confirm with status 'locked' (row moved to 'locked')`）
   先用 `circuitBreaker.recordFailure` 循环触发熔断，再提交 `MFA_CODE`，断言 `ok`/`status` 与持久化行状态。
2. `authorizeWithMfa` 的第三次错误验证码分支（返回 `mfaResult: 'failed'`、`code: 'CIRCUIT_OPEN'`、
   `message: '验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。'` 并把行 CAS 落为 `locked`）
   在本目录**无**用例：`gateway.test.ts` 的错误码用例只错一次，`mfa.test.ts`/`mfa-audit.test.ts` 直接调 `mfa.verify` 而不经网关。

锁定断言只核对这些机器事实：
`res.ok === false`、`res.status === 'locked'`、`res.mfaResult` 为 `undefined`（分支 1）或 `'failed'`（分支 2）、
`message` 仅断言「不含验证码」、持久化 `PendingAction.status === 'locked'`、`MfaChallenge.status === 'locked'`、
`MfaVerifyResult.locked`、`blockReason === 'HIGH_RISK_BLOCKED'`、`code: 'CIRCUIT_OPEN'`。
中文锁定文案与 i18n 键（`chat.error.securityLocked`）在本目录无断言。

拒绝类断言使用 `AppError` 的 `code`：`CIRCUIT_OPEN`（熔断 / 解锁被拒）与 `SECURITY_DENIED`（所有权不符）。
`execution-policy.test.ts` 是唯一直接守住「写入前 `isLocked(tx)` → `CIRCUIT_OPEN`」的用例。
`injection-guard.test.ts` 反向守住注入信号**不**触发熔断（`locked: true` 行数为 0）。

锁定状态的展示断言在 [../planner/CONTEXT.md](../planner/CONTEXT.md)：
`tool-diagnostics.test.ts` 渲染 `MfaCard`/`ConfirmationCard` 的 `locked` 状态（`cards.terminal.locked`）、
`action-contract.test.ts` 与 `action-attention-state.test.ts` 处理 `action_settled` `locked` 与 `MFA_FAILED` 事件。

## 关键边界

- 小额转账仍需确认。
- 日累计超过 `1000.00` 时需强验证。
- 已入账操作不能重复计入在途累计。
- 验证码需绑定操作，过期或消费后不能复用。
- 审计失败时，关键状态变化必须回滚。
- 重复、并发与取消决定必须保留真实执行事实。
- 注入检测不能替代代码中的权限判断。

熔断使用数据库持久化的所有者身份。
隔离用户与会话的规则见
[../../CONTEXT.md](../../CONTEXT.md)。
冷却测试需覆盖真实默认时钟。
固定演示时钟不能用于等待冷却。

运行：`pnpm exec vitest run tests/unit/security`。
根配置的 `hookTimeout` 为 60 秒。
不得再声明根配置缺少钩子超时设置。
