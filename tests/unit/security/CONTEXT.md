# 安全策略测试

## 范围

测试覆盖权限表、累计转账、所有权与原子授权。
也覆盖收款人解析、验证码挑战、熔断与注入信号。

权限来自 `lib/contracts/tool-catalog.ts` 与安全策略。
测试必须核对有效权限和实际资金状态。
不同会话的同一用户仍共享累计金额与熔断状态。

入口分工：
`mfa.test.ts` / `mfa-audit.test.ts` 直接调 `@/security/mfa`（`issueChallenge`/`verify`），不经网关；
`mfa-failure-contract.test.ts` / `gateway.test.ts` / `authorize-hardening.test.ts` / `circuit-breaker-audit.test.ts` 经 `securityGateway.authorizeAction` / `evaluate` / `handleToolCall`；
`circuit-breaker*.test.ts` 直接调 `@/security/circuit-breaker`。
安全事件落 `securityEvent` 表，不是 `auditLog`。

## 终止锁定（locked）结果的覆盖边界

网关有三条独立的 `status: 'locked'` 出口（`security/security-gateway.ts`），本目录三条都有用例：

1. `authorizeWithMfa` 第三次错误验证码：`mfa-failure-contract.test.ts` 覆盖。
   前两次 `status:'awaiting_mfa'`、`code:'MFA_FAILED'`、`failure.reason:'mfa_code_invalid'`、`attemptsLeft` 2→1；
   第三次 `status:'locked'`、`failure.code:'MFA_LOCKED'`、`failure.reason:'mfa_attempts_exhausted'`、`attemptsUsed:3`、`attemptsLeft:0`，并把 `PendingAction` 与 `MfaChallenge` 落为 `locked`。
   该用例不断言第三次的 `result.code`（源码为 `'CIRCUIT_OPEN'`）与 `mfaResult`。
2. 已锁动作的重复提交（`lockedOutcome(..., 'mfa_session_locked')`）：`mfa-failure-contract.test.ts` 用**正确**验证码重投，
   断言 `status:'locked'`、`code:'CIRCUIT_OPEN'`、`failure.reason:'mfa_session_locked'`、`attemptsLeft:0`，挑战条数与尝试数不变、无新交易。
3. 熔断闸门（`lockedOutcome(..., 'circuit_open')`）：`gateway.test.ts`（`locked session (breaker tripped) → refused, status 'locked', even with the correct code`）与 `authorize-hardening.test.ts`（`a locked session refuses a confirm with status 'locked' (row moved to 'locked')`）
   先用 `circuitBreaker.recordFailure` 循环触发熔断，再提交 `MFA_CODE`，断言 `ok`/`status`/`mfaResult === undefined` 与持久化行状态；两条都**不**断言 `code`/`failure`。

锁定断言核对的机器事实：
`res.ok === false`、`res.status === 'locked'`、`failure.{code,reason,actionId,attemptsUsed,attemptsLeft,maxAttempts}`（仅出口 1、2）、
`res.mfaResult` 为 `undefined`（出口 3）或 `'failed'`（出口 1，只有 `../../app` 断言）、
`message` 只做负例断言（不含验证码、不含 `__SECURITY_BLOCK__`）、
持久化 `PendingAction.status === 'locked'`、`MfaChallenge.status === 'locked'`、
`MfaVerifyResult.locked`、`blockReason === 'HIGH_RISK_BLOCKED'`。
`failure` 一律用 `toMatchObject`，字段多/少都不会被发现。
中文锁定文案与 i18n 键（`chat.error.securityLocked`）在本目录无断言。

拒绝类断言使用 `AppError` 的 `code`：`CIRCUIT_OPEN`（熔断 / 解锁被拒）与 `SECURITY_DENIED`（所有权不符）。
`execution-policy.test.ts` 是唯一直接守住「写入前 `isLocked(tx)` → `CIRCUIT_OPEN`」的用例。
`injection-guard.test.ts` 反向守住注入信号**不**触发熔断（`locked: true` 行数为 0）。

锁定状态的展示断言在 [../planner/CONTEXT.md](../planner/CONTEXT.md)：
`tool-diagnostics.test.ts` 渲染 `MfaCard`/`ConfirmationCard` 的 `locked` 状态（`cards.terminal.locked`）、
`action-contract.test.ts` 与 `action-attention-state.test.ts` 处理 `action_settled` `locked` 与 `MFA_FAILED` 事件。

## 文案改写时必须核对的断言形状

锁定拒绝的 `message` 在本目录只有负例断言，改写文案安全：
`gateway.test.ts:179/388/442/466`、`authorize-hardening.test.ts:201`、`authorize-concurrency.test.ts:191`、`transfer-limits-concurrency.test.ts:191/289` 均为 `not.toContain(MFA_CODE)`；
`mfa-failure-contract.test.ts:101-102/124/157` 为 `not.toContain('__SECURITY_BLOCK__')`；
`circuit-breaker-audit.test.ts:84-85`、`circuit-breaker-reset.test.ts:117-118` 只断言 `SecurityEvent.message` 非空。

改写文案、删除 `__SECURITY_BLOCK__` 原文透传或调整工具错误映射时，下列**精确形状**断言会失败，必须同时核对：

- `gateway.test.ts:190` 与 `:538-541`/`:554-557`：`serializeBlockReason`/`parseBlockReason` 的往返对象 `toEqual` 恰好 `{ actionId, decisionKind }` 两键，收窄/加键都会失败。
- `gateway.test.ts:202-234`：`parseBlockReason` 对无前缀 JSON、缺/空 `actionId`、缺/非法 `decisionKind` 一律 `toBeNull()`；把 deny 载荷改成可解析（返回部分对象）会打破这些用例。
- `gateway.test.ts:464`、`authorize-hardening.test.ts:262`：熔断分支的 `mfaResult` 必须 `toBeUndefined()`；在 `lockedOutcome` 上补 `'failed'` 会失败。
- `mfa-failure-contract.test.ts:77-84/90-97/116-123/150-156`：`failure` 用 `toMatchObject` 钉住 `code`/`reason`/`actionId`/`attemptsUsed`/`attemptsLeft`/`maxAttempts`，改这些字段名或取值会失败。
- `mfa.test.ts:174-178`/`:227-231`、`mfa-audit.test.ts:131-135`：`verify()` 返回值 `toEqual` 恰好 `{ ok, attemptsLeft, locked }` 三键。
- `mfa-audit.test.ts:83-91`：`MFA_FAILURE.detail` `toEqual` 恰好 7 键；`circuit-breaker-audit.test.ts:86-90`：熔断 `detail` `toEqual` 恰好 3 键。
- `gateway.test.ts:173`：四条决策的 `kind` 序列 `['allow','require_confirmation','require_mfa','deny']`。
- `execution-policy.test.ts:7`：`vi.mock('@/security/circuit-breaker', () => ({ isLocked: ports.locked }))` 只暴露 `isLocked`，`security/execution-policy.ts` 新增任何该模块导入都会失败。
- `gateway.test.ts:280`、`circuit-breaker-audit.test.ts:177`：锁定态 `blockReason` 必须是字面量 `'HIGH_RISK_BLOCKED'`。

## 本目录不覆盖（负向结论）

- 唯一的网关层「三次错码」用例是 `mfa-failure-contract.test.ts`；`gateway.test.ts` 的网关错码用例仍只错一次。
- 没有 `persistLockedAction` 的 CAS 负例：`claimPendingAction({ from: ['pending','awaiting_mfa'], to: 'locked' })` 只有正向断言，已终态行不被覆盖没有直接用例。
- `__SECURITY_BLOCK__` 只在本目录一处作负例（`mfa-failure-contract.test.ts:101-102/124/157`，检查 `message` 与 `failure.reason`）；没有 `SecurityEvent.detail`/`message` 的 marker、`decisionKind`、栈或原始 JSON 断言。
- 没有 turn 级 `security_event{kind:'locked', message}` 形状或内容断言（只断言 DB 级 `SecurityEvent` 行：`MFA_FAILURE`/`CIRCUIT_BREAKER_TRIPPED`/`SECURITY_RESET`/`INJECTION_ATTEMPT`）。
- 没有断言 `decisionKind === 'deny'` 之外的 deny 载荷文本，也没有断言 deny 载荷不含 `actionId`。
- 没有 `mfa_required` 事件断言，也没有「锁定后不再 surface」的 `GET /api/actions` 断言（那在 `../../app`）。
- 不调用 `publicToolError`/`publicToolSummary`，不断言 `chat.error.toolFailed` 或 `chat.error.securityLocked`；工具错误映射的唯一覆盖在 `../planner/tool-feedback.test.ts`。
- 解锁路径（`POST /api/security/reset`、`lockedActionsReopened`、旧 `PendingAction` 保持 `locked`、解锁后新请求得到新 id）不在本目录，见 `../../app`；本目录只覆盖熔断器层 `resetSession` 与 `SECURITY_RESET` 审计。

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
