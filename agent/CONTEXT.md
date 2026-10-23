# Agent runtime context

The agent layer assembles Pi Core, provider adapters, user context, workflow ports and server-authored presentation. It does not grant banking permission.

## Routing Table

- `./action-status.ts`: the single `PendingAction` status vocabulary — `OPEN_ACTION_STATUSES` (`pending`/`awaiting_mfa`), `TERMINAL_ACTION_STATUSES` (`executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`), `CLAIMABLE_ACTION_STATUSES`, `ALL_ACTION_STATUSES`, `REPRESENTED_ACTION_STATUSES` and the `isOpenActionStatus`/`isTerminalActionStatus`/`mayPromptForDecision`/`isClaimableActionStatus`/`isLegalActionSourceStatus` predicates plus the `asPendingActionStatus` narrowing for persisted strings; no agent path compares status literals locally.
- `./confirmation/`: confirm/verify/cancel decision facade internals, gateway outcome contracts, leases (incl. the `locked` MFA outcome behavior).
- `./durable/`: Pi event journal, run leases, workflow/standalone continuation and recovery.
- `./turns/`: turn contracts, event grounding/buffering, authorization views, bounded prompts.
- `./tools/`: banking tool implementations and the tool registry.
- `./providers/`: live + mock provider/model adapters.
- `./workflows/`: workflow control, the parked-decision seal/refusal projections (`parked-actions.ts`) and cancellation.
- `./context-compaction/`: historical summaries and bounded model-request projection.
- `./messages/`: presentation message catalogs.
- `./session.ts`: `SessionSnapshot` persistence (`stateJson` = `agentState` + `transcript` + reply/compaction state; plus `intentJson`, `revision` column) through `lib/db/repositories/session`. `getDemoSession(userId)` is the single server-configured web workspace: it seeds `newSession`, sets `sessionId = demo:${userId}`, calls `ensureDemoSession` (a Prisma `upsert` on that explicit primary key with `update: {}` — it never resets state or leases) and returns `loadSession(row.id)`, so the same `userId` always resolves to the same `sessionId`, including across restarts; a row owned by another user throws `The demo conversation belongs to another user`. `saveSession`/`getOrCreateSession` instead ADOPT the repository-minted cuid (a `newId('sess')` is provisional), and a save carrying an `AgentRunLease` goes through `commitRunSession` with the revision fence.

## Capability boundary: one card-spend write

The agent exposes exactly ONE card-spend write — `consume_virtual_card` (RED) — which pays a positive exact-CNY amount from an owned account-bound virtual card by debiting its linked checking account. There is no other card-consumption / card-spend / card-purchase / card-payment / card-debit capability.
`consume_virtual_card` books at SERVER business time: its schema carries no date or time argument, and a model-supplied time field is rejected with a `VALIDATION` error carrying `消费入账时间由服务端决定`, writing no funds, no ledger row and no `CardConsumption` row.
Its spendable amount is `min(account available cash, remaining monthly limit)`; a monthly limit of 0 blocks spending entirely, and a card with no monthly limit is bounded only by the linked account's cash.
A repeated `executionKey` replays the persisted consumption instead of charging the linked account again.
The card tool family otherwise reads and manages card records: `get_cards` (read), `set_card_limit` (per-category limit, no money movement), `freeze_card`, `unfreeze_card`, `report_lost_card`, `replace_card`, `apply_virtual_card`, plus the card-spend `consume_virtual_card` (see `tools/card.ts`, `card-emitter.ts`, `tools/index.ts`).
`analyze_spending`, `get_transactions` and `detect_anomaly` are GREEN reads over already-booked ledger rows; `detect_anomaly` never freezes a card.
A `CARD`-channel transaction row records a card charge but never identifies the owning debit/credit card from the deposit account type (see `system-prompt.ts:46`).
The other money-moving writes are `transfer_money`, `reserve_budget`, `subscribe_investment` and `redeem_investment`; `create_scheduled_task` with kind `PAYMENT` dispatches through the transfer channel, not a card or merchant billing integration.
Manual-only, on the Cards page with its own page verification, means exactly two things: creating a brand-new physical DEBIT/CREDIT card, and deleting a card record (`system-prompt.ts:38`).
The Cards page has no 补办 action.
`replace_card` (RED, `tools/card.ts:393-427`) is an ordinary agent capability for an owned `LOST` card of ANY type (DEBIT/CREDIT/VIRTUAL): the replacement inherits the source type and network, a CREDIT replacement inherits `creditLimitMinor`/`availableLimitMinor`, a VIRTUAL replacement keeps its linked settlement account and the month-continuous family allowance, the source card stays `LOST` with `replacedByCardId` set, and a repeat call returns that same replacement. No card-type gate exists in `agent/`, `lib/` or `security/`.
The server-authored manual-only reply is the guidance vocabulary `card_management_required` / `capabilities` in `messages/conversation.zh-CN.json:7-8`; it limits page-only scope to brand-new physical card creation and card cancellation, and never denies 补办 of an already-lost card or 申请虚拟卡. A live model may emit that envelope and the server renders it verbatim (`banking-guidance.ts:22-56`, `turns/buffer.ts:25-36`); because `write-continuation.ts` returns early on a guidance envelope, such a reply is final and cannot self-correct.
`write-continuation.ts` only rescues a DECLARED-but-unemitted write (`pendingDeclaredWrites`, live-only); `declaredWriteTools` selects every catalog entry with `effect: 'write'`, so a declared `replace_card` is covered exactly like any other write. A model that refuses without declaring the write is never corrected.

## Public entry points

`agent/index.ts` exposes turns, confirmation/verification/cancellation, task controls, manual handoff and scheduled dispatch. App routes use the server-configured demo user and persistent `demo:${userId}` workspace before calling it. The web demo has no login or authentication cookie. Generic internal sessions remain available for runtime tests and bank ownership contracts; they cannot be selected through the web API. Tests can inject a `ModelRuntime` through `RunTurnDeps.provider` while exercising the real runtime and bank.

## Execution contracts

`turn-runtime.ts` admits a stable request and owns its session run lease. The first awaited subscriber is `AgentRunJournal`. It snapshots and records every original Pi event, and creates the invocation with the tool-start event before preflight. Grounded UI events are immutable and persisted before SSE publication. JSON responses replay the same saved snapshots.

`run-turn.ts` owns input orchestration; `authorization-resume.ts` injects an original authorized outcome. `turns/` separates contracts, buffers, event grounding, parked authorization views and bounded prompts. Internal presentation modules do not import entry points or recovery drivers.
`workflow-context.ts` reads at most ten latest owned session workflows when assembling a new turn or authorization continuation. Only task/node identities and statuses enter the system context, so Web/IM cancellation or pause supersedes historical tool snapshots without exposing arguments or granting consent. Durable checkpoint replay retains its originally recorded system context.
`turn-presentation.ts` is only a re-export facade over `turns/` (contracts, buffer, events, authorization-view, live-prompt); implementations live there.
`RunTurnDeps` is `{ config?: AppConfig; now?: () => number; provider?: ModelRuntime; onEvent?: ... }` — every field optional; `provider` is the two-field `{ model, streamFn }` from `providers/types.ts` and overrides `resolveProvider(config)` (`banking-agent.ts:217`).
`turns/live-prompt.ts` `runLivePrompt(runtime, buffer, request, now, config)` order: clear `lastGuidance` → `agent.prompt(request)` → `continueDeclaredWrites` → `repairConversationalReply`; it holds no `llmMode` check itself, so the only live gate on the declared-write continuation is `write-continuation.ts:57`. Guidance-envelope rendering (`turns/buffer.ts` `groundMessage`, in-place rewrite of the candidate's `content`) and foreground format repair are not mode-gated.

Authorization result narration is server-authored in both mock and live modes. The original tool
result is replaced inside its contiguous result group while preserving all later dialogue. A missing
provider call cannot create an orphan tool result or hide an outcome already proven by its receipt.
Authorized workflow progress remains the executor's responsibility, not another model narration turn.

`durable/continuation.ts` resumes model checkpoints and verifies original context and execution facts. `durable/standalone-workflow.ts` resumes independent graphs without a model. `recovery-worker.ts` supplies bounded discovery and lease-protected recovery. Model partials are journal evidence only; changing the model contract, losing ownership or encountering uncertain effects cannot silently create a replacement operation.

`banking-agent.ts` installs the code-controlled gateway and supplies trusted user/session identities.
`beforeToolCall` is the ONLY consumer of `requiresDeclaredPlan` (`intent-context.ts:43`): with a declared multi-write or `workflow` intent it blocks individual write calls and preflights `submit_plan` (`banking-agent.ts:286-298`). At turn end `write-continuation.ts` reconciles a declared-but-unemitted write: `continueDeclaredWrites` issues exactly ONE bounded, restart-safe continuation (its `WriteContinuationState` budget is persisted before the provider call) — only when the candidate reply is ordinary prose, since a protocol envelope needing format repair or a valid `guidance` envelope stays on its own path — and if no controlled call appears the server still publishes its authoritative `declared_unsubmitted` state (`renderFinancialResponse(buffer.factResults, { declared })`) instead of prose that could claim a panel. The declared-vs-emitted comparison reads `runtime.serialize().intent` and is live-only (`config.llmMode === 'live'`); a real gate is still produced only by a blocked gateway call.
`intent-context.ts` starts a new undecided intent per user turn and stores the structured describe_turn
declaration. `tools/plan-compiler.ts` validates declared write counts/order and explicit structured
parameters, dates, conditions and output references before createTaskGraph persists the whole DAG.
Production does not extract arguments or dependencies from the original user sentence.

Preflight refusals remain model-facing corrections in `planningRejections` and Pi tool results.
`turns/events.ts` projects them through `lib/tool-feedback.ts` into catalog-owned public summaries
and a separate `ToolEventView.debugDetail`. Do not copy provider correction instructions into
ordinary user-facing summaries or error cards. Recorded diagnostics remain available to the
developer view; this presentation change does not alter checkpoint identities or permission gates.

Every registered write enters `command-execution.ts`. Operation identity belongs to the server invocation, action or node. The command's mutation, strict audit, original response and invocation completion share one transaction. Receipts are replayed before mutable lookup; transfers additionally match their ledger. Unknown outcomes stop for reconciliation.

## 投资写入能力

`subscribe_investment` 与 `redeem_investment` 都是 RED 写入，经同一网关授权、逐次强验证与执行围栏，操作身份由服务器拥有的调用/动作/节点决定。对已持有产品的再次申购由 SDK 聚合进现有持仓（`InvestResult.addedToExisting = true`），不新建持仓。赎回必须带显式口径 `mode`：`SHARES` 配 6 位小数的 `shares`，`AMOUNT` 配精确 CNY 金额 `amount`（按当前净值折算份额，折算为零或超过市值都拒绝），`ALL` 两者都不带并关闭持仓；赎回不再有本金口径，`redeemAmount` 一律拒绝。确认快照（`expectedShares`/`expectedNetValue`/`expectedNetValueDate`/`expectedSettlementAmount`）在写事务内与最新净值、净值日期、持仓份额及重算到账金额逐项比对，任一不匹配都以 `CONFLICT` 拒绝：本次零写入，用户必须重新确认；同身份重放不重新报价，返回原始回执与原净值。金额绝不使用浮点，计算使用整数最小单位或十进制算术。`system-prompt.ts` 要求：用户只给一个数字时先澄清「按金额赎回」还是「按份额赎回」，不得当成本金、不得承诺赎回额外收益；确认与结果必须给出赎回份额、成交净值、预计到账金额与费用口径；收益为模拟估算、不承诺保本。`providers/mock/investment-intents.ts` 对「…份」发 `SHARES`、对带货币单位的数字发 `AMOUNT`、对无数字的整笔赎回发 `ALL`，只有裸数字时反问口径而非提交工具调用。工具层细节见 `./tools/CONTEXT.md`。

`confirmation.ts` is the public decision facade. `confirmation/identity.ts` resolves persisted ownership;
`confirmation/liveness.ts` owns decision leases; `confirmation/outcomes.ts` projects refusals and convergence; `confirmation/authorized-execution.ts`
lands authorized command evidence before narration. `confirmation/gated-execution.ts` is the workflow execution port,
and `confirmation/plan-continuation.ts` resumes downstream nodes without rewriting a committed business result.
`confirmation-recovery.ts` lands action states and receipts without inventing effects. Workflow
generation/token and session policy fences remain in the actual banking transaction. Manual handoff
preserves current in-flight work and stops the next checkpoint. Scheduled dispatch reuses a persistent
workflow and current approval.

`confirmation-recovery.ts` `settlePendingAction` requires an explicit `from` and refuses an empty or illegal source with `SECURITY_DENIED` BEFORE the transaction opens (see the next section).

## PendingAction persistence: one funnel, no repository setter

`confirmation-recovery.ts:264` `settlePendingAction` is the ONLY production writer of a `PendingAction` terminal status TOGETHER WITH its `resultJson`, in one `prisma.$transaction` (`:268`): `claimPendingAction({actionId, from, to}, tx)` CAS (`:269-272`; a lost race returns `false` and writes nothing, `:273`), an inline `tx.pendingAction.update({where:{id}, data:{resultJson: toJson(result)}})` (`:275-279`, only when `result !== undefined`), an optional strict `recordAudit` (`:280-297`) and `settleInvocationFromAction` (`:299`). It returns the `boolean` "landed" flag and never throws on a concurrent settle.
`assertSettleSources` (`:242-251`) requires a non-empty `from` and refuses an illegal source with `AppError('SECURITY_DENIED')` BEFORE the transaction opens; every caller passes an explicit source (`from: ['confirmed']` at `confirmation/authorized-execution.ts:63`, `confirmation/gated-execution.ts:75`, `confirmation-recovery.ts:556` and `:615`).
`confirmation-recovery.ts` `persistedDecision(row)` is the single derivation of a recovery outcome's decision: `requiresMfa = row.requiresMfa || row.riskLevel === 'RED'` and `tier = requiresMfa ? 'RED' : row.riskLevel`. `landStandalone` uses it inside the settlement transaction (WON CAS) and again on the row a concurrent settle left behind (LOST CAS), `reconcileStandaloneAction` uses it for both, and `recoverStandaloneWedge` seeds its decision from it — so a stale pre-authorization snapshot can never downgrade a committed RED/MFA decision to `YELLOW`/`requiresMfa:false`.
`lib/db/repositories/pendingAction.ts:181-194` still exports `updatePendingActionStatus` and its alias `setPendingActionStatus`, but NO production module in `agent/`, `app/`, `security/`, `lib/`, `planner/` or `channels/` calls either one: status+result persistence no longer passes through a repository function, so a fault-injection spy on that symbol observes zero calls (tests do this — see `tests/CONTEXT.md`).
The post-execution status notification is `security/security-gateway.ts:1580` `recordActionResult`, a CAS over `RESULT_RECORDABLE_STATUSES` (`:315-323`) instead of an unconditional set, so a `locked` row keeps its lock; `confirmation/authorized-execution.ts:74-80` calls it only when `landed` is true and the status is `executed`/`failed`, and swallows its error because the settlement transaction is authoritative.
`command-execution.ts` writes no `PendingAction` status (it owns the `ToolCommand` receipt, `:94`); `manual-review.ts:210` only cancels the still-open actions of a superseded plan; `workflows/parked-actions.ts` is strictly read-only.

## Blocked, denied and locked outcomes

`action-status.ts` is the single `PendingAction` status vocabulary: `OPEN_ACTION_STATUSES` (`pending`/`awaiting_mfa`) is the only set a decision may still be taken on, `TERMINAL_ACTION_STATUSES` is `executed`/`failed`/`cancelled`/`locked`/`needs_reconciliation`, and `mayPromptForDecision`, `isOpenActionStatus`, `isTerminalActionStatus`, `isClaimableActionStatus` and `isLegalActionSourceStatus` replace every local status-literal comparison.
`locked` is TERMINAL: an exhausted-verification or open-circuit refusal is never re-presented as a pending entry, never re-prompted for a verification code, never resumed or retried, and never executed.
The security-centre unlock only clears MFA challenge rows, so after an unlock the user must start a new operation and confirm it again; no old operation is re-activated.
`banking-agent.ts` `beforeToolCall` is the only place a gateway block becomes a Pi tool result: it returns `{ block: true, reason: auth.blockReason ?? auth.decision.message }` and sets `stopAfterDecision`, so in live mode `finishTurn` ends the turn with no narration turn and no controlled execution.
That reason string stays model-facing; it is never copied into a public field.
The opaque payload is minted only in `security/security-gateway.ts`: `serializeBlockReason` (payload carries `actionId`, `decisionKind` and the typed `failure`) and the actionId-less deny payloads for a locked session and a cancelled plan.
`turns/events.ts` `handleToolEnd` classifies one error result: `needs_reconciliation` first, then `parseBlockReason` and a plain `startsWith(BLOCK_REASON_PREFIX)` test, then a typed `status:'error'` carrying `summary` + `errorCode`.
A blocked call's public `ToolEventView` carries typed facts only — `actionId`, `errorCode` from `parseBlockReason(...).failure.code`, and the renderable `attemptsLeft`/`attemptsUsed`/`maxAttempts` params.
A decision prompt is published only through `turns/authorization-view.ts` `publishPendingDecision`, which re-reads the persisted row: `mayPromptForDecision(status)` gates `mfa_required`/`confirmation_required` and its card, a `locked` row publishes the structured `security_event` from `settledDecisionSignal` (`kind:'locked'` + `code:'MFA_LOCKED'|'CIRCUIT_OPEN'` + `reason`, **no `message`**), and any other terminal status or a missing row publishes nothing.
`publishPendingDecision` returns `'prompted' | 'signalled' | 'skipped'`; `flushParkedDecision` clears the relayed parked id first and delegates to the same gate, so a plan cannot re-open a verification entry for a settled action.
`turns/events.ts` publishes a locked refusal as structured fields only (`code`/`reason`/`actionId`/`attemptsLeft`/`maxAttempts`), never the raw payload as `message`; `parseBlockReason` treats `actionId` as OPTIONAL (`security/security-gateway.ts:1065-1069`) because a `deny` payload — a tripped breaker or a cancelled plan — has no action at all, so a deny refusal keeps its typed `failure` code while a payload carrying no `failure` yields no code, and neither form reaches the user as raw payload text.
`lib/public-text.ts` (`safePublicText`/`securityNotice`/`isInternalDiagnostic`) is the only funnel through which the agent layer turns internal or untrusted text into user-visible refusal copy, which itself comes from the `lib/i18n` catalog; internal status literals, action/session ids, payloads, JSON and stack traces never reach it.
`lib/tool-feedback.ts` `publicToolError` maps by exact string or code, so an unmapped gateway sentence renders through the `chat.error.toolFailed` fallback instead of leaking.
`confirmation/gated-execution.ts` `blockedOutcome(auth, actionStatus)` fills the typed plan-layer fields — `failure` from `toPlanFailure(parseBlockReason(auth.blockReason ?? '').failure)` and `actionStatus` from the PERSISTED row (`auth.action.status`, else the node's newest stored row narrowed by `asPendingActionStatus`) — and `error` from `securityNotice`/`safePublicText`, so a refusal is never re-derived from its text.
`confirmation/contracts.ts` `GatedToolOutcome` carries `failure?: PlanFailure` and `actionStatus?: PendingActionStatus` — the ONLY carrier of a typed refusal into the plan layer: `confirmation/gated-execution.ts` fills them, `tools/planning.ts` `runTool` forwards the whole outcome into `planner/executor.ts#PlanToolOutcome`, and `planner/node-outcome.ts` projects `error`/`summary` through `publicFailureText` while keeping the structured fields verbatim. Every production plan port (`plan-continuation.ts`, `durable/standalone-workflow.ts`, `durable/workflow-resumption.ts`, `scheduled-dispatcher.ts`, `banking-agent.ts`, `tools/planning.ts`) is a pass-through of `executeGatedTool`, so no call site re-derives a reason from text and a typed refusal (`MFA_LOCKED`/`mfa_attempts_exhausted`, `locked`) survives the plan boundary.
`confirmation/gated-execution.ts` `representedStatuses` is `REPRESENTED_ACTION_STATUSES` (`action-status.ts`): `pending`/`awaiting_mfa`/`confirmed`/`executed`/`needs_reconciliation` represent their node, while `failed`/`locked`/`cancelled` do NOT — an explicit retry therefore re-enters the gateway for a fresh decision (MFA included) and a fresh `PendingAction`, and a `locked` row is never CAS-ed back or re-activated (the re-entry reaches the owner-scoped breaker as `CIRCUIT_OPEN`).
`workflows/parked-actions.ts` is read-only and exposes two projections: `sealedParkedNodes(plan)` (a node whose persisted action already settled → `{nodeId, actionId, actionStatus, reason, nodeStatus, error?}`, `reason` via `@/planner#sealReason`, `nodeStatus`/`error` from its single private `sealProjection`, `error` present only for a REFUSED seal) and `assertParkedActionsNotTerminal(plan)`.
`resumeTask` SEALS each sealed parked node through the plan persistence port (that seal's own `nodeStatus`, its catalog `error` only when refused, `pendingActionId` stripped from the node output) and then runs the remaining work: a settled decision never blocks other nodes, is never driven, never surfaced as a decision and never re-opened, and an all-terminal plan simply returns with nothing left to advance.
The seal REASON plus the PERSISTED action status, never the bare fact that a decision settled, decide that terminal outcome: `executed` under `action_not_open` is a COMPLETED node carrying no failure text, so a plan-node wedge recovered from real evidence settles `success`; `needs_reconciliation` (`chat.error.unknownOutcome`), `failed`/`cancelled` (`chat.error.stateChanged`) and `locked_refusal` (`chat.error.actionLocked`) stay `failed`, so a settled refusal or an unknown effect is never reported as success and a `locked` action is never re-activated, re-prompted or auto-executed.
`retryTask` REFUSES before any status claim or lease with a typed `AppError` (`locked` → `MFA_LOCKED`/`chat.error.actionLocked`, `needs_reconciliation` → `CONFLICT`/`chat.error.unknownOutcome`, another terminal → `CONFLICT`/`chat.error.stateChanged`), writing nothing and replaying nothing. See `workflows/CONTEXT.md`.
`confirmation.ts` `cancelAction` re-reads the persisted row and reports success only when it is actually `cancelled` (`unappliedCancelOutcome` otherwise); refusal sentences come from `publicRefusalMessage`/`failureReasonFor` and never interpolate a raw status literal.
`ConfirmationOutcome` carries a typed `code` and, for security refusals, the structured `failure`, so no caller has to parse `message`.
`confirmation-recovery.ts` `settlePendingAction` requires an explicit `from`, validates it with `assertSettleSources` before the transaction opens (empty or illegal source → `AppError('SECURITY_DENIED')`, nothing written) and CASes through `claimPendingAction`, so no path can write a `locked` row back to another status and `locked` is never a source.
`durable/journal.ts` stores a public-safe `summary` and keeps the internal text in `internalSummary`; `durable/continuation.ts` restores the model-facing content from `internalSummary` and re-synthesises a block envelope only while the persisted row is still open.
`transcript-activity.ts` re-projects a recorded `summary` only through `publicRecordedSummary`, and projects a recorded action as `blocked` only while it is still open.
Known boundaries: `financial-response.ts` `renderFinancialResponse` supports a `locked` narration but no caller in `agent/`, `app/` or `channels/` passes `locked: true`.
`confirmation.ts` returns on `!auth.ok` before `executeAuthorizedAction`, so a locked or denied human decision produces no `ToolExecutionResult`, no tool event and no factual result (`action_settled` has no server producer at all).
`agent/` contains no 未完成/请核对/原操作卡片 copy; that sentence is the `chat.error.toolFailed` fallback of `lib/i18n/messages/chat.zh-CN.json`.
No test under `agent/` or `tests/` feeds a `failure`-less `__SECURITY_BLOCK__{"decisionKind":"deny"}` payload into `parseBlockReason`/the `turns/events.ts` classification: `tests/unit/agent/turn-security-event.test.ts` and `tests/integration/security-deny-redaction.test.ts` drive the REAL gateway, whose deny payloads always carry a typed `failure` (`security/security-gateway.ts#handleToolCall` mints `{decisionKind:'deny', failure:{code:'CIRCUIT_OPEN'|'SECURITY_DENIED', reason}}`, and `security-deny-redaction.test.ts` asserts the raw reason contains `CIRCUIT_OPEN`), and `tests/unit/security/gateway.test.ts` round-trips only a `failure`-less `require_mfa` payload. The exact two-key literal exists only as hostile TEXT in the `lib/public-text.ts`/`lib/tool-feedback.ts` funnel (`tests/unit/lib/public-text.test.ts`, `public-text.locked.test.ts`, `public-text.manual-review.test.ts`, `app-error-public-message.test.ts`) and in the schedule, WeChat and planner-card projections (`tests/unit/schedules-page-text.test.ts`, `tests/unit/weixin-lock-presentation.test.ts`, `tests/unit/planner/locked-card-rendering.test.ts`, `tests/app/security-http-redaction.test.ts`).
`providers/mock/narration.ts` detects the literal `__SECURITY_BLOCK__` (not the exported prefix) and answers with fixed templates; its branch order prefers the MFA/验证码 template when the same string also contains 锁定/熔断.

## `verifyAction` MFA decision outcome shape

`agent/confirmation.ts:55-57` `verifyAction` = `withLiveConfirmation(() => authorizeAndExecute(actionId, opts, code))`; `authorizeAndExecute` (`:31-49`) calls `gateway.authorizeAction` and on `!auth.ok` returns `confirmation/outcomes.ts:158-186` `blockedOutcome`, which RE-RENDERS the sentence from typed facts via `securityNotice` — so a gateway sentence (`ATTEMPTS_EXHAUSTED_MESSAGE`, `CIRCUIT_LOCK_MESSAGE`) is never the returned `message`; only a prompt with no `code`+`failure` (code still required / challenge renewed) keeps gateway text.
`blockedOutcome` attaches `events` only while the row is open (`view.requiresMfa && mayPromptForDecision(view.status)`), so every terminal refusal carries `events: []` and a lock never re-emits `mfa_required`.
Wrong code with attempts remaining → `status:'awaiting_mfa'`, `tier:'RED'`, top-level `code:'MFA_FAILED'`, `failure{code:'MFA_FAILED', reason:'mfa_code_invalid', attemptsUsed:n, attemptsLeft:maxAttempts−n, maxAttempts:3}`, `message` = `chat.error.verificationRemaining` (`验证码错误。还可尝试 {count} 次。`, `count` = `attemptsLeft`), `events:[{type:'mfa_required', actionId, action}]`.
Third wrong code → `status:'locked'` where the top-level `code` is `CIRCUIT_OPEN` but `failure.code` is `MFA_LOCKED` (`security/security-gateway.ts:1243-1257`), `failure{reason:'mfa_attempts_exhausted', attemptsUsed:3, attemptsLeft:0, maxAttempts:3}`, `message` = `chat.error.actionLocked`, `events:[]`; the row is CAS-ed `pending|awaiting_mfa → locked` (`security-gateway.ts:1105-1108` `persistLockedAction`).
Verify on an ALREADY-`locked` row short-circuits at `security/security-gateway.ts:1472-1475` to `lockedOutcome` (`:1115-1132`): `status:'locked'`, `code:'CIRCUIT_OPEN'`, `failure{code:'CIRCUIT_OPEN', reason:'mfa_session_locked', attemptsLeft:0, maxAttempts:3}` with NO `attemptsUsed`, `message` = `chat.error.securityLocked`, `events:[]` — identical for a CORRECT and a WRONG code because the guard fires before `mfa.verify`.
An account breaker tripped by a DIFFERENT operation reports `failure{code:'CIRCUIT_OPEN', reason:'circuit_open', attemptsUsed, attemptsLeft}` and the same `chat.error.securityLocked` copy.
A consumed challenge CASes the row to `cancelled` (`security-gateway.ts:1189-1200`): `requiresMfa:false`, `code:'CONFLICT'`, `failure{code:'CONFLICT', reason:'denied'}`, `message` = `chat.error.securityDenied`; an expired/`command_changed` challenge re-issues and returns `awaiting_mfa` with NO `code`/`failure` and the `renewedChallenge` sentence, so it re-prompts.
Any other terminal row throws `CONFLICT`, which `confirmation.ts:43-45` turns into `outcomes.ts:109-131` `conflictOutcome`: `status` = the PERSISTED status, `tier`/`requiresMfa` from the persisted row, `code:'CONFLICT'`, `failure{code:'CONFLICT', reason:'denied'}`, `message` = `chat.error.stateChanged`, `events:[]`.
Success returns gateway `status:'confirmed'` (`security-gateway.ts:1309-1318`, `VERIFY_OK_MESSAGE`) and then `executeAuthorizedAction` (`confirmation/authorized-execution.ts:103-108`) reports the SETTLED status (`executed`/`failed`/`needs_reconciliation`) with the real continuation `events`.
The verify path produces NO `security_event`: `kind:'locked'` exists only on the SSE decision-prompt path (`turns/authorization-view.ts:61-67` `settledDecisionSignal`).
The breaker is OWNER-scoped and DB-durable (`security/circuit-breaker.ts:121-127`), so three wrong codes deny every later tool call of that user — GREEN reads included — until the security centre resets it, and an unlock never revives the locked action.

## Presentation

Developer chat reset clears the current transcript, model messages and intent only after the session
revision/write fence and unfinished-work checks succeed. The fixed session identity, bank data,
authorization evidence and immutable runtime history remain. `SessionSnapshot.historyStartedAt`
selects current-history plans after reset; ordinary refresh never changes this boundary.

Tool execution can begin after the provider assistant message ends. Each call has an independent
tool-role message and owned result/authorization cards; complete prose before or after it has its
own assistant message. Completion and authorization continuation update the original tool entry.
Durable run/model-request identities disambiguate reused provider call IDs, including after recovery.
`transcript-activity.ts` reconciles page history from scoped invocation/action evidence.
`transcript-presentation.ts` separates existing mixed UI entries without changing original prose,
financial records or the immutable model/event archive. See `turns/CONTEXT.md` for event ownership.

`grounding-facts.ts` projects exact structured account/write facts. `financial-response.ts` renders authoritative financial statements. Planning text, model-generated correction tags and prose are never execution evidence. Public APIs expose grounded events and safe metadata; raw thinking remains internal.


Card results — the card reads, the card mutations and `consume_virtual_card` — render as a `cards` card built from the server-returned card projection (`card-emitter.ts`), which carries the linked account, its available balance, the monthly limit and the currently payable amount; model prose never fills a result card.

Investment writes follow the same rule: `subscribe_investment` and `redeem_investment` re-read the CURRENT holdings (`banking.investment.listHoldings`) after the write commits and attach that snapshot additively as `data.holdings`, so `card-emitter.ts` projects the validated receipt AND an `investments` card of the post-write positions. The authoritative `InvestResult` fields keep their meaning; an unavailable re-read is omitted rather than fabricated, leaving the committed write successful with its receipt only.
A redemption's fee fields (`feeAmount`/`feeRule`, both constants of the simulated environment) never reach a card: the `receipt` payload is the validated subset of `business-card-payloads.ts#investmentPayload`, and `BusinessReceipt` (`lib/contracts/agent.ts:11-13`) has no fee slot. The 费用口径 sentence is authored only by `tools/investment.ts#feeLine` inside the redemption `summary` (shown via `ToolEventView.summary` and `financial-response.ts` `renderWrite`'s `write.summary`), plus the confirmation snapshot's own field list; `subscribe_investment` renders no fee line at all. The raw fields survive untouched in `data` (the SDK result is passthrough, only `holdings` is added) and therefore in the opaque result JSON of every receipt/journal/audit writer.

The registered internal describe_turn tool declares purpose, ordered requested capabilities and
optional workflow/example flags for one current user turn. Its result is interpretation, never
authorization. Ordinary explanation permits automatic GREEN reads but cannot open a gated read or
write authorization. Advice allows relevant authorized queries and refuses writes. Repeated write
declarations require a complete workflow. Production never infers these purposes from user wording.
GREEN lookups may identify targets before declaration. An operation preparation declaration may
contain only prerequisite reads; after their results, the complete write sequence is bound once.
Purpose never changes, and a declaration containing writes cannot be expanded or replaced.
Natural-language routing exists only inside providers/mock as a deterministic offline model script.

`conversation-context.ts` restores missing user wording from the server-saved transcript.
`context-compaction/projection.ts` replaces only a validated summarized prefix in the model request
view; the complete archive and contiguous tool groups remain intact. Historical requests never
provide current consent or replace the new turn's declaration. New-turn restoration uses the saved transcript,
matching ordered user occurrences and inserting at surviving user boundaries. Restoration adds no
assistant facts, tool chains or authorization, and cannot split a contiguous assistant/result group.
Recorded model-request continuation bypasses both context adjustments.

`guidance-messages.ts` is a closed presentation vocabulary without request parsing. The mock-only
conversation-guidance/policy/advisory/amount modules may script local demonstrations; production
business validation checks structured arguments through the same gateway and SDK used by live Pi.
`conversation-evidence.ts` collects prior structured query/write outcomes for dated discussion.
`conversational-response.ts` preserves model prose verbatim. It never infers intent, personal balance,
execution success or draft revival from wording. Actual financial outcomes are typed tool entries,
authorization states and execution receipts. `reply-format.ts` recognizes complete protocol envelopes
through JSON parsing and closed structure checks, rather than field words or embedded Markdown
examples. Explicit typed allowProtocolExamples permits protocol teaching examples. A format-only
repair has a persisted one-request budget and retains raw original and corrected responses. Retiring
an unpublished candidate removes only its assistant events; independent tool/result rows remain.
`turn-presentation.ts` keeps ordinary prose separate from server-authored financial result rendering;
financial success still requires actual execution evidence. A question about transfer funding is not
an instruction to execute the previous transfer draft or retry an unfinished plan.

Pi 1.2 derives its system context and tool set from transcript system messages. New input and authorization turns
remove prior system messages before constructing the current prompt and declarations, while retaining
user, assistant and tool history. Durable continuation with a recorded model request preserves its
checkpoint system context and original request, rather than applying a new turn's prompt retroactively.

`context-compaction/` persists historical summaries, pending summary requests and complete-turn cuts.
Pi request preparation and context transformation use the same bounded projection. Session and run
checkpoints retain the complete archive; the model request record retains the actual projection.
Summary calls have their own event stream and cannot execute banking tools. Recovery reuses an
unfinished summary input or the immutable original normal model input. Exact old wording is available
through the owner-bound GREEN `search_conversation_history` capability.

Authorization results update the original tool group in place. Mutation receipts remain server-authored
and do not invoke another model turn. A still-current query/advice question can continue model analysis,
and an operation preparation can propose its remaining declared work after a confirmed read,
using its saved purpose and original question. Every new write still needs gateway authorization. Later user messages
disable that automatic continuation. `authorization-context.ts` locates the
original assistant through the owned action, invocation and model request, so reused provider call IDs
cannot redirect an older committed result into a newer operation.

## Known Issues

- `planner/failure.ts:111` `sealReason` treats EVERY non-open `actionStatus` as `action_not_open`, including `executed`/`needs_reconciliation` — the two statuses `action-status.ts:59-63` `REPRESENTED_ACTION_STATUSES` says still represent their node.
- `confirmation/outcomes.ts#conflictOutcome` (used by confirm/verify/cancel and by `confirmation/liveness.ts`) projects both `CONFLICT` and `MANUAL_REVIEW_HOLD` into a domain outcome: `ok:false` plus the persisted `status`, the original `code` and a structured `failure`. It funnels `error.message` through `lib/tool-feedback.ts#publicToolError` with the error `code`, so the rendered copy comes from `PUBLIC_ERROR_CODES` (`MANUAL_REVIEW_HOLD` → `chat.error.manualReviewHold`, `CONFLICT` → `chat.error.stateChanged`) and never from the raw gateway sentence.
- `failureReasonFor` maps `MANUAL_REVIEW_HOLD` → `'manual_review_hold'`, deliberately not `'denied'`: an open manual review is a hold, not a security denial.
- `confirmation/gated-execution.ts:154-157` attaches `failure: toPlanFailure(error)` (i.e. `{code}`) to EVERY thrown gated refusal, so a refused `manual_add_card`/`manual_delete_card` call carries `failure` in addition to `errorCode`/`error` (`GatedToolOutcome.failure` is a documented contract field).

Use the central tool catalog and financial string contracts. See `docs/cn/architecture.md`, `docs/cn/agent-durability.md` and `docs/cn/security.md` for current behavior and limits.
