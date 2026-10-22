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
Card tools (`get_cards`, `set_card_limit`, `freeze_card`, etc.) are therefore not referenced in this layer.
