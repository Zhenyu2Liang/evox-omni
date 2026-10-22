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

There is no `index.ts`; the public surface is the facade `agent/task-control.ts`.

## Three status vocabularies meet here — never conflate them

- **PLAN** (`TaskPlanStatus`): `PAUSABLE`/`RESUMABLE`/`RETRYABLE` (`controls.ts:14-16`) and `NON_CANCELLED_PLAN_STATUSES` (`persistence.ts:9`). `waiting_confirmation` is listed in all three control sets, so a plan parked on a human decision is pausable, resumable and retryable.
- **NODE** (`TaskNodeStatus`): `TERMINAL_NODE_STATUSES` (`claims.ts:7`) = `success|failed|skipped|cancelled`. These are NODE states, never `PendingAction` states. `waiting_confirmation`/`waiting_verification` are deliberately absent so `clearStaleNodeClaims`/`claimNode` can re-drive a parked node.
- **ACTION** (`PendingActionStatus`): shared vocabulary is `../action-status.ts` (`OPEN_ACTION_STATUSES`, `TERMINAL_ACTION_STATUSES`, `isOpenActionStatus`, `isTerminalActionStatus`, `mayPromptForDecision`). Nothing here imports it: `cancellation.ts:59` and `:63` inline `['pending','awaiting_mfa']` instead of `OPEN_ACTION_STATUSES`. No `'locked'` literal and no `blockReason`/`__SECURITY_BLOCK__` handling exists anywhere in this directory.

## Re-driving a node whose action is terminal

`resumeTask` (`controls.ts:34`) and `retryTask` (`controls.ts:52`) read no `PendingAction` row, and the planner re-executes every node outside its own terminal set: a `waiting_confirmation` node calls `deps.runTool` again (`planner/executor.ts:474`) → `executeGatedTool` → security gateway.
- A `locked` row is never reactivated because every gateway CAS source is `pending|awaiting_mfa`; the invariant is enforced at the gateway, not here. After the breaker resets, the same node mints a NEW action (the reuse set `agent/confirmation/gated-execution.ts:19-21` omits `locked` and `failed`).
- The planner has no `explicitRetry` option. `controls.ts:52` passes `explicitRetry` into `TaskPersistenceOptions`, so it only reaches `withWorkflowExecutionClaim` (`ports.ts:33`); `lifecycle.retryPlan` resets only `pending`/`failed`/`skipped` (`planner/lifecycle.ts:273-279`) and rebuilds them without `output`, so a retried node loses its old `pendingActionId`.
- `lifecycle.resumePlan` writes the decision back, then continues the whole graph, so downstream nodes execute.
- Reachability of resume/retry while a plan is `waiting_confirmation`: `agent/durable/workflow-resumption.ts:50` (no action-status read), the user-triggered `POST /api/tasks/[id]` pause/resume/retry control, and `agent/confirmation/plan-continuation.ts:17` — the last one is unreachable for `locked` because the gateway returns `ok:false` and `agent/confirmation.ts:37` returns before `executeAuthorizedAction`.

## Locating a parked node (reuse, do not re-query)

`findTaskByPendingAction` (`action-continuation.ts:14`) resolves via `getPendingActionPlanLink` (`lib/db/repositories/pendingAction.ts:304-312`), whose projection is `{ id, taskId, nodeId }` — it neither filters nor returns `status`, so a `locked`/`executed` actionId still resolves to its task. `resumeTaskForAction` (`:24-48`) reads only the TASK row (early return on `status === 'cancelled'`) and never the action row.
- `getPendingAction(actionId)` (`pendingAction.ts:110-118`) → full row incl. `status`; `getPendingActionOwnership` (`:288-296`) → `{id,userId,sessionId,status}`.
- `listPendingActionsByTask(taskId, { statuses })` (`:144-156`) → rows incl. `status`/`nodeId`; pass `[...OPEN_ACTION_STATUSES]`, since omitting `statuses` returns terminal rows too.
- `revokePendingActionsByTask(taskId, fromStatuses)` (`:169-179`) is a blind `updateMany`: passing a terminal status would rewrite it (`locked` → `cancelled`), so only open statuses may be passed.

## Public text

`RevokeSummary.failed[].message` = `AppError.from(error).message` (`cancellation.ts:32`) and it is persisted into `recordSecurityEvent`'s `detail` (`:42`); `GET /api/security` returns `audit.listSecurityEvents` verbatim (`app/api/security/route.ts:113-129`), so gateway text and interpolated ids reach the browser through that route. The audit-only `message` at `:41` is a fixed sentence carrying `taskId`.
`UNUSED_RUN_TOOL`'s `INTERNAL` message (`ports.ts:10-12`) is masked (`app/api/_lib/http.ts#mapAppError` rewrites only `INTERNAL`; every other code's message ships verbatim).
`ownership.ts:9,10,12` interpolate `taskId` into `NOT_FOUND`/`SECURITY_DENIED`; those are unreachable over HTTP because `POST /api/tasks/[id]` rejects mismatched ownership before calling in.

## Constraints

Leases and staleness use the real clock (`Date.now()`); the pinned demo clock cannot measure owner liveness.
Executor-mode writes always prove ownership via plan/node token fences; only explicit `control`-mode intents write without a lease.
Cancellation revokes parked pending/awaiting_mfa actions and is committed together with the status change; already-committed money stays settled.
A takeover clears only nonterminal child claims while still owning the parent.
`ALREADY_SETTLED_CODES` (`cancellation.ts:16`) folds the gateway's `CONFLICT` on an already-terminal row into `alreadySettled`, so revoking a `locked` action reports "settled" rather than "locked".

## Notes for Agents

The `runTool` seam is supplied by callers (entry points/app routes) which pass the concrete banking tool dispatcher; this directory never defines tool names.
Control-only paths use `UNUSED_RUN_TOOL`, which throws if a tool execution is attempted.
Card tools (`get_cards`, `set_card_limit`, `freeze_card`, etc.) are therefore not referenced in this layer.
Lease semantics are in `claims.ts`; card/`PendingAction` status policy belongs to `../action-status.ts`, not here.
