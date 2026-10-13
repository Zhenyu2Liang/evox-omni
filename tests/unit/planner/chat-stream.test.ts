import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendChatTurn } from '@/components/chat/actions';
import type { AgentStreamEvent } from '@/lib/contracts/agent';

afterEach(() => vi.unstubAllGlobals());

describe('incremental chat transport', () => {
  it('publishes an SSE tool event before the response body ends', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }));
    vi.stubGlobal('fetch', fetchMock);
    const events: AgentStreamEvent[] = [];
    let completed = false;
    const response = sendChatTurn({ message: 'Read balance' }, undefined, event => events.push(event))
      .then(result => { completed = true; return result; });
    const encoder = new TextEncoder();
    const started: AgentStreamEvent = { type: 'tool_start', toolEvent: {
      toolCallId: 'call-1', toolName: 'get_balance', status: 'started',
    } };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(started)}\r`));
    controller.enqueue(encoder.encode('\n\r\n'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(events).toEqual([started]);
    expect(completed).toBe(false);
    const sent = JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as { requestId?: string };
    expect(sent.requestId).toMatch(/^[a-f\d-]{36}$/i);
    controller.enqueue(encoder.encode('data: {"type":"done"}\n\n'));
    controller.close();
    const result = await response;
    expect(result.events).toEqual([started, { type: 'done' }]);
    expect(events).toEqual(result.events);
  });

  it('preserves a supplied request identity so transport retries can reuse the same run', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: {
      sessionId: 'session', runId: 'run', events: [{ type: 'done' }],
    } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendChatTurn({ message: 'Read balance', requestId: 'request-fixed' });
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).requestId).toBe('request-fixed');
    expect(result.runId).toBe('run');
  });
});
