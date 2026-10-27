# lH 证据归档 —— live MFA 三次错码 → 终态锁定

- 场景 id：`lH` ｜ 场景名：`lH-live-mfa-attempt-limit-lock-terminal`
- 场景主体：`tests/e2e/live-mfa-lock.e2e-helper.ts`（`scenarioMfaAttemptLimitLock`）｜ 注册：`tests/e2e/live-acceptance.e2e.ts` 的 `SCENARIOS` 末尾（一行 import + 一行注册）
- 产品树提交（认证对象）：`0da121d2`（`git diff --stat 0da121d HEAD -- banking-sdk agent security planner lib app components prisma scripts` 为空）
- 认证 commit（本目录证据 + 场景）：见 `git log --oneline -- output/playwright/live/REPORT-lH-head0da121d-round4.md`
- 类型检查：`pnpm typecheck` → `tsc --noEmit`，`TYPECHECK_EXITCODE=0`
- 模型：`GET /api/health` → `{"ok":true,"data":{"status":"ok","time":1792726683629,"llmMode":"live"}}`（真实 DeepSeek 在线；未被 mock）

## 运行命令（退出码延迟展开法，必用）

```
cmd /v:on /c "set LIVE_SCENARIOS=lH&& set E2E_BROWSER_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe&& pnpm exec tsx tests/e2e/live-acceptance.e2e.ts > logs\lH-round<N>.log 2>&1 & set EC=!ERRORLEVEL! & echo EXITCODE=!EC! >> logs\lH-round<N>.log & exit !EC!"; exit $LASTEXITCODE
```

## 轮次台账

| 轮 | 退出码 | 汇总行 | 结论 | 说明 |
| --- | --- | --- | --- | --- |
| round1 | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS | 场景首版（三次错码 + 刷新 + 安全中心） |
| round2 | 1 | `== 汇总：PASS 0 ｜ FAIL 1 ｜ SKIP 0 ==` | FAIL（flaky） | 首个 `POST /api/chat` → 500 `INTERNAL`，随后两次 409 `Another agent run owns this session`；停泊区始终未出现，`waitForMfaCard` 90s 超时。两轮之间产品代码与场景代码未改动，round3/round4 均稳定 PASS |
| round3 | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS | 修订后认证轮（场景新增逐档错码截图） |
| round4 | 0 | `== 汇总：PASS 1 ｜ FAIL 0 ｜ SKIP 0 ==` | PASS | 独立复核轮（不同 worktree、`next dev` 随机端口 58255、库本轮重建） |

round4 场景行原文（`logs/lH-round4.log`）：

```
PASS lH-live-mfa-attempt-limit-lock-terminal — 停泊 actionId=cmvkf6mri006d84f8yv613x8s（kind=mfa，自然轮次 1，确认卡前置=否） ｜ … ｜ 截图 7 张
```

## (a) 每次错码的错误类型 + 剩余次数（逐字）

停泊方式：`submitChat('给张伟转5000元')` → `waitForMfaCard`；🔴 转账不出现确认卡（`[data-approval-request="true"]` 内「确认」按钮计数 = 0），直接 MFA 停泊区。

| 次 | 页面逐字 | `POST /api/actions/[id]/verify` | 选择器 |
| --- | --- | --- | --- |
| 1 | `验证失败，已尝试 1 次。` | HTTP 200 `status:"awaiting_mfa"` `mfaResult:"failed"` `message:"验证码错误。还可尝试 2 次。"` `code:"MFA_FAILED"` `failure={"code":"MFA_FAILED","reason":"mfa_code_invalid","attemptsUsed":1,"attemptsLeft":2,"maxAttempts":3}` `attemptsLeft:2` | `[role="status"]` 文本（`cards.mfa.failedAttempts`），`waitForStatusText` 去空白子串匹配 |
| 2 | `验证失败，已尝试 2 次。` | HTTP 200 `status:"awaiting_mfa"` `message:"验证码错误。还可尝试 1 次。"` `failure={…,"attemptsUsed":2,"attemptsLeft":1,"maxAttempts":3}` `attemptsLeft:1` | 同上 |
| 3 | `当前验证已锁定` | HTTP 200 `status:"locked"` 顶层 `code:"CIRCUIT_OPEN"` `mfaResult:"failed"` `message:"该操作已锁定，无法继续验证或执行。原因：验证码错误次数已达上限。请在安全中心解除限制后重新发起操作。"` `failure={"code":"MFA_LOCKED","reason":"mfa_attempts_exhausted","attemptsUsed":3,"attemptsLeft":0,"maxAttempts":3}` `attemptsLeft:0` | `[data-approval-stage="current"][data-stage-status="locked"]`（只读回执阶段行），徽章 `验证已锁定`（`chat.approval.status.locked`） |

- 第 1/2 次停泊区文本（逐字）：`… 操作需要安全验证，请输入 6 位演示验证码。本演示不会发送短信。 验证失败，已尝试 1 次。 请求失败，请检查网络后稍后重试。 取消 验证`
- **`?? 0` 探针**：全页扫「还可尝试 0 次」命中 **0**；可重试文案出现 **0**；服务端 `attemptsLeft` 逐次直传 2 / 1 / 0 → `lib/public-text.ts#securityNotice` 的单一 `?? 0` 在本链路**未**被误触发。
- 已知欠缺（本链路实测）：停泊区徽章读到的是兜底句 `请求失败，请检查网络后稍后重试。`（`chat.error.request`），不是剩余次数。根因：`components/chat/actions.ts:640-643` 的 error 事件不带 `code` → `components/chat/agent-stream-reducer.ts:507` `errorCode=undefined` → `components/chat/ChatWindow.tsx:77/237` `publicToolError(stream.error, t, 'chat.error.request', stream.errorCode)` → 走不到 `lib/tool-feedback.ts` 的 `PUBLIC_ERROR_CODES.MFA_FAILED`。「剩余次数」的确定性浏览器断言只能用停泊区计数行。

## (b) 达到上限后验证码入口结束（DB 核对）

| 检查 | 查询 | 结果 |
| --- | --- | --- |
| 验证码输入框 | `page.locator('[data-approval-request="true"] input[aria-label="验证码"]').count()`（`SELECTORS.mfaInput`） | **0** |
| MFA 卡片 | `mfaCardPresent(page)` | **false** |
| 停泊区 | `page.locator('[data-approval-request="true"]').count()` | **0** |
| 待决策列表 | `GET /api/actions`（`fetchPendingActions`） | **不含** `cmvkf6mri006d84f8yv613x8s` |
| `PendingAction` | `prisma.pendingAction.findUnique({ where: { id, sessionId } })` | `{id:"cmvkf6mri006d84f8yv613x8s", status:"locked", toolName:"transfer_money", riskLevel:"RED", requiresMfa:true, updatedAt:"2026-10-23T03:38:15.025Z"}`，`resultJson=null` |
| `MfaChallenge` | `prisma.mfaChallenge.findUnique({ where: { actionId } })` | `{attempts:3, maxAttempts:3, status:"locked", verifiedAt:null, consumedAt:null, expiresAt:"2026-10-23T03:43:09.728Z"}` |
| `CircuitBreakerState` | `prisma.circuitBreakerState.findUnique({ where: { key:'user:user_liming' } })` | `{key:"user:user_liming", userId:"user_liming", failures:3, locked:true, lockedAt:"2026-10-23T03:38:15.018Z"}` |
| 账本 | `fetchLedger` + `diffLedger(before, after)` | 新增 **0** 条（三次错码与锁定均未动账） |

## (c) 内部标记 / 泄漏扫描

共 **58** 项检查：DOM 8 类规则 × 5 个文本面（3 次错码后的 `role=status` 文本 + 停泊区文本 + 全页文本）+ verify 响应原文 6 类规则 × 3 次响应 → **全部未命中**（`leakHits:0`）。

规则：`__SECURITY_BLOCK__`、`decisionKind`、`"code":"`、`{ "` 原始 JSON 片段、`Error:`、堆栈帧 `at <文件>:<行>:<列>`、`node:internal`、`stack`。

边界（正确边界，非漏检）：`AgentSession.stateJson` 中 `transfer_money` 的 toolResult 原文确为 `__SECURITY_BLOCK__{"actionId":"…","decisionKind":"require_mfa"}`，属模型协议层内部标记，不出现在 DOM、也不出现在 verify 响应体。

## (d) 刷新后状态一致

`page.reload()` 后（`reload` 段实测）：

```
lockedReceipts=1  lockedStages=1  mfaInputs=0  dockCount=0  confirmButtons=0  verifyButtons=0  statusTexts=["当前验证已锁定"]
```

- 锁定回执 `[data-approval-history="true"][data-status="locked"]` = 1，内含 `[data-approval-locked="true"]`；
- 当前阶段行 `[data-approval-stage="current"][data-stage-status="locked"]` = 1；
- 验证码入口、停泊区、「确认」/「验证」按钮计数全为 0 → 锁定操作不重新激活；
- `PendingAction.status` 刷新后仍为 `locked`。

## (e) 安全中心（`/security`）

面板属性：`[data-unlock-panel][data-unlock-locked="true"][data-unlock-failures="3"][data-unlock-max-attempts="3"][data-unlock-locked-actions="1"]`

- 锁定原因：`锁定原因：连续验证失败 3 / 3 次，已达上限并触发熔断。`
- 操作状态：`操作状态：已锁定的操作保持终态，解锁不会把它变回待确认操作。`
- 恢复方式：`解锁方式：输入 6 位验证码并提交「重置失败计数」，只会清除熔断状态与失败计数。`
- `[data-lock-reason]` 全文：`高风险操作已锁定 失败 3 / 3 次 2026/9/25 12:00:00 连续验证失败次数已达上限。当前账户的高风险操作已锁定。 连续验证失败后，高风险操作保持锁定。`
- 锁定操作行：`section[data-locked-actions] li[data-locked-action-id]` = 1 条，含 `cmvkf6mri006d84f8yv613x8s`
- 事件行：`[data-security-event-kind="CIRCUIT_BREAKER_TRIPPED"]` = 2 行（锁定面板 + 安全事件表各一行）
- `GET /api/security`：`lock.code="CIRCUIT_OPEN"`、`circuitBreaker.failures=3`、`circuitBreaker.locked=true`、`lockedActions[].actionId` 含该行
- `SecurityEvent`（DB）：`MFA_FAILURE` = 3 条（`验证码错误（第 1/2/3 次失败）。`，severity `medium`）、`CIRCUIT_BREAKER_TRIPPED` = 1 条（severity `high`）

观察（非缺陷判定）：安全事件表中 `高风险操作已锁定` 行渲染在第 2 次与第 3 次 `验证失败` 行之间，因为三行 `createdAt` 相同（同一 demo 时钟），排序退化为按其他键。文案与条数均正确。

## 截图（`output/playwright/live/lH-head0da121d-round4/`）

| 文件 | 语义 |
| --- | --- |
| `01-lH-mfa-dock.png` | 停泊 MFA 面板（🔴 转账无确认卡） |
| `02-lH-wrong-1.png` | 第 1 次错码：停泊保留 + `验证失败，已尝试 1 次。` |
| `03-lH-wrong-2.png` | 第 2 次错码：`验证失败，已尝试 2 次。` |
| `04-lH-wrong-3.png` | 第 3 次错码：终态锁定（停泊区卸载） |
| `05-lH-locked-terminal.png` | 锁定终态全页 |
| `06-lH-after-reload.png` | 刷新后：面板不重弹、只读回执停在 `locked` |
| `07-lH-security-center.png` | 安全中心：锁定原因 / 操作状态 / 恢复方式 / 锁定操作行 |

round3 的对应 7 张归档在 `output/playwright/live/lH-head0da121d-round3/`。round1/round2 未产出归档目录（round2 在停泊前超时；round1 的截图未入库）。

## 证据表行

`| lH | <本目录证据提交> | 0da121d | PASS | 0 |`
