import type { StreamFn } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { requireCompletionTerminator } from './completion-transport';
import { httpModelFailure, type ModelFailure, type AuditedAssistantMessage } from './model-failure';

/** Retrying a model HTTP request cannot execute bank tools: Pi executes only a completed response. */
export function withLiveRequestLimits(stream: StreamFn, env: Record<string, string | undefined> = process.env): StreamFn {
  const configured = Number(env.LLM_REQUEST_TIMEOUT_MS ?? 30000);
  const timeoutMs = Number.isFinite(configured) && configured >= 1000 && configured <= 120000 ? configured : 30000;
  return (model, context, options) => {
    // SDK connection timeouts may end at response headers. The abort deadline also bounds an
    // idle body stream; an explicit caller cancellation remains a cancellation, not a retry.
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let transportFailure: ModelFailure | undefined;
    const originalFetch = options?.fetch ?? globalThis.fetch;
    const observedFetch: typeof originalFetch = async (input, init) => {
      transportFailure = undefined;
      try {
        const response = await originalFetch(input, init);
        if (!response.ok) transportFailure = httpModelFailure(response.status);
        return response;
      } catch (error) {
        transportFailure = { kind: 'transport', retryable: true };
        throw error;
      }
    };
    const fetch = model.api === 'openai-completions'
      ? requireCompletionTerminator(observedFetch, async event => {
        if (event && typeof event === 'object' && 'completed' in event && event.completed === false) {
          transportFailure = { kind: 'transport', retryable: true };
        }
        await options?.onProviderStreamEvent?.(event, model);
      }) : observedFetch;
    const failure = (): ModelFailure => options?.signal?.aborted ? { kind: 'cancelled', retryable: false }
      : deadline.aborted ? { kind: 'timeout', retryable: true }
      : transportFailure ?? { kind: 'provider', retryable: false };
    const output = createAssistantMessageEventStream();
    void (async () => {
      let terminalReceived = false;
      let partial: AssistantMessage | undefined;
      try {
        // Runtime setup failures must settle the same protocol stream as request failures.
        const source = await stream(model, context, { ...options, fetch, signal, timeoutMs, maxRetries: 1, maxRetryDelayMs: 1500 });
        for await (const event of source) {
          if ('partial' in event) partial = event.partial;
          if (event.type === 'done' || event.type === 'error') terminalReceived = true;
          if (event.type === 'error') {
            const error: AuditedAssistantMessage = { ...event.error, bankingFailure: failure(),
              ...(deadline.aborted && !options?.signal?.aborted ? { stopReason: 'error', errorMessage: 'Request timed out.' } : {}) };
            output.push({ ...event, error });
          } else output.push(event);
        }
        // end() without a result does not resolve Pi's result promise. A missing terminal
        // event is a broken provider stream, never a successfully completed response.
        if (!terminalReceived) {
          transportFailure = { kind: 'transport', retryable: true };
          throw new Error('Provider stream ended without a terminal event.');
        }
        output.end();
      } catch (error) {
        const reason = options?.signal?.aborted ? 'aborted' : 'error';
        const message: AuditedAssistantMessage = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          ...(partial ?? {}),
          timestamp: partial?.timestamp ?? Date.now(), stopReason: reason,
          errorMessage: deadline.aborted && !options?.signal?.aborted ? 'Request timed out.'
            : error instanceof Error ? error.message : 'Model request interrupted.',
          usage: partial?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          bankingFailure: failure(),
        };
        output.push({ type: 'error', reason, error: message });
      }
    })();
    return output;
  };
}
