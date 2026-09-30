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
export function providerId(cfg?: AppConfig): string;      // "mock" | `${provider}:${model}` — stable log id, never the API key
```

`Model` is imported from `@mariozechner/pi-ai`. `AppConfig` is imported from `@/lib/config`.
These signatures are frozen; consumers (e.g. `../banking-agent.ts`) depend on them.

## Constraints

- **No network in mock mode.** `createMockModel` MUST be fully offline and deterministic
  (faux provider only) — no live LLM, no sockets, no timers that vary output.
- **`getConfig()` is read at CALL TIME**, not at module load, so tests can toggle `LLM_MODE`
  between cases. `resolveModel`/`providerId` with no argument must call `getConfig()`.
- **Never leak secrets.** API keys are read from the environment only; they must never appear in
  `AppConfig`, logs, returned values, or `providerId`.
- **`live` is demo-only**; `mock` is the required path for all tests (root determinism rule).
- **The rest of `./agent` never constructs a `Model`** — it calls `resolveModel` and receives one.
- **Provider knowledge stays here.** No pi-ai model-constructor import outside this node.
- Dependency direction: depends on `@mariozechner/pi-ai` and `@/lib/config` only (plus the
  `@mariozechner/pi-agent-core` runtime types it must satisfy). No cycles.
- Files ≲ ~1000 lines; keep each file focused on one mode.

## Dependencies

- `@mariozechner/pi-ai` — `Model` (type), `registerFauxProvider()` (mock mode).
  Exact exported identifiers are CONFIRMED against the installed package at integration
  (bodies are stubs today; `.d.ts` types are the source of truth).
- `@/lib/config` — `AppConfig { llmMode: 'live'|'mock'; llmProvider: string; llmModel: string;
  demoUserId: string }`, `getConfig()`.

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
