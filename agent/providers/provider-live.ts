import type { Model } from '@mariozechner/pi-ai';
import type { AppConfig } from '@/lib/config';

/**
 * LIVE mode — builds a REAL chat model from the Pi AI SDK.
 *
 * The provider and model id come from `cfg.llmProvider` / `cfg.llmModel`; the API key
 * is read from the environment (never from `AppConfig`, never logged, never returned).
 * This path requires network access and a real key, so it is used ONLY for the
 * competition demo — never by the offline/mock test suite.
 */
export function createLiveModel(cfg: AppConfig): Model {
  throw new Error('not implemented');
}
