# 跨模块回归测试

## 范围

测试使用真实运行入口、网关、执行器与隔离 SQLite。
模型响应和并发时序可由测试控制。
文件名中的 live 不代表调用真实模型。
本目录直接 import `@/app/api/.../route` 处理器并在进程内包裹 `new NextRequest` 调用（`taskPost`／`confirmPost`／`actionsGet` 等），不是只测领域函数。
`../app/CONTEXT.md` 的 harness 在本目录的借用方只有 `task-feature-hardening.test.ts:13`（`idCtx`／`postJson`／`getJson`／`taskUrl`／`actionUrl`）与 `locked-action-recovery.test.ts:42`（只借 `getJson` 复读 `GET /api/actions`）。
真实模型与浏览器证据见
[../e2e/CONTEXT.md](../e2e/CONTEXT.md)。

| 测试组 | 关注点 |
| --- | --- |
| `live-complete-plan.test.ts`、`request-step-binding.test.ts` | 声明范围、完整任务图与逐步授权 |
| `request-scope-holdings.test.ts` | 持仓身份、所有权与独立操作 |
| `financial-response-boundary.test.ts` | 普通说明、工具结果与授权事实的归属 |
| `message-protocol.test.ts` | Pi 工具调用与结果的协议配对 |
| `write-audit.test.ts`、`execution-audit.test.ts` | 强制审计、去重与回滚 |
| `transfer-receipts.test.ts`、`transfer-replay.test.ts` | 原始回执、请求冲突与资金一致性 |
| `refactor-financial-commands.test.ts`、`confirmed-write-authority.test.ts`、`replace-card-replay.test.ts` | 通用写入回执重放：原样返回、不进入写栅栏、不产生新流水（含 `replace_card` 补卡原操作重放） |
| `write-idempotency.test.ts`、`execution-audit.test.ts` | 网关/确认路径去重与强制审计幂等 |
| `workflow-invocations.test.ts` | 持久化子调用与任务图恢复 |
| `workflow-context.test.ts` | 新对话读取当前用户与会话的任务状态；取消、暂停覆盖历史等待快照，且不暴露参数或创建授权 |
| `process-restart.test.ts`、`standalone-workflow-restart.test.ts` | 真实进程中断与恢复 |
| `model-checkpoint-boundaries.test.ts` | 模型检查点、租约与提交条件 |
| `write-continuation.test.ts` | 声明写操作未发出受控调用时的单次续办、面板真伪与持久化恢复 |
| `locked-action-recovery.test.ts` | 终止锁定不可被恢复路径复活：`recoverOwnedRun`、`resumeTask`／`retryTask`、`recoverAction` 四条生产入口之后 `PendingAction` 仍 `locked`、`updatedAt` 毫秒不变、计划链接与 challenge 集合不变、不新建 `PendingAction`／审计／安全事件、不动资金流水、`GET /api/actions` 不再列出，且各路径自身文案不含内部标记 |
| `card-consume-transaction.test.ts` | 虚拟卡消费的事务原子性（注入失败后余额、`Transaction`、`CardConsumption` 三者全未变）、月限额与余额的并发栅栏、并发相同 `executionKey` 只扣一次 |
| `card-replacement-transaction.test.ts` | 补办是一个事务（`card.update` 失败即回滚，不留半成品卡与 `replacedByCardId`）、源卡结算账户漂移（他人账户／储蓄账户／已删除）时拒绝补办且不落卡 |
| `card-replacement-binding.test.ts` | 补办继承结算账户（原始行核对）、跨代月限额连续且历史 `CardConsumption` 不改写、缺绑定只按显式前驱修复、无前驱的缺绑定卡拒绝消费且绝不回退默认账户 |
| `card-replace-capability-contract.test.ts` | 经真实网关路径（`executeGatedTool` → `securityGateway#handleToolCall` → `verifyAction` → 执行器 → SDK）覆盖 `replace_card`：CREDIT／DEBIT／VIRTUAL 均停靠 `requiresMfa` 的 RED `PendingAction` 且验证前零副作用，验证后恰好新增一张卡、源卡仍 `LOST` 并持有 `replacedByCardId`；CREDIT 额度原样继承；VIRTUAL 结算账户继承且当月额度经卡族连续；非 `LOST` 源卡被 `CONFLICT` 拒绝且持久行不被改写（绝不先挂失）；重复补办指向同一张替换卡 |
| `card-manual-only-management.test.ts` | 新建卡与删卡仍是人工页专属：`manual_add_card`／`manual_delete_card` 经注册表、`executeGatedTool`、`securityGateway#handleToolCall` 与决策端点均被拒绝，且不新增卡／`PendingAction`／`MfaChallenge`／`CardLimit`／`CardConsumption`／回执 |
| `card-dashboard-assets.test.ts` | 补办家族的信用额度只计一次、虚拟卡/借记卡现金不计入信用且不重复计入总资产、种子基线；补办后 `apply_virtual_card` + `consume_virtual_card` 仍可用且余额/流水/消费行只动一次 |
| `security-deny-redaction.test.ts` | 熔断后的真实网关拒绝（`securityGateway#handleToolCall` 返回 `deny`，`blockReason` 以 `__SECURITY_BLOCK__` 开头）经生产投影器 `agent/turns/events.ts` 后的整轮公开载荷（`events`／`cards`／`toolEvents`／散文）均不含 `__SECURITY_BLOCK__`／`decisionKind`／堆栈帧／`[object Object]`，`security_event{kind:'locked'}` 只有 `code`/`reason` 且无 `message`；审计端 3 条 `MFA_FAILURE`（`attempts` 1→2→3、`attemptsLeft` 2→1→0、`maxAttempts` 3、`result` 前两条 `attempt_counted` 末条 `session_locked`）+ 1 条 `CIRCUIT_BREAKER_TRIPPED`（`severity:'high'`，`detail` 含 `failures`/`max:3`/`result`），其 `message`/`detail` 同样无内部标记，`PendingAction` 与 `MfaChallenge` 均落 `locked` |

| `confirmation-policy.test.ts`、`recovery-authorization.test.ts` | 写时熔断与终态决策：`423`＋`CIRCUIT_OPEN`、`getState().locked`、已锁定会话仍凭原回执收敛且不新增扣款、`status: 'locked'` 的 RED 决策不再请求验证码 |
| `money-budget.test.ts`、`frontend-followup-fixes.test.ts` | 三次错误验证码耗尽：会话熔断且 GREEN 写不落地（`JSON.stringify(outcome)` 含「熔断」）、`MfaChallenge` 落 `locked`、错误解锁码不能续期、审计失败回滚解锁与续期 |
| `terminal-state-settle.test.ts`、`decision-guidance.test.ts`、`confirmation-evidence.test.ts` | 终态/阻塞：已终态动作的重复确认与取消是稳定 200 `ok:false`（`events` 为空）、未声明工具 `toolEvent.status === 'blocked'`、取消阻断栅栏后 SDK 写不落地 |
| `weixin-protocol.test.ts` | 固定版本 `pi-weixinbot` 线协议（不是银行链路）：轮询带 Bearer 与游标、uint64 消息编号不丢精度、发送用固定收件人/上下文/幂等 `client_id`、`ret:-14` 业务拒绝不视为已发送 |

其他测试覆盖预算、取消、接管、执行权和未知结果。
具体场景以测试源码中的断言为准。
不得保留已删除测试的路径或旧修复轮次清单。

## 脚本化驱动生产 runTurn

前台套件从 `@/agent` 导入 `runTurn`（facade 再导出 `./run-turn`），只用 `scriptedProvider(declaration, steps)` 注入模型。
`deps` 仅有 `config`/`now`/`provider`/`onEvent`（`agent/turns/contracts.ts`）。
`config` 必须是字面量或 `{ ...getConfig(), llmMode: 'live' }`：声明未提交写的单次续办只在 `config.llmMode === 'live'` 时触发（`agent/write-continuation.ts#pendingDeclaredWrites`）。
不传 `sessionId` 时由 `runTurn` 内 `getOrCreateSession(config.demoUserId, undefined)` 建库行，断言用响应里的 `turn.sessionId`，不写死 id。
`scriptedProvider` 总会先发 `describe_turn`，所以 `script.calls()` 计数含该声明。
续办候选必须 `stopReason: 'stop'` 的普通散文；格式修复型或合法 `guidance` 回复不消耗续办预算。
服务端权威文案 `declared_unsubmitted`（`agent/messages/conversation.zh-CN.json`）用 `agent/financial-response.ts#WRITE_LABELS` 把工具名换成中文标签，测试直接写字面量。
这些套件不需要 `vi.mock`：模型经 `deps.provider` 注入，网关、执行器、SQLite 都是生产实现。

## 恢复与租约用例的驱动方式

「进程内重启」与真实进程重启是两套：`vi.resetModules()` + 重新 `await import(...)` 伪造模块图重启（`restart-recovery.test.ts:184/296/363/370`、`standalone-recovery.test.ts:318`）；
真实子进程 SIGKILL 重启见 `process-restart.test.ts`（驱动 `tests/helpers/restart-process.ts`，`crash` 在 `:72-89`）与 `standalone-workflow-restart.test.ts`（驱动 `tests/helpers/standalone-restart-process.ts`，`crash` 在 `:67-76`）。

恢复入口的实际使用面：

| 入口 | 定义 | 本目录调用点 |
| --- | --- | --- |
| `recoverOwnedRun` | `agent/durable/service.ts:104` | `conversation-recovery.test.ts:62`、`conversation-compaction.test.ts:158/191`、`standalone-workflow-restart.test.ts:135`（断言 `CONFLICT`）、`locked-action-recovery.test.ts:217`（锁定动作，断言 `AUTHORIZATION_REQUIRED`）、子进程驱动 `tests/helpers/restart-process.ts:132/139` |
| `tickAgentRecovery` | `agent/recovery-worker.ts:44` | 只在子进程驱动内：`tests/helpers/restart-process.ts:136`、`tests/helpers/standalone-restart-process.ts:18` |
| `recoverInvocation` | `agent/durable/recovery.ts:63` | `agent-durability.test.ts:106/142` |
| `settlePendingAction` | `agent/confirmation-recovery.ts:264` | `agent-durability.test.ts:255/259` |
| `resumeOriginalRunTask` | `agent/durable/workflow-resumption.ts:15` | `workflow-invocations.test.ts:150/170/171` |
| `listRecoverableAgentRuns` | `lib/db/repositories/agentRun.ts:281` | `model-checkpoint-boundaries.test.ts:95/96/98/109`、`standalone-workflow-restart.test.ts:146/150` |
| `executeGatedTool` | `agent/confirmation/gated-execution.ts:88` | 造「停放」动作的唯一生产入口，见各 `parkStandalone`／`runner` 助手 |

`agent/index.ts:164` 的服务端 `recoverAction` 由 `locked-action-recovery.test.ts:264` 从 `@/agent` 直接调用（计划分支在 `:205-258`）。
`confirmation-policy.test.ts:10` 的 `recoverAction` 来自 `@/components/chat/actions`，是客户端函数，与服务端同名函数无关。
`agent/confirmation-recovery.ts:347` 的 `recoverStandaloneWedge` 只被间接经过，`agent/authorization-resume.ts:52` 的 `performAuthorizationResume` 无直接覆盖，`recoverPendingAction` 这个名字全仓不存在。

租约与执行占用一律用真实时钟直接写库强制过期，本目录没有 `vi.useFakeTimers`／`advanceTimersByTime`／`setSystemTime`。
计划执行占用写 `AgentTask.executionClaimedAt = new Date(Date.now() - 660000)`（超 `EXECUTION_CLAIM_TTL_MS = 600000` 60 秒：`executor-leases.test.ts:134`、`takeover-controls.test.ts:113/350`、`obsolete-executor.test.ts:130/184/237`、`initial-executor-fencing.test.ts:32`、`execution-integrity.test.ts:31-86`、`execution-barriers.test.ts:98`）。
节点占用用 `agentTaskNode.updateMany({ where: { taskId, status: 'running' }, data: { executionClaimedAt } })`（`obsolete-executor.test.ts:131/238`）。
运行租约用哨兵过去时间：`agentRun.leaseExpiresAt` + `agentSession.runLeaseExpiresAt` 置 `new Date('2000-01-01T00:00:00Z')`（`process-restart.test.ts:86-87`、`node-recovery.test.ts:34`、`standalone-workflow-restart.test.ts:74`）或 `new Date(1)`（`model-checkpoint-boundaries.test.ts:27-28`），随后 `beginAgentRun({ existingRunId, recover: true })` 重新准入。
确认动作的租约用 `pendingAction.update({ executionLeaseExpiresAt: new Date(now - 1) })`（`confirmation-lease-contention.test.ts:76`）或把 owner 与过期时间置空（`restart-recovery.test.ts:143-152`）。
没有用例写 `recoveryAttempts`／`maxRecoveryAttempts`／`activeRunId`：前两者只被断言（`model-checkpoint-boundaries.test.ts:54/106`），后者只被读（`agent-durability.test.ts:58/123/215/239`）。

停放状态的三条造法：`executeGatedTool` 直接停放（`restart-recovery.test.ts:102-113`、`confirmation-lease-contention.test.ts:20-28`）；`runSubmitPlan` 的 `runTool` 转发 `ctx.taskId`／`ctx.nodeId` 到 `executeGatedTool` 停放（`takeover-controls.test.ts:68-79`、`confirmation-liveness.test.ts:59-60`；共享版本为 `tests/helpers/locked-action.ts#parkRedTransferPlan`）；直接 `pendingAction.create`（`conversation-recovery.test.ts:100-105`、`agent-durability.test.ts:156-160/184-188/202-206`、`standalone-recovery.test.ts:218-222` 造无回执的 `confirmed`）。
`status: 'locked'` 不能直接写：只能经三次错误验证码的 MFA 阶梯产生（`money-budget.test.ts`、`frontend-followup-fixes.test.ts`）；公共阶梯与探针在 `tests/helpers/locked-action.ts`，由 `locked-action-recovery.test.ts` 与 `../app/mfa-lock-refresh-unlock-http.test.ts` 共用，二者都不手写 SQL 造锁定。

## 终止锁定不可被恢复路径复活

`locked-action-recovery.test.ts` 在进程内用四条生产恢复入口证明：终态 `locked` 的 `PendingAction` 永不回到 `pending`／`awaiting_mfa`，也不为同一节点产生新的可决策行。

保证它的当前生产事实：
- `recoverOwnedRun`（`agent/durable/service.ts:104`）在运行仍 `waiting_confirmation`／`waiting_verification` 时走 `AUTHORIZATION_REQUIRED` 早退（`:159-162`），只回报 `The original confirmation or verification is still required.`，不重新驱动写；待决策动作的状态过滤不含 `locked`（`:216`），`synchronizeRunActionInvocations` 只回写 `['executed','cancelled','failed','needs_reconciliation']`（`lib/db/repositories/agentRun.ts:240-243`）。
- `resumeTask`（`agent/workflows/controls.ts:27`）与 `retryTask`（`:49`）在认领任何状态之前先经 `assertParkedActionsNotTerminal`（`:33`／`:54` → `agent/workflows/parked-actions.ts:63-69`）读计划停靠动作的当前状态：终态即抛出，`locked` 抛 `MFA_LOCKED` + `chat.error.actionLocked`、`needs_reconciliation` 抛 `CONFLICT` + `chat.error.unknownOutcome`、其余终态抛 `CONFLICT` + `chat.error.stateChanged`（`:74-76`），计划状态与节点都不被改写，节点也就不会再被驱动到网关。
- `recoverAction`（`agent/index.ts:168`，计划分支 `:209-265`）对锁定 action 返回 `ok:false`，不重开决策：该分支调 `resumeTask` 后收到的 `MFA_LOCKED` 由 `:250-263` 转成公开文案。
- `authorizeAction` 先对 `status === 'locked'` 短路为 `lockedOutcome(..., 'mfa_session_locked')`（`security/security-gateway.ts:1116-1119`），其后才是非 `pending`／`awaiting_mfa` 的 `CONFLICT` 守卫（`:1123-1125`）；因此 `security/mfa.ts#issueChallenge`（`:100-105`）虽不过滤动作状态，对锁定动作不可达，验证码永不重发。
- `beginAgentRun`（`lib/db/repositories/agentRun.ts:51-54`）在 `agentSession.runLeaseExpiresAt` 未过期时拒绝第二次准入，真并发租约抢占无法由用例构造，用例改用崩溃边界作为等价保证。

用例的驱动：
- 前置统一来自 `tests/helpers/locked-action.ts`：`parkRedTransferPlan` 经生产 `submit_plan` runner 停一个 RED 转账节点，`lockAction` 走网关阶梯耗尽三次得到终态；`beforeEach(resetDatabase)` 因为熔断按所有者（`user:<userId>`）持久化。
- durable 路径用生产 `beginRun`（`lib/db/repositories/agentRun.ts:35`）准入运行，以 `nxe:<taskId>:<nodeId>` 作唯一 `ToolInvocation` 的 `operationKey`，把运行真正挂到锁定动作的任务上（`runPendingActionWhere`，`:215`），再以 `AgentRunJournal.finish('waiting_verification')`（`:189`）留在崩溃边界，最后调 `recoverOwnedRun`：断言 `outcomes` 含 `{ action:'waiting', reason:'AUTHORIZATION_REQUIRED' }`、无 `retried`、运行仍 `waiting_verification`、租约已释放。
- 计划路径对同一 `taskId` 调 `resumeTask` 与 `retryTask`：生产在认领前抛出，节点输出不会再写入新的 `pendingActionId`（`readPendingActionId` 为 `undefined`）。
- `tests/helpers/restart-process.ts` 刻意不用：它的 15s／20s 屏障在并发负载下易超时（见「已知缺口」），而进程内 `recoverOwnedRun` 走的是同一段恢复代码。

`baselineLockedAction` 在锁定后立即取样，`assertStillLocked` 在每条路径后逐项复核：
- `PendingAction.status === 'locked'` 且不在 `['pending','awaiting_mfa']` 内，`updatedAt` 毫秒相同，`taskId`／`nodeId`／`sessionId` 链接不变。
- 该 action 的全部 `MfaChallenge` 仍为 `locked`，challenge 集合（id + status）与基线一致。
- 按 `taskId` 取出的 `PendingAction` id 集合与基线完全相同，新行可被检出。
- `AuditLog` 计数、`mfa_required` 与 `locked` 两类 `SecurityEvent` 计数均不变；`checkingBalance()`／`transactionsCount()`／`zhangweiTransfers()` 不变。
- `GET /api/actions`（经 `tests/app/harness.ts#getJson` 调真实路由）返回 `200`、不列出该 action id、不出现 `locked` 状态项。
- 各路径自身返回的消息与计划节点状态串，以及三条再驱动入口抛出的错误，都不含 `__SECURITY_BLOCK__`／`decisionKind`／`[object Object]`／`/\n\s+at\s/`。

## 终止锁定（locked）、block reason 与错误验证码的覆盖边界

响应域 `status: 'locked'` 在本目录三处断言，全部在 `confirmation-policy.test.ts`：
`it.each(['needs_reconciliation','failed','cancelled','locked'])`（L187）与 `'a locked RED decision retains its historical MFA requirement without requesting another code'`（L197，`:201` `toMatchObject({ ok:false, status:'locked', tier:'RED', requiresMfa:true })`、`:202` 无 `mfa_required`、`:203` 余额不变）。
持久化 `PendingAction.status === 'locked'` 由 `locked-action-recovery.test.ts` 在每条恢复路径后断言，且明确不得为 `pending`／`awaiting_mfa`。
`frontend-followup-fixes.test.ts` 断言的是持久化 `MfaChallenge.status === 'locked'`（L134、L156、L157、L166），不是响应域状态。
`code: 'CIRCUIT_OPEN'` 只出现在 `confirmation-policy.test.ts`：L75/L87 断言 `/api/security/reset` 返回 `423`，L119/L135 仅把它当开锁前置，不断言该 code。

锁定由两条路径驱动：
真实三次错误验证码 —— `money-budget.test.ts:206` 三次 `verifyPost` `{ code: '000000' }`（L207 `getState().locked`、L211 `JSON.stringify(outcome)` 含「熔断」）；`frontend-followup-fixes.test.ts` 的 `exhaust()`（L31-33）。
进程内 `recordFailure` ×3 —— `confirmation-policy.test.ts` 的 `lock()`（L40-43）、`refactor-security-runtime.test.ts:47-61` 的第三次 `recordRiskSignal` 链路（`:60` 仅一条 `CIRCUIT_BREAKER_TRIPPED`）。

唯一与锁定相关的用户可见文案断言是 `money-budget.test.ts:211` 的「熔断」子串。
本目录没有 `chat.error.toolFailed`、`toolFailed`、`publicToolError` 或 `publicToolSummary` 的断言（这些只在 `tests/unit/planner/`）。`__SECURITY_BLOCK__` 在断言里只由 `security-deny-redaction.test.ts` 证明网关原始拒绝带标记，`locked-action-recovery.test.ts` 另以负例扫描恢复路径的文案。
`security_event` 的注入帧形状只在 `tests/app/chat-http.test.ts:295-299` 与 `tests/app/malicious-input-http.test.ts:206-208` 断言（`kind: 'injection'`），且都不断言 `message`；本目录的 `security_event` 断言是 `security-deny-redaction.test.ts` 的 `kind:'locked'` 帧。

被门禁拒绝的写入一般只断言 `toolEvent.status === 'blocked'`，不检查 block reason 文本：
`conversational-turns.test.ts:116/127/159/170/323/340/449`、`decision-guidance.test.ts:60`、`conversation-recovery.test.ts:114/189`、`live-complete-plan.test.ts:36`、`confirmation-policy.test.ts` 无此类断言。
唯一检查网关拒绝载荷的是 `security-deny-redaction.test.ts`：它先在网关返回值上确认 `blockReason` 以 `__SECURITY_BLOCK__` 开头且含 `decisionKind`/`CIRCUIT_OPEN`（证明确有内部载荷），再断言投影后的公开载荷不含任何标记。

该用例是本目录唯一把真实网关拒绝送到公开投影的入口：熔断由 `verifyAction`（`securityGateway#authorizeAction`，错误码 `000000` ×3）驱动，随后用 `helpers/faux-agent.ts` 的真实 Pi agent（`beforeToolCall` → `securityGateway#handleToolCall`）对同一会话再发一次 RED 写；Pi 的 `tool_execution_end` 直接交给生产投影器 `agent/turns/events.ts#createEventHandler` + `agent/turns/buffer.ts#createTurnBuffer`，不经 `helpers/scenario.ts`（其 `decideAndContinue` 在授权非 ok 时只返回 `{ text }`，无法承载拒绝帧）。

错误验证码的断言（均不改动资金）：
`confirmation-policy.test.ts:174-176` 客户端把 `message: '验证码错误'` 透传为 `error` 事件；`decision-guidance.test.ts:216-217`（`ok === false` + 余额不变）；`recovery-authorization.test.ts:101-102`；
`confirmed-write-authority.test.ts:80` `attempts === 1`、`:84` 重新 `confirm` 后 challenge 行完全不变、`:102` `assertNoCommit(..., /verification expired, was consumed or no longer matches this command/)` 依赖该英文原文；
`frontend-followup-fixes.test.ts:140` `{ ok:false, locked:false, attemptsLeft: 2 }` 是本目录唯一的响应域 `attemptsLeft` 断言（`security-deny-redaction.test.ts` 断言的是 `MFA_FAILURE.detail.attemptsLeft` 2→1→0）；`:166` `{ status:'locked', attempts: 3 }`。
`confirmation-liveness.test.ts:285` 是本目录唯一的 `mfaResult` 断言（`'success'`）。

## 解锁与重置（resetSession / POST /api/security/reset）的覆盖

本目录只有 `confirmation-policy.test.ts` 与 `frontend-followup-fixes.test.ts` 触及重置/解锁。
安全中心路由不带验证码时恒 `423` + `CIRCUIT_OPEN`，且不写任何 `SECURITY_RESET`（`confirmation-policy.test.ts:85-88`）。
带验证码的 `resetSession` 之后 `SECURITY_RESET` 恰好 1 行（`confirmation-policy.test.ts:91`、`frontend-followup-fixes.test.ts:142-143`，detail 含 `renewedMfaChallenges: 1`）。
解锁只续期「仍待决策」动作的 challenge：`renewLockedMfaChallenges`（`lib/db/repositories/pendingAction.ts`，由 `commitAuditedReset` 调用）只匹配 `action.status === 'awaiting_mfa' && requiresMfa` 的 `locked` challenge，把它们改回 `pending`/`attempts 0`，从不改写 `PendingAction.status`；终态 `locked` 动作与其 challenge 解锁后仍 `locked`（`../app/mfa-lock-refresh-unlock-http.test.ts` 第 3 组）。`frontend-followup-fixes.test.ts:137-138` 的 action 因 `exhaust()` 直调 `security/mfa.ts#verify` 只锁 challenge，所以解锁前后都是 `awaiting_mfa`。
续期按所有者与状态过滤：需决策的 challenge 变成 `pending`，`cancelled` 与其它用户的 challenge 保持 `locked`（`:156-157`）。
审计写入失败时解锁与续期一并回滚，`isLocked` 仍为 `true`、challenge 保持 `locked`/`attempts 3`（`:166-167`）。
解锁不会复活旧动作：解锁后同一业务意图的新请求铸造新的 `PendingAction` id（`retry.actionId !== red.actionId`、`retry.taskId !== red.taskId`），旧行仍 `locked`、旧 id 不在 `GET /api/actions` 列表内，响应自报 `lockedActionsReopened: false`，资金／流水／回执均未增加（`../app/mfa-lock-refresh-unlock-http.test.ts` 第 3 组）。
旧 id 上的重复提交仍被拒：同一套件第 2 组断言 `verify`（正确码）与 `confirm` 各三次都返回 `200` + `ok:false` + `status:'locked'` + `failure.reason:'mfa_session_locked'`；本目录 `locked-action-recovery.test.ts` 断言服务端 `recoverAction` 对锁定 action 返回 `ok:false`。
`confirmation-policy.test.ts:92` 的 `recover` 与 `frontend-followup-fixes.test.ts:140-141` 的 `verify` 都在原 id 上继续，针对的是 `confirmed`／`awaiting_mfa`（非锁定）动作。

## wedge 故障注入的有效接缝

wedge 用例只能注入生产确认路径真正调用的符号，否则 spy 永不触发，预期的 `500` 与「`confirmed` + `resultJson:null`」都不会出现。
接缝一：`vi.spyOn(auditStore, 'insertAuditLog')`——`audit/audit-logger.ts:102` 由 `recordAudit` 调用，`settlePendingAction` 在事务内以 `strict:true` 调它（`agent/confirmation-recovery.ts:288-297`），按 `opts.dedupeKey` 定向抛错即回滚状态与结果（`confirmation-policy.test.ts:53`、`recovery-authorization.test.ts:43/256`、`write-audit.test.ts:143`、`execution-audit.test.ts:94`、`confirmation-evidence.test.ts:131`、`task-feature-hardening.test.ts:173`）。
接缝二：`vi.spyOn(gateway, 'recordActionResult')`——`security/security-gateway.ts:1268`，由 `agent/confirmation/authorized-execution.ts:74-80` 在结算之后调用，只用于卡住或观察结算后的窗口，不产生 `confirmed` + `resultJson:null`（`write-idempotency.test.ts:26/40`）。
接缝三：直接注入 `settlePendingAction`（`agent/confirmation-recovery.ts:264`）或 `claimPendingAction`（`lib/db/repositories/pendingAction.ts:254`）。
`setPendingActionStatus`／`updatePendingActionStatus`（`lib/db/repositories/pendingAction.ts:181-194`）仍导出，但已无任何生产调用者（状态写入一律走 `claimPendingAction`）：在它们上装的 spy 永不触发，那个 `500` 与未落地结果的 wedge 都不再发生。
仍装这种死 spy 的规格：`action-refresh.test.ts:113`、`committed-outcomes.test.ts:98`、`confirmation-continuation.test.ts:53`、`confirmation-evidence.test.ts:69`、`confirmation-liveness.test.ts:198`、`confirmation-policy.test.ts:146`、`execution-audit.test.ts:82`、`execution-integrity.test.ts:114`、`node-result-recovery.test.ts:35/59/110`、`recovery-authorization.test.ts:81/227`、`restart-recovery.test.ts:131`、`sdk-transaction-fences.test.ts:104`、`standalone-recovery.test.ts:92`、`transfer-history.test.ts:121/278`、`transfer-receipts.test.ts:158`。
这些规格的注释也仍按旧接缝解释各自的 wedge：`action-refresh.test.ts:28`、`committed-outcomes.test.ts:24`、`confirmation-liveness.test.ts:20`、`node-result-recovery.test.ts:26`、`restart-recovery.test.ts:14`、`standalone-recovery.test.ts:24`、`transfer-receipts.test.ts:23`。

## 断言约束

- 声明与任务图来自结构化输入，不从原句正则补全。
- 成功事实必须核对回执、余额与流水。
- 未知结果必须保留待核对状态。
- 流输出与持久化历史必须保持相同的结果归属。
- 并发测试必须使用可控屏障和持久化断言。

运行：`pnpm exec vitest run tests/integration`。
共享数据库规则见 [../CONTEXT.md](../CONTEXT.md)。

## 已知缺口

- `live-*.test.ts` 中的 `live` 表示使用 live 模式配置，不代表调用真实模型；真实模型证据见 [../e2e/CONTEXT.md](../e2e/CONTEXT.md)。
- 面板/确认断言分两类前提：`conversational-turns.test.ts`、`decision-guidance.test.ts`、`live-recovery.test.ts` 等要求真实工具调用并持久化 `PendingAction`；`write-continuation.test.ts` 覆盖模型仅在散文里声称已确认或等待确认、却不发出任何受控调用、因而不存在 `PendingAction` 也不显示面板的情形。
- `write-continuation.test.ts` 中参数完整的声明写操作在有界续办里会真实抵达安全网关并打开真实面板（`PendingAction` + 等待中的工具调用），前台与 durable 路径要求一致；只有模型仅用散文声称面板、未发出受控调用时，服务端才发布真实未提交状态。伪造的面板文案绝不进入会话记录。
- `conversational-turns.test.ts` 的 `fixtures.fabricatedSuccess`／`fabricatedBalance` 只断言这类散文被原样保留且不触发授权，不涉及面板/确认声称。
- 真实模型自身的散文化面板声称稳定性由 [../e2e/CONTEXT.md](../e2e/CONTEXT.md) 的 live 验收诊断（`panel-claim.e2e-helper.ts`、`live-acceptance.e2e.ts#driveRedTool` 经 `helpers.ts#assertNoFabricatedConfirmationPanel`），本目录不覆盖真实模型稳定性。
- `report_lost_card`（RED 挂失）尚无“原操作回执重放”回归；`replace-card-replay.test.ts` 只把它当作同一操作键下的“换了工具”冲突用例（`errorCode: 'CONFLICT'`，不进入写栅栏），并不校验其重放。
- 通用回执重放入口为 `createToolRegistry(userId).executeDirect(tool, args, { sessionId, idempotencyKey })`，用同一 key 重发即原样返回（`refactor-financial-commands.test.ts:95`、`confirmed-write-authority.test.ts:136`）。
- `../helpers/db.ts#truncateAll()` 已覆盖无关系的 `CardConsumption`；套件只需 `beforeEach(resetDatabase)`，不得再自行逐表清理。
- `standalone-workflow-restart.test.ts` 使用真实子进程与 15s／20s 屏障超时，在磁盘／CPU 高负载（如整目录同时运行）下会偶发「child did not reach barrier」；单独重跑可 9/9 通过，先确认是否只是超时。
- 本目录不断言锁定话术文案：无 `chat.error.securityLocked`／`publicToolError`／「验证码错误次数过多，本会话高风险操作已被锁定…」用例；`__SECURITY_BLOCK__` 既用作「网关原始拒绝确实带标记」的证明，也用作恢复路径文案的负例标记，从不出现在任何上屏断言的正例里。
- 本目录不断言 `MfaCard` 的 LOCKED 渲染：`frontend-review-fixes.test.ts` 只用默认（验证码输入）与 `status: 'executed'` 两种状态。
- 夹具不播种 LOST 卡（`card_credit`/`card_debit` 均 `ACTIVE`，见 `../helpers/fixtures.ts:99`）；`replace_card` 需先 `report_lost_card` 或直接改库把源卡置 `LOST`。
- 节点级内部标记不进入计划节点输出：`agent/confirmation/gated-execution.ts:49-60` 的 `blockedOutcome` 只从结构化 `failure` 生成 `securityNotice` 目录句，否则经 `safePublicText`→`publicToolError` 回退到 `chat.error.operationNotStarted`，`auth.blockReason` 原文不再交给 `planner/node-outcome.ts`；且带 `taskId`／`nodeId` 的节点动作先经 `:66-84` 的 `findRepresentedAction` 早退（`:80-83` 为公开中文句），不触达网关。
- `locked-action-recovery.test.ts` 只覆盖进程内恢复入口：`tickAgentRecovery` 与真实子进程重启（`../helpers/restart-process.ts`）没有锁定动作用例，原因是其屏障在高负载下易超时；真并发租约抢占被 `beginAgentRun` 拒绝，无法直接构造。
- 锁定动作没有 HTTP `POST /api/actions/[id]/recover` 用例：本目录覆盖的是服务端 `recoverAction`（`agent/index.ts:168`），`../app/mfa-lock-refresh-unlock-http.test.ts` 覆盖的是 `verify`／`confirm` 与 `POST /api/security/reset`。
- 两条再驱动入口的用例仍按「控制返回计划快照／`200`」的旧语义调用：`locked-action-recovery.test.ts:244/254` 与 `write-idempotency.test.ts:40-42` 期望控制调用正常返回，而生产已因 `assertParkedActionsNotTerminal` 在认领前抛出（`MFA_LOCKED`／`CONFLICT`，HTTP `409`）。
