import { describe, expect, it, vi } from 'vitest';
import { requireCompletionTerminator } from '@/agent/providers/completion-transport';

const encoder = new TextEncoder();

describe('provider SSE transport completion contract', () => {
  it.each(['\n', '\r\n', '\r'])('preserves payloads with split UTF-8 and %j frame endings', async newline => {
    const wire = `data: {"text":"\u4e2d\u6587"}${newline}${newline}data: [DONE]${newline}${newline}`;
    const bytes = encoder.encode(wire);
    let position = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      if (position < bytes.length) controller.enqueue(bytes.slice(position, ++position));
      else controller.close();
    } });
    const observe = vi.fn(async () => undefined);
    const fetch: typeof globalThis.fetch = async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } });
    const response = await requireCompletionTerminator(fetch, observe)('https://example.invalid');
    // CR-only can complete at the first empty line; the SDK does not need later delimiters.
    expect(await response.text()).toContain('data: {"text":"\u4e2d\u6587"}');
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ completed: true, terminator: '[DONE]', frames: 2 }));
  });

  it('reports incomplete EOF without changing or inspecting the answer text', async () => {
    const observe = vi.fn(async () => undefined);
    const fetch: typeof globalThis.fetch = async () => new Response('data: {"finish_reason":"stop"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const response = await requireCompletionTerminator(fetch, observe)('https://example.invalid');
    await expect(response.text()).rejects.toThrow('without the required [DONE] terminator');
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ completed: false }));
  });

  it('retains HTTP failures for the official SDK retry and error decoder', async () => {
    const error = new Response('{"error":"rate limited"}', { status: 429 });
    const fetch: typeof globalThis.fetch = async () => error;
    expect(await requireCompletionTerminator(fetch, vi.fn())('https://example.invalid')).toBe(error);
  });

  it('requires persistable termination evidence before exposing successful completion', async () => {
    const fetch: typeof globalThis.fetch = async () => new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    const response = await requireCompletionTerminator(fetch, async () => { throw new Error('Evidence storage unavailable'); })('https://example.invalid');
    await expect(response.text()).rejects.toThrow('Evidence storage unavailable');
  });
});
