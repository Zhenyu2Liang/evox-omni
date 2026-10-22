# Confirmation / authorization-decision context

Human decisions (`confirm` / MFA `verify` / `cancel`) authorize the PERSISTED `PendingAction` arguments through the Security Gateway (`@/security`); the model never grants execution. This submodule is the agent-side facade plus the durable lease bookkeeping around that gateway.

## API Surface

- `../confirmation.ts` (parent) — public `confirmAction` / `verifyAction` / `cancelAction`; each is wrapped by `withLiveConfirmation`. `authorizeAndExecute(actionId, opts, mfaCode?)` resolves identity, short-circuits a cancelled owning plan, calls `gateway.authorizeAction`, and returns `blockedOutcome` when `!auth.ok`.
- `contracts.ts` — `ConfirmOptions`, `ConfirmationOutcome`, `GatedToolOutcome`, `TrustedIdentity`.
- `identity.ts` — `resolveTrustedIdentity`: persisted-owner assertion, never a grant.
- `liveness.ts` — `withLiveConfirmation`: takes the durable execution lease; a lease conflict → `conflictOutcome`.
- `outcomes.ts` — `blockedOutcome`, `cancelledPlanOutcome`, `conflictOutcome`, `effectiveTier`, `emitAll`.
- `authorized-execution.ts` — lands authorized command evidence before narration.
- `gated-execution.ts` — `executeGatedTool` (the workflow execution port; re-exported by `../confirmation.ts`).
- `plan-continuation.ts` — resumes downstream graph nodes without rewriting a committed business result.

## Contracts

`ConfirmationOutcome = { ok: boolean; actionId: string; status: PendingActionStatus; tier: RiskLevel; requiresMfa: boolean; message: string; code?: ErrorCode; failure?: SecurityFailure; result?: ToolExecutionResult; events: AgentStreamEvent[] }` (`contracts.ts:15-28`) — the typed refusal code and the structured failure ARE part of the outcome, so a caller never parses `message`.

`PendingActionStatus` (`@/lib/contracts/security`) = `'pending' | 'awaiting_mfa' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'locked' | 'needs_reconciliation'`.

The gateway's `AuthorizationResult` (`@/security/security-gateway`) additionally carries optional `mfaResult: 'success' | 'failed' | 'not_required'`; `mfaResult` stays gateway-only, while `code` and `failure` are copied into `ConfirmationOutcome` (`outcomes.ts:73-74`).

## Constraints

- Ownership is fail-closed: `ConfirmationOutcome` is built from persisted state, never from request-supplied text. `verifyAction` can still THROW `AppError('NOT_FOUND' | 'SECURITY_DENIED')` and (via the gateway) `'CONFLICT'`; a `CONFLICT` is converted to `conflictOutcome`.
- `blockedOutcome.events` emits `{ type: 'mfa_required', actionId, action }` ONLY when `view.requiresMfa && (view.status === 'pending' || view.status === 'awaiting_mfa')`, so every terminal status (including `'locked'`) gets `events: []` — a terminal prompt intentionally requests no further code.
- NO module under `agent/` produces an `action_settled` event: the type is declared in `lib/contracts/agent.ts:99` and its only emitter repo-wide is the browser client (`components/chat/actions.ts:604-611`, for `confirmed` plus `TERMINAL_ACTION_STATUSES`, which includes `locked`).
- Both `liveness.ts` (`withLiveConfirmation`) and `gated-execution.ts` (`executeGatedToolOnce`) refuse `isManualCardCommand` tool names (`manual_add_card` / `manual_delete_card`, `@/lib/contracts/card-management`) with `SECURITY_DENIED` — card creation/deletion must go through the card management page, not the confirmation flow. These are the only card references in this directory; no card-consumption / spend / purchase / pay / debit capability exists here.

## A locked MFA outcome is terminal and carries EMPTY events

When wrong MFA codes trip the session circuit breaker (`security/mfa.ts` `verify` → `security/security-gateway.ts` `authorizeWithMfa`), the gateway returns `status: 'locked'`, `requiresMfa: true`, `tier: 'RED'`, `code: 'CIRCUIT_OPEN'`, `mfaResult: 'failed'` and a lock message, AND durably persists the row via `persistLockedAction` — a race-safe CAS from `['pending', 'awaiting_mfa']` → `'locked'` (from an undecided state ONLY; a concurrent/terminal row is never clobbered and a lost CAS is benign). `blockedOutcome` still emits `events: []` (status `'locked'` is neither `'pending'` nor `'awaiting_mfa'`), i.e. no `mfa_required` and no `action_settled`.
Because the row is now terminal, it is no longer surfaced as a pending decision and `nextPlanDecision`/`withPlanUpdate` do NOT re-emit `mfa_required` for it — the MFA popup does not reappear. A re-attempt on the row returns the SAME idempotent `lockedOutcome` (no new challenge, no consumed attempt, no re-prompt), because `authorizeAction` short-circuits a `'locked'` row before the undecided guard.
No `ToolExecutionResult` is ever built for a lock: `authorizeAndExecute` returns `blockedOutcome` at `../confirmation.ts:37` and SKIPS `executeAuthorizedAction`, so there is no `result`, no `summary`/`error`, and `performAuthorizationResume` is not called. The lock survives as `status: 'locked'`, `message` (the gateway's human lock string) and the typed `code`/`failure` (`CIRCUIT_OPEN` + `{ code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', … }`), and reaches the UI through the HTTP `ActionResponse`, which the client stamps onto the MFA card together with the status.

Two distinct lock messages exist in `@/security/security-gateway`: the session-circuit gate (`lockedOutcome`, 「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」) and the attempt-limit branch of `authorizeWithMfa` (「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」). Both reach this facade verbatim as `ConfirmationOutcome.message`.

### What a lock publishes: a message, never a tool event

- No `ToolEventView`, no `tool_end` and no public `summary`/`errorCode` is produced for a lock: `publishAuthorizedToolOutcome` (`agent/turns/buffer.ts:111-134`) is unreachable because no `ToolExecutionResult` exists. The gateway's `CIRCUIT_OPEN` still crosses the boundary as `ConfirmationOutcome.code` plus `failure` (`contracts.ts:22-25`, copied in `outcomes.ts:73-74`), and the lock is also readable from `status: 'locked'`.
- The only agent-emitted public event with `kind: 'locked'` is `agent/turns/events.ts:92-96` `security_event`, reached ONLY from a model-driven `beforeToolCall` deny (`security-gateway.ts:1241-1247` session breaker, `:1272-1279` cancelled plan), never from confirm/verify. `parseBlockReason` (`security-gateway.ts:762-782`) treats `actionId` as OPTIONAL, so the deny payload DOES parse and the event carries typed `code`/`reason` (plus `attemptsLeft`/`maxAttempts`) and no text field; the zero-field branch (`parsed === null` despite a matching prefix) also emits no raw text, and `components/chat/agent-stream-reducer.ts:490-504` renders the event from those typed fields only.
- `gated-execution.ts:64-67` copies `auth.blockReason ?? auth.decision.message` into `GatedToolOutcome.error`, so the raw marker can also travel into a plan node through `plan-continuation.ts:17-19`, which forwards only `{ ok, data, summary, error }` (no `errorCode`) to `resumeTaskForAction`.
- Public copy depends on an EXACT match: `lib/tool-feedback.ts:25` maps only the attempt-limit sentence 「验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。」 (and `:10` maps the `CIRCUIT_OPEN` code) to `chat.error.securityLocked`. The session-gate sentence 「当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。」 is in no catalog, and `localizeChatError` (`lib/i18n/display.ts:11-18`) is exact-match only, so it falls through to `chat.error.toolFailed` 「操作未完成。请核对原操作卡片和账户记录。」.
- `components/chat/cards/MfaCard.tsx:65-71` renders the reason line only for `terminal === 'failed'`; a `locked` card shows `cards.terminal.locked` 「已锁定」 and exposes the raw message in developer mode only.

At the HTTP edge (`app/api/actions/[id]/verify/route.ts`) a locked verification reports `status: 'locked'`, `requiresMfa: true` (because `tier === 'RED'`) and `mfaResult: 'failed'` — the ternary maps both `'awaiting_mfa'` and `'locked'` to `'failed'`, so a terminal lock is reported as a failed verification.

## Resuming a parked plan node after a human decision

Chain (all inside this directory):
`../confirmation.ts:21-39` `authorizeAndExecute(actionId, opts?, mfaCode?)` → `gateway.authorizeAction` → `blockedOutcome` when `!auth.ok` → `executeAuthorizedAction` (`authorized-execution.ts:22`).
`executeAuthorizedAction` lands the decided side effect, then resumes the plan, then narrates:
`buildConfirmFence(link?.taskId, link?.nodeId, actionId, {…})` (`:39`) → `registry.executeDirect(action.toolName, action.args, { idempotencyKey, fence, … })` (`:49-53`) → `decideConvergence(current, { completion, sideEffectCommitted })` (`:59`) → `settlePendingAction({ actionId, status, result, audit, dedupeKey })` (`:61-72`) → `gateway.recordActionResult` (`:75`) → `resumeOwningPlan(action, result, identity.userId, opts)` (`:80`) → `resumeTurn({ … toolName: link?.taskId ? 'submit_plan' : action.toolName, … })` (`:81-89`).
`plan-continuation.ts:13-37` `resumeOwningPlan(action: PendingAction, result: ToolExecutionResult, userId: string, opts?: ConfirmOptions): Promise<AgentStreamEvent[]>` — `resumeTaskForAction(action.sessionId, action.id, { ok: result.ok, data: result.data, summary: result.summary, error: result.error }, { runTool: … })` (`:17-26`), `synchronizeScheduledWorkflow(resumed.plan.id)` (`:28`), one `plan_update` event (`:29`). Returns `[]` when `resumed === undefined` (a standalone action has no plan link); any failure becomes an `error` event 「任务计划恢复失败：…」 (`:33`) and never throws.

Only two plan-resume call sites exist in this directory: `resumeTaskForAction` at `plan-continuation.ts:17` and `findTaskByPendingAction` at `outcomes.ts:25` (the cancelled-plan guard). No `lifecycle.resumePlan` / `executor.runPlan` / `lifecycle.retryPlan` / `resumeTask` / `retryTask` is called here — the chain continues in `../workflows/action-continuation.ts:24-48` (claim → `lifecycle.resumePlan(toTaskPlan(row), { nodeId: located.nodeId, outcome }, planDeps, { now })` at `:41` → `sweepCancelledPlan` → `releaseTaskExecution` + `settlePlanFromNodes`), with `recordDecidedNodeFenced` (`../task-fencing.ts:217`) recording the single decided node when the plan claim is held elsewhere.

The parked node's own tool is NOT re-invoked by the planner: `planner/lifecycle.ts:322-367` `resumePlan` applies the given outcome through `settleToolNode` (`:340`), persists that node (`:344-345`), and only then calls `runPlan` (`:366`) so dependents run; a re-park returns the snapshot early (`:362`).
A resumed-walk outcome carries `{ ok, data, summary, error }` only — `plan-continuation.ts:19` drops `requiresConfirmation`/`pendingActionId`, so a DOWNSTREAM node that gets gated during the continuation settles `failed` (`planner/node-outcome.ts:30`) with the raw block reason as `error` and never re-parks in `waiting_confirmation`.

## actionId ↔ plan/node matching

The authoritative link is the `PendingAction` row's OWN `taskId`/`nodeId` columns (persisted at creation, `security/security-gateway.ts:704-707`), read by `getPendingActionPlanLink(actionId)` (`lib/db/repositories/pendingAction.ts:304-312`, `select: { id, taskId, nodeId }`). `TaskNodeOutput.pendingActionId` / `readPendingActionId` (`agent/workflows/contracts.ts:4-10`) is the node-side echo, not the lookup key.
Resolvers: `findTaskByPendingAction(sessionId, actionId): Promise<{ taskId: string; nodeId: string } | undefined>` (`../workflows/action-continuation.ts:14-21`, also re-checking `task.sessionId === sessionId`); the reverse direction is `findRepresentedAction(taskId, nodeId)` (`gated-execution.ts:24-27`, `listPendingActionsByTask` + `rows.find(row => row.nodeId === nodeId)`).
Nothing in this directory takes an `actionId` and a `nodeId` as a pair; the only such function is `buildConfirmFence(taskId, nodeId, actionId, expected)` (`../execution-fence.ts:210-215`), called with `link?.taskId, link?.nodeId, actionId` (`authorized-execution.ts:39`, `confirmation-recovery.ts:491`), and `ledgerKeyForAction({ id, taskId, nodeId })` (`lib/ledger.ts:63-73`).

## PendingAction writes reachable from here

| site | method | where | data | kind |
|---|---|---|---|---|
| `liveness.ts:17` → repo `:210-221` `claimPendingActionLease` | `updateMany` | `{ id, status: { in: ['pending','awaiting_mfa'] }, OR: [{ executionLeaseOwner: null }, { executionLeaseExpiresAt: { lte: now } }] }` | lease owner + expiry | CAS on status+lease, no status change |
| `liveness.ts:45` → repo `:235-238` `clearPendingActionLease` | `updateMany` | `{ id, ...(owner ? { executionLeaseOwner: owner } : {}) }` | lease → `null` | CAS on owner |
| `gated-execution.ts:49`, `authorized-execution.ts:61` → `confirmation-recovery.ts:251` `settlePendingAction` | `$transaction` (`:252`) wrapping `claimPendingAction` (`:254-257`) or `setPendingActionStatus` (`:260`) + `resultJson` update (`:263-266`) | CAS: `{ id, status: { in: from }, userId?, sessionId? }` (`repo:262-270`); unconditional `{ id }` | `status`, `resultJson` | CAS when `from` given, else unconditional (`repo:186`); both inside one tx |
| `authorized-execution.ts:75` / `confirmation-recovery.ts:59`-style `gateway.recordActionResult` → `security-gateway.ts:1218-1220` → repo `:186` | `update` | `{ id }` | `status` | UNCONDITIONAL |
| `security-gateway.ts:1162-1168` YELLOW claim | `updateMany` (own tx when `to === 'confirmed'`, `repo:258-260`) | `{ id, status: { in: ['pending'] }, userId, sessionId }` | `status: 'confirmed'` | CAS |
| `security-gateway.ts:1131-1134` policy upgrade | `updateMany` | `{ id, userId, sessionId, status: { in: ['pending','awaiting_mfa'] } }` | `riskLevel:'RED', requiresMfa:true, status:'awaiting_mfa'` | CAS |
| `security-gateway.ts:817-820` `persistLockedAction` (called `:1148`, `:914`) | `updateMany` via `claimPendingAction` | `{ id, status: { in: ['pending','awaiting_mfa'] } }` | `status: 'locked'` | CAS |
| `security-gateway.ts:922-932` verified-MFA claim | `updateMany` inside `prisma.$transaction` | `{ id, status: { in: ['awaiting_mfa','pending'] }, userId, sessionId }` | `status: 'confirmed'` | CAS |
| `security-gateway.ts:940` plan-cancelled reverse | `update` inside the same tx | `{ id: row.id }` | `status: 'cancelled'` | UNCONDITIONAL |
| `security-gateway.ts:993-1002` transfer claim | `updateMany` inside `prisma.$transaction` (`:992`) | `{ id, status: { in: ['pending'] }, userId, sessionId }` | `status: 'confirmed'` | CAS |
| `security-gateway.ts:1014` transfer plan-cancelled reverse | `update` inside the same tx | `{ id: row.id }` | `status: 'cancelled'` | UNCONDITIONAL |
| `security-gateway.ts:1029-1034` transfer escalation | `update` inside the same tx | `{ id: row.id }` | `status:'awaiting_mfa', riskLevel:'RED', requiresMfa:true, summaryJson:…` | UNCONDITIONAL |
| `security-gateway.ts:1197-1203` `cancelAction` | `updateMany` via `claimPendingAction` | `{ id, status: { in: ['pending','awaiting_mfa'] }, userId, sessionId }` | `status: 'cancelled'` | CAS |

`security-gateway.ts:993` also calls `assertActionMayStart` (`repo:275-281`), an identity-preserving `updateMany({ where: { id: actionId }, data: { id: actionId } })` taken purely for SQLite's writer slot. Not reachable from here: `revokePendingActionsByTask` (bulk plan cancel, `repo:169-179`).
