import type { Model } from '@earendil-works/pi-ai';
import { getConfig, type AppConfig } from '@/lib/config';
import { createLiveRuntime } from './provider-live';
import { createMockRuntime } from './provider-mock';
import type { ModelRuntime } from './types';

/**
 * Facade of the providers node.
 *
 * `resolveProvider` reads `getConfig()` at CALL TIME (so tests can toggle `LLM_MODE`).
 * Pi 1.x requires both a Model and a streamFn bound to its provider collection.
 * Each Agent receives this pair together, without a global provider registry.
 */
export function resolveProvider(cfg?: AppConfig): ModelRuntime {
  const resolved = cfg ?? getConfig();
  return resolved.llmMode === 'mock'
    ? createMockRuntime(resolved)
    : createLiveRuntime(resolved);
}

/** Model-only inspection facade; Agent construction must use resolveProvider(). */
export function resolveModel(cfg?: AppConfig): Model<any> {
  return resolveProvider(cfg).model;
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
