import {
  createProvider,
  envApiKeyAuth,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModels, getBuiltinProviders, type BuiltinProvider } from '@earendil-works/pi-ai/providers/all';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AppConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import type { ModelRuntime } from './types';

/**
 * Chat-completions is the widest-compatible api dialect for an OpenAI-compatible endpoint.
 */
const OPENAI_COMPATIBLE_API: Api = 'openai-completions';

/**
 * OpenAI-host base URL. It is used ONLY when the configured provider genuinely IS the OpenAI
 * host — never as a blanket default. Defaulting every unregistered provider here is exactly the
 * defect that sends a configured provider's API key to somebody else's host.
 */
const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** Provider ids that really are the OpenAI host, so the OpenAI base URL is the correct one. */
const OPENAI_FAMILY_PROVIDERS = new Set(['openai']);

/** Base-URL override env vars consulted for an UNregistered (custom) provider, in order. */
const SHARED_BASE_URL_ENV = 'LLM_BASE_URL';
const BASE_URL_ENV_SUFFIX = '_BASE_URL';

/** Limits for the literal `Model` built for a custom (unregistered) provider endpoint. */
const CUSTOM_CONTEXT_WINDOW = 128_000;
const CUSTOM_MAX_TOKENS = 16_384;

/** Environment source for the base-URL override (injectable so tests need no real env). */
export type LiveModelEnv = Record<string, string | undefined>;

/**
 * The slice of the Pi AI model registry this resolver needs. Injectable so the resolution
 * mapping is unit-testable without network / API key — the default delegates to pi-ai.
 */
export interface LiveModelRegistry {
  getProviders(): string[];
  getModels(provider: string): Model<any>[];
}

const DEFAULT_REGISTRY: LiveModelRegistry = {
  getProviders: () => getBuiltinProviders(),
  getModels: (provider) => getBuiltinProviders().includes(provider as BuiltinProvider)
    ? getBuiltinModels(provider as BuiltinProvider) as Model<any>[]
    : [],
};

export interface LiveModelDeps {
  registry?: LiveModelRegistry;
  env?: LiveModelEnv;
}

export interface LiveModelResolution {
  /** The `Model` to use — ALWAYS for the requested provider, never another provider's host. */
  model: Model<any>;
  /**
   * A LOUD advisory naming the REQUESTED vs the ACTUALLY-USED model id / endpoint. `undefined`
   * when the requested model id was registered for the requested provider (honoured verbatim).
   */
  warning?: string;
}

/** `<PROVIDER>_BASE_URL` — provider id upper-cased with non-alphanumerics collapsed to `_`. */
export function providerBaseUrlEnvVar(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}${BASE_URL_ENV_SUFFIX}`;
}

/** The explicit base-URL override for `provider`, if any (`<PROVIDER>_BASE_URL`, else `LLM_BASE_URL`). */
function explicitBaseUrl(provider: string, env: LiveModelEnv): string | undefined {
  const providerSpecific = env[providerBaseUrlEnvVar(provider)]?.trim();
  if (providerSpecific) return providerSpecific;
  const shared = env[SHARED_BASE_URL_ENV]?.trim();
  return shared || undefined;
}

/** Literal `Model` for a custom OpenAI-compatible endpoint. */
function customModel(provider: string, modelId: string, baseUrl: string): Model<any> {
  return {
    id: modelId,
    name: modelId,
    api: OPENAI_COMPATIBLE_API,
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: CUSTOM_CONTEXT_WINDOW,
    maxTokens: CUSTOM_MAX_TOKENS,
  };
}

/**
 * PURE resolution of `(provider, modelId)` → a usable `Model`, never leaking one provider's key
 * to another host. Resolution order:
 *
 *  1. **Registry hit** — `modelId` is registered for `provider` ⇒ that `Model` verbatim
 *     (correct api dialect, base URL, headers, limits and pricing), no warning.
 *  2. **Provider default** — `provider` IS registered (`getProviders()`), but `modelId` is not.
 *     Never silently point an unknown model id at a hardcoded foreign host;
 *     resolve THAT provider's own default
 *     (`getModels(provider)[0]`) and warn loudly naming requested vs used id.
 *  3. **Unknown provider** (custom OpenAI-compatible endpoint) — a literal `Model` is built ONLY
 *     for an EXPLICIT base URL (`<PROVIDER>_BASE_URL` → `LLM_BASE_URL`) or when the provider
 *     really is the OpenAI host; otherwise it FAILS LOUDLY rather than guessing somebody's host.
 */
export function resolveLiveModel(
  provider: string,
  modelId: string,
  deps: LiveModelDeps = {},
): LiveModelResolution {
  const registry = deps.registry ?? DEFAULT_REGISTRY;
  const env = deps.env ?? process.env;
  const registered = registry.getModels(provider);
  const knownProviders = registry.getProviders();

  // 1. Registered model id for this provider — honoured verbatim.
  const exact = registered.find((model) => model.id === modelId);
  if (exact) return { model: exact };

  // 2. Known provider, unregistered model id ⇒ the PROVIDER'S OWN registered default.
  if (knownProviders.includes(provider)) {
    const providerDefault = registered[0];
    if (providerDefault) {
      return {
        model: providerDefault,
        warning:
          `[llm] model "${modelId}" is NOT a registered pi-ai model id for provider ` +
          `"${provider}" — using its default "${providerDefault.id}" ` +
          `(baseUrl ${providerDefault.baseUrl}) instead. ` +
          `Set LLM_MODEL to a registered id for "${provider}" to silence this.`,
      };
    }
    throw new AppError(
      'VALIDATION',
      `Provider "${provider}" is known to pi-ai but exposes no registered model, so no Model ` +
        `can be resolved for "${modelId}".`,
    );
  }

  // 3. Unknown provider (custom endpoint): require an EXPLICIT base URL, or require the
  //    provider to actually be an OpenAI-family host. Never assume someone else's host.
  const baseUrl =
    explicitBaseUrl(provider, env) ??
    (OPENAI_FAMILY_PROVIDERS.has(provider) ? OPENAI_BASE_URL : undefined);
  if (!baseUrl) {
    throw new AppError(
      'VALIDATION',
      `Unknown LLM provider "${provider}" with no base URL configured — refusing to send its ` +
        `API key to an unrelated host. Set ${providerBaseUrlEnvVar(provider)} (or ` +
        `${SHARED_BASE_URL_ENV}) to the endpoint's base URL, or use a pi-ai registered ` +
        `provider id (${knownProviders.slice(0, 8).join(', ')}, …).`,
    );
  }
  return {
    model: customModel(provider, modelId, baseUrl),
    warning:
      `[llm] provider "${provider}" is not a registered pi-ai provider — using custom ` +
      `endpoint ${baseUrl} for model "${modelId}".`,
  };
}

/**
 * LIVE mode — builds a REAL chat model from the Pi AI SDK.
 *
 * The provider and model id come from `cfg.llmProvider` / `cfg.llmModel`; the API key is read
 * from the environment (never from `AppConfig`, never logged, never returned). This path requires
 * network access and a real key, so it is used ONLY for the competition demo — never by the
 * offline/mock test suite.
 *
 * The `Model` itself is produced by the pure `resolveLiveModel` helper (registry hit → that
 * provider's registered default → explicit custom endpoint / loud failure), so the resolved
 * model ALWAYS targets `cfg.llmProvider` and its key is never sent to another host. A model-id
 * substitution emits a LOUD `console.warn`.
 *
 * The API key is NOT attached to the returned `Model` (the type has no key field): the Pi AI
 * Models collection resolves provider-scoped auth at request time. Common API-key providers
 * also get a synchronous presence check so the live demo fails clearly before streaming.
 * Custom endpoints use `<PROVIDER>_API_KEY` through their explicitly registered provider.
 */
export function createLiveModel(cfg: AppConfig): Model<any> {
  // Common API-key providers can fail fast synchronously. Request-time auth is
  // resolved by Models; no key is attached to a persisted Model or AgentState.
  const keyVariables: Record<string, string[]> = {
    deepseek: ['DEEPSEEK_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
    google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    xai: ['XAI_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
    cerebras: ['CEREBRAS_API_KEY'],
  };
  const variables = keyVariables[cfg.llmProvider];
  if (variables && !variables.some((name) => process.env[name]?.trim())) {
    throw new AppError(
      'VALIDATION',
      `No API key found in the environment for provider "${cfg.llmProvider}". ` +
        `Set the provider's *_API_KEY env var (see .env.example). ` +
        `The live model is demo-only — use LLM_MODE=mock for offline runs.`,
    );
  }

  const { model, warning } = resolveLiveModel(cfg.llmProvider, cfg.llmModel);
  if (warning) console.warn(warning);
  return model;
}

/** Pi 1.x routes requests through an explicit, provider-scoped Models collection. */
export function createLiveRuntime(cfg: AppConfig): ModelRuntime {
  const model = createLiveModel(cfg);
  const models = builtinModels();
  if (!models.getProvider(model.provider)) {
    const keyVariable = `${model.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    models.setProvider(createProvider({
      id: model.provider,
      baseUrl: model.baseUrl,
      models: [model],
      auth: { apiKey: envApiKeyAuth(`${model.provider} API key`, [keyVariable]) },
      api: openAICompletionsApi(),
    }));
  }
  return { model, streamFn: models.streamSimple.bind(models) };
}
