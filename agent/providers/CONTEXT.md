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

// provider-live.ts — PURE, injectable mapping used by createLiveModel (unit-testable offline)
export type LiveModelEnv = Record<string, string | undefined>;
export interface LiveModelRegistry { getProviders(): string[]; getModels(provider: string): Model<any>[]; }
export interface LiveModelDeps { registry?: LiveModelRegistry; env?: LiveModelEnv; }
export interface LiveModelResolution { model: Model<any>; warning?: string; }
export function resolveLiveModel(provider: string, modelId: string, deps?: LiveModelDeps): LiveModelResolution;
export function providerBaseUrlEnvVar(provider: string): string;   // `<PROVIDER>_BASE_URL` derivation

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

#### Direct ACTION routes (`classifyDirectAction`, consulted BEFORE the broad READ matchers)

`classify` runs the READ matchers (异常/流水/花了/概览/余额/卡片/订阅/持仓/理财/…) only AFTER a
`classifyDirectAction(t, messages)` block (in `classify`, just below the
`if (isConditionalPlan(t)) return handlePlan(t);` line). Its purpose: a prompt that targets a gated
(🟡/🔴) tool is routed to that ACTION — never answered with a query result through a broad matcher
like `/(卡片|额度)/ ⇒ get_cards` or `/(订阅)/ ⇒ list_subscriptions`. The chain returns the FIRST
non-`undefined` of: `classifySetCardLimit` → `classifyFreezeCard` → `classifySubscribeInvestment` →
`classifyRedeemInvestment` → `classifyCancelSubscription` → `classifyActionFollowUp`. Each emits ONE
tool call (the shared `toolCall(name, args)` helper hardcodes the id `call_<name>`), or a
`plain(...)` CLARIFICATION for the SPECIFIC missing field, or `undefined` to fall through to the READ
matchers.

| Trigger (fuzzy) | Action route | Emitted call |
|---|---|---|
| 限额/额度 + adjustment verb (调整到/调整为/调整成/调整至/调到/调成/改成/改为/设置为/设为/限额为…), e.g. `把信用卡娱乐限额调整到1500` | `classifySetCardLimit` | 🟡 `set_card_limit { cardId, category, amount }`; missing amount ⇒ clarification `LIMIT_AMOUNT_QUESTION` |
| 冻结…卡 (not 被冻结/已冻结) | `classifyFreezeCard` | 🟡 `freeze_card { cardId }`; no 卡 ⇒ clarification |
| 申购/认购/买入/购买 (+ 理财/基金/产品), e.g. `申购稳健理财A 1000元` | `classifySubscribeInvestment` | 🔴 `subscribe_investment { productId, amount }`; missing product/amount ⇒ clarification |
| 赎回, or 取出 + 理财/基金/产品 | `classifyRedeemInvestment` | 🔴 `redeem_investment { holdingId }` (best effort) |
| 取消/退订 + 订阅/会员/续费 (or a known subscription name), e.g. `取消Netflix订阅` | `classifyCancelSubscription` | 🟡 `cancel_subscription { subscriptionId }`; missing name ⇒ clarification |
| a BARE amount that answers OUR OWN limit/subscribe clarification | `classifyActionFollowUp` | reuses the earlier parsed card/product (cheap multi-turn) |

Scripted id helpers (PURITY: the responder holds no DB access — they mirror
`tests/helpers/fixtures.ts`): `resolveCardId` (`/借记卡|储蓄卡/ ⇒ 'card_debit'`, else
`DEMO_CREDIT_CARD_ID='card_credit'`); `PRODUCT_ID_BY_NAME` (稳健理财A→`prod_wenjiana`,
稳健理财B→`prod_wenjib`, 进取混合C→`prod_jinrong`, 货币基金→`prod_huobi`; an unknown name is used
verbatim as `productId`, best effort); `SUBSCRIPTION_ID_BY_NAME` (Netflix→`sub_netflix`,
Spotify→`sub_spotify`, iCloud→`sub_icloud`, 视频会员→`sub_video`; unknown ⇒ verbatim);
`DEMO_HOLDING_ID='holding_wenjiana'`.

The `LIMIT_ADJUSTMENT_VERB` string covers 调整到/调整成/调整至 as well as the older 调整为/改为/…, and
`parseCardLimitAdjustment` (the conditional-plan branch) + `classifySetCardLimit` (the direct route)
both use the SHARED `LIMIT_ADJUSTMENT_AMOUNT_RE`, so the amount AFTER the verb is parsed identically
on both paths (never the earlier threshold number of a 如果…就… plan trigger).

An action intent with missing info is ALWAYS a clarification — the missing field is NEVER defaulted
and NEVER falls back to a read tool.

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
- **`handlePlan` can emit a GATED node** — a conditional message that ALSO asks to adjust a card
  spend limit (限额/额度 + 调整到/调整为/改为/…) builds a `submit_plan` DAG of
  `analyze`(tool `analyze_spending`, GREEN) → `check`(condition `analyze.total > <threshold>`) →
  `setlimit`(tool `set_card_limit`, args `{ cardId:'card_credit', category:<parsed>, amount:<parsed> }`,
  YELLOW). The canonical trigger is exactly `如果这个月娱乐消费超过2000元，就把娱乐消费限额调整为1500元`
  ⇒ nodes sit at `analyze:success` / `check:success` / `setlimit:waiting_confirmation` and the plan
  parks at `waiting_confirmation`, so the plan-level `confirmation_required` frame IS reachable
  through the mock model; a human `confirmAction` runs the real `set_card_limit` and the node
  advances to `success`. `cardId:'card_credit'` is a scripted demo-model id (the seeded credit card
  already carries an 娱乐 limit of ¥3000).
- A conditional message WITHOUT a limit-adjustment phrase still builds only GREEN
  `analyze_spending`/`get_balance` tool nodes plus `condition`/`note` nodes, so it never parks.

Purity contract: `mock-responder.ts` imports only `@mariozechner/pi-ai` faux helpers + message types
(no prisma / banking-sdk / network / filesystem), and uses EXPLICIT stable tool-call ids (e.g.
`call_get_balance`) so output is byte-for-byte reproducible.

### `createLiveModel` / `resolveLiveModel` — live model resolution

`createLiveModel(cfg)` is a thin wrapper: for a KNOWN provider it checks the env for an API key
(`getEnvApiKey`; only its truthiness is read) and throws `AppError('VALIDATION')` when absent — a
clear demo-time failure instead of a mid-stream one — then delegates the mapping to the pure,
exported `resolveLiveModel(provider, modelId, { registry?, env? })` helper (injectable registry
accessors + env) and `console.warn`s its `warning`. The key value is never read into a
logged/returned variable, never attached to the returned `Model`, and never surfaced by
`providerId`.

`resolveLiveModel` resolution order. The returned `Model`'s `baseUrl`/`api` ALWAYS belong to
`cfg.llmProvider`: a configured provider's key is NEVER sent to another host.

1. **Registry hit** — `getModels(provider)` (runtime-safe: `[]` for an unknown provider) contains
   `modelId` ⇒ that fully-specified built-in `Model` verbatim (correct api dialect, base URL,
   headers, limits, pricing) and NO warning.
2. **Provider default** — `getProviders()` includes `provider` but `modelId` is NOT registered ⇒
   that provider's OWN first registered model (`getModels(provider)[0]`) plus a LOUD `warning`
   naming the REQUESTED vs the ACTUALLY-USED id and base URL. This covers the live
   `deepseek`/`deepseek-flash` case: `deepseek-flash` is not a registered pi-ai id (the registry has
   `deepseek-v4-flash`, `deepseek-v4-pro`), so it resolves to `deepseek-v4-flash` at
   `https://api.deepseek.com` instead of a hardcoded `https://api.openai.com/v1` literal that would
   send the DeepSeek key to OpenAI's host. A known provider exposing no models at all throws
   `AppError('VALIDATION')`.
3. **Unknown provider** (custom OpenAI-compatible endpoint) ⇒ a literal `Model<any>`
   (`api: 'openai-completions'`) is built ONLY for an EXPLICIT base URL — `<PROVIDER>_BASE_URL`
   (provider id upper-cased, non-alphanumerics → `_`, e.g. `MY_LLM_BASE_URL`) then the shared
   `LLM_BASE_URL` — or when the provider genuinely IS the OpenAI host
   (`OPENAI_FAMILY_PROVIDERS`, i.e. `openai`), where the OpenAI base URL is correct rather than a
   leak. Otherwise it FAILS LOUDLY with `AppError('VALIDATION')` naming the env var to set — it
   never guesses somebody else's host. A literal custom endpoint also emits a `warning` naming the
   endpoint.

## Constraints

- **No network in mock mode.** `createMockModel` MUST be fully offline and deterministic (faux
  provider only) — no live LLM, no sockets, no timers that vary output. `mock-responder.respond` is
  a pure function of the conversation: no `Date.now()` / `Math.random()` may affect reply content.
- **`getConfig()` is read at CALL TIME**, not at module load, so tests can toggle `LLM_MODE`
  between cases. `resolveModel`/`providerId` with no argument must call `getConfig()`.
- **Never leak secrets.** API keys come from the environment only; they must never appear in
  `AppConfig`, logs, returned values, or `providerId`. The key is NOT a `Model` field — the Pi AI
  stream layer reads it from the env at request time.
- **Never cross hosts.** A resolved `Model` must target `cfg.llmProvider`: the OpenAI base URL is
  used ONLY for a provider that really is the OpenAI host, and an unregistered provider without an
  explicit base URL fails loudly instead of receiving another provider's traffic/key.
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
  (mock), `getModels()` / `getProviders()` / `getEnvApiKey()` (live). `getModels` is runtime-safe
  (`[]` for an unknown provider) and `getProviders()` returns the registered provider ids; the
  registry's FIRST model per provider is that provider's natural default. Identifiers CONFIRMED
  against the installed 0.73.1 `.d.ts` files.
- `@/lib/config` — `AppConfig { llmMode: 'live'|'mock'; llmProvider: string; llmModel: string;
  demoUserId: string }`, `getConfig()`. NOTE: `AppConfig` has NO base-URL field, so a custom
  endpoint's base URL comes from the environment (`<PROVIDER>_BASE_URL` / `LLM_BASE_URL`).
- `@/lib/errors` — `AppError` (thrown by `createLiveModel`/`resolveLiveModel`: a known provider with
  no env key, a known provider exposing no models, or an unknown provider with no base URL).

## Test Strategy

Vitest. This node is a thin, well-isolated boundary:
- `mock-responder.respond` — PURE, table-driven unit tests (no DB, no network) covering fuzzy
  intents, multi-turn context reuse, insufficient-info clarification, ambiguous-name clarification,
  failure narration, and blocked→awaiting-confirmation. Build `context.messages` with the real
  pi-ai message shapes + `fauxAssistantMessage`/`fauxToolCall`.
- `resolveModel()` with `LLM_MODE=mock` returns the scripted model and the FULL agent pipeline
  (run-turn + security) runs offline — the primary integration coverage.
- `providerId()` is pure: `"mock"` in mock mode, `${provider}:${model}` in live mode; the API key
  never appears in the return value.
- `resolveLiveModel` — PURE and DB-free: driven against the REAL installed pi-ai registry (no key,
  no network) for the `deepseek`/`deepseek-flash` → `deepseek-v4-flash` @
  `https://api.deepseek.com` mapping, plus injected fake registries/envs for the provider-default,
  custom-endpoint, shared/`<PROVIDER>_BASE_URL` override and loud-failure branches, and
  `createLiveModel`'s env-key presence check + warning (asserting the key VALUE never appears).
  `live` mode itself (real network + key) is exercised manually for the demo.

The specs live at `tests/unit/agent/providers/provider-mock.test.ts` and
`tests/unit/agent/providers/plan-limit-park.test.ts`, auto-discovered by the ROOT `vitest.config.ts`
(`test.include: ['tests/**/*.{test,spec}.ts']`) via `npm run test`. `tests/` is a read-only SIBLING
of this node, so the node-local spec `agent/providers/provider-live.test.ts` is NOT auto-discovered
and the CLI filter alone cannot widen `include`; it runs through its own runner
(`agent/providers/vitest.provider-live.config.ts`, `@` aliased to the repo root, `include` exactly
that spec):

```
npx vitest run --config agent/providers/vitest.provider-live.config.ts
```

## Routing Table

- `./agent/providers/provider-live.ts` → `createLiveModel(cfg)` (real Pi AI model, demo-only) + the PURE exported `resolveLiveModel(provider, modelId, { registry?, env? })` / `providerBaseUrlEnvVar(provider)` resolution helper (registry hit → provider default → explicit custom endpoint, else loud `AppError`)
- `./agent/providers/provider-live.test.ts` → node-local pure spec for `resolveLiveModel` + `createLiveModel` (not under `tests/`)
- `./agent/providers/vitest.provider-live.config.ts` → runner config for the node-local spec above
- `./agent/providers/provider-mock.ts` → `createMockModel(cfg)` — self-requeuing faux factory (offline, deterministic, interactive)
- `./agent/providers/mock-responder.ts` → `respond(context)` — PURE scripted decision logic (intent → tool call / clarify / narrate); `classify` (READ routes) + `classifyDirectAction` (gated ACTION routes: set_card_limit / freeze_card / subscribe_investment / redeem_investment / cancel_subscription) + `handlePlan` (conditional DAG)
- `./agent/providers/index.ts` → node facade: `resolveModel`, `providerId`
- `../banking-agent.ts` → sole consumer; receives a `Model` from `resolveModel` (sibling file, same node — read-only here)
- `@/lib/config` → `AppConfig` + `getConfig()` (cross-node dependency — read-only)
- `@/lib/errors` → `AppError` (cross-node dependency — read-only)
- `../tools` → the registered banking tools whose param schemas `mock-responder` mirrors (sibling node — read-only)
