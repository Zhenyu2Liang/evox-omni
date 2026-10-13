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

  it('reports an incomplete stream while retaining the durable run identity and delivered events', async () => {
    const started: AgentStreamEvent = { type: 'session', sessionId: 'session-new', runId: 'run-new' };
    const body = `data: ${JSON.stringify(started)}\n\ndata: {"type":"text_delta","delta":"Partial reply"}\n\n`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const delivered: AgentStreamEvent[] = [];
    const result = await sendChatTurn({ message: 'Read balance' }, undefined, event => delivered.push(event));
    expect(result.sessionId).toBe('session-new');
    expect(result.runId).toBe('run-new');
    expect(result.events.slice(0, 2)).toEqual([started, { type: 'text_delta', delta: 'Partial reply' }]);
    expect(result.events.at(-1)).toMatchObject({ type: 'error' });
    expect(delivered).toEqual(result.events);
  });

  it('retains received events when the stream reader fails after the session frame', async () => {
    let reads = 0;
    const started: AgentStreamEvent = { type: 'session', sessionId: 'session-new', runId: 'run-new' };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(started)}\n\n`));
        else controller.error(new Error('Transport disconnected'));
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const delivered: AgentStreamEvent[] = [];
    const result = await sendChatTurn({ message: 'Read balance' }, undefined, event => delivered.push(event));
    expect(result.sessionId).toBe('session-new');
    expect(result.runId).toBe('run-new');
    expect(result.events[0]).toEqual(started);
    expect(result.events.at(-1)).toMatchObject({ type: 'error' });
    expect(delivered).toEqual(result.events);
  });

  it('accepts a final completion event without a terminating blank line', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"done"}', {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    expect((await sendChatTurn({ message: 'Read balance' })).events).toEqual([{ type: 'done' }]);
  });

  it.each([{}, null, { sessionId: 'session' }, { sessionId: 'session', events: {} }])(
    'rejects an incomplete JSON chat response %j', async (data) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data })));
      expect((await sendChatTurn({ message: 'Read balance' })).events).toMatchObject([{ type: 'error' }]);
    },
  );
});
