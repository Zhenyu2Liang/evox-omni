import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendChatTurn } from '@/components/chat/actions';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { webcrypto } from 'node:crypto';

afterEach(() => vi.unstubAllGlobals());

describe('incremental chat transport', () => {
  it.each(['\n', '\r\n', '\r'])('preserves multibyte UTF-8 and cross-chunk SSE line endings %j', async newline => {
    const text = String.fromCodePoint(0x4f60, 0x597d, 0x20, 0x1f4b3) + ' complete response.\n\nAnother paragraph.';
    const message = { id: 'assistant-utf8', role: 'assistant' as const, content: '', timestamp: 1 };
    const expected: AgentStreamEvent[] = [{ type: 'message_start', message },
      { type: 'text_delta', delta: text }, { type: 'message_end', message: { ...message, content: text } }, { type: 'done' }];
    const bytes = new TextEncoder().encode(expected.map(event => `data: ${JSON.stringify(event)}${newline}${newline}`).join(''));
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (let index = 0; index < bytes.length; index++) controller.enqueue(bytes.slice(index, index + 1));
      controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const delivered: AgentStreamEvent[] = [];
    const result = await sendChatTurn({ message: 'Explain spending' }, undefined, event => delivered.push(event));
    expect(result.events).toEqual(expected);
    expect(delivered).toEqual(expected);
  });

  it('rejects corrupt UTF-8 inside an otherwise valid JSON event instead of displaying replacement characters', async () => {
    const prefix = new TextEncoder().encode('data: {"type":"session","sessionId":"session","runId":"run"}\n\n');
    const head = new TextEncoder().encode('data: {"type":"text_delta","delta":"');
    const tail = new TextEncoder().encode('"}\n\ndata: {"type":"done"}\n\n');
    const bytes = Uint8Array.from([...head, 0xff, ...tail]);
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(prefix); controller.enqueue(bytes); controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const result = await sendChatTurn({ message: 'Explain spending' });
    expect(result.events).toMatchObject([{ type: 'session', runId: 'run' }, { type: 'error' }]);
    expect(result.events.some(event => event.type === 'text_delta' || event.type === 'done')).toBe(false);
  });

  it('flushes the decoder at EOF and reports a pending incomplete UTF-8 sequence', async () => {
    const bytes = new TextEncoder().encode('data: {"type":"session","sessionId":"session","runId":"run"}\n\n');
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes); controller.enqueue(Uint8Array.from([0xe4, 0xbd])); controller.close();
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })));
    const result = await sendChatTurn({ message: 'Explain spending' });
    expect(result.runId).toBe('run');
    expect(result.events.at(-1)).toEqual({ type: 'error', message: 'The response stream was interrupted. Inspect the saved run before retrying.' });
  });

  it('reports an early done before message_end and does not consume later frames', async () => {
    const message = { id: 'assistant', role: 'assistant', content: '', timestamp: 1 };
    const events = [{ type: 'message_start', message }, { type: 'text_delta', delta: 'Partial' }, { type: 'done' },
      { type: 'message_end', message: { ...message, content: 'Late payload after done' } }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const result = await sendChatTurn({ message: 'Explain spending' });
    expect(result.events.map(event => event.type)).toEqual(['message_start', 'text_delta', 'error', 'done']);
    expect(result.events.at(-2)).toEqual({ type: 'error', message: 'The response stream ended before completion. Inspect the saved run before retrying.' });
    expect(result.events.some(event => event.type === 'message_end')).toBe(false);
  });

  it('reports a missing tool-row terminal snapshot instead of leaving silent permanent progress', async () => {
    const message = { id: 'tool-row', role: 'tool', content: '', timestamp: 1, cards: [],
      toolEvents: [{ messageId: 'tool-row', toolCallId: 'call', toolName: 'list_subscriptions', status: 'started' }] };
    const events = [{ type: 'message_start', message }, { type: 'tool_start', toolEvent: message.toolEvents[0] }, { type: 'done' }];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const result = await sendChatTurn({ message: 'Read subscriptions' });
    expect(result.events.map(event => event.type)).toEqual(['message_start', 'tool_start', 'error', 'done']);
    expect(result.events.at(-2)).toEqual({ type: 'error', message: 'The response stream ended before completion. Inspect the saved run before retrying.' });
  });

  it('ignores heartbeat frames and parses multiline data with a final complete message before done', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(': heartbeat\r\ndata: {"type":"message_end",\r\ndata: "message":{"id":"assistant","role":"assistant","content":"Complete prose","timestamp":1}}\r\n\r\ndata: {"type":"done"}', {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    expect((await sendChatTurn({ message: 'Explain spending' })).events).toEqual([
      { type: 'message_end', message: { id: 'assistant', role: 'assistant', content: 'Complete prose', timestamp: 1 } }, { type: 'done' },
    ]);
  });

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

  it('sends a chat request when randomUUID is unavailable on the browser crypto object', async () => {
    vi.stubGlobal('crypto', { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true, data: {
      sessionId: 'session', runId: 'run', events: [{ type: 'done' }],
    } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await sendChatTurn({ message: 'Read balance' });
    expect(result.runId).toBe('run');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string).requestId)
      .toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
  });

  it('reuses an explicit request ID for a retry without generating a new identity', async () => {
    vi.stubGlobal('crypto', undefined);
    const fetchMock = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json({ ok: true, data: {
        sessionId: 'session', runId: 'original-run', events: [{ type: 'done' }],
      } }));
    vi.stubGlobal('fetch', fetchMock);
    const request = { message: 'Read balance', requestId: 'request-fixed' };
    expect((await sendChatTurn(request)).events).toMatchObject([{ type: 'error' }]);
    expect((await sendChatTurn(request)).runId).toBe('original-run');
    expect(fetchMock.mock.calls.map(call => JSON.parse(call[1]?.body as string).requestId))
      .toEqual(['request-fixed', 'request-fixed']);
  });

  it('reports unsupported browser randomness without sending an unidentified request', async () => {
    vi.stubGlobal('crypto', undefined);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    expect((await sendChatTurn({ message: 'Read balance', sessionId: 'session-existing' })))
      .toEqual({ sessionId: 'session-existing', events: [{ type: 'error', message:
        'This browser cannot create a request ID. Use a current browser and try again.' }] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose runtime exception details in a user-facing failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Private transport configuration detail')));
    const result = await sendChatTurn({ message: 'Read balance' });
    expect(result.events).toMatchObject([{ type: 'error' }]);
    expect(JSON.stringify(result)).not.toContain('Private transport configuration detail');
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

  it('reports malformed SSE payloads without delivering objects to the message renderer', async () => {
    const frame = { type: 'message_end', message: { id: 'assistant', role: 'assistant', content: { analysis: 'Invalid protocol object' }, timestamp: 1 } };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(frame)}\n\ndata: {"type":"done"}\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })));
    const delivered: AgentStreamEvent[] = [];
    const result = await sendChatTurn({ message: 'Analyze spending' }, undefined, event => delivered.push(event));
    expect(result.events).toEqual([{ type: 'error', message: 'chat.error.invalidResponse' }, { type: 'done' }]);
    expect(delivered).toEqual(result.events);
  });

  it('rejects malformed JSON event lists as a whole before publishing any message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data: { sessionId: 'session', events: [
      { type: 'tool_end', toolEvent: { toolName: 'get_balance' } }, { type: 'done' },
    ] } })));
    const delivered: AgentStreamEvent[] = [];
    expect((await sendChatTurn({ message: 'Read balance' }, undefined, event => delivered.push(event))).events).toMatchObject([{ type: 'error' }]);
    expect(delivered).toEqual([]);
  });

  it.each([{}, null, { sessionId: 'session' }, { sessionId: 'session', events: {} }])(
    'rejects an incomplete JSON chat response %j', async (data) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, data })));
      expect((await sendChatTurn({ message: 'Read balance' })).events).toMatchObject([{ type: 'error' }]);
    },
  );
});
