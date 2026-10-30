# Pi Interfaces and Version Adaptation

**English** | [简体中文](../cn/pi-integration.md)

The project directly depends on 3 Pi packages, with versions pinned to `1.2.0`.
The dependencies are listed in [package.json](../../package.json).
The `overrides` of [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml) additionally pins `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, and `pi-tui`.
The actual resolved versions are determined by [pnpm-lock.yaml](../../pnpm-lock.yaml).

Bank execution uses Pi Agent Core, and model calls use Pi AI.
Context compaction calls the `compact()` of Pi Coding Agent.
The project does not start the Coding Agent's command line, terminal interface, or extension runtime.
The bank tool registry registers only bank tools.
For the compaction adaptation, see [Conversation Archiving and Compaction](context-compaction.md).

`patchedDependencies` patches `pi-weixinbot`.
The patch file must use LF line endings.
[`.gitattributes`](../../.gitattributes) forces `*.patch` to be checked out with LF.
A CRLF checkout causes `pnpm install` to report `ERR_PNPM_INVALID_PATCH`.

## Adopted Interface Contracts

| Pi Contract | Project Handling |
| --- | --- |
| `AssistantMessageEventStream` | Normal responses, initialization failures, and read failures all return a termination event. |
| `getCurrentTools()` | Tool additions and removals are replayed one by one according to system messages, taking the current complete tool set. |
| `prepareRequest` | Prepare the projection and request log before each model request. |
| `transformContext` | Only the projected messages are passed to the current request. |
| `finishTurn` | Generation ends after a pending-confirmation decision that has been persisted, or a successful plan commit. |
| Sequentially wait for subscribers | The run is considered finished only after the `agent_end` subscribers complete. |
| `AgentToolResult.isError` | Failures return a structured error result rather than only throwing text. |
| Model-visible `content` | Business JSON goes in `content`, and interface data goes in `details`. |
| `structuredContent` | Read by programmatic callers and not sent to the model. |
| `usage`, `durationMs` | Preserve the original call metadata; calls that were not executed carry no duration. |

`prepareRequest` and `transformContext` are registered in [Bank Agent](../../agent/banking-agent.ts).
`beforeToolCall` is the only authorization entry point.
`afterToolCall` does not change already-completed results.

## Model Request Flow

In online mode, the Pi AI model collection is wrapped as a stream function.
The wrapper outputs the project's own `AssistantMessageEventStream`.
Both synchronous throws from the stream function and initialization Promise rejections are converted into termination events.
A missing termination event is treated as a transport failure, and the Promise awaiting the result will not hang forever.
See [Request Options](../../agent/providers/request-options.ts).

The request timeout takes `LLM_REQUEST_TIMEOUT_MS`, with a default of `30000` milliseconds.
The valid range is `1000` to `120000` milliseconds; out-of-range values fall back to the default.
The timeout is combined with the caller's signal using `AbortSignal.timeout`.
Caller cancellation is recorded as cancellation, and a read timeout is recorded as a timeout; the two do not share retries.
The retry limit for a single request is `maxRetries: 1`, and the retry interval limit is `maxRetryDelayMs: 1500`.

The `openai-completions` stream also requires an SSE terminator.
The terminator is `data: [DONE]`, and the response type must be `text/event-stream`.
A missing terminator or a missing response body reports a transport error.
Text from a normal supplier end is saved verbatim and is not judged for completeness based on sentence endings.
A UTF-8 decoding failure is treated as a fatal error.
See [Complete Transport](../../agent/providers/completion-transport.ts).

When run logs are present, the stream function is wrapped in an additional audit layer.
The audit records `provider_request_payload`, `provider_response_headers`, and `provider_response_event`.
Only `content-type`, `x-request-id`, and `request-id` are retained from response headers.
Tool arguments in chunks are first replaced with placeholders, and redaction happens after Pi finishes assembling them.
See [Model Audit](../../agent/providers/model-audit.ts).

Call IDs within the same assistant reply must be non-empty and unique.
`beforeToolCall` first calls `validateToolCallIdentities` and refuses execution if it does not pass.
Result matching checks both the call ID and the tool name.

## Tool Call Results

Tool content may contain multiple text or image segments.
The event log saves the complete `content`, not just the first text segment.
Resumption reuses the same content and preserves usage and duration.
The continuation after confirmation and the re-query after resumption use the same result projection.
For the business contract, see [Bank Tool Contract](tool-contracts.md).

## Model Configuration

The configured model ID must be resolvable.
Registered models are used as-is according to the provider registry.
Unregistered models are accepted only when a compatible endpoint is explicitly configured.
The compatible endpoint takes `<PROVIDER>_BASE_URL` first, then `LLM_BASE_URL`.
Unregistered models are fixed to use `openai-completions`, with a context window of `128000` and an output limit of `16384`.
The project does not substitute another model from the provider, nor does it send the key to an unrelated host.
When configuration fails, it states specifically which model cannot be used.
For configuration instructions, see [Development Guide](development.md).

## Regression Entry Points

- [Model Stream Initialization and Timeout](../../agent/providers/request-options.test.ts).
- [SSE Terminator](../../tests/unit/agent/providers/completion-transport.test.ts).
- [Model Audit](../../tests/unit/agent/providers/model-audit.test.ts).
- [Complete Tool Log](../../agent/durable/journal.test.ts).
- [Resumption Result Projection](../../agent/durable/tool-result.test.ts).
- [Call ID Boundaries](../../tests/integration/tool-call-identity-boundary.test.ts).
- [Model Configuration](../../tests/unit/agent/providers/provider-live.test.ts).
