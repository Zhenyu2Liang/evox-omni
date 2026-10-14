import { describe, expect, it, vi } from 'vitest';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { fauxAssistantMessage, fauxProvider, normalizeContext, createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { AgentRunJournal } from '@/agent/durable/journal';
import { withModelAudit } from '@/agent/providers/model-audit';

describe('provider evidence is recorded through awaited Pi request hooks', () => {
  it('records the effective request, whitelisted headers and raw reply events before forwarding observers', async () => {
    const record = vi.fn(async () => undefined);
    const journal = { recordModelProviderEvent: record } as unknown as AgentRunJournal;
    const response = { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-1',
      'set-cookie': 'private-cookie', authorization: 'private-token' } };
    const event = { choices: [{ delta: { content: 'The actual text', tool_calls: [{ function: { name: 'unsupported_secret_tool', arguments: 'partial private credential' } }] } }] };
    let observed: unknown;
    const stream: StreamFn = (model, _context, options) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        await options?.onPayload?.({ stream: true, max_tokens: 8192 }, model);
        await options?.onResponse?.(response, model);
        await options?.onProviderStreamEvent?.(event, model);
        output.push({ type: 'done', reason: 'stop', message: fauxAssistantMessage('The actual text') });
      })();
      return output;
    };
    const source = await withModelAudit(stream, journal)(fauxProvider().getModel(), normalizeContext({ messages: [] }), {
      onPayload: () => ({ stream: true, max_tokens: 16384 }),
      onProviderStreamEvent: data => { observed = data; expect(record).toHaveBeenCalledTimes(3); },
    });
    await source.result();
    expect(record.mock.calls).toEqual([
      ['provider_request_payload', { stream: true, max_tokens: 16384 }],
      ['provider_response_headers', { status: 200, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'request-1' } }],
      ['provider_response_event', expect.objectContaining({ choices: [expect.objectContaining({ delta: {
        content: 'The actual text', tool_calls: [{ function: { name: 'unsupported_secret_tool', arguments: '[REDACTED TOOL ARGUMENT FRAGMENT]', argumentBytes: 26 } }],
      } })] })],
    ]);
    expect(observed).toBe(event);
  });
});
