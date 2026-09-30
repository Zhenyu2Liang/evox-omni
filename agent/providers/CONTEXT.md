# agent/providers — LLM Provider Selection

## Intent

The single place where Pi AI `Model` instances are constructed. It exists so the rest of
`./agent` NEVER imports `@mariozechner/pi-ai` model constructors directly — every other file
receives a ready `Model` from `resolveModel`, keeping model/provider wiring isolated and
swappable.

Two modes, chosen at call time from `AppConfig.llmMode`:

- **`mock`** — a scripted in-memory model via `registerFauxProvider()` from `@mariozechner/pi-ai`.
  Fully offline and deterministic. Drives `LLM_MODE=mock`, all unit tests and the 12 demo
  scenario tests. Same Agent / tools / security pipeline — only the model is scripted.
- **`live`** — a real chat model from `@mariozechner/pi-ai`, built from `cfg.llmProvider` /
  `cfg.llmModel` with the API key read from the environment. Demo-only: requires network + a key.

## API Surface

```ts
// provider-live.ts
export function createLiveModel(cfg: AppConfig): Model<any>;   // real model; needs network + key

// provider-mock.ts
export function createMockModel(cfg: AppConfig): Model<any>;   // registers faux provider; offline, deterministic

// index.ts (node facade)
export function resolveModel(cfg?: AppConfig): Model<any>;     // mock ⇒ createMockModel, live ⇒ createLiveModel; defaults to getConfig()
export function providerId(cfg?: AppConfig): string;           // "mock" | `${provider}:${model}` — stable log id, never the API key
```

`Model<TApi extends Api>` (from `@mariozechner/pi-ai`) REQUIRES a type argument, so every signature
here returns `Model<any>` — the same instantiation as `AgentState.model` (pi-agent-core). `AppConfig`
is imported from `@/lib/config`. These signatures are frozen; consumers (e.g. `../banking-agent.ts`)
depend on them.

`createLiveModel` resolves, in order: (1) the Pi AI model registry via `getModels(provider)`
(runtime-safe — `[]` for unknown providers), returning the fully-specified built-in `Model`; else
(2) a literal `Model<any>` (`api: 'openai-completions'`) for a custom endpoint. For KNOWN providers
it checks the env for an API key (`getEnvApiKey`) and throws `AppError('VALIDATION')` if absent — a
clear demo-time failure instead of a mid-stream one. The key is never attached to the returned
`Model`, logged, or surfaced by `providerId`.

## Constraints

- **No network in mock mode.** `createMockModel` MUST be fully offline and deterministic
  (faux provider only) — no live LLM, no sockets, no timers that vary output. `registerFauxProvider()`
  with no options returns the single in-memory `faux-1` model; with no `tokensPerSecond` set, text
  deltas stream on the microtask queue (no variable timers). Scenario tests that need scripted
  replies register their OWN faux provider and call `setResponses` — this factory only guarantees a
  deterministic, offline faux model.
- **`getConfig()` is read at CALL TIME**, not at module load, so tests can toggle `LLM_MODE`
  between cases. `resolveModel`/`providerId` with no argument must call `getConfig()`.
- **Never leak secrets.** API keys come from the environment only; they must never appear in
  `AppConfig`, logs, returned values, or `providerId`. The key is NOT a `Model` field — the Pi AI
  stream layer reads it from the env at request time.
- **`live` is demo-only**; `mock` is the required path for all tests (root determinism rule).
- **The rest of `./agent` never constructs a `Model`** — it calls `resolveModel` and receives one.
- **Provider knowledge stays here.** No pi-ai model-constructor import outside this node.
- Dependency direction: depends on `@mariozechner/pi-ai`, `@/lib/config` and `@/lib/errors` only
  (plus the `@mariozechner/pi-agent-core` runtime types it must satisfy). No cycles.
- Files ≲ ~1000 lines; keep each file focused on one mode.

## Dependencies

- `@mariozechner/pi-ai` — `Model` (type), `registerFauxProvider()` (mock), `getModels()` /
  `getProviders()` / `getEnvApiKey()` (live). Identifiers CONFIRMED against the installed 0.73.1
  `.d.ts` files (`dist/types.d.ts`, `dist/models.d.ts`, `dist/providers/faux.d.ts`).
- `@/lib/config` — `AppConfig { llmMode: 'live'|'mock'; llmProvider: string; llmModel: string;
  demoUserId: string }`, `getConfig()`.
- `@/lib/errors` — `AppError` (thrown by `createLiveModel` when a known provider has no env key).

## Test Strategy

Vitest (`../tests`, sibling). This node is a thin, well-isolated boundary, so it needs little
direct testing:
- `resolveModel()` with `LLM_MODE=mock` returns the faux scripted model and the FULL agent
  pipeline (run-turn + security) runs offline — this is the primary integration coverage.
- `providerId()` is pure: assert `"mock"` in mock mode and `${provider}:${model}` in live mode;
  assert the API key never appears in the return value.
- `live` mode is not unit-tested (network + key); it is exercised manually for the demo.

## Routing Table

- `./agent/providers/provider-live.ts` → `createLiveModel(cfg)` — real Pi AI model (demo-only)
- `./agent/providers/provider-mock.ts` → `createMockModel(cfg)` — scripted faux model (offline, deterministic)
- `./agent/providers/index.ts` → node facade: `resolveModel`, `providerId`
- `../banking-agent.ts` → sole consumer; receives a `Model` from `resolveModel` (sibling file, same node — read-only here)
- `@/lib/config` → `AppConfig` + `getConfig()` (cross-node dependency — read-only)
- `@/lib/errors` → `AppError` (cross-node dependency — read-only)
