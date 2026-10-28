import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import type { AppConfig } from '@/lib/config';
import { AppError } from '@/lib/errors';

export interface ModelBudgetState {
  version: 1;
  intentId: string;
  startedAt: number;
  requests: number;
  reservedTokens: number;
  limits: { maxRequests: number; maxTokens: number; maxDurationMs: number };
}

export const MODEL_BUDGET_MESSAGE = '本轮模型调用已达到安全上限，请缩小请求后重试。';
const defaults = { maxRequests: 32, maxTokens: 2000000, maxDurationMs: 300000 };

function limits(config: AppConfig) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = config.modelBudget?.[key as keyof typeof defaults];
    return [key, Number.isSafeInteger(value) && value! > 0 ? value! : fallback];
  })) as typeof defaults;
}

/** Reservations survive crashes: retries and summaries spend the same turn budget, never reset it. */
export function withModelBudget(stream: StreamFn, options: {
  config: AppConfig;
  state(): ModelBudgetState | undefined;
  intentId(): string;
  save(state: ModelBudgetState): Promise<void>;
  now?: () => number;
}): StreamFn {
  const now = options.now ?? Date.now;
  return async (model, context, requestOptions) => {
    const id = options.intentId();
    const previous = options.state();
    const configured = limits(options.config);
    const state: ModelBudgetState = previous?.intentId === id ? previous : {
      version: 1, intentId: id, startedAt: now(), requests: 0, reservedTokens: 0, limits: configured,
    };
    // A changed process configuration may tighten a recorded budget but cannot renew it.
    const effective = Object.fromEntries(Object.entries(configured).map(([key, value]) =>
      [key, Math.min(value, state.limits[key as keyof typeof configured])])) as typeof configured;
    const remainingMs = state.startedAt + effective.maxDurationMs - now();
    // UTF-8 bytes conservatively bound transcript tokens; include room for provider framing.
    const inputBound = Buffer.byteLength(JSON.stringify(context), 'utf8') + 1024;
    const outputBound = Math.min(requestOptions?.maxTokens ?? model.maxTokens,
      effective.maxTokens - state.reservedTokens - inputBound);
    if (remainingMs <= 0 || outputBound < 1) throw new AppError('TOOL_FAILED', MODEL_BUDGET_MESSAGE);
    let budgetDenied = false;
    const reserve = async () => {
      if (state.requests >= effective.maxRequests || state.reservedTokens + inputBound + outputBound > effective.maxTokens ||
          now() >= state.startedAt + effective.maxDurationMs) {
        budgetDenied = true;
        throw new AppError('TOOL_FAILED', MODEL_BUDGET_MESSAGE);
      }
      state.requests++;
      state.reservedTokens += inputBound + outputBound;
      await options.save(state);
    };
    await reserve();
    const controller = new AbortController();
    const signal = requestOptions?.signal ? AbortSignal.any([controller.signal, requestOptions.signal]) : controller.signal;
    const output = createAssistantMessageEventStream();
    const failure = (): AssistantMessage => ({ role: 'assistant', content: [], api: model.api, provider: model.provider,
      model: model.id, timestamp: now(), stopReason: 'aborted', errorMessage: MODEL_BUDGET_MESSAGE,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const stop = () => {
      const message = failure();
      if (!controller.signal.aborted) message.errorMessage = '本轮模型请求已取消。';
      output.push({ type: 'error', reason: 'aborted', error: message }); output.end();
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => controller.abort(), remainingMs);
    timer.unref?.();
    let fetches = 0;
    void (async () => {
      try {
        if (signal.aborted) { stop(); return; }
        const source = await stream(model, context, { ...requestOptions, maxTokens: outputBound, signal,
          fetch: async (input, init) => {
            // SDK retries may reuse a payload without invoking onPayload again. Count the actual
            // HTTP attempts, before fetch, while the initial reservation also covers faux providers.
            if (fetches++ > 0) await reserve();
            return (requestOptions?.fetch ?? globalThis.fetch)(input, init);
          } });
        for await (const event of source) {
          if (signal.aborted) break;
          if (budgetDenied) {
            output.push({ type: 'error', reason: 'error', error: { ...failure(), stopReason: 'error' } });
            break;
          }
          output.push(event);
        }
        if (!signal.aborted) output.end(await source.result());
      } catch (error) {
        const message = failure();
        if (!signal.aborted) message.errorMessage = error instanceof Error ? error.message : 'Model request failed';
        output.push({ type: 'error', reason: 'error', error: { ...message, stopReason: 'error' } });
        output.end();
      } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); }
    })();
    return output;
  };
}
