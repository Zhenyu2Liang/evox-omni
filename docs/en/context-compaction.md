# Conversation Archiving and Context Compression

**English** | [简体中文](../cn/context-compaction.md)

The complete conversation is stored in the database and is not trimmed by message count.
Compression directly calls the Pi Coding Agent's official `compact()`.
When a model request exceeds the compression threshold, the adapter layer prepares the archive scope and generates a summary.
The model then reads the summary and the recent complete conversation.
The user page can still read the original messages.

The summary prompt and history serialization are handled by the official `compact()`.
The database adapter layer handles bank constraints, persistence, and recovery.

## Official Interfaces and Project Adaptation

The project imports functions from the public entry point of `@earendil-works/pi-coding-agent`.
The 3 direct Pi dependencies are pinned to `1.2.0` in [package.json](../../package.json).
The `overrides` of `pnpm-workspace.yaml` additionally pins 5 `@earendil-works/*` transitive dependencies.
The actual resolved versions are governed by [pnpm-lock.yaml](../../pnpm-lock.yaml).

| Responsibility | Responsible module |
| --- | --- |
| Summary prompt, history serialization, and summary generation | Official `compact()`. |
| Message token estimation and compression trigger determination | Official `estimateTokens()`, `shouldCompact()`. |
| Current model, service provider address, and request function | The project's model runtime passes in `model` and `streamFn`. |
| Bank record archiving, owning user and session | The project's database and execution identity. |
| Complete recent turns and tool pairing | The project's archive scope and retention policy. |
| Batching of oversized archives, events, and checkpoints | The project's bank persistence adapter layer. |

The Coding Agent's `AgentSession.compact()` is an upper-layer session method.
This method also manages coding sessions, extension hooks, and the recovery process.
Bank sessions use Prisma to persist state, so they directly call the lower-level public functions.
The project does not create the Coding Agent's file session manager.
The project also does not start a Coding Agent command-line session.
The bank tool registry does not register file, Shell, or coding tools.

## Stored Data and Model Requests

Stored data and the model request view are handled separately.

| Data | Storage method | Purpose |
| --- | --- | --- |
| Raw user, assistant, and tool messages | Fully stored in session state and run events. | Archiving, verification, and recovery. |
| User page messages | Fully stored in conversation records. | Read history by page. |
| History summary and compression scope | Stored as session compression metadata. | Construct subsequent model requests. |
| Summary requests and model increments | Stored as separate compression events. | Query the summary generation process and recover from interruptions. |

Compression only changes the view sent to the model.
Summaries do not overwrite original messages and do not truncate assistant answers.
Recent messages are retained as complete user turns.
Tool calls and their corresponding results are retained in the same turn.

Historical user original words and complete tool groups continue to be retained.
The model view is compressed only within the coverage scope of registered summaries.
`projectedMessages` inserts a history memory message after the summary.
This message declares that it is not a new instruction and is not authorization.
A new user message starts a new turn declaration.
Amounts in old requests and summaries cannot replace the current turn's declaration or authorization.
Confirmed tool results still belong to the original call.

When the projection exceeds the model budget, `VALIDATION` is thrown.
The failure reason is written as `CONTEXT_BUDGET_EXCEEDED`, including the token count and budget.
At this point, history is not cleared and answers are not truncated.

## Compression Triggering

The adapter layer uses `estimateContextTokens` to estimate the request size.
This function compensates for Chinese characters on top of the official `estimateTokens()`.
The estimate includes system messages and tool declarations.
`shouldCompact` compares the threshold with the model context capacity.
`compactionCut` determines the compressible scope by complete user turns.
`compactionCut` retains at least the latest user turn.
`summaryBatches` splits only the summary input, not the archived messages.

| Environment variable | Default value | Meaning |
| --- | --- | --- |
| `AGENT_COMPACTION_THRESHOLD_TOKENS` | `60000` | Attempt to compress history after exceeding this value. |
| `AGENT_COMPACTION_RESERVE_TOKENS` | `8192` | Context space reserved for model responses. |
| `AGENT_COMPACTION_KEEP_RECENT_TOKENS` | `12000` | Target size for retaining recent complete turns. |
| `AGENT_COMPACTION_SUMMARY_TOKENS` | `2048` | Maximum output size per summary request. |

Environment variables accept integers from `128` to `1000000`.
Invalid configurations use default values.
The model budget equals the context capacity minus the reserved space.
The actual threshold does not exceed this budget.
The reserved space does not exceed one quarter of the context capacity.
The recent retention target does not exceed half of the actual threshold.
The summary output limit does not exceed one eighth of the actual threshold, with a minimum of `128`.

When the original conversation exceeds a single summary window, the adapter layer batches by message group.
Each batch directly calls the official `compact()` and passes in the previous batch's summary.
A single oversized message is split into text fragments only in the summary input.
Original messages and financial tool results continue to be archived in full.
Official serialization limits the length of tool results in the summary input.
This limit is `TOOL_RESULT_MAX_CHARS`, taking `2000` characters.
Original tool results in the database are not subject to this limit.

The reserved space for formal model requests and the summary output quota are handled separately.
The project's `AGENT_COMPACTION_RESERVE_TOKENS` reserves answer space.
The `reserveTokens` of the official summary preparation parameters is used to calculate the summary quota.
The adapter layer sets this parameter according to `ceil(summaryTokens / 0.8)`.
The default summary limit of `2048` tokens corresponds to the preparation parameter `2560`.
The official function also limits summary output according to the model's `maxTokens`.
When a single-batch summary request exceeds the context capacity, `VALIDATION` is thrown.
The failure reason is written as `COMPACTION_BUDGET_EXCEEDED`.

A single model request is still limited by the model context capacity.
The conversation archive can continue to grow, and summaries are not guaranteed to remember every original character.
When original words need to be verified, use archive queries.

## Querying Original Words

`search_conversation_history` is a green read-only tool.
The tool queries the archive by the server-bound user and session.
The model cannot select another user or session through parameters.
When a trusted session identity is missing, `SECURITY_DENIED` is returned.
When the session does not exist or does not belong to that user, `NOT_FOUND` is returned.

The parameters include the following fields:

- `query`: The query text from the original words, length `1` to `256`.
- `limit`: Maximum number of messages returned per call is `20`, default `20`.
- `beforeIndex`: Position to continue querying earlier messages, minimum `0`.

The result includes `matches`, `hasMore`, and an optional `nextBeforeIndex`.
When `beforeIndex` exceeds the current message count, it is rejected as `VALIDATION`.
Query results preserve original negative signs, decimals, names, and corrected text.
Results include only user and assistant message text.
Historical requests do not represent new authorization or execution facts.
When business needs to continue, the server checks the current turn's declaration and permissions.

## Generation and Recovery

Summaries use the current model runtime's model and streaming request function.
In offline mode, a fixed-structure summary is generated by `providers/mock/compaction.ts`.
Summary requests do not provide bank tools and do not execute tool calls.
The adapter layer passes bank constraints through the official `customInstructions` parameter.
Amount signs, user corrections, preferences, and pending items need to be preserved.

Summary events use the following names:

- `compaction_request`: Saves the summary request, input summary, and attempt count.
- `compaction_provider_event`: Saves the raw streaming events of the summary model.
- `compaction_response`: Saves the complete response of the summary model.
- `compaction_partial`: Saves the summary and subsequent position of a batch completed by the adapter layer.
- `compaction_completed`: Saves the final summary and compression scope.
- `compaction_failed`: Saves this failure.

Before each summary request, the system saves a checkpoint.
The first SDK call saves the actual model context.
On restart, this context is reused, preserving the original message times and summary input.
When the model identity or input does not match, `CONFLICT` is thrown.
After a process restart, unfinished read-only summary requests can be re-executed.
Completed batches continue from their original position without needing to redo banking business.
Batch recovery is handled by the database adapter layer.
The official `compact()` handles each batch's summary and is not responsible for bank checkpoint recovery.
When a summary is interrupted, truncated, failed, or empty, the system retains the original conversation.
An interrupted summary is not adopted even if it contains text.
The adapter layer rejects results where `stopReason` is `aborted` or cancelled.
Summary results are not registered as ordinary assistant replies or business model requests.

When a registered ordinary model request is recovered, the original request view is used.
Recovery does not re-compress and change that request's input.
Business tools are still recovered based on the original call identity, authorization, and execution receipt.

The reply format correction budget and compression metadata are stored separately.
The checkpoint records the pre-correction candidate, original instruction, and processing stage.
When the correction is already complete, restart does not generate a new correction request.
Both the original candidate and the corrected reply continue to be archived.

The analysis follow-up after query confirmation uses the original question saved by the server.
The follow-up purpose is bound to the query or suggestion declaration in the original model request.
Recovery also needs to verify the latest user message and the original query result.
Analysis follow-ups do not grant bank write operation permissions.
For specific rules, see [Persistence and Recovery](agent-durability.md#reply-correction-and-suggested-answer-continuation).

## Code Entry Points

Pi Agent Core provides 2 hooks: `prepareRequest` and `transformContext`.
These 2 hooks connect the compression projection to bank model requests.
`compact()` comes from the Coding Agent SDK and is not a method of the Core instance.
See [Pi official compression source](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/src/core/compaction/compaction.ts).

- [Compression adapter layer](../../agent/context-compaction).
- [Pi integration](../../agent/banking-agent.ts).
- [Model request logs](../../agent/durable/journal.ts).
- [Archive read-only search](../../agent/conversation-history-search.ts).
- [Compression unit tests](../../tests/unit/planner/context-compaction.test.ts).
- [Persistence recovery integration tests](../../tests/integration/conversation-compaction.test.ts).

## Dependency Cost and Upgrades

Using the public interfaces still requires installing the entire Coding Agent npm package.
Transitive dependencies include `@earendil-works/pi-codemode`, `@earendil-works/pi-mcp`, and `@earendil-works/pi-tui`.
Transitive dependencies also include the `@silvia-odwyer/photon-node` image library and `quickjs-wasi`.
These dependencies expand the installation scope and cannot be regarded as a small package containing only compression functions.
Installing dependencies does not mean the bank model has obtained coding or file operation permissions.

When upgrading, verify the 3 direct dependencies, `overrides`, and the lock file at the same time.
`overrides` pins the versions of 5 packages under `@earendil-works`.
The constraints are stored in [pnpm-workspace.yaml](../../pnpm-workspace.yaml).
The official summary format, interfaces, and token determination may change with versions.
After upgrading, verify archive retention, bank constraints, and crash recovery.
