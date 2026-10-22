# 跨模块回归测试

## 范围

测试使用真实运行入口、网关、执行器与隔离 SQLite。
模型响应和并发时序可由测试控制。
文件名中的 live 不代表调用真实模型。
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

## 终止锁定（locked）、block reason 与错误验证码的覆盖边界

领域 `status: 'locked'` 只在本目录三处断言，全部在 `confirmation-policy.test.ts`：
`it.each(['needs_reconciliation','failed','cancelled','locked'])`（L187）与 `'a locked RED decision retains its historical MFA requirement without requesting another code'`（L197，`:201` `toMatchObject({ ok:false, status:'locked', tier:'RED', requiresMfa:true })`、`:202` 无 `mfa_required`、`:203` 余额不变）。
`frontend-followup-fixes.test.ts` 断言的是持久化 `MfaChallenge.status === 'locked'`（L134、L156、L157、L166），不是响应域状态。
`code: 'CIRCUIT_OPEN'` 只出现在 `confirmation-policy.test.ts`：L75/L87 断言 `/api/security/reset` 返回 `423`，L119/L135 仅把它当开锁前置，不断言该 code。

锁定由两条路径驱动：
真实三次错误验证码 —— `money-budget.test.ts:206` 三次 `verifyPost` `{ code: '000000' }`（L207 `getState().locked`、L211 `JSON.stringify(outcome)` 含「熔断」）；`frontend-followup-fixes.test.ts` 的 `exhaust()`（L31-33）。
进程内 `recordFailure` ×3 —— `confirmation-policy.test.ts` 的 `lock()`（L40-43）、`refactor-security-runtime.test.ts:47-61` 的第三次 `recordRiskSignal` 链路（`:60` 仅一条 `CIRCUIT_BREAKER_TRIPPED`）。

唯一与锁定相关的用户可见文案断言是 `money-budget.test.ts:211` 的「熔断」子串。
本目录没有 `chat.error.toolFailed`、`toolFailed`、`publicToolError` 或 `publicToolSummary` 的断言（这些只在 `tests/unit/planner/`）。`__SECURITY_BLOCK__` 与公开 `security_event` 帧只由 `security-deny-redaction.test.ts` 断言（其余用例都不涉及）。
`security_event` 的注入帧形状只在 `tests/app/chat-http.test.ts:295-299` 与 `tests/app/malicious-input-http.test.ts:206-208` 断言（`kind: 'injection'`），且都不断言 `message`；本目录的 `security_event` 断言是 `security-deny-redaction.test.ts` 的 `kind:'locked'` 帧。

被门禁拒绝的写入一般只断言 `toolEvent.status === 'blocked'`，不检查 block reason 文本：
`conversational-turns.test.ts:116/127/159/170/323/340/449`、`decision-guidance.test.ts:60`、`conversation-recovery.test.ts:114/189`、`live-complete-plan.test.ts:36`、`confirmation-policy.test.ts` 无此类断言。
唯一例外是 `security-deny-redaction.test.ts`：它先在网关返回值上确认 `blockReason` 以 `__SECURITY_BLOCK__` 开头且含 `decisionKind`/`CIRCUIT_OPEN`（证明确有内部载荷），再断言投影后的公开载荷不含任何标记。

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
解锁会把该 action 的 `MfaChallenge` 续期为 `pending`/`attempts 0`，并把其 `PendingAction` 由 `locked` 改回 `awaiting_mfa`（`frontend-followup-fixes.test.ts:137-138`）——测试断言的是「重开该 action」，不是「保持 locked」。
续期按所有者与状态过滤：需决策的 challenge 变成 `pending`，`cancelled` 与其它用户的 challenge 保持 `locked`（`:156-157`）。
审计写入失败时解锁与续期一并回滚，`isLocked` 仍为 `true`、challenge 保持 `locked`/`attempts 3`（`:166-167`）。
没有任何用例断言「解锁后新请求产生新 `PendingAction` id」：解锁后仍复用同一个 actionId（`confirmation-policy.test.ts:92` 的 `recover`、`frontend-followup-fixes.test.ts:140-141` 的 `verify`）。

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
- 本目录不断言锁定话术文案：无 `chat.error.securityLocked`／`publicToolError`／「验证码错误次数过多，本会话高风险操作已被锁定…」用例；`__SECURITY_BLOCK__` 只在 `security-deny-redaction.test.ts` 出现，用于证明网关返回的原始拒绝带有内部标记、而投影后的公开载荷不带。
- 本目录不断言 `MfaCard` 的 LOCKED 渲染：`frontend-review-fixes.test.ts` 只用默认（验证码输入）与 `status: 'executed'` 两种状态。
- 夹具不播种 LOST 卡（`card_credit`/`card_debit` 均 `ACTIVE`，见 `../helpers/fixtures.ts:99`）；`replace_card` 需先 `report_lost_card` 或直接改库把源卡置 `LOST`。
