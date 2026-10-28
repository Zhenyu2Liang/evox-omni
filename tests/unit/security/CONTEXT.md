# 安全策略测试

## 范围

`http-write-boundary.test.ts` 覆盖可信地址、同源与请求体边界。
读取请求仍校验 Host，写入另校验 Origin 和正文类型。
页面与静态请求的 Proxy 行为见 `../../app/request-host-proxy.test.ts`。
测试覆盖权限表、累计转账、所有权与原子授权。
也覆盖收款人解析、验证码挑战、熔断与注入信号。

权限来自 `lib/contracts/tool-catalog.ts` 与安全策略。
测试必须核对有效权限和实际资金状态。
不同会话的同一用户仍共享累计金额与熔断状态。

入口分工：
`mfa.test.ts` / `mfa-audit.test.ts` 直接调 `@/security/mfa`（`issueChallenge`/`verify`），不经网关；
`mfa-failure-contract.test.ts` / `gateway.test.ts` / `authorize-hardening.test.ts` / `circuit-breaker-audit.test.ts` 经 `securityGateway.authorizeAction` / `evaluate` / `handleToolCall`；
`circuit-breaker*.test.ts` 直接调 `@/security/circuit-breaker`。
`unlock-panel-render.test.ts` / `unlock-panel-notice.test.ts` / `developer-reset-panel-hook.test.ts` 只做 `react-dom/server` 静态渲染，不连库、不调网关。
安全事件落 `securityEvent` 表，不是 `auditLog`。

## `mfa.test.ts` 的骨架与覆盖缺口

`mfa.test.ts` 直测 `@/security/mfa` 的 `issueChallenge`/`verify`/`getChallenge`（不经网关），也是本目录唯一直接调 `issueChallenge` 的文件。
setup 只在文件顶层：`vi.setConfig({ hookTimeout: 30_000 })`（`mfa.test.ts:26`，低于根配置的 60 秒）与 `useFreshDatabase()`（`:27`，为整文件注册 `beforeEach(resetDatabase)` + `afterAll(disconnect)`）。
import 直连 `../../helpers/db`、`../../helpers/fixtures`，不走 `helpers/index` barrel；文件内无 `vi.mock`、无 `vi.useFakeTimers`/`vi.setSystemTime`、无 `process.env`。
`seedAction()`（`:35-52`）用仓库 `createPendingAction` 造前置动作：`toolName:'transfer_money'`、`tier:'RED'`、`requiresMfa:true`、`status:'awaiting_mfa'`、`userId:DEMO_USER_ID`（`user_liming`，由 `fixtures.seedDemoData` 的 `user.create` 建成）。
不造 User/AgentSession/MfaChallenge 行：`MfaChallenge` 一律由被测的 `issueChallenge` 产生。
每例 `newSessionId()` = `newId('sess_mfa')`（`:30-32`），没有对应 `AgentSession` 行（`PendingAction.sessionId` 无外键，`prisma/schema.prisma:418-448`），熔断所有者因此落到 `session:<该 id>` 兜底键（`security/circuit-breaker.ts:121-127`），而不是用户级 `user:user_liming`；隔离来自每例唯一 id 加 `truncateAll()` 清 `circuitBreakerState`。
文件头“in-process breaker keyed by sessionId”的注释与实现不符：熔断状态是持久化、按所有者键的表（`security/circuit-breaker.ts:1-6`、`prisma/schema.prisma:465-479`）。
本文件不用任何假时钟：`expiresAt` 从不出现，challenge 有效期恒为 `realNow() + MFA_CHALLENGE_TTL_MS`（常量 `security/mfa.ts:34`，两处写入点 `:189`、`:199`）。
因此以下 `security/mfa.ts` 分支不被本文件触达，改动它们时不会有本文件报错保护：
`issueChallenge` 的 `locked` 动作 `MFA_LOCKED` 拒绝（`:167-169`）、已执行/已取消的 `CONFLICT` 拒绝（`:173-175`）、已 `locked` challenge 直接回 `toView` 而不重置计数（`:183`）、过期或 `commandDigest` 不符时的重建（`:184-192`）；
`verify` 的 `consumed`/`expired`/`command_changed` 拒绝（`:228-234`，`ChallengeInvalidError`）、`locked` 动作与已锁会话/已锁 challenge 的 `locked:true` 短路（`:241-254`）、已 `verified` challenge 的短路（`:257-263`）。
`tests/unit/security` 全目录不出现 `expiresAt`；`MfaChallenge.expiresAt` 的改写只出现在 `tests/integration/confirmed-write-authority.test.ts:60,97-99,112,144`（恒为 `new Date(Date.now() - 1)`，另两例改 `consumedAt`/`commandDigest`）与 `tests/integration/refactor-security-runtime.test.ts:68`。
`confirmed-write-authority.test.ts:97-99` 的三态（`expired`/`consumed`/`changed_digest`）是在 `pauseAtWriteFence()` 屏障处改写，用来证明网关授权通过之后、扣款之前仍会复核 challenge。
`tests/integration/confirmation-lease-contention.test.ts:76` 改的是 `PendingAction.executionLeaseExpiresAt`（执行租约），与验证码有效期无关，不得混为一谈。
`tests/integration/frontend-followup-fixes.test.ts:152` 用 `mfaChallenge.updateMany({ status: 'locked', attempts: 3 })` 直造锁定行（非过期）。

## 安全中心解锁面板（`/security`）的渲染契约

`app/security/page.tsx` 是 await `cookies()`/`requireIdentity()`/DB 的 async Server Component，Node 测试无法调用，**页面本身不在本目录测试**。
`unlock-panel-render.test.ts` 与 `unlock-panel-notice.test.ts` 共用同一套 harness 直测页面无条件渲染的 `app/security/UnlockPanel.tsx`（`createElement` + `renderToStaticMarkup`，
`vi.mock('next/navigation')` 提供 `useRouter`，`LocaleProvider` 固定 `zh-CN`，期望值取 `createTranslator('zh-CN')` 与 `*.zh-CN.json` 真值；
两者都先用 `markup.replace(/<!-- -->/g, '')` 去掉 React 的相邻文本分隔注释，再断言人读文本）。
前者管属性、输入形态与不外泄，后者管解锁语义的四段文案与 `data-unlock-reinitiate` 钩子：

- 锁定态（`locked:true, failures:3, maxAttempts:3, lockedActionCount:1`）：根节点 `data-unlock-panel` 与 `data-unlock-locked="true"`、
  `data-unlock-failures="3"`、`data-unlock-max-attempts="3"`、`data-unlock-locked-actions="1"`，
  以及影响块 `data-unlock-impact="1"`（`security.breaker.lockedDescription` + `pages.activity.status.locked` + 计数）。
- 文案：`security.breaker.lockedDescription`、`chat.error.actionLocked`、`pages.security.unlockDescription` 按目录真值断言；
  `chat.error.actionLocked` 的“请在安全中心解除限制后重新发起操作”一并断言，钉住解锁语义的“重新发起”半边。
- 输入：恰好一个 `<input>`，`aria-label` 等于 `security.reset.codeLabel`（`6 位验证码`），
  并断言 `name="verificationCode"`、`inputMode="numeric"`、`autoComplete="one-time-code"`、`maxLength="6"`；
  提交按钮 `type="submit"` 文案为 `security.reset.unlock`，常驻结果区为 `role="status"` + `data-unlock-status="idle"`。
- 不外泄：渲染串不含 `__SECURITY_BLOCK__`、`{"decisionKind"`、栈帧（`/\n\s+at\s/` 与 `at foo.ts:1`）、`Error:`、`<script`、
  `undefined`、`[object Object]`，也不含 `lib/constants.ts#MFA_CODE` 的明文（`123456`）。
- 未锁定态（`locked:false, failures:0, maxAttempts:3, lockedActionCount:0`）：面板照常渲染
  （`data-unlock-locked="false"`、无 `data-unlock-impact`、同一 `aria-label` 验证码输入仍在），
  因此浏览器套件的“没有开发者验证码输入”类断言必须限定作用域而非断言整页。
- 解锁语义四段由 `unlock-panel-notice.test.ts` 钉住：`security.reset.lockReason`（目录模板含 `{count}`/`{max}`，插值成 `连续验证失败 3 / 3 次`）、`security.reset.lockedActionState`、`security.reset.reinitiate`、`security.reset.recovery`（`:60-73`、`:85-96`）。
- `security.reset.reinitiate` 的整句“解锁后需重新发起并重新确认，原操作不会自动执行。”以字面量 `REINITIATE`（`:35`）与 `createTranslator` 真值双重断言；
  `data-unlock-reinitiate` 必须挂在承载整句的 `<p>` 上（`:75-83`），两种熔断态都渲染该语义（`:98-126` 的钩子清单、`:128-138` 的未锁定态语义），未锁定态不出现“锁定原因：”（`:136`）。
- `data-unlock-panel`、`data-unlock-reinitiate` 与验证码输入的 `aria-label` 值就是 e2e 依赖的页面级不变量，改名须同步 `tests/e2e/`。
- 开发者专属的熔断重置入口由 `developer-reset-panel-hook.test.ts` 钉住：`app/security/ResetBreakerButton.tsx` 在开发者模式下渲染 `data-developer-breaker-reset-panel` 包裹 `data-developer-breaker-reset` 按钮与 `security.reset.developerOnly` 文案（`:43-57`），
  非开发者模式渲染空串、两个钩子都不出现（`:59-65`）；`UnlockPanel` 在两种熔断态且对非开发者都渲染，所以浏览器套件的“这里没有开发者重置入口”断言必须限定到该 panel 钩子。
- 两个用例只证明服务端渲染的属性、文案与输入形态，不证明点击、请求或解锁结果——`POST /api/security/reset` 的行为仍不在本目录（见 `../../app`）。

## 终止锁定（locked）结果的覆盖边界

网关有三条独立的 `status: 'locked'` 出口（`security/security-gateway.ts`），本目录三条都有用例：

1. `authorizeWithMfa` 第三次错误验证码：`mfa-failure-contract.test.ts` 覆盖。
   前两次 `status:'awaiting_mfa'`、`code:'MFA_FAILED'`、`failure.reason:'mfa_code_invalid'`、`attemptsLeft` 2→1；
   第三次 `status:'locked'`、`failure.code:'MFA_LOCKED'`、`failure.reason:'mfa_attempts_exhausted'`、`attemptsUsed:3`、`attemptsLeft:0`，并把 `PendingAction` 与 `MfaChallenge` 落为 `locked`。
   该用例不断言第三次的 `result.code`（源码为 `'CIRCUIT_OPEN'`）与 `mfaResult`。
2. 已锁动作的重复提交（`lockedOutcome(..., 'mfa_session_locked')`）：`mfa-failure-contract.test.ts` 用**正确**验证码重投，
   断言 `status:'locked'`、`code:'CIRCUIT_OPEN'`、`failure.reason:'mfa_session_locked'`、`attemptsLeft:0`，挑战条数与尝试数不变、无新交易。
   这里的 `code` 是**顶层** code，`failure.code` 同样为 `'CIRCUIT_OPEN'`；`status`/`code`/`failure` 三层同时被钉住。
   `mfa-failure-contract.test.ts`（`describe('security-gateway · MFA failure contract')`，64 行）的 it 与行锚点：
   `the attempt limit is 3`（65-67）、
   `reports each wrong code as a typed, retryable failure with the remaining attempts`（69-104，`first`/`second` 的 `status:'awaiting_mfa'` + `code:'MFA_FAILED'` + `failure` 六字段 1/2→2/1）、
   `the third wrong code locks the action, the challenge, and reports the terminal reason`（106-131，`third` 只断言 `failure.code:'MFA_LOCKED'` + `reason:'mfa_attempts_exhausted'`，**不断言** `third.code`）、
   `a correct code on the locked action stays locked: no new challenge, no attempt, no execution`（133-168）、
   `audits three MFA_FAILURE records with renderable counts and exactly one breaker trip`（170-188）。
   `retry`（145 行赋值）是**第 4 次**提交，用 `CORRECT_CODE = '123456'`：`submitCode(action.id, sessionId, CORRECT_CODE)`；
   149 行 `expect(retry.code).toBe('CIRCUIT_OPEN')` 断顶层 code，151 行 `failure.code` 同为 `'CIRCUIT_OPEN'`，154-155 行钉 `failure.attemptsLeft:0` + `maxAttempts`。
   与 HTTP 契约同形：第三次的顶层 code 是 `CIRCUIT_OPEN`，`MFA_LOCKED` 只出现在 `failure.code`（对照 `tests/app/mfa-lock-http-contract.test.ts:236-238`）。
3. 熔断闸门（`lockedOutcome(..., 'circuit_open')`）：`gateway.test.ts`（`locked session (breaker tripped) → refused, status 'locked', even with the correct code`）与 `authorize-hardening.test.ts`（`a locked session refuses a confirm with status 'locked' (row moved to 'locked')`）
   先用 `circuitBreaker.recordFailure` 循环触发熔断，再提交 `MFA_CODE`，断言 `ok`/`status`/`mfaResult === undefined` 与持久化行状态；两条都**不**断言 `code`/`failure`。

锁定断言核对的机器事实：
`res.ok === false`、`res.status === 'locked'`、`failure`（形状即 `lib/contracts/security.ts:26-33` 的 `SecurityFailure`：`code` + `reason` + 可选 `actionId`/`attemptsUsed`/`attemptsLeft`/`maxAttempts`；`reason` ∈ `mfa_code_invalid`/`mfa_attempts_exhausted`/`mfa_session_locked`/`circuit_open`/`manual_review_hold`/`denied`，见 `:13-19`；本目录只钉出口 1、2 的 `failure`）、
`res.mfaResult` 为 `undefined`（出口 3）或 `'failed'`（出口 1，只有 `../../app` 断言）、
`message` 只做负例断言（不含验证码、不含 `__SECURITY_BLOCK__`）、
持久化 `PendingAction.status === 'locked'`、`MfaChallenge.status === 'locked'`、
`MfaVerifyResult.locked`、`blockReason === 'HIGH_RISK_BLOCKED'`。
`failure` 一律用 `toMatchObject`，字段多/少都不会被发现。
`'MFA_LOCKED'` 与 `'mfa_attempts_exhausted'` 在本目录只同时出现在 `mfa-failure-contract.test.ts:116-123`（`toMatchObject`，无 `toBe` 全等断言可钉住该组合）；
作为**顶层** `code` 的 `'CIRCUIT_OPEN'` 只在 `mfa-failure-contract.test.ts:149`（`retry.code`）断言，`gateway.test.ts:452-471`、`authorize-hardening.test.ts:251-264`、`authorize-concurrency.test.ts` 的锁定用例都不断言 `code`/`failure`。
本目录不出现 `chat.error.securityLocked` 的断言；唯一的中文锁定文案断言属于解锁面板（`security.breaker.lockedDescription`、`chat.error.actionLocked`、`pages.security.unlockDescription`、`security.reset.*`，见上文“安全中心解锁面板”）。

拒绝类断言使用 `AppError` 的 `code`：`CIRCUIT_OPEN`（熔断 / 解锁被拒）与 `SECURITY_DENIED`（所有权不符）。
`execution-policy.test.ts` 是唯一直接守住“写入前 `isLocked(tx)` → `CIRCUIT_OPEN`”的用例。
`injection-guard.test.ts` 反向守住注入信号**不**触发熔断（`locked: true` 行数为 0）。

锁定状态的展示断言在 [../planner/CONTEXT.md](../planner/CONTEXT.md)：
`tool-diagnostics.test.ts` 渲染 `MfaCard`/`ConfirmationCard` 的 `locked` 状态（`cards.terminal.locked`）、
`action-contract.test.ts` 与 `action-attention-state.test.ts` 处理 `action_settled` `locked` 与 `MFA_FAILED` 事件。

## 文案改写时必须核对的断言形状

锁定拒绝的 `message` 在本目录只有负例断言，改写文案安全：
`gateway.test.ts:179/389/443/466`、`authorize-hardening.test.ts:201`、`authorize-concurrency.test.ts:191`、`transfer-limits-concurrency.test.ts:191/289` 均为 `not.toContain(MFA_CODE)`；
`mfa-failure-contract.test.ts:101-102/124/157` 为 `not.toContain('__SECURITY_BLOCK__')`；
`circuit-breaker-audit.test.ts:84-85`、`circuit-breaker-reset.test.ts:117-118` 只断言 `SecurityEvent.message` 非空。

改写文案、删除 `__SECURITY_BLOCK__` 原文透传或调整工具错误映射时，下列**精确形状**断言会失败，必须同时核对：

- `gateway.test.ts:190` 与 `:193-199`/`:539-542`/`:555-558`：**不带 `failure`** 时 `serializeBlockReason`/`parseBlockReason` 的往返对象 `toEqual` 恰好 `{ actionId, decisionKind }` 两键；这些用例钉的是“省略 `failure` 时载荷仍是两键”，无条件往载荷里塞 `failure` 会失败。
  `security/security-gateway.ts:780-789` 的第三参 `failure?: SecurityFailure` 只在给出时写入；`:1379`/`:1411` 的 deny 拒绝分别在载荷内带 `{code:'CIRCUIT_OPEN', reason:'circuit_open'}` 与 `{code:'SECURITY_DENIED', reason:'denied'}`。
- `gateway.test.ts:202-234`：`parseBlockReason` 对空串、无前缀 JSON、前缀后非 JSON、前缀后非对象（`null`/字符串）、缺/非法 `decisionKind` 一律 `toBeNull()`；
  **缺省或空 `actionId` 是合法载荷**（`:218-227` 断言落到 `{ decisionKind: 'require_mfa' }`，与 `security/security-gateway.ts:832` 的“`actionId` is OPTIONAL”一致），改成必填会打破这两条。
  `parseFailure`（`:793-814`）只保留 typed 字段：`code` 非空且 `reason` ∈ `FAILURE_REASONS`（`:224` 的六个 `SecurityFailureReason`），否则整个 `failure` 被丢弃；`attempts*` 只收有限数值。
- `gateway.test.ts:465`、`authorize-hardening.test.ts:262`：熔断分支的 `mfaResult` 必须 `toBeUndefined()`；在 `lockedOutcome` 上补 `'failed'` 会失败。
- `mfa-failure-contract.test.ts:77-84/90-97/116-123/150-156`：`failure` 用 `toMatchObject` 钉住 `code`/`reason`/`actionId`/`attemptsUsed`/`attemptsLeft`/`maxAttempts`，改这些字段名或取值会失败。
- `mfa.test.ts:174-178`/`:227-231`、`mfa-audit.test.ts:131-135`：`verify()` 返回值 `toEqual` 恰好 `{ ok, attemptsLeft, locked }` 三键。
- `mfa-audit.test.ts:83-91`：`MFA_FAILURE.detail` `toEqual` 恰好 7 键；`circuit-breaker-audit.test.ts:86-90`：熔断 `detail` `toEqual` 恰好 3 键。
- `gateway.test.ts:173`：四条决策的 `kind` 序列 `['allow','require_confirmation','require_mfa','deny']`。
- `execution-policy.test.ts:7`：`vi.mock('@/security/circuit-breaker', () => ({ isLocked: ports.locked }))` 只暴露 `isLocked`，`security/execution-policy.ts` 新增任何该模块导入都会失败。
- `gateway.test.ts:281`、`circuit-breaker-audit.test.ts:177`：锁定态 `blockReason` 必须是字面量 `'HIGH_RISK_BLOCKED'`。

## 本目录不覆盖（负向结论）

- 唯一的网关层“三次错码”用例是 `mfa-failure-contract.test.ts`；`gateway.test.ts` 的网关错码用例仍只错一次。
- 没有 `persistLockedAction` 的 CAS 负例：`claimPendingAction({ from: ['pending','awaiting_mfa'], to: 'locked' })` 只有正向断言，已终态行不被覆盖没有直接用例。
- `__SECURITY_BLOCK__` 在本目录三处作负例：`mfa-failure-contract.test.ts:101-102/124/157`（`message` 与 `failure.reason`）、`unlock-panel-render.test.ts:121-134`、`unlock-panel-notice.test.ts:140-156`（渲染串，另含 `{"decisionKind"`、`Error:`、`undefined`、`[object Object]`、`MFA_CODE` 与 `/\n\s+at\s/`）；没有 `SecurityEvent.detail`/`message` 的 marker、`decisionKind`、栈或原始 JSON 断言。
- 没有 turn 级 `security_event{kind:'locked', message}` 形状或内容断言（只断言 DB 级 `SecurityEvent` 行：`MFA_FAILURE`/`CIRCUIT_BREAKER_TRIPPED`/`SECURITY_RESET`/`INJECTION_ATTEMPT`）。
- 没有断言 `decisionKind === 'deny'` 之外的 deny 载荷文本，也没有断言 deny 载荷不含 `actionId`。
- 没有 `mfa_required` 事件断言，也没有“锁定后不再 surface”的 `GET /api/actions` 断言（那在 `../../app`）。
- 不调用 `publicToolError`/`publicToolSummary`，不断言 `chat.error.toolFailed` 或 `chat.error.securityLocked`；工具错误映射的唯一覆盖在 `../planner/tool-feedback.test.ts`。
- 解锁路径（`POST /api/security/reset`、`lockedActionsReopened`、旧 `PendingAction` 保持 `locked`、解锁后新请求得到新 id）不在本目录，见 `../../app`；本目录只覆盖熔断器层 `resetSession` 与 `SECURITY_RESET` 审计。
- 人工复核停泊（`MANUAL_REVIEW_HOLD` / `reason:'manual_review_hold'`）不在本目录：开着的复核拦下 confirm/verify/cancel 的用例在 `../../app`（`manual-review-http.test.ts`）。

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
