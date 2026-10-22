# Workflow control and continuation context

## Intent

Owns persistence-backed workflow control for the planner: pause/resume/retry/cancel, decision-driven continuation after a pending action, node/plan execution leases and lease-fenced persistence.
These modules are tool-agnostic: they route every tool through the generic `TaskRunTool(toolName, args, context)` passthrough and name no concrete banking tool.
No card-consumption / spend / purchase / pay / debit capability, helper, type or scenario exists here.

## API Surface

- `contracts.ts`: `TaskRunTool`, `TaskControlDeps`, `TaskControlOptions`, `TaskPersistence`, `TaskPersistenceOptions`, `TaskPersistenceMode`, `readPendingActionId`.
- `ports.ts`: `buildPlanDeps`, `defaultPollControls`, `UNUSED_RUN_TOOL`, `PAUSE_NOW_CONTROLS`.
- `controls.ts`: `pauseTask`, `resumeTask`, `retryTask` (status gating via `PAUSABLE`/`RESUMABLE`/`RETRYABLE`).
- `cancellation.ts`: `cancelTask`, `sweepCancelledPlan`, `RevokeSummary`.
- `action-continuation.ts`: `findTaskByPendingAction`, `resumeTaskForAction`.
- `ownership.ts`: `loadOwnedTask`, `loadOwnedTaskWithOwner`, `getTaskPlan`.
- `claims.ts`: `buildNodeClaimPorts`, `planExecutionClaimHeld`, `clearStaleNodeClaims`, `TERMINAL_NODE_STATUSES`, `staleExecutionClaimBefore`.
- `persistence.ts`: `toTaskPlan`, `createTaskPersistence`.
- `execution-context.ts`: `withWorkflowExecutionClaim`, `currentWorkflowExecutionClaim`, `WorkflowExecutionClaim`.

## Constraints

Leases and staleness use the real clock (`Date.now()`); the pinned demo clock cannot measure owner liveness.
Executor-mode writes always prove ownership via plan/node token fences; only explicit `control`-mode intents write without a lease.
Cancellation revokes parked pending/awaiting_mfa actions and is committed together with the status change; already-committed money stays settled.
A takeover clears only nonterminal child claims while still owning the parent.

## Lease, generation and parked-node semantics

`resumeTask` (`controls.ts:26`), `retryTask` (`controls.ts:44`) and `resumeTaskForAction` (`action-continuation.ts:24`) each mint `newId('taskclaim')`, then `claimTaskExecution` — which atomically sets `executionToken` and INCREMENTS `AgentTask.generation` (`lib/db/repositories/task.ts:198-208`) — then `clearStaleNodeClaims`, then run/continue the plan, and in `finally` `releaseTaskExecution` + `settlePlanFromNodes`.
`waiting_confirmation`/`waiting_verification` are NOT terminal node statuses (`planner/executor.ts:155-160`), so `resumeTask` RE-WALKS a parked node through `deps.runTool`; the default adapter (`agent/index.ts:300` → `executeGatedTool`) finds the represented `pending`/`awaiting_mfa` action for that node and returns `requiresConfirmation` with the SAME `pendingActionId` (`agent/confirmation/gated-execution.ts:41-60`), so resuming neither re-executes nor duplicates the gated command — a human decision still arrives only through `resumeTaskForAction`.
`retryTask` resets only `failed`/`skipped`/`pending` nodes plus descendants (`planner/lifecycle.ts:242-301`); a parked node is not reset but is still re-walked.

## PendingAction writes reachable from this directory

No file here touches `prisma.pendingAction`; only `cancellation.ts` mutates action state:
- `cancellation.ts:27` `security.gateway.securityGateway.cancelAction(actionId, { userId, sessionId })` → CAS `claimPendingAction({ from: ['pending','awaiting_mfa'], to: 'cancelled', userId, sessionId })` (`security/security-gateway.ts:1197-1203`).
- `cancellation.ts:59` (pre-transaction) and `:63` (inside the transaction) `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'], tx?)` → `updateMany({ where: { taskId, status: { in: fromStatuses } }, data: { status: 'cancelled' } })` (`lib/db/repositories/pendingAction.ts:174-177`) — CAS on status only, never user-scoped.
- `cancellation.ts:65` `restoreCommittedCancellationNodes` → `pendingAction.update({ where: { id }, data: { status: 'needs_reconciliation', … } })` (`agent/cancellation-evidence.ts:49`) — the one UNCONDITIONAL status write reachable from here, inside the cancel transaction.
`cancelTask` revokes three times, so rows cancelled by the bulk pass land in `RevokeSummary.alreadySettled` (gateway `CONFLICT`) and only the in-transaction bulk pass catches actions created concurrently.

## Notes for Agents

The `runTool` seam is supplied by callers (entry points/app routes) which pass the concrete banking tool dispatcher; this directory never defines tool names.
Control-only paths use `UNUSED_RUN_TOOL`, which throws if a tool execution is attempted.
Confirm-continuation (`resumeTaskForAction`) claims the PLAN slot with a fresh `taskclaim` token, clears nonterminal node claims, builds deps via `buildPlanDeps(..., { mode: 'executor', planToken })` and calls `lifecycle.resumePlan`; a LOST plan claim instead records the decided node via `recordDecidedNodeFenced` and never drives the walk.
On that path `runTool` is `executeGatedTool` (`confirmation/plan-continuation.ts:21`), so a DOWNSTREAM node can re-park with `requiresConfirmation`/`pendingActionId`, while the decided node's own outcome is narrowed to `{ ok, data, summary, error }` (`plan-continuation.ts:19`) and can never re-park.
`buildPlanDeps` receives the default no-op `onNodeUpdate`, so the confirmation walk emits no per-node events; the single `plan_update` is emitted from the reloaded `getTaskPlan` snapshot (the `resumePlan` return value is discarded).
A `paused` plan is wired to `PAUSE_NOW_CONTROLS`; unlike `resumeTask`/`retryTask`, `resumeTaskForAction` does not call `assertNoOpenManualReview`.
Card tools (`get_cards`, `set_card_limit`, `freeze_card`, etc.) are therefore not referenced in this layer.
None of these functions is an agent tool: `lib/contracts/tool-catalog.ts` has no pause/resume/retry/cancel-task entry (only the planner's `submit_plan`), so plan control is reachable only through `agent/index.ts` wrappers and `POST /api/tasks/[id]`.

## Durable write map

Status gates (`controls.ts:14-16`): `PAUSABLE=['pending','running','paused','waiting_confirmation']`, `RESUMABLE=['running','paused','waiting_confirmation','pending','failed']`, `RETRYABLE=['pending','paused','waiting_confirmation','failed']`; every claim is `claimTaskStatus` → one `prisma.agentTask.updateMany({ where: { id, status: { in: fromStatuses }, ...(to==='running' ? { manualReviews: { none: { status: 'open' } } } : {}), ...(fenceToken ? { executionToken: fenceToken } : {}) }, data: { status: to } })` returning `count === 1` (`lib/db/repositories/task.ts:140-157`).
`pauseTask` (`controls.ts:18-24`) writes NO node row: `claimTaskStatus(PAUSABLE,'paused')` (`:20`) then a control-mode `executor.persistPlanSnapshot` (`:22`) which re-claims status `'paused'` through `persistence.ts:44-46` (`NON_CANCELLED_PLAN_STATUSES` minus `success`, no fence); `lifecycle.pausePlan(plan,{now})` is pure and takes no deps (`planner/lifecycle.ts:125`), the unused `paused` status is forced by the caller. It does not call `assertNoOpenManualReview`.
`resumeTask` (`controls.ts:26-42`) DOES launch execution: `assertNoOpenManualReview` (`:28`) → `claimTaskStatus(RESUMABLE,'running')` (`:29`) → `claimTaskExecution(taskId, newId('taskclaim'), { staleBefore: staleExecutionClaimBefore() })` (`:31`) → `clearStaleNodeClaims(taskId, token)` (`:32`) → `executor.runPlan(toTaskPlan(row), buildPlanDeps(taskId, deps, undefined, { planToken: token }), { now: deps.now, explicitResume: true })` (`:34`) → `sweepCancelledPlan` (`:35`) and `finally` `releaseTaskExecution` (`:37`) + `settlePlanFromNodes(taskId)` (`:39`).
`retryTask` (`controls.ts:44-61`) mirrors it and calls `lifecycle.retryPlan(...)` at `:52` with `explicitRetry: true`, then `claimTaskStatus(taskId, ['running'], result.status)` at `:54` so a no-op retry does not stay `running`; `retryPlan` resets only `pending`/`failed`/`skipped` nodes (never `success`) to `pending` and persists a `pending` plan snapshot before walking (`planner/lifecycle.ts:242-300`).
`claimTaskExecution` writes `{ executionToken: token, executionClaimedAt: new Date(), generation: { increment: 1 } }` with `where: { id, manualReviews: { none: { status: 'open' } }, OR: [{ executionToken: null }, { executionClaimedAt: { lt: staleBefore } }] }` (`lib/db/repositories/task.ts:198-214`).
`cancelTask` (`cancellation.ts:56-73`) writes `PendingAction` status `'cancelled'` and `AgentTask.status='cancelled'`: `revokePendingActionsByTask(taskId, ['pending','awaiting_mfa'])` (`:59`), per-action `security.gateway.cancelAction` (`:27`), then one transaction (`:62-67`) repeating `revokePendingActionsByTask(..., tx)` (`:63`), `tx.agentTask.update({ where: { id: taskId }, data: { status: 'cancelled' } })` (`:64`) and `restoreCommittedCancellationNodes(tx, taskId, userId, (options.now ?? demoNow)())` (`:65`); afterwards `lifecycle.cancelPlan(toTaskPlan(row), buildPlanDeps(..., { mode: 'control' }), { now })` (`:68-70`) writes every non-terminal node to `cancelled` and the plan snapshot.
`revokePendingActionsByTask` is the only pending-action write here: `pendingAction.updateMany({ where: { taskId, status: { in: fromStatuses } }, data: { status: 'cancelled' } })` returning the count (`lib/db/repositories/pendingAction.ts:169-179`); no `'revoked'` status exists.
`sweepCancelledPlan` (`cancellation.ts:47-54`) writes no plan/node row; it no-ops unless `row.status === 'cancelled'`, then revokes leftover parked actions via the gateway and records a `HIGH_RISK_BLOCKED` security event on failure.
`restoreCommittedCancellationNodes` (`agent/cancellation-evidence.ts:11`) rewrites a non-terminal `kind:'tool'` node to `success` when a receipt (or, for `transfer_money`, the ledger row) proves commit, or to `failed` plus `PendingAction.status='needs_reconciliation'` on a result conflict; nodes without evidence stay untouched.
`resumeTaskForAction` (`action-continuation.ts:24-48`): `findTaskByPendingAction` (`:26`) → `getTask` (`:28`) → early return when the plan is `cancelled` (`:30`) → `claimTaskExecution` (`:32`). A LOST plan claim records only the decided node via `recordDecidedNodeFenced({ taskId, nodeId, outcome, now })` (`:33`, fenced update; 0 rows means a live owner keeps the truth) and never drives the walk; a WON claim clears node claims (`:37`), builds `{ mode: 'executor', planToken }` deps (`:39`), swaps `PAUSE_NOW_CONTROLS` when the plan is `paused` (`:40`) and calls `lifecycle.resumePlan(toTaskPlan(row), { nodeId, outcome }, planDeps, { now: deps.now })` (`:41`), which itself persists the decided node and plan status before running downstream nodes through `runPlan` (`planner/lifecycle.ts:322-366`).
`persistNode` (`persistence.ts:48-69`) is the terminal-rewrite fence: executor mode with a node or plan token issues `agentTaskNode.updateMany({ where: { taskId, nodeId, ...(token ? { executionToken: token } : {}), ...(planToken ? { task: { executionToken: planToken } } : {}), ...(terminal ? { status: { notIn: TERMINAL_NODE_STATUSES } } : {}) }, data: { ...toNodeUpdate(node), output: jsonNodeOutput(node) } })`; executor mode without any token returns silently (`:63`); control mode drops the token predicates and keeps only `status: { notIn: TERMINAL_NODE_STATUSES }` (`:65-68`) so a cancellation snapshot cannot overwrite committed results.
`buildNodeClaimPorts(planId, planToken)` (`claims.ts:35-67`) claims a node with `agentTaskNode.updateMany({ where: { taskId: planId, nodeId, status: { notIn: TERMINAL_NODE_STATUSES }, task: { executionToken: planToken }, OR: [{ executionToken: null }, { executionClaimedAt: { lt: staleExecutionClaimBefore() } }] }, data: { executionToken: token, executionClaimedAt: new Date() } })` and renews the parent via `agentTask.updateMany({ where: { id: taskId, executionToken: token }, data: { executionClaimedAt: new Date() } })` (`claims.ts:14-19`); without a plan token it delegates to `claimNodeExecution`.
`planExecutionClaimHeld(planId, token)` (`claims.ts:29-32`) and `defaultPollControls(planId)` (`ports.ts:16-25`) are read-only; the latter maps persisted `paused`→`[{kind:'pause'}]` and `cancelled`→`[{kind:'cancel'}]` without consuming the control.
`settlePlanFromNodes(taskId)` (`agent/task-fencing.ts:162`) settles a plan whose nodes are all terminal only when `executionToken` is null, writing `agentTask.updateMany({ where: { id: taskId, executionToken: null, status: { in: ['pending','running','waiting_confirmation'] } }, data: { status } })` with `success` or `failed`.

## Callers

`agent/index.ts:320/325/332/339` wrap the internal functions (re-exported through `agent/task-control.ts`); `resumeTask`/`retryTask` bind `runTool: taskRunToolFor(sessionId)` (`index.ts:300-317`, always `executeGatedTool`), and `resumeTask`/`cancelTask`/`retryTask` also call `synchronizeScheduledWorkflow(taskId)`.
HTTP: `POST /api/tasks/[id]` (`app/api/tasks/[id]/route.ts:71`, body `z.enum(['pause','resume','cancel','retry','rollback'])` at `:44-46`, call at `:86`) → `app/api/_lib/agent-bridge.ts:59-65`.
Other internal callers: `sweepCancelledPlan` from `agent/tools/planning.ts:393`; `resumeTask` from `agent/scheduled-dispatcher.ts:106`, `agent/durable/workflow-resumption.ts:50`, `agent/durable/standalone-workflow.ts:165`, `agent/index.ts:226` (`recoverAction`); `resumeTaskForAction` from `agent/confirmation/plan-continuation.ts:17`; `findTaskByPendingAction` also from `agent/confirmation/outcomes.ts:25`.
