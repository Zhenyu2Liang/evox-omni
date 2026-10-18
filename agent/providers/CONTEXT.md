# agent/providers — Pi 1.2 model and stream selection

## Intent

request-options.ts bounds each live request (including body streaming) with a deadline and at most
one transport retry. An explicit caller cancellation stays aborted; only the deadline is mapped to
a transient timeout. Defaults: 30 seconds, maximum provider-requested retry delay 1500ms. The
LLM_REQUEST_TIMEOUT_MS override accepts 1000–120000ms. Offline faux streams remain unchanged.
The wrapper forwards every event until the provider terminal event. A source that closes
without a done/error event becomes an error with its partial response retained, so result()
cannot hang after EOF. A provider stop reason does not prove that its prose is complete.

This node owns NO prompt template. The model's system prompt is built by `../system-prompt.ts`
(`buildSystemPrompt`, line 24) and handed to Pi through `banking-agent.ts`
(`initialState.systemPrompt`); the only model-facing wording this node produces is the tool-call lead
text in `mock/replies.ts` and the post-result narration in `mock/narration.ts`. The confirmation /
approval / MFA / "request panel above the composer" instructions sent to the model live in
`../system-prompt.ts` near line 37, not here.

For openai-completions, completion-transport.ts wraps the official Pi fetch extension point. A
successful SSE body requires the [DONE] transport terminator; finish_reason=stop followed by EOF
remains a connection error. A complete tool_calls argument payload without the terminator is also
rejected before authorization or execution. The adapter forwards original bytes to the official
Pi SDK, which still maps messages and tools. It neither inspects prose nor rewrites text. A partial
sentence delivered with stop and [DONE] remains unchanged: protocol completion cannot prove semantic
completeness. The older screenshot has no recorded [DONE] evidence, so its root cause is unproven.

model-audit.ts withModelAudit wraps official onPayload, onResponse and onProviderStreamEvent hooks.
provider_request_payload stores the effective payload after any caller replacement, including the
actual max_tokens/stop fields when present. provider_response_headers stores status and only
content-type, x-request-id and request-id; authentication headers are never retained.
provider_response_event stores sanitized provider chunks and transport_end evidence with completed,
bytes, frames and, on success, terminator=[DONE]. Every record binds the prepared modelRequestId,
and persistence is awaited before the model request may complete. Argument fragments retain only
their byte length and a redaction marker; fully assembled sanitized calls remain in the original
Pi journal. Existing financial-claim and reply-format repair is independent of transport checks.

This node owns the model/provider wiring. Pi packages are pinned to 1.2.0 under
@earendil-works; Node.js >=22.19.0 is required. The production Agent receives a
ModelRuntime pair from resolveProvider(), not a model without a stream function.

## Public API

- types.ts: ModelRuntime = { model: Model<any>; streamFn: StreamFn }.
- index.ts: resolveProvider(cfg?) creates the mode-specific runtime at call time.
  resolveModel(cfg?) remains a model-only inspection facade; Agent constructors must
  use resolveProvider(). providerId(cfg?) returns a key-free log identifier.
- provider-mock.ts: createMockRuntime(cfg) returns a local faux model and stream;
  createMockModel(cfg) remains the model-only facade.
- provider-live.ts: createLiveRuntime(cfg) returns the live model and provider-bound
  stream; createLiveModel(cfg) resolves the model and checks common key variables.
- resolveLiveModel(provider, modelId, deps?) is pure, with injectable registry/env.
  LiveModelResolution contains model and an optional warning.
- providerBaseUrlEnvVar(provider) derives the provider-specific base URL variable.
- mock-responder.ts: respond(context) is a pure scripted decision function over
  messages. It drives the offline demo without changing the banking tools/security.
- mock/: the dispatcher selects separate transfer, card, investment, subscription and
  plan handlers. Exact amount parsing, conversation projection, deterministic reply
  construction and fact narration are independent pure modules. Family handlers cannot
  import database access, live providers or banking execution; boundary tests enforce
  those imports and an acyclic dependency graph.

## Native Pi runtime

Live imports individual public provider factories and creates a fresh createModels()
collection containing only the configured provider. Explicit built-ins are DeepSeek,
OpenAI, Anthropic, Google, Groq, OpenRouter, xAI, Mistral and Cerebras. Other
OpenAI-compatible endpoints require an explicit provider-specific or shared base URL.
Do not import providers/all or instantiate unrelated provider collections.
Each factory imports its own catalog and lazy API wrapper; SDK implementations load
on the first request for their API. Pi AI still declares the vendor SDKs as package
dependencies, so lazy runtime loading does not remove them from the lockfile.
The stream binds models.streamSimple as the Agent streamFn. The collection resolves provider-scoped
credentials at request time; keys are never attached to Model or serialized state.
Common API-key providers are checked synchronously for missing env variables.

Mock creates a fresh fauxProvider() handle and a createModels() collection for each
runtime, then registers handle.provider on that collection. A self-requeuing
FauxResponseFactory calls respond(context), allowing multiple prompts and tool
continuations. There is no global provider registry or unregister step. No /compat
API is used. Mock must stay offline and must not read or require a real API key.

Pi 1.x places system prompt/tool definitions in transcript system messages. Agent
normalizes the context before calling streamFn; direct stream tests must call
normalizeContext() explicitly. Tool arguments/details are JSON, so adapters serialize
DTOs at the boundary instead of passing arbitrary unknown values. The model receives
tool `content`, not `details` or `structuredContent`. Banking success content includes
the server summary and a JSON projection with resource IDs and exact financial strings.
Failures set native `isError: true` and return a typed safe error envelope. The durable
journal saves all content parts so recovery preserves the same model-facing evidence.

## Live model and host policy

1. Exact model id registered for the provider: use it unchanged.
2. Unknown model id: fail without changing the requested model, unless an explicit
   OpenAI-compatible endpoint is configured.
3. Custom provider or model: require <PROVIDER>_BASE_URL or LLM_BASE_URL.
   Register createProvider() with the native
   lazy openAICompletionsApi() and envApiKeyAuth(<PROVIDER>_API_KEY).

Pi 1.2 registers deepseek-flash directly at https://api.deepseek.com; the user's
LLM_MODEL=deepseek-flash needs no fallback or forced override. DEEPSEEK_API_KEY stays
in ignored .env.local. Do not log keys, place them in models, or send them to a
foreign provider host.

## Verification

Root Vitest auto-discovers provider tests under tests/unit/agent/providers/:

- provider-live.test.ts: pure resolution, exact DeepSeek id, unknown-id rejection,
  explicit custom hosts, missing keys and key-free models.
- provider-mock.test.ts: production mock behavior through the banking Agent.
- provider-runtime.test.ts: isolated mock collections, native DeepSeek adapter
  serialization of confirmed tool results, custom endpoint auth. Adapter tests use
  an injected fetch and fake keys; they make no paid model requests.
- provider-stream-completion.test.ts: actual Pi/OpenAI SDK SSE parsing with injected fetch;
  finish-chunk and later text before [DONE], missing terminators, final SSE flush, transport errors,
  idle-body deadlines and caller cancellation. stop+[DONE] prose remains verbatim even if unfinished.
- completion-transport.test.ts: official fetch seam rejects missing [DONE] independently of prose.
- model-audit.test.ts: effective payload, header whitelist, fragmented-argument redaction and
  model-request identity on provider evidence. Integration coverage also rejects otherwise complete
  tool-call arguments at EOF before banking authorization or execution.

Run pnpm test tests/unit/agent/providers and pnpm typecheck. Browser entry
points remain tests/e2e/acceptance.e2e.ts (mock) and live-acceptance.e2e.ts (real API,
requires local credentials). Both use isolated databases. Historical live reports
refer to their recorded baseline, not automatically to the current Pi version.

## Mock intent and safety constraints

The mock provider reads current tool declarations through Pi getCurrentTools(messages), including
system toolsAdded/toolsRemoved deltas in normalized provider contexts. When describe_turn is
registered and its current-user-turn result is absent, the model first returns that real control
call. Metadata results never become final narration. The declaration records ordered repeated
operations and optional workflow/example flags; it cannot bypass the production security hook.
Natural-language conversation, advice, guidance and request DSL parsers live only in mock/.
Before resource writes, resource-resolution.ts queries real card/product/holding/subscription
records and binds actual IDs; unknown or ambiguous selections cannot substitute another resource.
The mock has no card-consumption/spend/payment intent: its only card tool calls are get_cards (read), set_card_limit, freeze_card and apply_virtual_card. report_lost_card, replace_card and unfreeze_card keep reply labels, REQUEST_COMMANDS entries and resource binding but no classifier emits them. See `./mock/CONTEXT.md`.

## Card-management guidance (the "manual-only" reply)

`inferConversationGuidance` (`mock/conversation-guidance.ts:29-31`) returns `card_management_required` when an issuance/removal verb (申请/添加/新增/删除/删掉/注销/开通/创建/办理, or create|add|issue|remove|delete|close|cancel|apply for) is paired with a card noun whose modifiers may be 银行/信用/借记/储蓄/实体.
`mock/classifier.ts:24-26` short-circuits on that code and returns the closed template `agent/messages/conversation.zh-CN.json:7` ("添加或删除卡片需在“卡片”页面操作并完成验证。AI 助手不能创建、申请或删除卡片，也不会将这些操作加入任务计划。") without proposing a tool call; `mock/turn-declaration.ts:32-33` then declares the turn purpose `conversation`.
虚拟 is deliberately outside the modifier list (`mock/conversation-guidance.ts:27-30` comment), so virtual-card application stays agent-available (`mock/card-intents.ts:57-60`).
挂失/补办/lost/replace are NOT in that verb list: 挂失信用卡 falls through to `get_cards` (`mock/classifier.ts:76`), 补办一张新卡 is treated as conversation (补办 is absent from `WRITE_VERB`, `mock/conversation-policy.ts:3`), and a multi-step sequence containing either aborts with `missingDetails` (`mock/plan-intents.ts:104-106`). Because 办理 is a generic verb, 办理信用卡挂失 does match and yields the card-management reply.
`mock/card-intents.ts:53-55` repeats the same code inside `classifyCardAction`; the full-text check in `classify` always precedes it, so only direct test callers reach that branch.
The same envelope is accepted from a live model: `parseBankingGuidance` accepts `card_management_required` and `capabilities` (`../banking-guidance.ts:36`) and the server renders its own template (`../turns/buffer.ts:29-33`).
This node adds no mitigation of its own: `provider-live.ts:206-223` returns the model plus `models.streamSimple` wrapped only by `withLiveRequestLimits` (deadline and one retry, `request-options.ts:7-45`), so no extra system instruction, temperature, capability preamble or tool filtering is sent and no card tool is dropped from the live declaration.
`capabilities` is emitted at `mock/classifier.ts:55` only for non-conversational text; a plain 能做什么/有哪些功能 question is answered with `help` (`mock/classifier.ts:44-45`).

- respond(context) is pure: no database, banking SDK, filesystem, network,
  Date.now() or Math.random() may affect reply content. Tool-call ids are explicit.
- A result after the latest user message is narrated from that actual result.
  search_contact after a transfer intent refines to transfer_money only for one
  unambiguous match. Missing amount/recipient or multiple matches require clarification.
- Direct action matchers run before broad read matchers. The identified operation then resolves
  its required resource through the corresponding registered query before proposing a write.
  Bare-amount follow-ups may reuse only the responder's own immediately preceding clarification.
- Seed identifiers are selector hints inside deterministic proposals. Actual submitted IDs come
  from successful current-turn query results, including plans and non-seed resource identities.
- Conditional limit adjustment creates analyze_spending -> condition -> set_card_limit;
  the last node parks for human confirmation. Other conditional templates can contain
  only GREEN queries plus condition/note nodes. Multi-turn transfer reuse preserves
  the previous resolved recipient while taking the newly requested amount.
- A security block is narrated as awaiting confirmation/MFA, never as executed.
  A failed tool result is reported honestly. The responder chooses the proposed action;
  authorization stays in beforeToolCall -> security gateway.
- Read getConfig() at call time. Keep provider construction inside this node and keys
  outside AppConfig, Model, logs, snapshots and providerId(). No global registry state.
