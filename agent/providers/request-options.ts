import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

/** Retrying a model HTTP request cannot execute bank tools: Pi executes only a completed response. */
export function withLiveRequestLimits(stream: StreamFn, env: Record<string, string | undefined> = process.env): StreamFn {
  const configured = Number(env.LLM_REQUEST_TIMEOUT_MS ?? 30000);
  const timeoutMs = Number.isFinite(configured) && configured >= 1000 && configured <= 120000 ? configured : 30000;
  return (model, context, options) => {
    // SDK connection timeouts may end at response headers. The abort deadline also bounds an
    // idle body stream; an explicit caller cancellation remains a cancellation, not a retry.
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const source = stream(model, context, { ...options, signal, timeoutMs, maxRetries: 1, maxRetryDelayMs: 1500 });
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of await source) {
          output.push(event.type === 'error' && deadline.aborted && !options?.signal?.aborted
            ? { ...event, reason: 'error', error: { ...event.error, stopReason: 'error', errorMessage: 'Request timed out.' } }
            : event);
        }
        output.end();
      } catch (error) {
        output.push({ type: 'error', reason: 'error', error: {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), stopReason: 'error',
          errorMessage: deadline.aborted && !options?.signal?.aborted ? 'Request timed out.'
            : error instanceof Error ? error.message : '模型请求中断',
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        } });
      }
    })();
    return output;
  };
}
