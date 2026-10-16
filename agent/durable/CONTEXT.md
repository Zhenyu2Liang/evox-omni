# Durable execution context

Owns the persist-first evidence layer for agent runs: the Pi event journal, run leases, stable invocation/model-request identities, bounded retries/recovery and the model-checkpoint continuation used by recovery.

## Intent

Turn a live agent run into durable, replayable evidence — no banking effect is attributed to an operation until its invocation, receipt and model request are persisted — and resume an interrupted run from its saved checkpoint without inventing effects or new operation identities.

## API Surface

`index.ts` (barrel) re-exports exactly: `AgentRunJournal`, `beginRun`, `type BeginRunInput`; `decideInvocationRetry`, `toolReplayPolicy`, `type RetryPolicyCapabilities`, `type RetryState`; `encodeRuntimeValue`, `runtimeRequestDigest`, `snapshotRuntimeValue`; `inspectRunRecovery`, `readRunPresentation`, `recoverInvocation`, `wakeRecoverableRuns`, `type InvocationRecovery`, `type InvocationRecoveryPort`, `type InvocationRecoveryOutcome`.
`continuation.ts` exports `restoreWaitingCheckpoint` (l.35) and `continueDurableRun` (l.110) plus `ContinuationDependencies` (l.103); NOT re-exported from the barrel — imported directly by `service.ts`, `recovery-worker.ts` and tests.
`service.ts` exports `recoverOwnedRun` (l.103) and `getOwnedRunSummary`; NOT re-exported. `standalone-workflow.ts` exports `recoverStandaloneWorkflowRun` (l.125). `journal.ts` exports `AgentRunJournal` (l.32) and `beginRun` (l.26).
`retry-policy.ts` exports `toolReplayPolicy` (l.9), `decideInvocationRetry` (l.35) and the `PERMANENT_ERRORS`/`TRANSIENT_ERRORS` sets. `serialization.ts` exports `snapshotRuntimeValue` (l.7), `encodeRuntimeValue` (l.51), `runtimeRequestDigest` (l.56). `checkpoint.ts` exports `RunCheckpoint`, `encodeCheckpoint`, `decodeCheckpoint`, `hasRedactedCredentials`.

## Continuation model (the "keep going" primitive)

`continueInContext` inside `continueDurableRun` (`continuation.ts:198-202`) is the ONLY existing mechanism that re-asks the model to keep working: it pushes a `role: 'system'` message ("Continue the interrupted answer for this recorded run using the existing conversation and verified results. Do not repeat completed tool calls, restart an earlier request, or treat a historical request as new consent.") when the last message is an assistant, then awaits `runtime.agent.continue()`.
Branch decision after restoring the latest completed model request (`continuation.ts:240-310`): `calls = assistant.content.filter(type==='toolCall')` (l.251); rejected dialogue call → `continueInContext`/server reply (l.294-296); `calls.length === 0` (l.297-301) rebuilds the grounded presentation and then awaits `continueDeclaredWrites(runtime, buffer, () => Date.now(), { config })` (the durable mirror of the live-prompt continuation); `submit_plan` present → server reply (l.302-303); otherwise `continueInContext` (l.304); `checkpointStage==='input'` → `runtime.agent.prompt(request.message!)` (l.308); else `continueInContext` (l.309).
`continuation.ts:310` gates an extra provider generation on `config.llmMode === 'live'` before `repairConversationalReply(...)` — the existing precedent for a live-only extra request. `continueDeclaredWrites` applies the same live-only gate internally (`pendingDeclaredWrites` returns `undefined` unless `config?.llmMode === 'live'`).

## Bounds and budgets

All bounds are enforced by persisted DB counters, not by in-memory loop constants. There is no `MAX_`/`bounded`/`rounds`/`nudge`/`followup`/`re-prompt` identifier anywhere in this directory.
`ModelRequest.maxAttempts Int @default(3)` (`prisma/schema.prisma:539`) — at most 3 attempts per request including the first; `startModelRequest` (`lib/db/repositories/agentRun.ts:307`) reuses an unfinished row but throws `CONFLICT` 'Model request retry limit reached' at `previous.attempt >= previous.maxAttempts` (l.315), and a new request gets `ordinal = previous.ordinal + 1` (l.318).
`AgentRun.maxRecoveryAttempts Int @default(3)` (schema l.518); `listRecoverableAgentRuns` filters `recoveryAttempts < maxRecoveryAttempts` and excludes `RECONCILIATION_REQUIRED`/`WORKFLOW_REQUIRES_ATTENTION`/`CHECKPOINT_MISSING` (`agentRun.ts:281-293`).
`ReplyRepairState.attempt` is the literal `1` → at most ONE corrective generation per durable run (`reply-repair.ts:14`).
Recovery worker: `batchLimit` 1..100 default 25 (`recovery-worker.ts:36-41`), interval default 5000 ms clamped 250..60000 (l.90-93); `wakeRecoverableRuns` clamps limit to 1..100 (`recovery.ts:44`); `readRunPresentation` clamps limit to 1..500 (`recovery.ts:31`).
Run lease `DEFAULT_LEASE_MS = 120_000` (`agentRun.ts:10`); standalone workflow execution lease `WORKFLOW_EXECUTION_LEASE_MS = 600_000` (`lib/contracts/runtime.ts`).

## Identity and digests

Every generation must be a distinct `ModelRequest` row: `AgentRunJournal.prepareModelRequest` (`journal.ts:83`) builds `input = original ?? {messages, systemPrompt, model, tools, requestIntent}`, computes `digest = original&&originalModelDigest ? originalModelDigest : runtimeRequestDigest('model_request', input)` (l.93), sets `this.modelRequestId = undefined` (l.96), then awaits `startModelRequest(lease, digest, json, checkpoint)` (l.98) and stores `this.modelRequestId = attempt.id` (l.99).
`AgentRunJournal.restoreModelRequestIdentity(id, inputJson?, requestDigest?)` (l.57) re-binds the latest persisted request on continuation (`continuation.ts:141`); `currentModelRequestIdentity()` (l.73) feeds presentation.
`runtimeRequestDigest(toolName, args)` (`serialization.ts:56`) = `sha256(JSON.stringify(snapshotRuntimeValue({toolName,args}, false)))`, tagged by domain: `agent_input`, `model_request`, `tool_declarations`, `node_result`, `reply_candidate`, `reply_instruction`, `authorized_context`, `authorized_outcome`, `workflow_result`, `tool_result`.
`recordAgentEvent` on `message_end` computes failure from `['error','aborted','length']` and `retryableModelFailure` → `MODEL_TRANSIENT`/`MODEL_PERMANENT`, then `completeModelRequest(...)` (`journal.ts:137-145`). On `tool_execution_start` it creates the invocation with `modelRequestId: this.modelRequestId` and rejects overlapping `callId`s with `CONFLICT` (l.147-161).

## Bounded continuation for a declared-but-unemitted write

`turns/live-prompt.ts` `runLivePrompt` (l.71) awaits `runtime.agent.prompt(request)` (l.77), then `continueDeclaredWrites(runtime, buffer, now, { config, applyCorrection: true })` (l.83) and finally `repairConversationalReply` (l.84). The durable mirror reuses the same helper: `continueDurableRun`'s `calls.length === 0` branch (`continuation.ts:297-301`) rebuilds the grounded presentation and awaits `continueDeclaredWrites(runtime, buffer, () => Date.now(), { config })`. Both run only when `config.llmMode === 'live'` (`../write-continuation.ts`).
`../write-continuation.ts` `continueDeclaredWrites` spends at most ONE continuation per candidate: the persisted `WriteContinuationState` (`../reply-repair.ts`, `version: 1`, `phase: 'requested' | 'completed'`, `attempt: 1`, `sourceDigest`, `instruction`, `declaredTools`) is written BEFORE `runtime.agent.continue()`, so a restart reuses the recorded request instead of issuing a second one. If the continuation still yields no write evidence, the server publishes `renderFinancialResponse(buffer.factResults, { declared })` (`declared_unsubmitted`) instead of unverified model prose; a real confirmation/MFA card is still produced only by a blocked gateway call.
`banking-agent.ts:336-339` `finishTurn` forces `{action:'end'}` when `config.llmMode === 'live'` and a `submit_plan` succeeded / `stopAfterDecision` — where "the turn already ended" is decided.

## Constraints

Pi events are copied (`snapshotRuntimeValue`) and persisted before any transform or effect; only `ui`-channel grounded events are public.
`checkpoint.ts:decodeCheckpoint` throws `CONFLICT` 'The original provider configuration is required for continuation' if the `llmMode`/`llmProvider`/`llmModel` triple changed.
Invocation receipt replay precedes mutable lookup; a write's committed receipt must match its stored result digest (`service.ts:128-139`) before it is trusted.
`continueDurableRun` throws `CONFLICT` on ownership/revision mismatch (`continuation.ts:115`), on a permanent model failure (`l.142`), on mismatched original tool arguments (`l.260`) and on unresolved original calls (`l.261`).
Never create a replacement operation identity for an uncertain effect; unknown outcomes park as `RECONCILIATION_REQUIRED`/`needs_reconciliation`.
Delegated write evidence and gateway authorization live in `../confirmation/` and `../tools/`; this layer only persists and resumes it.

## Routing Table

- `./` models: `continuation.ts` (model-checkpoint resume), `service.ts` (recovery dispatch), `journal.ts` (event/lease journal), `standalone-workflow.ts` (graph resume without a model), `recovery.ts` (single-invocation recovery), `control-recovery.ts` (describe_turn replay), `authorized-checkpoint.ts` (verified authorization input), `workflow-resumption.ts` + `workflow-invocations.ts` (child-invocation contract), `retry-policy.ts`, `serialization.ts`, `checkpoint.ts`, `tool-result.ts`.
- Recovery driver: `../recovery-worker.ts` (outside this node) — bounded discovery/interval and `tickAgentRecovery`.
- Persistence/repositories: `../../lib/db/repositories/agentRun.ts`; schema `../../prisma/schema.prisma`.
- Callers in the agent root: `../run-turn.ts`, `../turns/live-prompt.ts`, `../banking-agent.ts`, `../reply-repair.ts`.
- Tests: `../../tests/unit/agent/durable-reply-repair.test.ts`, `durable-advice-context.test.ts`, `recovery-worker.test.ts`; `../../tests/integration/agent-durability.test.ts`, `process-restart.test.ts`, `standalone-workflow-restart.test.ts`, `live-recovery.test.ts`.
- Docs: `../../docs/cn/agent-durability.md` (bounds/decision tables), `../../docs/cn/pi-integration.md` (Pi 1.2 contracts).
