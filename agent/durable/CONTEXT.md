# Durable execution context

Owns the persist-first evidence layer for agent runs: the Pi event journal, run leases, stable invocation/model-request identities, bounded retries/recovery and the model-checkpoint continuation used by recovery.

## Intent

Turn a live agent run into durable, replayable evidence — no banking effect is attributed to an operation until its invocation, receipt and model request are persisted — and resume an interrupted run from its saved checkpoint without inventing effects or new operation identities.

## API Surface

`index.ts` (barrel) re-exports exactly: `AgentRunJournal`, `beginRun`, `type BeginRunInput`; `decideInvocationRetry`, `toolReplayPolicy`, `type RetryPolicyCapabilities`, `type RetryState`; `encodeRuntimeValue`, `runtimeRequestDigest`, `snapshotRuntimeValue`; `inspectRunRecovery`, `readRunPresentation`, `recoverInvocation`, `wakeRecoverableRuns`, `type InvocationRecovery`, `type InvocationRecoveryPort`, `type InvocationRecoveryOutcome`.
`continuation.ts` exports `restoreWaitingCheckpoint` (l.68) and `continueDurableRun` plus `ContinuationDependencies`; NOT re-exported from the barrel — imported directly by `service.ts`, `recovery-worker.ts` and tests.
`service.ts` exports `recoverOwnedRun` and `getOwnedRunSummary`; NOT re-exported. `standalone-workflow.ts` exports `recoverStandaloneWorkflowRun`. `journal.ts` exports `AgentRunJournal` and `beginRun`.
`retry-policy.ts` exports `toolReplayPolicy`, `decideInvocationRetry` and the `PERMANENT_ERRORS`/`TRANSIENT_ERRORS` sets. `serialization.ts` exports `snapshotRuntimeValue`, `encodeRuntimeValue`, `runtimeRequestDigest`. `checkpoint.ts` exports `RunCheckpoint`, `encodeCheckpoint`, `decodeCheckpoint`, `hasRedactedCredentials`.

## Continuation model (the "keep going" primitive)

`continueInContext` inside `continueDurableRun` (`continuation.ts:240`) is the ONLY existing mechanism that re-asks the model to keep working: it pushes a `role: 'system'` message ("Continue the interrupted answer for this recorded run using the existing conversation and verified results. Do not repeat completed tool calls, restart an earlier request, or treat a historical request as new consent.") when the last message is an assistant, then awaits `runtime.agent.continue()`.
Branch decision after restoring the latest completed model request: `calls = assistant.content.filter(type==='toolCall')`; rejected dialogue call → `continueInContext`/server reply; `calls.length === 0` rebuilds the grounded presentation and then awaits `continueDeclaredWrites(runtime, buffer, () => Date.now(), { config })` (the durable mirror of the live-prompt continuation); `submit_plan` present → server reply; otherwise `continueInContext`; `checkpointStage==='input'` → `runtime.agent.prompt(request.message!)`; else `continueInContext`.
`continuation.ts:310`-area gating of an extra provider generation on `config.llmMode === 'live'` before `repairConversationalReply(...)` is the precedent for a live-only extra request. `continueDeclaredWrites` applies the same live-only gate internally (`pendingDeclaredWrites` returns `undefined` unless `config?.llmMode === 'live'`).

## Bounds and budgets

All bounds are enforced by persisted DB counters, not by in-memory loop constants. There is no `MAX_`/`bounded`/`rounds`/`nudge`/`followup`/`re-prompt` identifier anywhere in this directory.
`ModelRequest.maxAttempts Int @default(3)` (`prisma/schema.prisma:539`) — at most 3 attempts per request including the first; `startModelRequest` (`lib/db/repositories/agentRun.ts:307`) reuses an unfinished row but throws `CONFLICT` 'Model request retry limit reached' at `previous.attempt >= previous.maxAttempts` (l.315), and a new request gets `ordinal = previous.ordinal + 1` (l.318).
`AgentRun.maxRecoveryAttempts Int @default(3)` (schema l.518); `listRecoverableAgentRuns` filters `recoveryAttempts < maxRecoveryAttempts` and excludes `RECONCILIATION_REQUIRED`/`WORKFLOW_REQUIRES_ATTENTION`/`CHECKPOINT_MISSING` (`agentRun.ts:281-293`).
`ReplyRepairState.attempt` is the literal `1` → at most ONE corrective generation per durable run (`reply-repair.ts:14`).
Recovery worker: `batchLimit` 1..100 default 25 (`recovery-worker.ts:36-41`), interval default 5000 ms clamped 250..60000 (l.90-93); `wakeRecoverableRuns` clamps limit to 1..100 (`recovery.ts:44`); `readRunPresentation` clamps limit to 1..500 (`recovery.ts:31`).
Run lease `DEFAULT_LEASE_MS = 120_000` (`agentRun.ts:10`); standalone workflow execution lease `WORKFLOW_EXECUTION_LEASE_MS = 600_000` (`lib/contracts/runtime.ts`).

## Timing: what actually waits

`journal.ts:223-230` `startHeartbeat(intervalMs = 20_000)` is the ONLY timer in this directory: `setInterval`, `unref?.()`-ed, started on the synchronous turn path by `../turn-runtime.ts:44` (`journal.startHeartbeat()`) and by `service.ts:170`/`standalone-workflow.ts:163` on the recovery path, stopped in `finally`/`finish`.
There is no `setTimeout`, `await new Promise`, sleep, delay or `AbortSignal.timeout` anywhere in `./`; every wait here is a DB round-trip.
A heartbeat renewal renews a 120 000 ms lease once per tick (`renewAgentRunLease`), but it is queued through `enqueue` (`journal.ts:107-117`) — the SAME serialized `tail` as event writes — so renewal latency equals the depth of queued writes ahead of it, not the 20 s tick.
`enqueue` is fail-fast: `this.tail = result.then(() => undefined)` keeps a rejected promise and the next `enqueue` chains onto it, so ONE failed write (lease CAS or SQLite contention) rejects every later write in that journal without executing it; there is no retry, and `finish()` then reports `EVENT_PERSISTENCE_FAILED`.
Every `appendRuntimeEvent`/`startInvocationWithEvent`/`finishInvocationWithEvent`/`saveRunCheckpoint`/`startModelRequest`/`completeModelRequest` is its own `prisma.$transaction` that re-runs `assertAgentRunLease` (2 `findUnique`) first, i.e. 4-6 statements per journal write, and the turn path performs one such write per Pi event, one per `tool_result` checkpoint and one per published presentation event.
`readRunPresentation` pages at most 500 events (`recovery.ts:31`), and `../turn-runtime.ts:16-25` drains all pages with `for (;;)` before the HTTP response is returned, so a long run costs one extra page query per 500 presentation events on the synchronous path.
`recoverInvocation` (`recovery.ts:65`) re-reads the run's FULL invocation list per invocation, so `service.ts:118`/`:173` recovery loops are O(N²) query round-trips (recovery HTTP path, not the chat path).

## Identity and digests

Every generation must be a distinct `ModelRequest` row: `AgentRunJournal.prepareModelRequest` (`journal.ts:84`) builds `input = original ?? {messages, systemPrompt, model, tools, requestIntent}`, computes `digest = original&&originalModelDigest ? originalModelDigest : runtimeRequestDigest('model_request', input)`, clears `this.modelRequestId`, then awaits `startModelRequest(lease, digest, json, checkpoint)` and stores `this.modelRequestId = attempt.id`.
`AgentRunJournal.restoreModelRequestIdentity(id, inputJson?, requestDigest?)` re-binds the latest persisted request on continuation; `currentModelRequestIdentity()` feeds presentation.
`runtimeRequestDigest(toolName, args)` (`serialization.ts`) = `sha256(JSON.stringify(snapshotRuntimeValue({toolName,args}, false)))`, tagged by domain: `agent_input`, `model_request`, `tool_declarations`, `node_result`, `reply_candidate`, `reply_instruction`, `authorized_context`, `authorized_outcome`, `workflow_result`, `tool_result`.
`recordAgentEvent` on `message_end` computes failure from `['error','aborted','length']` and `retryableModelFailure` → `MODEL_TRANSIENT`/`MODEL_PERMANENT`, then `completeModelRequest(...)`. On `tool_execution_start` it creates the invocation with `modelRequestId: this.modelRequestId` and rejects overlapping `callId`s with `CONFLICT`.

## Bounded continuation for a declared-but-unemitted write

`turns/live-prompt.ts` `runLivePrompt` awaits `runtime.agent.prompt(request)`, then `continueDeclaredWrites(runtime, buffer, now, { config })` and finally `repairConversationalReply`. The foreground deliberately does NOT set `applyCorrection` on this continuation: a reply-correction bracket makes `beforeToolCall` reject any write emitted during the continuation, so the declared write could never reach the security gateway and create the real gate. Only `repairConversationalReply` brackets its own format repair with correction. The durable mirror reuses the same helper: `continueDurableRun`'s `calls.length === 0` branch rebuilds the grounded presentation and awaits `continueDeclaredWrites(runtime, buffer, () => Date.now(), { config })`. Both run only when `config.llmMode === 'live'` (`../write-continuation.ts`).
`../write-continuation.ts` `continueDeclaredWrites` spends at most ONE continuation per candidate: the persisted `WriteContinuationState` (`../reply-repair.ts`, `version: 1`, `phase: 'requested' | 'completed'`, `attempt: 1`, `sourceDigest`, `instruction`, `declaredTools`) is written BEFORE `runtime.agent.continue()`, so a restart reuses the recorded request instead of issuing a second one. If the continuation still yields no write evidence, the server publishes `renderFinancialResponse(buffer.factResults, { declared })` (`declared_unsubmitted`) instead of unverified model prose; a real confirmation/MFA card is still produced only by a blocked gateway call.
`banking-agent.ts` `finishTurn` forces `{action:'end'}` when `config.llmMode === 'live'` and a `submit_plan` succeeded / `stopAfterDecision` — where "the turn already ended" is decided.

## Terminal statuses: `locked` never re-opens a decision

`../action-status.ts` is the ONLY status vocabulary here: `isOpenActionStatus`/`mayPromptForDecision` (`pending`, `awaiting_mfa`) versus `isTerminalActionStatus` (`executed`, `failed`, `cancelled`, `locked`, `needs_reconciliation`). No durable file compares status literals locally. Terminal means settled: never re-activated into `pending`/`awaiting_mfa`, never re-prompted for a decision, never resumed or executed, never a transition source. A terminal row is skipped, never rewritten to open.
`restoreWaitingCheckpoint` (`continuation.ts:68`) reads the PERSISTED `PendingAction.status` of the parked call before synthesizing anything (`:110` `mayPromptForDecision`). An OPEN row keeps the synthesis: the `__SECURITY_BLOCK__{actionId, decisionKind}` marker is the public `tool_execution_end` content with `isError` true, so the decision can be resumed. A TERMINAL row — `locked` above all — synthesizes no envelope and publishes no `mfa_required`/`confirmation_required`: the public content is catalog text from `settledParkedProjection` (`:57`, `safePublicText` with `chat.error.actionLocked` for `locked`, `chat.error.stateChanged` otherwise) and one typed `security_event` (`kind:'locked'`, `actionId`, `code`/`reason` from `settledDecisionFacts` `:39`, no `message`, no payload) is appended at `:126`. The historical tool row is still published because the recovered-invocation integrity check (`:129-133`) requires it.
The Pi-internal `ToolResultMessage.content` keeps the original text (`result.summary ?? result.internalSummary ?? summary`, `:119`) with `isError: true` — nothing executed — so the model/classifier contract is unchanged and only the public projection is closed. `locked` is never described as `require_mfa`/`require_confirmation`; it is not a representable `decisionKind`.
`recoverOwnedRun` (`service.ts:217-226`) and `recoverStandaloneWorkflowRun` (`standalone-workflow.ts:177-186`) read the pending rows including `'locked'` and split them with `isOpenActionStatus`: only an OPEN row can produce `waiting_verification`/`waiting_confirmation`, while `confirmed` (authorized, its process died), `locked`, `needs_reconciliation` and every other closed row yield `interrupted` (a graph additionally parks as `WORKFLOW_REQUIRES_ATTENTION`). Such a run is never continued (`service.ts:232` still requires no existing action row before `continueDurableRun`), never re-publishes a decision prompt (`:235` runs only for `waiting_*`), and `standalone-workflow.ts:190` stops reporting a closed invocation as an outstanding authorization.
`recoverInvocation`/`decideInvocationRetry` (`retry-policy.ts:39`) keeps returning `wait_for_authorization` for `waiting_confirmation`/`waiting_verification`, and `PERMANENT_ERRORS` still maps `CIRCUIT_OPEN` to `{action:'stop'}`.

## Authorization outcome injection (`authorized-checkpoint.ts`)

`verifiedAuthorizationInput` is the only gate for a `kind: 'authorization_result'` resume: `toolResult.ok` must be boolean, the owned action must be terminal per `isTerminalActionStatus` (`:19`), and only `toolResult.data` is digest-compared — against the model checkpoint (`:38`) and the committed receipt (`:50`). `toolResult.summary` / `error` / `errorCode` are never digest-verified; they reach the public `tool_end` view (`../turns/buffer.ts`) and `buffer.factResults`.
A successful narration still requires `action.status === 'executed'` with a replayed receipt; a failed narration is rejected for an executed action (`:42`) and remains possible for a settled refusal such as `locked`, which provably executed nothing. `locked` and `needs_reconciliation` are terminal, so neither can become a success claim.

## Public text of durable projections

`ToolInvocation.resultJson.summary` is PUBLIC text: `../transcript-activity.ts` re-projects it onto the historical tool row once the invocation settles. `journal.ts:172-174` therefore stores `summary` only when `isInternalDiagnostic` does not match, keeps the untouched text as `internalSummary` (`:182`) and never drops the original `content`/`data`/`error` evidence, so the classifier, the model and the receipt/digest checks still see the raw tool result. Read the internal text back as `result.summary ?? result.internalSummary`.
`workflow-resumption.ts:65-69` funnels a resuming graph's node failure the same way: `isInternalDiagnostic(failure.error)` (a `gated-execution` `auth.blockReason` payload) becomes `chat.error.toolFailed` plus the typed `errorCode: 'TOOL_FAILED'`, while a business sentence stays verbatim; the graph summary counts completed steps instead of echoing a plan status literal.
Every public refusal renders from typed fields through `@/lib/public-text` (`safePublicText`/`securityNotice`) or a catalog key — never from a `__SECURITY_BLOCK__…` payload, a JSON fragment, a stack trace or a status literal.

## Constraints

Pi events are copied (`snapshotRuntimeValue`) and persisted before any transform or effect; only `ui`-channel grounded events are public.
`checkpoint.ts:decodeCheckpoint` throws `CONFLICT` 'The original provider configuration is required for continuation' if the `llmMode`/`llmProvider`/`llmModel` triple changed.
Invocation receipt replay precedes mutable lookup; a write's committed receipt must match its stored result digest (`service.ts`) before it is trusted.
`continueDurableRun` throws `CONFLICT` on ownership/revision mismatch, on a permanent model failure, on mismatched original tool arguments and on unresolved original calls.
Never create a replacement operation identity for an uncertain effect; unknown outcomes park as `RECONCILIATION_REQUIRED`/`needs_reconciliation`.
Delegated write evidence and gateway authorization live in `../confirmation/` and `../tools/`; this layer only persists and resumes it.
No financial arithmetic and no domain money field exists here: amounts, fees, rates and receipts stay opaque inside a tool result's `data`/`content`/`summary` or an `ExecutionReceipt` row, and this layer only snapshots, digest-compares and replays those blobs.
A parked decision is re-presented only while its persisted row is open; a terminal row is skipped and reported through typed event fields, never through text.
Raw tool payloads stay in the stored `content`/`internalSummary` evidence for the model and classifiers; every user-visible string is funnelled through `@/lib/public-text` or a catalog key.

## Known Issues

`lib/db/repositories/agentRun.ts` `synchronizeRunActionInvocations`/`finalizeReceiptedAgentRun` still enumerate settled statuses inline without `locked`, so a locked row never settles its `ToolInvocation` (it stays `waiting_verification`) and a run whose only remaining row is locked can be finalized without reconciliation. This layer compensates (`closedActions` prevents the decision prompt) but those lists belong to `TERMINAL_ACTION_STATUSES` in `lib/`.

## Routing Table

- `./` models: `continuation.ts` (model-checkpoint resume), `service.ts` (recovery dispatch), `journal.ts` (event/lease journal), `standalone-workflow.ts` (graph resume without a model), `recovery.ts` (single-invocation recovery), `control-recovery.ts` (describe_turn replay), `authorized-checkpoint.ts` (verified authorization input), `workflow-resumption.ts` + `workflow-invocations.ts` (child-invocation contract), `retry-policy.ts`, `serialization.ts`, `checkpoint.ts`, `tool-result.ts`.
- Recovery driver: `../recovery-worker.ts` (outside this node) — bounded discovery/interval and `tickAgentRecovery`.
- Persistence/repositories: `../../lib/db/repositories/agentRun.ts`; schema `../../prisma/schema.prisma`.
- Callers in the agent root: `../run-turn.ts`, `../turns/live-prompt.ts`, `../banking-agent.ts`, `../reply-repair.ts`.
- Shared vocabulary: `../action-status.ts` (open/terminal predicates — reuse, never re-declare); `../../lib/public-text.ts` (public text funnel).
- Tests: `../../tests/unit/agent/durable-reply-repair.test.ts`, `durable-advice-context.test.ts`, `recovery-worker.test.ts`, `turn-security-event.test.ts`; `../../tests/integration/agent-durability.test.ts`, `process-restart.test.ts`, `standalone-workflow-restart.test.ts`, `live-recovery.test.ts`; in-node `*.test.ts` (`authorized-checkpoint`, `checkpoint`, `control-recovery`, `journal`, `recovery`, `retry-policy`, `serialization`, `service`, `tool-result`).
- Docs: `../../docs/cn/agent-durability.md` (bounds/decision tables), `../../docs/cn/pi-integration.md` (Pi 1.2 contracts).
