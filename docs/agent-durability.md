# Agent durability and banking command recovery

## Decision

Keep `@earendil-works/pi-agent-core` pinned to `1.1.0`. Store every original Agent event in a Prisma journal and retain a separate grounded presentation channel. Use the bank's atomic execution receipts as committed-effect evidence. Do not introduce Pi Durable as a second persistence authority.

This decision was checked against official Pi `v1.1.0`, commit `abe508e1b89912adde45528136c3221eb69acdd7`.

Pi Durable is an independent Harness based on Pi AI and Chord. Its [Storage interface](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/types.ts#L1015-L1025) persists Pi records; it does not expose a Prisma transaction to bank commands. Its [Session implementation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/src/session/session.ts#L402-L446) runs the application callback before admitting the storage batch. A bank adapter would still need atomic receipts and reconciliation across the effect/outcome boundary.

The official [watch documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#watching-a-conversation) describes throttled partial/output commits and snapshot replacement for slow consumers. That is useful for live state but differs from retaining each original provider/Agent event. The [storage documentation](https://github.com/earendil-works/pi/blob/v1.1.0/packages/durable/README.md#storage) assumes one process owns storage at a time. A direct migration would also require replacing current tools, hooks, and session integration.

Pi Core already offers the necessary barrier: [Agent.subscribe()](https://github.com/earendil-works/pi/blob/v1.1.0/packages/agent/src/agent.ts#L255-L269) awaits listeners in registration order. The tool loop awaits the started event before preflight. Register the journal first, await its transaction, and only then ground or publish the event. A failed append propagates; it must not be converted into a presentation error while execution continues.

## Records and identities

`AgentRun` admits an input, stores its request identity, and owns a fenced session execution lease. A repeated request ID with the same digest locates the original run; a different digest is a conflict. Recovery reclaims that run rather than minting new operation identities.

`AgentRunEvent` appends each event with a monotonically increasing run-local sequence. The `raw` channel retains original lifecycle events, model deltas, and tool evidence. The `ui` channel stores server-grounded presentation events. HTTP readers can read only `ui`; raw reasoning is internal. Structured credentials and recognizable bearer/API tokens are redacted before storage. Original request digests use unredacted canonical inputs, so redaction does not collapse distinct operations.

`ToolInvocation` uses a server-generated ID and a run-local ordinal. Provider call IDs are correlation data and may repeat in later rounds. Concurrent calls with the same provider identity are rejected because their completion events would be ambiguous. A started event and invocation creation commit together. The default banking operation key is derived from the invocation ID. Pending commands may bind the invocation to the authoritative command identity before parking.

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

`POST /api/runs/:id/recover` accepts only an optional original invocation ID. It first verifies immutable bank receipts, then reclaims the original run if an interrupted GREEN read needs a bounded retry. Gated reads, confirmation, and MFA still require their original authorization. The endpoint never sends a bank write, grants a new approval, or blindly repeats a workflow submission.

Pending-action settlement synchronizes approved read results and terminal decisions into the linked invocation in the same transaction. Explicit recovery also reconciles stored terminal actions before deciding whether authorization is still pending. Financial writes synchronize their completed invocation through the banking receipt transaction. A later Pi end event remains in the raw journal but cannot replace a completed receipt or a terminal action decision. Repeated synchronization does not append duplicate settlement events.

A run's outstanding actions are scoped to its invocation IDs, operation keys and submitted plan identity. Unrelated pending actions and newer session runs cannot prevent an older run from converging to its terminal facts. Cancelled invocations settle the original run as failed with `CANCELLED` without a new tool attempt.

Interrupted model generation is deliberately reported as interrupted when there is no recoverable tool result. The saved state checkpoint supports inspection and future model continuation, but this recovery endpoint does not regenerate model planning after a crash. This keeps the supported recovery guarantee explicit: original tool results and banking command outcomes are recoverable, while automatic process-level model replay is not implemented.
