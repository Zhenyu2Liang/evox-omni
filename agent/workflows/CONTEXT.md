# Workflow control and continuation context

## Intent

Owns persistence-backed workflow control for the planner: pause/resume/retry/cancel, decision-driven continuation after a pending action, node/plan execution leases and lease-fenced persistence.
These modules are tool-agnostic: they route every tool through the generic `TaskRunTool(toolName, args, context)` passthrough and name no concrete banking tool.
No card-consumption / spend / purchase / pay / debit capability, helper, type or scenario exists here.

`parked-actions.ts` owns the ONE terminal-state fence over a plan's parked human decisions. A parked node stores `{ pendingActionId }` in `AgentTaskNode.output`, so the plan snapshot alone cannot distinguish an OPEN decision from an already-settled one; the fence reads the PERSISTED `PendingAction` status before any control may re-activate the plan.

## API Surface

- `contracts.ts`: `TaskRunTool`, `TaskControlDeps`, `TaskControlOptions`, `TaskPersistence`, `TaskPersistenceOptions`, `TaskPersistenceMode`, `readPendingActionId`.
- `ports.ts`: `buildPlanDeps`, `defaultPollControls`, `UNUSED_RUN_TOOL`, `PAUSE_NOW_CONTROLS`.
- `controls.ts`: `pauseTask`, `resumeTask`, `retryTask` (status gating via `PAUSABLE`/`RESUMABLE`/`RETRYABLE`).
- `parked-actions.ts`: `parkedActionIds`, `assertParkedActionsNotTerminal`.
- `cancellation.ts`: `cancelTask`, `sweepCancelledPlan`, `RevokeSummary`, `REVOCABLE_ACTION_STATUSES`.
- `action-continuation.ts`: `findTaskByPendingAction`, `resumeTaskForAction`.
- `ownership.ts`: `loadOwnedTask`, `loadOwnedTaskWithOwner`, `getTaskPlan`.
- `claims.ts`: `buildNodeClaimPorts`, `planExecutionClaimHeld`, `clearStaleNodeClaims`, `TERMINAL_NODE_STATUSES`, `staleExecutionClaimBefore`.
- `persistence.ts`: `toTaskPlan`, `createTaskPersistence`.
- `execution-context.ts`: `withWorkflowExecutionClaim`, `currentWorkflowExecutionClaim`, `WorkflowExecutionClaim`.

There is no `index.ts`; the public surface is the facade `agent/task-control.ts`.

## Three status vocabularies meet here — never conflate them

- **PLAN** (`TaskPlanStatus`): `PAUSABLE`/`RESUMABLE`/`RETRYABLE` (`controls.ts:15-17`) and `NON_CANCELLED_PLAN_STATUSES` (`persistence.ts:9`). `waiting_confirmation` is listed in all three control sets, so a plan parked on a human decision is pausable, resumable and retryable — subject to the parked-action fence below.
- **NODE** (`TaskNodeStatus`): `TERMINAL_NODE_STATUSES` (`claims.ts:7`) = `success|failed|skipped|cancelled`. These are NODE states, never `PendingAction` states. `waiting_confirmation`/`waiting_verification` are deliberately absent so `clearStaleNodeClaims`/`claimNode` can re-drive a parked node.
- **ACTION** (`PendingActionStatus`): shared vocabulary is `../action-status.ts` (`OPEN_ACTION_STATUSES`, `TERMINAL_ACTION_STATUSES`, `isOpenActionStatus`, `isTerminalActionStatus`, `mayPromptForDecision`). Importers here: `parked-actions.ts` (`isTerminalActionStatus`) and `cancellation.ts` (`OPEN_ACTION_STATUSES` via `REVOCABLE_ACTION_STATUSES`). No `'locked'` literal and no `blockReason`/`__SECURITY_BLOCK__` handling exists anywhere in this directory.

## Re-driving a node whose action is terminal

`resumeTask` (`controls.ts:27`) and `retryTask` (`controls.ts:49`) fence on the parked action BEFORE any status claim; without that fence the planner re-executes every node outside its own terminal set, so a `waiting_confirmation` node would call `deps.runTool` again (`planner/executor.ts:474`) → `executeGatedTool` → security gateway.
- A `locked` row is never reactivated by the gateway either: every CAS source is `pending|awaiting_mfa` (`security/security-gateway.ts`). After the breaker resets, the same node mints a NEW action, because the decision-reuse set `agent/confirmation/gated-execution.ts:19-21` omits `locked` and `failed` — that set, not this directory, decides whether a node's settled decision may be re-presented.
- The planner has no `explicitRetry` option. `controls.ts:60` passes `explicitRetry` into `TaskPersistenceOptions`, so it only reaches `withWorkflowExecutionClaim` (`ports.ts:33`); `lifecycle.retryPlan` resets only `pending`/`failed`/`skipped` (`planner/lifecycle.ts:273-279`) and rebuilds them without `output`, so a retried node loses its old `pendingActionId`.
- `lifecycle.resumePlan` writes the decision back, then continues the whole graph, so downstream nodes execute.
- Reachability of resume/retry for a `waiting_confirmation` plan: the user-triggered `POST /api/tasks/[id]` pause/resume/retry control, `agent/durable/workflow-resumption.ts:50` (reads no action status — it now inherits this fence through `resumeTask`), the standalone-graph driver, and `agent/confirmation/plan-continuation.ts:17` — the last one is unreachable for `locked` because the gateway returns `ok:false` and `agent/confirmation.ts:37` returns before `executeAuthorizedAction`.

## Locating a parked node (reuse, do not re-query)

`parkedActionIds` filters `plan.results` on `waiting_confirmation` / `waiting_verification` and reads the id with `readPendingActionId` from `./contracts` (the same reader `agent/turns/authorization-view.ts` uses) — do not write another parser for the node output.
`findTaskByPendingAction` (`action-continuation.ts:14`) resolves via `getPendingActionPlanLink` (`lib/db/repositories/pendingAction.ts:304-312`), whose projection is `{ id, taskId, nodeId }` — it neither filters nor returns `status`, so a `locked`/`executed` actionId still resolves to its task. `resumeTaskForAction` (`:24-48`) reads only the TASK row (early return on `status === 'cancelled'`) and never the action row; it is unreachable for a `locked` action because the caller only reaches it with an authorized outcome.
- `getPendingAction(actionId)` (`pendingAction.ts:110-118`) → full row incl. `status`; `getPendingActionOwnership` (`:288-296`) → `{id,userId,sessionId,status}` (the projection the fence uses).
- `listPendingActionsByTask(taskId, { statuses })` (`:144-156`) → rows incl. `status`/`nodeId`; pass `[...OPEN_ACTION_STATUSES]`, since omitting `statuses` returns terminal rows too.
- `revokePendingActionsByTask(taskId, fromStatuses)` (`:169-179`) is a blind `updateMany`: passing a terminal status would rewrite it (`locked` → `cancelled`), so only open statuses may be passed — hence `REVOCABLE_ACTION_STATUSES`.

## Public text

`RevokeSummary.failed[].message` = `AppError.from(error).message` only when it is ordinary business text; `revokeFailureText` (`cancellation.ts:41`) replaces an internal diagnostic (`isInternalDiagnostic`: `__SECURITY_BLOCK__`, JSON fragment, stack, `undefined`/`null` placeholder) with `chat.error.toolFailed`, and the typed `code` (`cancellation.ts:54`) carries the machine-readable classification. This matters because that summary is persisted into `recordSecurityEvent`'s `detail` (`cancellation.ts:61-65`) and `GET /api/security` returns audit records verbatim (`app/api/security/route.ts:113-129`) — audit text is browser-visible in this product.
`UNUSED_RUN_TOOL`'s `INTERNAL` message (`ports.ts:10-12`) is masked (`app/api/_lib/http.ts#mapAppError` rewrites only `INTERNAL`; every other code's message ships verbatim).
`ownership.ts:9,10,12` interpolate `taskId` into `NOT_FOUND`/`SECURITY_DENIED`; those are unreachable over HTTP because `POST /api/tasks/[id]` rejects mismatched ownership before calling in.

## Constraints

Leases and staleness use the real clock (`Date.now()`); the pinned demo clock cannot measure owner liveness.
Executor-mode writes always prove ownership via plan/node token fences; only explicit `control`-mode intents write without a lease.
Cancellation revokes parked open actions and is committed together with the status change; already-committed money stays settled.
A takeover clears only nonterminal child claims while still owning the parent.
`ALREADY_SETTLED_CODES` (`cancellation.ts:19`) folds the gateway's `CONFLICT` on an already-terminal row into `alreadySettled`, so revoking a `locked` action reports "settled" rather than "locked".

`resumeTask` / `retryTask` run `loadOwnedTask` → `assertNoOpenManualReview` → `toTaskPlan` → `assertParkedActionsNotTerminal(plan)` → `claimTaskStatus` → `claimTaskExecution`, and the single `plan` maps the row once.
The parked-action check MUST stay BEFORE the first status claim: a refusal therefore leaves the persisted plan status exactly as it was (no `running` flip, no executor walk, no re-driving of the settled node, no lease taken, no tool run).

A settled parked decision is refused with a STRUCTURED `AppError` — never a bare `Error`, never a status string used as a code, and never an effect:
- `locked` (the MFA attempt limit was exhausted; the gateway CAS-ed the action away from `pending`/`awaiting_mfa`) → code `MFA_LOCKED`, `chat.error.actionLocked`.
- `needs_reconciliation` (unknown outcome) → code `CONFLICT`, `chat.error.unknownOutcome`.
- every other terminal status (`executed` / `failed` / `cancelled`) → code `CONFLICT`, `chat.error.stateChanged`.

Status classification comes from the shared vocabulary in `../action-status` (`isTerminalActionStatus` / `isOpenActionStatus` / `TERMINAL_ACTION_STATUSES`); this node defines no private action-status set. Messages come from the existing catalog through `createTranslator(DEFAULT_LOCALE)`; no new i18n key is introduced here. The public `message` is always a clean business sentence, while `{ taskId, actionId, status }` lives in `detail` as internal diagnostics only. Non-`INTERNAL` codes surface their message verbatim through `app/api/_lib/http.ts#mapAppError` (`MFA_LOCKED` → 423, `CONFLICT` → 409); `detail` never reaches the response body.

The fence is READ-ONLY: it writes no status, claims nothing, executes nothing, replays nothing and creates no authorization. A `locked` plan is never revived by unlock (安全中心 reset) either — after unlocking, the user starts a NEW request and confirms it anew.

## Notes for Agents

The `runTool` seam is supplied by callers (entry points/app routes) which pass the concrete banking tool dispatcher; this directory never defines tool names.
Control-only paths use `UNUSED_RUN_TOOL`, which throws if a tool execution is attempted.
Card tools (`get_cards`, `set_card_limit`, `freeze_card`, etc.) are therefore not referenced in this layer.
Lease semantics are in `claims.ts`; card/`PendingAction` status policy belongs to `../action-status.ts`, not here.

Only parked nodes are fenced: a plan with no parked node (a plain `pending`/`success` DAG) is unaffected, so `pause`→`resume` control flows stay exactly as before.
Boundaries that intentionally keep today's behavior:
- OPEN action (`pending` / `awaiting_mfa`) → not refused; resume/retry proceed through the normal claim + gateway path.
- Missing action row (`null`) → not refused: missing evidence does not prove failure, and the gateway remains the only authority.
- `confirmed` (neither open nor terminal — an authorized continuation still in flight) → not refused, so recovery of a wedge where the node committed its result keeps working.
The refusal precedes `agent/index.ts`'s post-control `synchronizeScheduledWorkflow`, so a refused control never re-syncs a scheduled workflow against a stale plan.

## Test Strategy

`parked-actions.test.ts` is a co-located PURE spec (repositories and the ownership reader are mocked; no database, no banking tool): it pins the action-id projection, every status branch (`pending` / `awaiting_mfa` / `null` / `confirmed` / `locked` / `needs_reconciliation` / `executed` / `failed` / `cancelled`), the structured code + catalog message + internal `detail`, and that `resumeTask`/`retryTask` refuse BEFORE `claimTaskStatus`/`claimTaskExecution` while the OPEN cases still claim normally.
Cancellation revoke/race behavior is covered outside this directory by `tests/unit/agent/task-cancel-revokes.test.ts` and `tests/integration/cancellation-result-race.test.ts`.
