import type { Model } from '@mariozechner/pi-ai';
import { getConfig, type AppConfig } from '@/lib/config';
import { createLiveModel } from './provider-live';
import { createMockModel } from './provider-mock';

/**
 * Facade of the providers node.
 *
 * `resolveModel` reads `getConfig()` at CALL TIME (so tests can toggle `LLM_MODE`),
 * dispatching to `createMockModel` (mock) or `createLiveModel` (live). The rest of the
 * agent node receives the returned `Model` and NEVER constructs one itself.
 */
export function resolveModel(cfg?: AppConfig): Model<any> {
  const resolved = cfg ?? getConfig();
  return resolved.llmMode === 'mock'
    ? createMockModel(resolved)
    : createLiveModel(resolved);
}

/**
 * A stable identifier for logs/telemetry: `"mock"` in mock mode, otherwise
 * `` `${cfg.llmProvider}:${cfg.llmModel}` `` for live. Never includes the API key.
 */
export function providerId(cfg?: AppConfig): string {
  const resolved = cfg ?? getConfig();
  return resolved.llmMode === 'mock'
    ? 'mock'
    : `${resolved.llmProvider}:${resolved.llmModel}`;
}
