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

`resumeTask` / `retryTask` run `loadOwnedTask` → `assertNoOpenManualReview` → `toTaskPlan` → `assertParkedActionsNotTerminal(plan)` → `claimTaskStatus` → `claimTaskExecution`, and the single `plan` maps the row once. The parked-action check MUST stay BEFORE the first status claim: a refusal therefore leaves the persisted plan status exactly as it was (no `running` flip, no executor walk, no re-driving of the settled node, no lease taken, no tool run).

A settled parked decision is refused with a STRUCTURED `AppError` — never a bare `Error`, never a status string used as a code, and never an effect:
- `locked` (the MFA attempt limit was exhausted; the gateway CAS-ed the action away from `pending`/`awaiting_mfa`) → code `MFA_LOCKED`, `chat.error.actionLocked`.
- `needs_reconciliation` (unknown outcome) → code `CONFLICT`, `chat.error.unknownOutcome`.
- every other terminal status (`executed` / `failed` / `cancelled`) → code `CONFLICT`, `chat.error.stateChanged`.

Status classification comes from the shared vocabulary in `../action-status` (`isTerminalActionStatus` / `isOpenActionStatus` / `TERMINAL_ACTION_STATUSES`); this node defines no private status set. Messages come from the existing catalog through `createTranslator(DEFAULT_LOCALE)`; no new i18n key is introduced here. The public `message` is always a clean business sentence, while `{ taskId, actionId, status }` lives in `detail` as internal diagnostics only. Non-`INTERNAL` codes surface their message verbatim through `app/api/_lib/http.ts#mapAppError` (`MFA_LOCKED` → 423, `CONFLICT` → 409); `detail` never reaches the response body.

The fence is READ-ONLY: it writes no status, claims nothing, executes nothing, replays nothing and creates no authorization. A `locked` plan is never revived by unlock (安全中心 reset) either — after unlocking, the user starts a NEW request and confirms it anew.

## Notes for Agents

`parkedActionIds` filters `plan.results` on `waiting_confirmation` / `waiting_verification` and reads the id with `readPendingActionId` from `./contracts` (the same reader `agent/turns/authorization-view.ts` uses) — do not write another parser for the node output.
Only parked nodes are fenced: a plan with no parked node (a plain `note`/`pending` DAG, a `success` plan) is unaffected, so `pause`→`resume` control flows stay exactly as before.
Boundaries that intentionally keep today's behavior:
- OPEN action (`pending` / `awaiting_mfa`) → not refused; resume/retry proceed through the normal claim + gateway path.
- Missing action row (`null`) → not refused: missing evidence does not prove failure, and the gateway remains the only authority.
- `confirmed` (neither open nor terminal — an authorized continuation still in flight) → not refused, so recovery of a wedge where the node committed its result keeps working.
The refusal precedes `agent/index.ts`'s post-control `synchronizeScheduledWorkflow`, so a refused control never re-syncs a scheduled workflow against a stale plan.
`RevokeSummary.failed[].message` in `cancellation.ts` is written only to `recordSecurityEvent` (internal audit evidence) and is not rendered to users; keep it verbatim for audit fidelity.

## Test Strategy

`parked-actions.test.ts` is a co-located PURE spec (repositories and the ownership reader are mocked; no database, no banking tool): it pins the action-id projection, every status branch (`pending` / `awaiting_mfa` / `null` / `confirmed` / `locked` / `needs_reconciliation` / `executed` / `failed` / `cancelled`), the structured code + catalog message + internal `detail`, and that `resumeTask`/`retryTask` refuse BEFORE `claimTaskStatus`/`claimTaskExecution` while the OPEN cases still claim normally.
