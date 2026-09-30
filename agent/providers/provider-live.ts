import {
  getEnvApiKey,
  getModels,
  getProviders,
  type Api,
  type KnownProvider,
  type Model,
} from '@mariozechner/pi-ai';
import type { AppConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';

/**
 * Default api dialect + base URL for the best-effort literal `Model` built when
 * `cfg.llmProvider` / `cfg.llmModel` are not present in the Pi AI model registry
 * (e.g. a custom OpenAI-compatible endpoint). Chat-completions is the widest
 * compatible default.
 */
const FALLBACK_API: Api = 'openai-completions';
const FALLBACK_BASE_URL = 'https://api.openai.com/v1';

/**
 * LIVE mode — builds a REAL chat model from the Pi AI SDK.
 *
 * The provider and model id come from `cfg.llmProvider` / `cfg.llmModel`; the API key
 * is read from the environment (never from `AppConfig`, never logged, never returned).
 * This path requires network access and a real key, so it is used ONLY for the
 * competition demo — never by the offline/mock test suite.
 *
 * Resolution order:
 *  1. Prefer the Pi AI model registry (`getModels(provider)`), so the returned `Model`
 *     carries the correct api dialect, base URL, headers, limits and pricing. The
 *     registry lookup is runtime-safe for unknown providers (returns `[]`).
 *  2. Fall back to a literal `Model<any>` for a model absent from the registry (custom
 *     OpenAI-compatible endpoint).
 *
 * The API key is NOT attached to the returned `Model` (the type has no key field): the
 * Pi AI stream layer resolves it from the environment at request time. We only check
 * for its PRESENCE (via `getEnvApiKey`) so the live demo fails fast and clearly instead
 * of mid-stream. The key value is never read into a variable that is logged or returned.
 */
export function createLiveModel(cfg: AppConfig): Model<any> {
  // env-only presence check (never read from AppConfig); skip for unknown providers,
  // whose key variable the SDK cannot know.
  const isKnownProvider = (getProviders() as string[]).includes(cfg.llmProvider);
  if (isKnownProvider && !getEnvApiKey(cfg.llmProvider)) {
    throw new AppError(
      'VALIDATION',
      `No API key found in the environment for provider "${cfg.llmProvider}". ` +
        `Set the provider's *_API_KEY env var (see .env.example). ` +
        `The live model is demo-only — use LLM_MODE=mock for offline runs.`,
    );
  }

  const registered = (
    getModels(cfg.llmProvider as KnownProvider) as Model<any>[]
  ).find((model) => model.id === cfg.llmModel);
  if (registered) return registered;

  return {
    id: cfg.llmModel,
    name: cfg.llmModel,
    api: FALLBACK_API,
    provider: cfg.llmProvider,
    baseUrl: FALLBACK_BASE_URL,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}
