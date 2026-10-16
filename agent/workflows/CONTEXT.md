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

## Notes for Agents

The `runTool` seam is supplied by callers (entry points/app routes) which pass the concrete banking tool dispatcher; this directory never defines tool names.
Control-only paths use `UNUSED_RUN_TOOL`, which throws if a tool execution is attempted.
Card tools (`get_cards`, `set_card_limit`, `freeze_card`, etc.) are therefore not referenced in this layer.
