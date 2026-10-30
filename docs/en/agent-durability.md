# Persistence and Recovery

**English** | [简体中文](../cn/agent-durability.md)

The banking agent uses Pi Core to drive conversations and tool calls.
The Prisma database stores model requests, events, and execution receipts.
Recovery continues the original run and preserves the original tool call identity.

## Data Records

| Record | Facts stored |
| --- | --- |
| `AgentRun` | Original input, run state, session version, and execution lease |
| `ModelRequest` | Model request context, complete response, turn, and attempt count |
| `AgentRunEvent` | Events ordered by in-run sequence number |
| `ToolInvocation` | Original parameters, tool call state, retry rules, and execution key |
| `PendingAction` | Original pending-confirmation operation and user authorization result |
| `ExecutionReceipt` | Complete original result of a committed business operation |

Checkpoints store the complete run state.
Checkpoints include messages, session intent, conversation record, and model configuration.
Checkpoints also store compression summaries, original message ranges, and unfinished summary requests.
Model input may use the summary view; checkpoints still store the complete original messages.
For compression and archive queries, see [Context Compression](context-compaction.md).
Session commits verify both the execution lease and the session version.
An old executor cannot overwrite a new session or commit new financial changes.

The same `requestId` and input digest locate the original run.
When the same `requestId` passes different input, the system reports a conflict.
Recovery does not create a replacement run to bypass the original execution state.

## Persistence Order of Requests and Events

Model requests are committed to the database before contacting the model provider.
Summary calls use the public `compact()` of the Pi Coding Agent.
The database adapter layer stores independent compression events and batch checkpoints.
Summary requests do not occupy ordinary business model request identities.
The official `compact()` handles per-batch summaries; the adapter layer handles interruption recovery.
The actual request context of a summary is stored before contacting the provider.
On restart, the saved context is reused, preserving the original summary request identity.
`ModelRequest` stores the original model, endpoint, and tool definitions.
Tools can begin execution only after the complete `message_end` is stored.

### Provider Transport and Auditing

The current `openai-completions` uses the official Pi `fetch` extension point.
A successful SSE response must receive `[DONE]` to end according to protocol.
Receiving only `finish_reason: stop` followed by end-of-file (EOF) is still a connection failure.
Missing `[DONE]` after complete tool parameters also prevents creating an authorization or executing an operation.
Messages and tool parameters are still mapped by the official Pi SDK.
Transport checks do not analyze the body text and do not rewrite provider text.

`withModelAudit` uses the official Pi callbacks to store transport evidence:

| Record | Content |
| --- | --- |
| `provider_request_payload` | The actual request body sent; preserves fields actually transmitted such as `max_tokens` and `stop`. |
| `provider_response_headers` | HTTP status, plus allowlisted content types and request identifiers. |
| `provider_response_event` | Provider response increments, plus the `transport_end` end record. |

The request body comes from `onPayload` and includes the effective values after caller modifications.
Response headers come from `onResponse`, keeping only `content-type`, `x-request-id`, and `request-id`.
Response increments are recorded by `onProviderStreamEvent`.
The end record stores `completed`, the cumulative byte count `bytes`, and the data frame count `frames`.
When the end marker is received, `terminator: [DONE]` is stored at the same time.
All these records are bound to the corresponding `modelRequestId`.
The model request can complete registration only after the records are written.

Tool parameter fragments record only byte counts and redaction markers.
Complete tool calls assembled by Pi are still stored redacted according to the original logging rules.
Authentication headers, keys, and credentials do not enter provider audit records.
Transport completion only proves protocol termination; it does not prove that the language is semantically complete.
Provider audit records serve only as transport evidence and do not judge whether a reply is trustworthy.

Incomplete model output is stored only as event evidence.
Erroneous, aborted, and truncated responses cannot serve as executable decisions.
Recovery regenerates unfinished requests.
Recovered text may differ from the original streaming output.

Original Pi events are stored before conversion or publication.
Tool start events and tool call records are committed in the same transaction.
If log writing fails, execution stops.

| Event channel | Purpose | Visibility |
| --- | --- | --- |
| `raw` | Original Pi lifecycle, model increments, and tool events | Server internal |
| `internal` | Checkpoints, retries, recovery, and provider transport evidence | Server internal |
| `ui` | Display events generated from business facts | Readable by the owning session |

Passwords, identifiable tokens, and keys are redacted before storage.
Input digests are computed from the canonical input before redaction.
Redacted credentials cannot be executed again as operation parameters.

## Tool Call Identity

The server generates tool call IDs and in-run sequence numbers.
Call IDs supplied by the model are used only to associate model messages.
Subsequent model turns may reuse a call ID.
Concurrently overlapping identical call IDs are rejected.

`origin` distinguishes Pi calls from workflow sub-calls.
Sub-calls are associated with model requests, parent calls, tasks, and nodes.
Pi, HTTP resumption, and scheduling paths share `ToolInvocation`.
The node execution key `nodeExecutionKey` remains unchanged after retries.

Tool parameter digests and financial command digests serve different purposes.
The former binds the call proposed by the model.
The latter binds the normalized business parameters.
Verifying execution receipts also requires checking the user, tool, and execution key.
Transfer receipts must also match the booked ledger.

`resultJson` uses the `ToolExecutionResult` format.
Original Pi tool results are still stored in the `raw` event.
`responseJson` stores the complete original result of the execution receipt.
Model text cannot replace these business evidence records.

## Automatic Retry and Result Replay

Replay returns the stored original result.
Retry re-executes the same tool call.
Both actions preserve the original tool call ID and execution key.

| Stored replay rule | Automatic recovery condition |
| --- | --- |
| `read_only` | Automatic querying is still allowed, and the attempt limit has not been exceeded |
| `idempotent` | The adapter can verify identity and digest, and atomically commit the execution receipt |
| `reconcile_only` | Only proven results are recovered; when the result is unknown, it is escalated to manual verification |

Automatic retry checks both the stored rule and the current rule.
Code updates cannot turn an originally unsafe call into one that can be retried automatically.
Retries use compare-and-update; only 1 executor can claim an attempt.

The following situations do not trigger automatic business retries:

- User confirmation or multi-factor authentication has not yet completed.
- Parameter validation, permission checks, or authentication fail.
- Insufficient funds, credit limit exceeded, or business rejection.
- The user cancels, or the result cannot be proven.

If a financial write has been committed, recovering the original execution receipt takes priority.
The system does not charge again just because the end event was lost.
When the receipt is missing or contradictory, automatic recovery stops.

When the user explicitly retries a failed node, the system re-checks authorization.
The system first proves that the original failed attempt did not commit financial effects.
The retry still uses the original node call and execution key.
A new pending-confirmation operation cannot serve as automatic approval of the old operation.

## Recovery Decisions After a Crash

| Interruption point | Recovery action |
| --- | --- |
| Input stored, runtime not yet created | Create the runtime from the original input checkpoint |
| Model request stored, response incomplete | Regenerate the original request, subject to the attempt limit |
| Complete model decision stored, tool not yet started | Check and execute with the original call ID and parameters |
| Query started, original result not stored | Re-check permissions, then retry the original call |
| Financial write committed, return or end event lost | Verify the receipt and ledger, restore the original result |
| Write operation result cannot be proven | Store a manual verification state |
| Confirmation operation stored, session not yet stored | Rebuild the original call context, wait for the original authorization |
| Authorized write operation committed, result display interrupted | Verify the original action and receipt, generate the result text |
| Query confirmed, continuation of the same suggested question interrupted | Verify the original query and question, recover the original analysis request |
| Workflow predecessor node completed | Recover the unique original graph, preserving completed nodes |
| Original planned call stored, graph not yet created | First create the graph after proving there are no sub-calls |
| Session committed, run end state not stored | End the original run, do not request the model again |
| Original session version, model, or endpoint changed | Stop continuation of the original model |
| Tool declarations of an unfinished model request changed | Refuse to resend the original model request |

Resuming the authorization result also verifies the following bindings:

- The original user, session, and pending-confirmation operation.
- The original tool call and parent call.
- The original task, node, and funding account.
- The original tool result in the model context.

When recovering only a specified call, other results that the continuation would use are also checked.
Completed financial calls must have a matching execution receipt.
Old plan results cannot skip the original graph that has not yet been completed.
Paused, cancelled, and failed graphs retain their original control state.

## Recovery of Locked Operations

`locked` is a terminal state: after verification code attempts are exhausted or the account is circuit-broken, the operation has settled as rejected.
Recovery and reconnection only report this fact and do not write the operation back to a pending-decision state.
For lock determination and external wording, see [Security Design](security.md#multi-factor-authentication).

`agent/durable/continuation.ts#restoreWaitingCheckpoint` projects the original parked calls according to the persisted state:

| Persisted state | Content published on recovery |
| --- | --- |
| `locked` | Preserve the original tool row and catalog wording, and additionally emit a typed `security_event`. `code` is `MFA_LOCKED`, and `reason` is `mfa_attempts_exhausted`. |
| `executed`, `failed`, `cancelled`, `needs_reconciliation` | Same structure; `code` and `reason` take the settled facts of that state. |

The projection relies only on persisted state and does not re-distinguish the source of the lock.
`settledParkedProjection` does not rebuild the confirmation or verification code panel.
The committed `__SECURITY_BLOCK__` payload remains in the tool event and internal result, while public text is generated from catalog wording instead.
Locked calls are not re-verified, not retried, and do not enter manual verification.

`agent/action-status.ts#mayPromptForDecision` returns true only when `pending` and `awaiting_mfa`.
`agent/turns/authorization-view.ts` and `agent/turns/events.ts` use the same predicate to publish the decision entry point.
Therefore terminal-state rows do not pop up confirmation or verification code cards after recovery or reconnection.

`agent/action-status.ts#isLegalActionSourceStatus` never treats `locked` as a source state.
`isClaimableActionStatus` likewise excludes `locked`.
`agent/confirmation-recovery.ts#settlePendingAction` rejects illegal sources before the transaction begins, without writing state, results, or audit.

When the user explicitly retries a locked operation, the system creates a new `PendingAction`.
`agent/workflows/parked-actions.ts` rejects the original row with `MFA_LOCKED`.
Account unlocking does not change that row; see [Security Design](security.md#multi-factor-authentication).

## Reply Correction and Suggested-Answer Continuation

The reply format check identifies the complete protocol envelope.
When a format problem is found, the model is asked once to correct it in the original context.
A lone amount, business term, or old draft term does not trigger automatic re-answering.
Processing status and balance are separately subjected to [Fact Checking](chat-presentation.md#handling-status-and-balance).
That check uses existing evidence to generate status and does not add a new model request to replace erroneous statements.
Business results are explained by independent tool records, authorizations, and receipts.
The page temporarily withholds unverified candidate replies from display.
The original candidate continues to be stored; correction does not trim archived messages.
When a candidate body is retracted, only that body's display event is removed.
Tool events, result cards, and plan records published at the same time are retained.

`replyRepair` stores the correction budget for the same run.
The state includes the original candidate checksum, correction instructions, and problem type.
`attempt` is fixed to `1`, meaning at most 1 correction generations.
Stages are stored in the following order:

| Stage | Store or recovery action |
| --- | --- |
| `requested` | First store the budget and original correction instructions, then request the model. |
| `completed` | The correction response is complete; continue validating that response. |
| `fallback` | The correction still has problems; store the specific prompt text. |

When a response has been registered but the stage checkpoint has not yet been stored, recovery identifies that response.
The system updates the stage and does not append a new correction request.
Unfinished correction requests still use the original input according to the model retry rules.
A service restart does not increase the new correction budget.
After the user sends a new message, the system clears the correction state of the previous run.
Output truncation is a generation failure and cannot replace a complete reply.
After receiving `stop` and `[DONE]`, no completion is requested based on sentence-ending words.
When the underlying model stream lacks `done` or `error`, generation failure is registered.
Text and usage received before the stream ended are retained.
The call does not continue waiting for an end event that is already missing.

Queries, suggestions, and processing preparation may require confirmed reads.
After a query is confirmed, processing of the original question still in the current turn may continue.
The server uses `replyContext` to store the original question and its owning model request.
This state is generated only from a verified query context.
Browser parameters and model text cannot set the continuation purpose.

When recovering a query continuation or processing preparation, the following conditions are checked:

- The original model request belongs to that user and session.
- The original question matches the stored question.
- The purpose of the original model request still matches the current declaration.
- The latest user message is still that question.
- The confirmed tool belongs to a query and its result succeeded.

If these conditions are not met, the old question cannot be recovered.
Analysis continuation still blocks write operations and workflow submission.
Processing preparation may bind the complete operation sequence using query results.
Each subsequent write still requires its own authorization.
Read confirmation cannot replace write confirmation or verification codes.
A write sequence cannot be changed once bound.
Result text for financial write operations is generated by the server.
A new round of conversation clears old continuation purposes while retaining the entire conversation archive.

For code, see [Reply Format Check](../../agent/reply-format.ts) and [Reply Correction](../../agent/turns/live-prompt.ts).
For recovery use cases, see [Correction Budget Test](../../tests/unit/agent/durable-reply-repair.test.ts).
For suggested-purpose use cases, see [Suggestion Recovery Test](../../tests/unit/agent/durable-advice-context.test.ts).

## Single Continuation for Declared Writes

When a turn of information is complete and declares a write operation but has no controlled tool call, the runtime appends at most 1 continuation.
For code, see [write-continuation.ts](../../agent/write-continuation.ts).

The declaration comes from `ConversationIntent` recorded by `describe_turn`; it is a model explanation, not an authorization.
Continuation is triggered only when all of the following conditions are met:

- `llmMode` is `live`.
- The declaration contains a tool whose `effect` is `write`.
- The declaration explicitly sets `needsInput:false`.
- This turn has no confirmation event, verification code event, write operation result, or `submit_plan` call.
- The `stopReason` of the last assistant message is `stop`.
- The reply does not require format correction and is not a renderable guidance envelope.

When the processing target or other choices are missing, clarification is retained and the system waits for the user's answer.
When the model omits the declaration and claims the operation has been submitted, the same single continuation may be used to request re-explanation of the request in this turn.
For this branch, `declaredTools` is empty and no operation or authorization is inferred from old text.
DeepSeek non-thinking mode may require calling `describe_turn` first.
This constraint only requires explanation and does not force calling a financial write tool.
Other providers and thinking modes retain the original tool selection method.
For adaptation, see [required-declaration.ts](../../agent/providers/required-declaration.ts).

The budget is stored with checkpoints; for the structure, see `WriteContinuationState` in [reply-repair.ts](../../agent/reply-repair.ts):

| Field | Content |
| --- | --- |
| `phase` | `requested` means the budget and instructions have been stored; `completed` means the continuation request has returned. |
| `attempt` | Fixed to `1`, meaning at most one continuation. |
| `sourceDigest` | Digest of the original assistant message that triggered the continuation. |
| `instruction` | The complete correction instruction sent to the model. |
| `declaredTools` | The write tool name declared in this turn, as evidence only. |

The budget and instructions are committed before contacting the provider.
When resuming, if `phase` is already `completed`, or the original message digest has changed, the model is no longer requested.
When `phase` is still `requested` and the digest matches, resumption reuses the original instruction to send this one request.
The resumption path is in [continuation.ts](../../agent/durable/continuation.ts), and no second continuation is appended.

Continuation first revokes the unverified candidate reply, then publishes `repairing` progress.
Foreground continuation does not set the reply correction marker; otherwise the declared write would be rejected by `beforeToolCall`.
Continuation does not create pending-confirmation operations, nor does it confirm, execute, or bypass the safety gateway.

If there is still no controlled write after continuation, the server explains the true status.
Declared operations have their status generated by [financial-response.ts](../../agent/financial-response.ts) based on true facts.
Branches with omitted declarations have the unsubmitted status explained by [reply-safety.ts](../../agent/reply-safety.ts).
When information still needs to be supplied after error correction, keep the specific question; do not replace the question with an unsubmitted notice.

## Single-turn model call budget

[model-budget.ts](../../agent/model-budget.ts) maintains `ModelBudgetState` for calls in the same turn.
The budget is identified by the intent ID of the turn and is saved with the conversation checkpoint.
Normal generation, context compaction, reply repair, and HTTP retries share the total amount.
Before a request, the count and token reservation are saved first, then the model service is contacted.
Failed requests retain the reservation already used; it is not refunded due to retry or resumption.

Input is reserved based on the UTF-8 byte count of the context plus protocol margin.
Output is reserved based on the request's or model's maximum output; when the balance is insufficient, the output cap is lowered.
Actual HTTP retries reserve again before sending the request.
This conservative estimate is used to limit call volume, not to replace the provider's billing statistics.

The total duration starts from the first model call and includes time between retries and resumption.
After the time limit is reached, the turn's output is terminated even if the provider ignores the cancellation signal.
New user input starts a new budget.
Resumption uses the saved budget; configuration changes can only tighten the original cap.
For default values and environment variables, see the [development guide](development.md#single-turn-model-call-budget).

## Standalone workflows

HTTP and scheduled workflows may have no outer model call.
The complete graph and the resumption source are saved in the same transaction.
The source uses `requestJson.kind = "workflow"`.
The source stage uses `checkpointStage = "workflow_only"`.

Standalone workflow resumption reads the original graph and does not request the model.
Completed sub-calls do not cause the whole graph to end early.
On normal completion, the task status is committed synchronously with the source run status.

Only graphs meeting the following conditions enter automatic resumption:

- The graph is in `pending` or `running`.
- The original task's execution lease has expired, or there is no executor.
- The graph has no open manual-handling records.
- The conversation has no other valid run execution lease.

Before resumption, query node outputs must match the original tool call results.
Financial pre-nodes must match the original parameters, receipts, and ledger.
When evidence is missing, stop subsequent nodes and switch to manual verification.
Waiting for authorization, pausing, failure, and cancellation still require the original control entry point.

Standalone graphs have complete input and can be resumed across subsequent conversation versions.
The new resumption executor still needs to acquire the run and node execution leases.
Model checkpoints depend on the original conversation version and cannot continue across versions.

## Resumption service and public interfaces

| Interface | Content |
| --- | --- |
| `GET /api/runs/:id` | Run and tool call metadata of the owning conversation |
| `GET /api/runs/:id/events` | Read `ui` events by cursor |
| `POST /api/runs/:id/recover` | Resume the original run, optionally specifying the original tool call ID |

Public interfaces do not return original reasoning, request parameters, or lease tokens.
The resumption entry point cannot approve operations or complete authentication on the user's behalf.
Cancelled calls end with `CANCELLED` and do not increase tool attempts.

The resumption service must be started separately; for commands, see the [development guide](development.md).
By default, up to 25 candidate runs are discovered every 5 seconds.
The run execution lease is 120 seconds, and a live executor keeps renewing it.
The standalone workflow execution lease is 600 seconds.
A restart cannot directly seize a still-valid execution lease.

Each model request is attempted at most 3 times, including the first request.
Each run is granted resumption at most 3 times.
Tool calls have a separate saved attempt limit.
Transient model failures keep the original input and save a backoff time.
Permanent failures such as authentication and parameter errors stop automatic resumption.

After receiving `SIGINT` or `SIGTERM`, the service stops claiming new runs.
The service exits after waiting for the current resumption to finish.
After a forced termination, the original persisted records are left for a subsequent executor.
Unknown results pause automatic discovery to prevent repeated empty runs.

## Pi Durable trade-offs

The current project uses Pi Core `1.2.0` fixed.
The project adopts Pi Durable's rules of saving intent first and replaying.
Run records and financial execution receipts share the Prisma database.

Pi Durable's storage interface does not provide a bank transaction handle.
After directly using Pi Durable, financial commit evidence still needs to be solved.
The current transaction commits business changes, audit, receipts, and call status together.
Therefore, the project retains the current transaction and journal code.

Pi Core's event subscription waits for listeners to complete.
The journal subscription is registered before the presentation subscription.
This order ensures the original event is saved first, then transformed or published.

| Basis | Comparison |
| --- | --- |
| [Pi event subscription](https://github.com/earendil-works/pi/blob/v1.2.0/packages/agent/src/agent.ts) | Waits for event listeners to complete |
| [Pi Durable tool code](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/src/harness/tool.ts) | Intent checkpoints and safe replay |
| [Pi Durable storage interface](https://github.com/earendil-works/pi/blob/v1.2.0/packages/durable/src/types.ts) | Storage boundary of run records |

## Code and test entry points

| File | Responsibility |
| --- | --- |
| [journal.ts](../../agent/durable/journal.ts) | Save original events, model requests, and checkpoints |
| [continuation.ts](../../agent/durable/continuation.ts) | Continue the original model execution |
| [action-status.ts](../../agent/action-status.ts) | Status vocabulary, source guards, and decision entry determination for pending-confirmation operations |
| [write-continuation.ts](../../agent/write-continuation.ts) | Single continuation for declared writes and server-side status explanation |
| [authorized-checkpoint.ts](../../agent/durable/authorized-checkpoint.ts) | Verify authorized-result continuation |
| [workflow-resumption.ts](../../agent/durable/workflow-resumption.ts) | Resume the original graph of the outer model call |
| [standalone-workflow.ts](../../agent/durable/standalone-workflow.ts) | Resume standalone graphs |
| [recovery-worker.ts](../../agent/recovery-worker.ts) | Discover candidates and claim resumption tasks |
| [Real process test](../../tests/integration/process-restart.test.ts) | Continue the model and original operations after `SIGKILL` |
| [Standalone graph process test](../../tests/integration/standalone-workflow-restart.test.ts) | Original graph, authorization, control status, and receipts |
| [Single continuation test](../../tests/integration/write-continuation.test.ts) | Foreground and resumption paths each continue only once |
| [Continuation budget test](../../tests/unit/agent/write-continuation-durable.test.ts) | Budget is saved before the request; restart does not add budget |

For how to run tests, see the [testing guide](test-cases.md).
