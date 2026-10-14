import { describe, expect, it } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-completions';
import { withLiveRequestLimits } from '@/agent/providers/request-options';

const model = deepseekProvider().getModels().find(candidate => candidate.id === 'deepseek-flash')!;
// This test bridge is only invoked with the concrete OpenAI-compatible model above.
const testStream = streamSimple as StreamFn;
const context = normalizeContext({ messages: [{ role: 'user', content: 'Explain the next step.', timestamp: 1 }] });
const encoder = new TextEncoder();

function chunk(text: string, finishReason: string | null = null, outputTokens?: number): string {
  return `data: ${JSON.stringify({
    id: 'offline-completion', object: 'chat.completion.chunk', model: model.id,
    choices: [{ index: 0, delta: { content: text }, finish_reason: finishReason }],
    ...(outputTokens === undefined ? {} : { usage: { prompt_tokens: 5, completion_tokens: outputTokens, total_tokens: 5 + outputTokens } }),
  })}\n\n`;
}

async function receive(body: ReadableStream<Uint8Array> | string, signal?: AbortSignal, timeoutMs = '30000') {
  const fetch: typeof globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const source = await withLiveRequestLimits(testStream, { LLM_REQUEST_TIMEOUT_MS: timeoutMs })(model, context, {
    fetch, apiKey: 'offline-test-key', signal,
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of source) events.push(event);
  return { result: await source.result(), events };
}

describe('real Pi OpenAI-compatible stream completion through live request bounds', () => {
  it('retains text sent in the finish chunk and in later chunks before DONE', async () => {
    const { result, events } = await receive(chunk('First ') + chunk('second ', 'stop') + chunk('last.', null, 26) + 'data: [DONE]\n\n');
    expect(result.stopReason).toBe('stop');
    expect(result.rawStopReason).toBe('stop');
    expect(result.content).toEqual([{ type: 'text', text: 'First second last.' }]);
    expect(result.usage.output).toBe(26);
    expect(events.filter(event => event.type === 'text_delta').map(event => event.delta)).toEqual(['First ', 'second ', 'last.']);
    expect(events.at(-1)?.type).toBe('done');
  });

  it.each(['\n', '\r\n', '\r'])('preserves split Unicode payloads through the real SDK with %j delimiters', async newline => {
    const wire = (chunk('\u4e2d\u6587', 'stop') + 'data: [DONE]\n\n').replaceAll('\n', newline);
    const bytes = encoder.encode(wire);
    let position = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (position < bytes.length) controller.enqueue(bytes.slice(position, ++position));
      else controller.close();
    } });
    const { result } = await receive(body);
    expect(result.stopReason).toBe('stop');
    expect(result.content).toEqual([{ type: 'text', text: '\u4e2d\u6587' }]);
  });

  it('reports an EOF without finish_reason as an error while preserving partial text', async () => {
    const { result, events } = await receive(chunk('The unfinished response'));
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('without the required [DONE] terminator');
    expect(result.content).toEqual([{ type: 'text', text: 'The unfinished response' }]);
    expect(events.at(-1)?.type).toBe('error');
  });

  it('rejects EOF after explicit stop when the completion terminator never arrived', async () => {
    const { result } = await receive(chunk('I understand your concern.\n\nFo', 'stop', 26));
    expect(result.stopReason).toBe('error');
    expect(result.rawStopReason).toBe('stop');
    expect(result.errorMessage).toContain('without the required [DONE] terminator');
    expect(result.content).toEqual([{ type: 'text', text: 'I understand your concern.\n\nFo' }]);
  });

  it('does not guess whether a provider-declared complete response is linguistically finished', async () => {
    const { result } = await receive(chunk('I understand your concern.\n\nFo', 'stop', 26) + 'data: [DONE]\n\n');
    expect(result.stopReason).toBe('stop');
    expect(result.rawStopReason).toBe('stop');
    expect(result.content).toEqual([{ type: 'text', text: 'I understand your concern.\n\nFo' }]);
    expect(result.usage.output).toBe(26);
  });

  it('flushes a final SSE event without its trailing blank line', async () => {
    const { result } = await receive(chunk('All text retained.', 'stop') + 'data: [DONE]');
    expect(result.stopReason).toBe('stop');
    expect(result.content).toEqual([{ type: 'text', text: 'All text retained.' }]);
  });

  it('does not mistake a transport failure after stop for a successful response', async () => {
    let sent = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (!sent) { sent = true; controller.enqueue(encoder.encode(chunk('Partial ', 'stop'))); }
      else controller.error(new Error('Connection body failed.'));
    } });
    const { result } = await receive(body);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('Connection body failed.');
    expect(result.rawStopReason).toBe('stop');
  });

  it('converts an idle body deadline after stop into a recoverable error', async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(encoder.encode(chunk('Partial ', 'stop')));
    } });
    const { result } = await receive(body, undefined, '1000');
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toBe('Request timed out.');
    expect(result.rawStopReason).toBe('stop');
    expect(result.content).toEqual([{ type: 'text', text: 'Partial ' }]);
  });

  it('keeps explicit cancellation after stop aborted', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start(streamController) {
      streamController.enqueue(encoder.encode(chunk('Partial ', 'stop')));
    } });
    const fetch: typeof globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    const source = await withLiveRequestLimits(testStream, {})(model, context, {
      fetch, apiKey: 'offline-test-key', signal: controller.signal,
    });
    for await (const event of source) {
      if (event.type === 'text_delta') controller.abort();
    }
    expect((await source.result()).stopReason).toBe('aborted');
    expect((await source.result()).errorMessage).not.toBe('Request timed out.');
  });
});
