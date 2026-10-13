# agent/providers — Pi 1.1 model and stream selection

## Intent

request-options.ts bounds each live request (including body streaming) with a deadline and at most
one transport retry. An explicit caller cancellation stays aborted; only the deadline is mapped to
a transient timeout. Defaults: 30 seconds, maximum provider-requested retry delay 1500ms. The
LLM_REQUEST_TIMEOUT_MS override accepts 1000–120000ms. Offline faux streams remain unchanged.

This node owns the model/provider wiring. Pi packages are pinned to 1.1.0 under
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

Live uses builtinModels() from @earendil-works/pi-ai/providers/all and binds
models.streamSimple as the Agent streamFn. The collection resolves provider-scoped
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
DTOs at the boundary instead of passing arbitrary unknown values.

## Live model and host policy

1. Exact model id registered for the provider: use it unchanged.
2. Known provider, unknown model id: choose that provider's first registered model
   and warn with requested/actual ids. Never silently select another provider's host.
3. Custom provider: require <PROVIDER>_BASE_URL or LLM_BASE_URL (the OpenAI provider
   itself may use its own standard host). Register createProvider() with the native
   lazy openAICompletionsApi() and envApiKeyAuth(<PROVIDER>_API_KEY).

Pi 1.1 registers deepseek-flash directly at https://api.deepseek.com; the user's
LLM_MODEL=deepseek-flash needs no fallback or forced override. DEEPSEEK_API_KEY stays
in ignored .env.local. Do not log keys, place them in models, or send them to a
foreign provider host.

## Verification

Root Vitest auto-discovers provider tests under tests/unit/agent/providers/:

- provider-live.test.ts: pure resolution, exact DeepSeek id, provider-local fallback,
  explicit custom hosts, missing keys and key-free models.
- provider-mock.test.ts: production mock behavior through the banking Agent.
- provider-runtime.test.ts: isolated mock collections, native DeepSeek adapter
  serialization of confirmed tool results, custom endpoint auth. Adapter tests use
  an injected fetch and fake keys; they make no paid model requests.

Run pnpm test tests/unit/agent/providers and pnpm typecheck. Browser entry
points remain tests/e2e/acceptance.e2e.ts (mock) and live-acceptance.e2e.ts (real API,
requires local credentials). Both use isolated databases. Historical live reports
refer to their recorded baseline, not automatically to the current Pi version.

## Mock intent and safety constraints

- respond(context) is pure: no database, banking SDK, filesystem, network,
  Date.now() or Math.random() may affect reply content. Tool-call ids are explicit.
- A result after the latest user message is narrated from that actual result.
  search_contact after a transfer intent refines to transfer_money only for one
  unambiguous match. Missing amount/recipient or multiple matches require clarification.
- Direct action matchers run BEFORE broad read matchers: set_card_limit, freeze_card,
  subscribe_investment, redeem_investment and cancel_subscription must not silently
  route to get_cards/list_investments/list_subscriptions. Bare-amount follow-ups may
  reuse only information from the responder's own earlier clarification.
- Demo product/card/subscription identifiers mirror the seed fixtures; these are
  scripted mock conveniences, not live identity resolution or authorization.
- Conditional limit adjustment creates analyze_spending -> condition -> set_card_limit;
  the last node parks for human confirmation. Other conditional templates can contain
  only GREEN queries plus condition/note nodes. Multi-turn transfer reuse preserves
  the previous resolved recipient while taking the newly requested amount.
- A security block is narrated as awaiting confirmation/MFA, never as executed.
  A failed tool result is reported honestly. The responder chooses the proposed action;
  authorization stays in beforeToolCall -> security gateway.
- Read getConfig() at call time. Keep provider construction inside this node and keys
  outside AppConfig, Model, logs, snapshots and providerId(). No global registry state.
