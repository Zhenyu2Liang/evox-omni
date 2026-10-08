/**
 * provider-live — NODE-LOCAL spec for the LIVE model resolution.
 *
 * Pins the fix for the live `deepseek`/`deepseek-flash` 401: `deepseek-flash` is NOT a registered
 * pi-ai model id, and the old fallback silently returned a literal `Model` pointed at
 * `https://api.openai.com/v1` — i.e. it sent the DeepSeek API key to OpenAI's host. The resolver
 * must instead resolve a model for the SAME configured provider (its registered default) and warn
 * loudly, and it must NEVER return a model whose `baseUrl` belongs to a different provider.
 *
 * PURE: the pure `resolveLiveModel` helper is driven against the REAL installed pi-ai registry
 * (no key, no network) and against injected fake registries/envs for the branch coverage.
 *
 * How to run (the repo-root `vitest.config.ts` only globs `tests/**`, a read-only sibling of this
 * node, so a node-local spec is NOT auto-discovered by `npm run test`; the CLI filter alone also
 * cannot widen `include`):
 *   npx vitest run --config agent/providers/vitest.provider-live.config.ts
 * (`agent/providers/vitest.provider-live.config.ts` aliases `@` to the repo root and includes
 * exactly this file.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@mariozechner/pi-ai';

import {
  createLiveModel,
  providerBaseUrlEnvVar,
  resolveLiveModel,
  type LiveModelRegistry,
} from './provider-live';
import { AppError } from '@/lib/errors';

/** A fake registry so every branch is exercised deterministically, without the shipped data. */
function fakeRegistry(
  providers: Record<string, Model<any>[]>,
): LiveModelRegistry {
  return {
    getProviders: () => Object.keys(providers),
    getModels: (provider) => providers[provider] ?? [],
  };
}

function model(id: string, provider: string, baseUrl: string, api = 'openai-completions'): Model<any> {
  return {
    id,
    name: id,
    api,
    provider,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('resolveLiveModel — the real installed pi-ai registry', () => {
  it('maps deepseek/deepseek-flash to the DeepSeek default model, never an OpenAI host', () => {
    const { model: resolved, warning } = resolveLiveModel('deepseek', 'deepseek-flash', { env: {} });

    expect(resolved.id).toBe('deepseek-v4-flash');
    expect(resolved.provider).toBe('deepseek');
    expect(resolved.api).toBe('openai-completions');
    expect(resolved.baseUrl).toBe('https://api.deepseek.com');
    expect(resolved.baseUrl).not.toContain('openai.com');

    // LOUD + explicit: names the REQUESTED and the ACTUALLY-USED model id.
    expect(warning).toBeDefined();
    expect(warning).toContain('deepseek-flash');
    expect(warning).toContain('deepseek-v4-flash');
    expect(warning).toContain('deepseek');
  });

  it('honours a REGISTERED model id verbatim (no warning)', () => {
    const { model: resolved, warning } = resolveLiveModel('deepseek', 'deepseek-v4-pro', { env: {} });

    expect(warning).toBeUndefined();
    expect(resolved.id).toBe('deepseek-v4-pro');
    expect(resolved.baseUrl).toBe('https://api.deepseek.com');
  });

  it('never resolves a provider’s key onto a foreign host for ANY registered provider', () => {
    for (const provider of ['deepseek', 'openai', 'anthropic', 'groq', 'xai']) {
      for (const modelId of ['definitely-not-a-real-model-id']) {
        const { model: resolved } = resolveLiveModel(provider, modelId, { env: {} });
        expect(resolved.provider).toBe(provider);
      }
    }
  });
});

describe('resolveLiveModel — known provider, unregistered model id', () => {
  it('resolves the provider default (first registered) and warns requested vs used', () => {
    const registry = fakeRegistry({
      acme: [model('acme-default', 'acme', 'https://api.acme.test/v1'), model('acme-pro', 'acme', 'https://api.acme.test/v1')],
    });

    const { model: resolved, warning } = resolveLiveModel('acme', 'acme-flash', { registry, env: {} });

    expect(resolved.id).toBe('acme-default');
    expect(resolved.baseUrl).toBe('https://api.acme.test/v1');
    expect(warning).toContain('acme-flash');
    expect(warning).toContain('acme-default');
    expect(warning).toContain('https://api.acme.test/v1');
  });

  it('fails loudly for a known provider that exposes no models', () => {
    const registry = fakeRegistry({ empty: [] });

    expect(() => resolveLiveModel('empty', 'whatever', { registry, env: {} })).toThrow(AppError);
  });
});

describe('resolveLiveModel — unknown provider (custom endpoint)', () => {
  it('uses <PROVIDER>_BASE_URL when configured', () => {
    const env = { [`${providerBaseUrlEnvVar('my-llm')}`]: 'https://llm.internal/v1' };

    const { model: resolved, warning } = resolveLiveModel('my-llm', 'my-model', {
      registry: fakeRegistry({}),
      env,
    });

    expect(providerBaseUrlEnvVar('my-llm')).toBe('MY_LLM_BASE_URL');
    expect(resolved.baseUrl).toBe('https://llm.internal/v1');
    expect(resolved.api).toBe('openai-completions');
    expect(resolved.provider).toBe('my-llm');
    expect(warning).toContain('https://llm.internal/v1');
    expect(warning).toContain('my-model');
  });

  it('falls back to the shared LLM_BASE_URL', () => {
    const { model: resolved } = resolveLiveModel('my-llm', 'my-model', {
      registry: fakeRegistry({}),
      env: { LLM_BASE_URL: 'https://gateway.internal/v1' },
    });

    expect(resolved.baseUrl).toBe('https://gateway.internal/v1');
  });

  it('FAILS LOUDLY instead of assuming an OpenAI host', () => {
    let thrown: unknown;
    try {
      resolveLiveModel('my-llm', 'my-model', { registry: fakeRegistry({}), env: {} });
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('VALIDATION');
    expect((thrown as AppError).message).toContain('my-llm');
    expect((thrown as AppError).message).toContain('MY_LLM_BASE_URL');
    expect((thrown as AppError).message).toContain('LLM_BASE_URL');
  });

  it('uses the OpenAI host ONLY when the provider really is openai', () => {
    const { model: resolved } = resolveLiveModel('openai', 'gpt-fictional', {
      registry: fakeRegistry({}),
      env: {},
    });

    expect(resolved.baseUrl).toBe('https://api.openai.com/v1');
    expect(resolved.provider).toBe('openai');
  });
});

describe('createLiveModel — env-key presence check + warning', () => {
  it('builds the DeepSeek default model for LLM_PROVIDER=deepseek / LLM_MODEL=deepseek-flash', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'not-a-real-key');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const resolved = createLiveModel({
      llmMode: 'live',
      llmProvider: 'deepseek',
      llmModel: 'deepseek-flash',
      demoUserId: 'user_liming',
    });

    expect(resolved.id).toBe('deepseek-v4-flash');
    expect(resolved.api).toBe('openai-completions');
    expect(resolved.baseUrl).toBe('https://api.deepseek.com');

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('deepseek-flash');
    expect(message).toContain('deepseek-v4-flash');
    expect(message).toContain('https://api.deepseek.com');
    // The key VALUE is never surfaced.
    expect(message).not.toContain('not-a-real-key');
  });

  it('fails fast (VALIDATION) for a known provider with no key in the environment', () => {
    // `vi.stubEnv` to the empty string makes the key env var ABSENT for `findEnvKeys`.
    vi.stubEnv('DEEPSEEK_API_KEY', '');

    expect(() =>
      createLiveModel({
        llmMode: 'live',
        llmProvider: 'deepseek',
        llmModel: 'deepseek-v4-flash',
        demoUserId: 'user_liming',
      }),
    ).toThrow(AppError);
  });

  it('fails loudly for an unknown provider with no base URL (key never sent elsewhere)', () => {
    vi.stubEnv('LLM_BASE_URL', '');

    expect(() =>
      createLiveModel({
        llmMode: 'live',
        llmProvider: 'totally-custom-llm',
        llmModel: 'my-model',
        demoUserId: 'user_liming',
      }),
    ).toThrow(AppError);
  });
});
