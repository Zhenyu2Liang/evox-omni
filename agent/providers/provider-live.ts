import {
  createProvider,
  createModels,
  envApiKeyAuth,
  type Api,
  type Model,
} from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { googleProvider } from '@earendil-works/pi-ai/providers/google';
import { groqProvider } from '@earendil-works/pi-ai/providers/groq';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import { mistralProvider } from '@earendil-works/pi-ai/providers/mistral';
import { cerebrasProvider } from '@earendil-works/pi-ai/providers/cerebras';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import type { AppConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';
import type { ModelRuntime } from './types';
import { withLiveRequestLimits } from './request-options';

/**
 * Chat-completions is the widest-compatible api dialect for an OpenAI-compatible endpoint.
 */
const OPENAI_COMPATIBLE_API: Api = 'openai-completions';

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

/** Only explicit provider factories and their lazy APIs enter the application. */
const LIVE_PROVIDER_FACTORIES = {
  deepseek: deepseekProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  google: googleProvider,
  groq: groqProvider,
  openrouter: openrouterProvider,
  xai: xaiProvider,
  mistral: mistralProvider,
  cerebras: cerebrasProvider,
} as const;

const PROVIDER_KEY_VARIABLES: Record<string, string[]> = {
  deepseek: ['DEEPSEEK_API_KEY'], openai: ['OPENAI_API_KEY'],
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'], google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  groq: ['GROQ_API_KEY'], openrouter: ['OPENROUTER_API_KEY'], xai: ['XAI_API_KEY'],
  mistral: ['MISTRAL_API_KEY'], cerebras: ['CEREBRAS_API_KEY'],
};

function liveProviderFactory(provider: string) {
  return Object.hasOwn(LIVE_PROVIDER_FACTORIES, provider)
    ? LIVE_PROVIDER_FACTORIES[provider as keyof typeof LIVE_PROVIDER_FACTORIES]
    : undefined;
}

const DEFAULT_REGISTRY: LiveModelRegistry = {
  getProviders: () => Object.keys(LIVE_PROVIDER_FACTORIES),
  getModels: (provider) => [...(liveProviderFactory(provider)?.().getModels() ?? [])],
};

export interface LiveModelDeps {
  registry?: LiveModelRegistry;
  env?: LiveModelEnv;
}

export interface LiveModelResolution {
  /** The `Model` to use — ALWAYS for the requested provider, never another provider's host. */
  model: Model<any>;
  /**
   * An explicit custom endpoint advisory. Model identity is never silently substituted.
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
 *  2. **Unknown model** — fail clearly unless an explicit OpenAI-compatible endpoint is configured.
 *  3. **Custom endpoint** — retain the requested model id and require an explicit base URL
 *     (`<PROVIDER>_BASE_URL` → `LLM_BASE_URL`), never infer another model or host.
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

  const baseUrl = explicitBaseUrl(provider, env);
  if (knownProviders.includes(provider) && !baseUrl) {
    throw new AppError(
      'VALIDATION',
      `Model "${modelId}" is not registered for provider "${provider}". ` +
        `Use a registered model id or configure ${providerBaseUrlEnvVar(provider)} for an explicit OpenAI-compatible endpoint.`,
    );
  }
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
      `[llm] using explicitly configured OpenAI-compatible ` +
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
 * explicit custom endpoint / loud failure), so the resolved model retains the requested id.
 *
 * The API key is NOT attached to the returned `Model` (the type has no key field): the Pi AI
 * Models collection resolves provider-scoped auth at request time. Common API-key providers
 * also get a synchronous presence check so the live demo fails clearly before streaming.
 * Custom endpoints use `<PROVIDER>_API_KEY` through their explicitly registered provider.
 */
export function createLiveModel(cfg: AppConfig): Model<any> {
  // Common API-key providers can fail fast synchronously. Request-time auth is
  // resolved by Models; no key is attached to a persisted Model or AgentState.
  const variables = PROVIDER_KEY_VARIABLES[cfg.llmProvider];
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
  const models = createModels();
  const providerFactory = liveProviderFactory(model.provider);
  if (providerFactory && DEFAULT_REGISTRY.getModels(model.provider).some(candidate => candidate.id === model.id)) {
    models.setProvider(providerFactory());
  } else {
    const keyVariable = `${model.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
    models.setProvider(createProvider({
      id: model.provider,
      baseUrl: model.baseUrl,
      models: [model],
      auth: { apiKey: envApiKeyAuth(`${model.provider} API key`, PROVIDER_KEY_VARIABLES[model.provider] ?? [keyVariable]) },
      api: openAICompletionsApi(),
    }));
  }
  return { model, streamFn: withLiveRequestLimits(models.streamSimple.bind(models)) };
}
