# agent/providers — LLM Provider Selection

## Intent

The single place where Pi AI `Model` instances are constructed. It exists so the rest of
`./agent` NEVER imports `@mariozechner/pi-ai` model constructors directly — every other file
receives a ready `Model` from `resolveModel`, keeping model/provider wiring isolated and
swappable.

Two modes, chosen at call time from `AppConfig.llmMode`:

- **`mock`** — a scripted in-memory model via `registerFauxProvider()` from `@mariozechner/pi-ai`.
  Fully offline and deterministic, and it produces **real, interactive replies with no API key**:
  the one queued step is a self-requeuing `FauxResponseFactory` that delegates to the pure
  decision function in `./mock-responder`. Drives `LLM_MODE=mock` (the DEFAULT demo mode), all
  unit tests and the 12 demo scenario tests. Same Agent / tools / security pipeline — only the
  model is scripted.
- **`live`** — a real chat model from `@mariozechner/pi-ai`, built from `cfg.llmProvider` /
  `cfg.llmModel` with the API key read from the environment. Demo-only: requires network + a key.

## API Surface

```ts
// provider-live.ts
export function createLiveModel(cfg: AppConfig): Model<any>;   // real model; needs network + key

// provider-mock.ts
export function createMockModel(cfg: AppConfig): Model<any>;   // offline, deterministic, interactive

// mock-responder.ts
export interface MockContext { systemPrompt?: string; messages: Message[]; tools?: unknown[]; }
export function respond(context: MockContext): AssistantMessage;   // PURE decision function

// index.ts (node facade)
export function resolveModel(cfg?: AppConfig): Model<any>;     // mock ⇒ createMockModel, live ⇒ createLiveModel; defaults to getConfig()
export function providerId(cfg?: AppConfig): string;           // "mock" | `${provider}:${model}` — stable log id, never the API key
```

`Model<TApi extends Api>` (from `@mariozechner/pi-ai`) REQUIRES a type argument, so every signature
here returns `Model<any>` — the same instantiation as `AgentState.model` (pi-agent-core). `AppConfig`
is imported from `@/lib/config`. These signatures are frozen; consumers (e.g. `../banking-agent.ts`)
depend on them.

### `createMockModel` — self-requeuing faux factory

The faux provider consumes EXACTLY ONE queued step per model call (an empty queue yields an error
assistant message, `stopReason:'error'`). So `createMockModel` queues ONE step — a
`FauxResponseFactory` that, on every call, re-queues ITSELF (`reg.appendResponses([factory])`) and
returns `respond(context)`. This keeps the model alive across every model call of an agent turn
(prompt → tool result → narration). No `tokensPerSecond` is set, so text deltas stream on the
microtask queue (no variable timers) — determinism holds.

### `respond` — the scripted decision function (mock's "brain")

`respond(context)` is a PURE state machine over the conversation. `context.messages` is the full
history (system prompt is separate in `context.systemPrompt`): user messages, assistant messages
(with `toolCall` blocks) and `toolResult` messages.

1. **Narration** — if a `toolResult` follows the most recent user message, narrate its outcome
   truthfully from the toolResult's own text (the SDK already produced the human summary). A
   `search_contact` result that follows a transfer intent is REFINED into a `transfer_money` call
   (single match ⇒ that recipient; multiple/zero matches ⇒ ask which one) instead of narrated.
2. **Classification** — otherwise classify the latest user message by FUZZY Chinese keywords and
   emit the tool call(s), e.g. 余额/多少钱 ⇒ `get_balance`; 消费/花多少 ⇒ `analyze_spending`;
   异常/可疑 ⇒ `detect_anomaly`; 卡片/额度 ⇒ `get_cards`; 订阅 ⇒ `list_subscriptions`; 理财/投资 ⇒
   `list_investments`; "给X转N元/备注AA" ⇒ `search_contact({query:'X'})` first; 条件任务(如果…就…) ⇒
   `submit_plan`. Emitted args match the TypeBox schemas in `../tools/*.ts` EXACTLY; `userId` is
   NEVER emitted (server-injected).

Additional behaviours:
- **Multi-turn reuse** — "还是刚才那个人，再转100" reuses the recipient from a prior
  `transfer_money` toolCall / prior contact resolution and takes only the new amount.
- **Clarifying question** — a plain assistant message with NO tool call when info is insufficient
  (missing amount/recipient) or a contact match is AMBIGUOUS (e.g. two 张伟). Never guess a
  high-risk identifier.
- **Failure narration** — a genuine error `toolResult` (error flag set, text NOT a security block)
  is reported honestly; success is never claimed.
- **Blocked gated call** — a YELLOW/RED call parked for a human decision surfaces as a
  `toolResult`; detected via the `__SECURITY_BLOCK__` literal plus 确认/验证/验证码/MFA/awaiting
  keywords and narrated as "awaiting user confirmation / verification — not executed". It NEVER
  claims the action executed.

Purity contract: `mock-responder.ts` imports only `@mariozechner/pi-ai` faux helpers + message types
(no prisma / banking-sdk / network / filesystem), and uses EXPLICIT stable tool-call ids (e.g.
`call_get_balance`) so output is byte-for-byte reproducible.

`createLiveModel` resolves, in order: (1) the Pi AI model registry via `getModels(provider)`
(runtime-safe — `[]` for unknown providers), returning the fully-specified built-in `Model`; else
(2) a literal `Model<any>` (`api: 'openai-completions'`) for a custom endpoint. For KNOWN providers
it checks the env for an API key (`getEnvApiKey`) and throws `AppError('VALIDATION')` if absent — a
clear demo-time failure instead of a mid-stream one. The key is never attached to the returned
`Model`, logged, or surfaced by `providerId`.

## Constraints

- **No network in mock mode.** `createMockModel` MUST be fully offline and deterministic (faux
  provider only) — no live LLM, no sockets, no timers that vary output. `mock-responder.respond` is
  a pure function of the conversation: no `Date.now()` / `Math.random()` may affect reply content.
- **`getConfig()` is read at CALL TIME**, not at module load, so tests can toggle `LLM_MODE`
  between cases. `resolveModel`/`providerId` with no argument must call `getConfig()`.
- **Never leak secrets.** API keys come from the environment only; they must never appear in
  `AppConfig`, logs, returned values, or `providerId`. The key is NOT a `Model` field — the Pi AI
  stream layer reads it from the env at request time.
- **`live` is demo-only**; `mock` is the required path for all tests (root determinism rule).
- **The rest of `./agent` never constructs a `Model`** — it calls `resolveModel` and receives one.
- **`mock-responder` decides WHAT to do next, never WHETHER it is allowed.** It only emits tool
  calls; gating stays in `beforeToolCall → security.gateway`.
- **Provider knowledge stays here.** No pi-ai model-constructor import outside this node.
- Dependency direction: depends on `@mariozechner/pi-ai` and `@/lib/config` / `@/lib/errors` only
  (plus the `@mariozechner/pi-agent-core` runtime types it must satisfy). No cycles.
- Files ≲ ~1000 lines; keep each file focused on one mode.

## Dependencies

- `@mariozechner/pi-ai` — `Model` (type), `registerFauxProvider()` + `fauxAssistantMessage` /
  `fauxText` / `fauxToolCall` + the `Context`/`Message`/`AssistantMessage`/`ToolResultMessage` types
  (mock), `getModels()` / `getProviders()` / `getEnvApiKey()` (live). Identifiers CONFIRMED against
  the installed 0.73.1 `.d.ts` files.
- `@/lib/config` — `AppConfig { llmMode: 'live'|'mock'; llmProvider: string; llmModel: string;
  demoUserId: string }`, `getConfig()`.
- `@/lib/errors` — `AppError` (thrown by `createLiveModel` when a known provider has no env key).

## Test Strategy

Vitest (`../tests`, sibling). This node is a thin, well-isolated boundary:
- `mock-responder.respond` — PURE, table-driven unit tests (no DB, no network) covering fuzzy
  intents, multi-turn context reuse, insufficient-info clarification, ambiguous-name clarification,
  failure narration, and blocked→awaiting-confirmation. Build `context.messages` with the real
  pi-ai message shapes + `fauxAssistantMessage`/`fauxToolCall`.
- `resolveModel()` with `LLM_MODE=mock` returns the scripted model and the FULL agent pipeline
  (run-turn + security) runs offline — the primary integration coverage.
- `providerId()` is pure: `"mock"` in mock mode, `${provider}:${model}` in live mode; the API key
  never appears in the return value.
- `live` mode is not unit-tested (network + key); it is exercised manually for the demo.

NOTE: the responder unit tests belong under `tests/unit/agent/providers/`, which is a SIBLING of
this node (`./agent`). Writers here cannot create them (node-scope rule) — escalate the test-file
creation to the root/owner of `./tests`.

## Routing Table

- `./agent/providers/provider-live.ts` → `createLiveModel(cfg)` — real Pi AI model (demo-only)
- `./agent/providers/provider-mock.ts` → `createMockModel(cfg)` — self-requeuing faux factory (offline, deterministic, interactive)
- `./agent/providers/mock-responder.ts` → `respond(context)` — PURE scripted decision logic (intent → tool call / clarify / narrate)
- `./agent/providers/index.ts` → node facade: `resolveModel`, `providerId`
- `../banking-agent.ts` → sole consumer; receives a `Model` from `resolveModel` (sibling file, same node — read-only here)
- `@/lib/config` → `AppConfig` + `getConfig()` (cross-node dependency — read-only)
- `@/lib/errors` → `AppError` (cross-node dependency — read-only)
- `../tools` → the registered banking tools whose param schemas `mock-responder` mirrors (sibling node — read-only)
