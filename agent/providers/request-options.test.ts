import { describe, expect, it, vi } from 'vitest';
import { createAssistantMessageEventStream, fauxProvider, fauxAssistantMessage, normalizeContext } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { withLiveRequestLimits } from './request-options';
import { retryableModelFailure, type AuditedAssistantMessage } from './model-failure';

describe('live provider request bounds', () => {
  it.each(['throw', 'reject'] as const)('encodes a provider startup %s in the returned protocol stream', async mode => {
    const stream: StreamFn = () => {
      const error = new Error('Provider initialization failed.');
      if (mode === 'throw') throw error;
      return Promise.reject(error);
    };
    const output = await withLiveRequestLimits(stream, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }));
    const events = [];
    for await (const event of output) events.push(event);
    expect(events.map(event => event.type)).toEqual(['error']);
    expect(await output.result()).toMatchObject({ stopReason: 'error', errorMessage: 'Provider initialization failed.',
      bankingFailure: { kind: 'provider', retryable: false } });
  });

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
    expect((result as AuditedAssistantMessage).bankingFailure).toEqual({ kind: 'timeout', retryable: true });
    expect(retryableModelFailure(result)).toBe(true);
  });
  it('preserves explicit caller cancellation instead of treating it as a timeout', async () => {
    const controller = new AbortController();
    const output = await withLiveRequestLimits(abortingStream, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }), { signal: controller.signal });
    controller.abort();
    const result = await output.result();
    expect(result.stopReason).toBe('aborted');
    expect(result.errorMessage).not.toBe('Request timed out.');
    expect((result as AuditedAssistantMessage).bankingFailure).toEqual({ kind: 'cancelled', retryable: false });
    expect(retryableModelFailure(result)).toBe(false);
  });
  it('settles a prematurely closed source as an error and preserves its partial response', async () => {
    const partial = fauxAssistantMessage('The unfinished response', { stopReason: 'pending' });
    const source = createAssistantMessageEventStream();
    source.push({ type: 'text_delta', contentIndex: 0, delta: 'The unfinished response', partial });
    source.end();
    const output = await withLiveRequestLimits(() => source, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }));
    const result = await output.result();
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('Provider stream ended without a terminal event.');
    expect(result.content).toEqual(partial.content);
    expect(result.usage).toEqual(partial.usage);
    expect((result as AuditedAssistantMessage).bankingFailure).toEqual({ kind: 'transport', retryable: true });
    const events = [];
    for await (const event of output) events.push(event.type);
    expect(events).toEqual(['text_delta', 'error']);
  });
  it('preserves a completed response when cancellation arrives after its terminal event', async () => {
    const controller = new AbortController();
    const message = fauxAssistantMessage('The complete response');
    const source = createAssistantMessageEventStream();
    source.push({ type: 'done', reason: 'stop', message });
    const output = await withLiveRequestLimits(() => source, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }), { signal: controller.signal });
    expect(await output.result()).toMatchObject({ stopReason: 'stop', content: message.content });
    controller.abort();
    expect(await output.result()).toMatchObject({ stopReason: 'stop', content: message.content });
  });

  it.each([[401, false], [429, true]] as const)('uses observed HTTP status %s instead of provider failure wording', async (status, retryable) => {
    const stream: StreamFn = async (_model, _context, options) => {
      const source = createAssistantMessageEventStream();
      await options!.fetch!('https://offline.invalid');
      source.push({ type: 'error', reason: 'error', error: fauxAssistantMessage('', {
        stopReason: 'error', errorMessage: status === 401 ? 'Network timeout 429.' : 'Authentication denied 401.',
      }) });
      return source;
    };
    const fetch: typeof globalThis.fetch = async () => new Response('', { status });
    const output = await withLiveRequestLimits(stream, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }), { fetch });
    const result = await output.result();
    expect((result as AuditedAssistantMessage).bankingFailure).toEqual({ kind: 'http', status, retryable });
    expect(retryableModelFailure(result)).toBe(retryable);
  });

  it('classifies a thrown fetch as transport failure without scanning its message', async () => {
    const stream: StreamFn = async (_model, _context, options) => {
      const source = createAssistantMessageEventStream();
      try { await options!.fetch!('https://offline.invalid'); } catch {
        source.push({ type: 'error', reason: 'error', error: fauxAssistantMessage('', { stopReason: 'error', errorMessage: '401 permission denied.' }) });
      }
      return source;
    };
    const fetch: typeof globalThis.fetch = async () => { throw new Error('401 permission denied.'); };
    const output = await withLiveRequestLimits(stream, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }), { fetch });
    const result = await output.result();
    expect((result as AuditedAssistantMessage).bankingFailure).toEqual({ kind: 'transport', retryable: true });
  });

  it('does not retry a provider error without observed transport failure merely because it contains timeout words', async () => {
    const source = createAssistantMessageEventStream();
    source.push({ type: 'error', reason: 'error', error: fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'timeout network 429 503' }) });
    const output = await withLiveRequestLimits(() => source, {})(fauxProvider().getModel(), normalizeContext({ messages: [] }));
    const result = await output.result();
    expect((result as AuditedAssistantMessage).bankingFailure).toEqual({ kind: 'provider', retryable: false });
    expect(retryableModelFailure(result)).toBe(false);
  });
});
