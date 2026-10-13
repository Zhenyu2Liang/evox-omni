# Agent durability and banking command recovery

## Decision

Keep `@earendil-works/pi-agent-core` pinned to `1.1.0`. Store every original Agent event in a Prisma journal and retain a separate grounded presentation channel. Use the bank's atomic execution receipts as committed-effect evidence. Do not introduce Pi Durable as a second persistence authority.

This decision was checked against official Pi `v1.1.0`, commit `abe508e1b89912adde45528136c3221eb69acdd7`.

Pi Durable is an independent Harness based on Pi AI and Chord. Its [Storage interface](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/types.ts#L1015-L1025) persists Pi records; it does not expose a Prisma transaction to bank commands. Its [Session implementation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/session/session.ts#L402-L446) runs the application callback before admitting the storage batch. A bank adapter would still need atomic receipts and reconciliation across the effect/outcome boundary.

The official [watch documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#watching-a-conversation) describes throttled partial/output commits and snapshot replacement for slow consumers. That is useful for live state but differs from retaining each original provider/Agent event. The [storage documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#storage) assumes one process owns storage at a time. A direct migration would also require replacing current tools, hooks, and session integration.

Pi Core already offers the necessary barrier: [Agent.subscribe()](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/src/agent.ts#L255-L269) awaits listeners in registration order. The tool loop awaits the started event before preflight. Register the journal first, await its transaction, and only then ground or publish the event. A failed append propagates; it must not be converted into a presentation error while execution continues.

## Records and identities

`AgentRun` admits an input, stores its request identity, and owns a fenced session execution lease. A repeated request ID with the same digest locates the original run; a different digest is a conflict. Recovery reclaims that run rather than minting new operation identities.

The admission transaction also saves a complete input checkpoint and the session's base revision. Subsequent checkpoints contain the original provider configuration, model endpoint, Agent messages, conversation intent and transcript. The session commit checks both revision and the current run lease in the same transaction; an older owner cannot overwrite a replacement's conversation or post a bank effect.

`ModelRequest` records an ordinal, input digest, complete request context, provider model, tool declarations, status and bounded attempt count. `prepareRequest` commits its intent before contacting the provider. A complete assistant `message_end` commits the result and a complete checkpoint before any tool preflight. Streaming partials remain raw evidence and never become executable tool decisions. Error, aborted and truncated messages do not become complete results.

`AgentRunEvent` appends each event with a monotonically increasing run-local sequence. The `raw` channel retains original lifecycle events, model deltas, and tool evidence. The `ui` channel stores server-grounded presentation events. HTTP readers can read only `ui`; raw reasoning is internal. Structured credentials and recognizable bearer/API tokens are redacted before storage. Original request digests use unredacted canonical inputs, so redaction does not collapse distinct operations.

`ToolInvocation` uses a server-generated ID and a run-local ordinal. Provider call IDs are correlation data and may repeat in later rounds. Concurrent calls with the same provider identity are rejected because their completion events would be ambiguous. A started event and invocation creation commit together. The default banking operation key is derived from the invocation ID. Pending commands may bind the invocation to the authoritative command identity before parking.

`origin` distinguishes Pi and workflow child calls. The original model request, parent invocation, task and node are explicit identities. Every DAG bank tool uses this same invocation table, including automatic reads and tools resumed through HTTP or scheduler paths. A node's invocation and `nodeExecutionKey` survive takeover and retry. Unique source graph and node constraints prevent a second graph or operation identity from being created for the same recorded intent.

The invocation request digest identifies the model-facing request. A bank command's receipt digest identifies the normalized domain command. These serve different boundaries: receipt reconciliation must first verify the bank's owner, command, operation key, and normalized digest, then supply the verified original receipt to the invocation recovery function.

The invocation's `resultJson` uses the application's `ToolExecutionResult` shape. The raw event retains the original Pi `AgentToolResult`. Agent command receipts retain the full canonical response in `responseJson`; invocation recovery verifies that exact response in the authoritative receipt table. Missing or corrupt evidence requires reconciliation, without any historical format fallback.

## Replay and retry

Borrow Pi Durable's [stored intent and replay rules](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/harness/tool.ts#L82-L110): capture arguments and replay policy before execution, never upgrade an unsafe historical intent after a code change, and keep interruption distinct from a proven failure. Pi Durable does not rerun `beforeTool` after the intent checkpoint. Banking authorization therefore belongs at the actual command write boundary, regardless of the Agent hook used for early rejection.

Completed invocations replay their original result. Read operations without results can retry with a bounded attempt count. A write is `idempotent` only after its adapter checks owner and request digest and commits the business mutation, immutable receipt, and audit together. All other writes default to `reconcile_only`. A crash after a possible external effect does not justify another write.

Confirmation and verification park the invocation. Validation errors, security denials, cancellation, and business rejections do not trigger automatic retries. Retry eligibility is checked against both stored and current policy. A claimed retry keeps the same invocation and operation key and advances its attempt with a compare-and-set update.

If a bank receipt exists but the Agent end event was not saved, restore the original result from that receipt and record recovery. Do not debit again. A missing or mismatched receipt leaves the operation unresolved. Worker discovery only locates expired or interrupted runs; the host must reacquire a lease and apply the explicit recovery decision before invoking anything.

`recoverInvocation()` is an execution port for one original invocation. It checks the lease, prioritizes a verified receipt, claims a permitted attempt with an atomic recovery-start event, then invokes the trusted adapter. A successful write must yield an actual bank receipt; a response without one becomes `needs_reconciliation`. The adapter must repeat current authorization and the transaction fence. Ordinary repeated failed requests remain settled; `beginRun({ recover: true })` allows explicit owner-requested recovery to reclaim the same run.

## Runtime integration

1. Call `beginRun()` with server-owned session/user identity and a stable transport request ID.
2. If the result has no lease, return the existing run rather than execute it again.
3. Construct `AgentRunJournal`, register `journal.subscribe(agent)` first, and start its heartbeat.
4. In tool preflight, use `journal.invocationForCall()` for the stable operation identity and park confirmed/MFA commands explicitly.
5. Persist each grounded presentation event before streaming it.
6. Await `journal.flush()` and `journal.finish()` on every success, waiting, and failure path.
7. Recover committed commands through verified receipts; retry only after the policy decision and invocation attempt claim.

## Public recovery surface

`GET /api/runs/:id` returns invocation metadata for the cookie-owned session and user. It excludes raw messages, reasoning, arguments, request text, and lease tokens. `GET /api/runs/:id/events` reads the grounded presentation channel with an exclusive sequence cursor. Raw events remain internal.

`POST /api/runs/:id/recover` accepts only an optional original invocation ID. It verifies immutable bank receipts, reclaims the original run, retries eligible interrupted GREEN reads through fresh security evaluation, resumes the original graph, and continues the original complete model checkpoint when execution evidence is resolved. A complete recorded assistant decision with no started invocation executes its original calls through the ordinary schema validation and gateway hooks. A partial assistant decision is discarded and its original model request is regenerated. New decisions still require current permission, confirmation and MFA; unknown committed effects stop for reconciliation.

Pending-action settlement synchronizes approved read results and terminal decisions into the linked invocation in the same transaction. Explicit recovery also reconciles stored terminal actions before deciding whether authorization is still pending. Financial writes synchronize their completed invocation through the banking receipt transaction. A later Pi end event remains in the raw journal but cannot replace a completed receipt or a terminal action decision. Repeated synchronization does not append duplicate settlement events.

A run's outstanding actions are scoped to its invocation IDs, operation keys and submitted plan identity. Unrelated pending actions and newer session runs cannot prevent an older run from converging to its terminal facts. Cancelled invocations settle the original run as failed with `CANCELLED` without a new tool attempt.

## Process restart and model continuation

The model's in-memory stream is not resumed at a byte offset. Recovery regenerates an unfinished model request from its exact saved input, with the same model, endpoint and tool declaration fingerprint. Each model intent allows at most three total attempts. Authentication, invalid-request, validation and other permanent failures stop; transient model failures retain the complete input checkpoint and use persisted backoff. A run allows at most three recovery admissions, independently of tool attempt limits.

| Durable boundary at interruption | Recovery behavior |
| --- | --- |
| Input admitted, runtime not constructed | Construct the original configured runtime from the admission checkpoint |
| Model intent saved, response incomplete | Retry the original bounded model request; never execute partial tool calls |
| Complete assistant decision saved, call not started | Validate and execute the recorded call ID and arguments through current gateway hooks |
| Eligible read intent started, result absent | Retry the same invocation and operation identity with current security evaluation |
| Bank write committed, response or Pi end event lost | Verify the receipt and ledger, then insert the original result into the original model context |
| Write outcome cannot be proved | Preserve reconciliation state and suspend automatic worker recovery |
| Confirmation or MFA persisted before session save | Rebuild the original parked call in session state and wait for the original decision |
| Authorized effect committed, result narration interrupted | Verify the original action, call binding and bank receipt; continue its saved narration without another command |
| DAG predecessor committed | Resume the unique original graph, preserve completed nodes and reuse child invocations |
| Graph intent saved but graph not created | Create its first graph only after proving no child effect exists and checking the new lease |
| Session state committed but run finalization lost | Finalize without another model request or bank effect |
| Newer session revision or different provider/tool definitions | Stop the obsolete continuation rather than overwrite or reinterpret it |

[`agent/durable/continuation.ts`](../agent/durable/continuation.ts) reconstructs the original provider call/result adjacency. [`workflow-resumption.ts`](../agent/durable/workflow-resumption.ts) resumes the graph under the current run fence. A paused or cancelled graph is not advanced automatically. Redacted credentials cannot be supplied as real operation arguments.

Run `pnpm agent:recover` for one bounded recovery pass, or `pnpm agent:worker` for a resident worker. The worker uses lease-protected admission, persisted backoff and attempt caps; concurrent workers may discover the same run but only the admitted owner executes it. Graceful shutdown drains the current recovery before stopping. This worker is separate from `pnpm scheduler:tick`, which dispatches due business schedules.

Run leases expire after 120 seconds and renew during live execution. A restart does not bypass a still-valid lease. The worker's default discovery interval is 5 seconds. Shutdown stops admission and drains the current recovery; a forceful kill leaves work for the next eligible owner.

## Independent workflow recovery

HTTP and scheduled workflows can have no outer Pi call or model request. Their full graph and recovery source commit together, with `requestJson.kind = "workflow"` and `checkpointStage = "workflow_only"`. [`standalone-workflow.ts`](../agent/durable/standalone-workflow.ts) resumes this original graph without calling a model. A completed child does not imply that the whole graph completed.

Discovery requires the graph to be pending or running, with no live executor and no open manual review. Workflow execution claims expire after 600 seconds by default; discovery and claim admission share the same constant. A null claim permits admission immediately. The driver verifies saved query outputs against invocation results and verifies completed financial predecessors against their original receipt and ledger before downstream work can consume them. Missing evidence parks the run for reconciliation.

Paused, failed, cancelled and parked human decisions preserve their original control state. Automatic recovery does not invoke the explicit failed-node retry path. A user-requested retry can produce fresh authorization only after proving the earlier attempt did not commit; it retains the node invocation and operation key. Source run state and ordinary task lease release or final node settlement synchronize transactionally.

An independent graph can survive later conversation revisions because it has its own complete input. Admission aligns its base revision only when neither a session executor nor a task executor is live; all new effects remain fenced by the admitted run and node ownership. Model continuation, by contrast, stops when its original conversation revision has changed.

## Verification

[`process-restart.test.ts`](../tests/integration/process-restart.test.ts) uses real child processes and `SIGKILL` to cover partial model generation, a complete decision before tool intent, read interruption, a committed budget, a committed DAG predecessor, a parked transfer followed by approval, and interrupted narration after an authorized transfer. It verifies original invocation and graph identities, one bank effect and one success audit. [`standalone-workflow-restart.test.ts`](../tests/integration/standalone-workflow-restart.test.ts) covers independent graph restart, committed predecessors, parked approvals, control retention, receipt integrity and live/manual ownership. Additional transaction tests cover model retry limits, persisted backoff, permanent failure, lease replacement and newer conversation revisions.
