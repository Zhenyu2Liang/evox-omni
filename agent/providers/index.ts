import type { Model } from '@mariozechner/pi-ai';
import type { AppConfig } from '@/lib/config';

/**
 * Facade of the providers node.
 *
 * `resolveModel` reads `getConfig()` at CALL TIME (so tests can toggle `LLM_MODE`),
 * dispatching to `createMockModel` (mock) or `createLiveModel` (live). The rest of the
 * agent node receives the returned `Model` and NEVER constructs one itself.
 */
export function resolveModel(cfg?: AppConfig): Model {
  throw new Error('not implemented');
}

/**
 * A stable identifier for logs/telemetry: `"mock"` in mock mode, otherwise
 * `` `${cfg.llmProvider}:${cfg.llmModel}` `` for live. Never includes the API key.
 */
export function providerId(cfg?: AppConfig): string {
  throw new Error('not implemented');
}
