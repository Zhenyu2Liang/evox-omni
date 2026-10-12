import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, normalizeContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { withLiveRequestLimits } from './request-options';

describe('live provider request bounds', () => {
  it.each([undefined, 'NaN', '0', '999999'])('uses safe defaults for timeout %s', value => {
    const stream = vi.fn<StreamFn>().mockReturnValue(createAssistantMessageEventStream());
    withLiveRequestLimits(stream, { LLM_REQUEST_TIMEOUT_MS: value })(fauxProvider().getModel(), normalizeContext({ messages: [] }));
    expect(stream.mock.calls[0][2]).toMatchObject({ timeoutMs: 30000, maxRetries: 1, maxRetryDelayMs: 1500 });
  });
  it('keeps caller cancellation and payload hooks while bounding timeout and transport retries', () => {
    const stream = vi.fn<StreamFn>().mockReturnValue(createAssistantMessageEventStream());
    const signal = new AbortController().signal, onPayload = vi.fn();
    withLiveRequestLimits(stream, { LLM_REQUEST_TIMEOUT_MS: '45000' })(fauxProvider().getModel(), normalizeContext({ messages: [] }),
      { signal, onPayload, timeoutMs: 600000, maxRetries: 100 });
    expect(stream.mock.calls[0][2]).toMatchObject({ onPayload, timeoutMs: 45000, maxRetries: 1 });
    expect(stream.mock.calls[0][2]?.signal?.aborted).toBe(false);
  });
  const abortingStream: StreamFn = (_model, _context, options) => {
    const source = createAssistantMessageEventStream();
    const fail = () => source.push({ type: 'error', reason: 'aborted', error: fauxAssistantMessage('', { stopReason: 'aborted', errorMessage: 'The operation was aborted.' }) });
    if (options?.signal?.aborted) fail(); else options?.signal?.addEventListener('abort', fail, { once: true });
    return source;
  };
  it('maps its stream deadline to a recoverable timeout, even after response headers', async () => {
    const output = await withLiveRequestLimits(abortingStream, { LLM_REQUEST_TIMEOUT_MS: '1000' })(fauxProvider().getModel(), normalizeContext({ messages: [] }));
    const result = await output.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('Request timed out.');
  });
  it('preserves explicit caller cancellation instead of treating it as a timeout', async () => {
    const controller = new AbortController();
    const output = await withLiveRequestLimits(abortingStream, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }), { signal: controller.signal });
    controller.abort();
    const result = await output.result();
    expect(result.stopReason).toBe('aborted');
    expect(result.errorMessage).not.toBe('Request timed out.');
  });
});
