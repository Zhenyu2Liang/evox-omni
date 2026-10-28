import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, Response } from 'playwright-core';

const mocks = vi.hoisted(() => ({
  readDemoSessionId: vi.fn(async () => 'demo:test'),
  submitChat: vi.fn(async () => undefined),
  withDb: vi.fn<(read: (db: unknown) => Promise<unknown>) => Promise<unknown>>(),
}));
vi.mock('../../e2e/helpers', async load => ({
  ...await load<typeof import('../../e2e/helpers')>(),
  readDemoSessionId: mocks.readDemoSessionId,
  submitChat: mocks.submitChat,
}));
vi.mock('../../e2e/live-virtual-card.e2e-helper', () => ({ withDb: mocks.withDb }));
import { submitCompletedLiveChatTurn } from '../../e2e/chat-turn.e2e-helper';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

const message = { id: 'current-result', role: 'assistant', content: 'Current balance', timestamp: 1 };
let activeRunId: string | null;
let status: string;
let renderedIds: string[];
let body: ReturnType<typeof deferred<Error | null>>;
let response: Response;
let page: Page;
let runLookup: ReturnType<typeof vi.fn>;
let eventLookup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  activeRunId = null;
  status = 'completed';
  // Historical content is present from the start, as in a shared demo conversation.
  renderedIds = ['old-result', 'current-result'];
  body = deferred<Error | null>();
  runLookup = vi.fn(async () => ({ id: 'current-run', status, errorCode: null }));
  eventLookup = vi.fn(async (query: { where: { channel: string; eventType: string } }) =>
    query.where.channel === 'ui' && query.where.eventType === 'message_end'
      ? [{ payloadJson: JSON.stringify({ type: 'message_end', message }) }] : []);
  const db = {
    agentSession: { findUnique: async () => ({ activeRunId }) },
    agentRun: { findUnique: runLookup },
    agentRunEvent: { findMany: eventLookup },
  };
  mocks.withDb.mockImplementation(async read => read(db));
  mocks.submitChat.mockImplementation(async () => { activeRunId = 'current-run'; });
  response = {
    ok: () => true, status: () => 200,
    request: () => ({ postDataJSON: () => ({ requestId: 'current-request', message: 'Check balance' }) }),
    finished: () => body.promise,
  } as unknown as Response;
  page = {
    waitForResponse: vi.fn(async () => response),
    locator: (selector: string) => selector.includes('composer') ? { isEnabled: async () => true } : {
      evaluateAll: async (read: (elements: { getAttribute: () => string }[], ids: string[]) => boolean, ids: string[]) =>
        read(renderedIds.map(id => ({ getAttribute: () => id })), ids),
    },
  } as unknown as Page;
});

describe('live browser turn completion', () => {
  it('ignores historical results and waits for the current HTTP body and server lease release', async () => {
    let settled = false;
    const result = submitCompletedLiveChatTurn(page, 'Check balance').then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(mocks.submitChat).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(runLookup).not.toHaveBeenCalled();
    body.resolve(null);
    await vi.waitFor(() => expect(runLookup).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    activeRunId = null;
    await expect(result).resolves.toMatchObject({ requestId: 'current-request', runId: 'current-run', messages: [message] });
    expect(runLookup).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId_requestId: { sessionId: 'demo:test', requestId: 'current-request' } },
    }));
    expect(eventLookup).toHaveBeenCalledWith(expect.objectContaining({
      where: { runId: 'current-run', channel: 'ui', eventType: 'message_end' },
    }));
  });

  it('does not accept a historical DOM message in place of the current persisted message', async () => {
    renderedIds = ['old-result'];
    const result = submitCompletedLiveChatTurn(page, 'Check balance');
    let settled = false;
    void result.then(() => { settled = true; });
    await vi.waitFor(() => expect(mocks.submitChat).toHaveBeenCalledOnce());
    activeRunId = null;
    body.resolve(null);
    await vi.waitFor(() => expect(eventLookup).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    renderedIds.push('current-result');
    await expect(result).resolves.toMatchObject({ messages: [message] });
  });

  it('fails HTTP 409 without silently retrying the POST or reusing an old reply', async () => {
    response.ok = () => false;
    response.status = () => 409;
    await expect(submitCompletedLiveChatTurn(page, 'Check balance')).rejects.toThrow('HTTP 409');
    expect(mocks.submitChat).toHaveBeenCalledOnce();
    expect(runLookup).not.toHaveBeenCalled();
  });

  it('rejects an interrupted response even when the old page still shows a result', async () => {
    body.resolve(new Error('connection closed'));
    await expect(submitCompletedLiveChatTurn(page, 'Check balance')).rejects.toThrow('response was interrupted');
    expect(eventLookup).not.toHaveBeenCalled();
  });

  it('does not report a failed persisted run as a completed turn', async () => {
    status = 'failed';
    body.resolve(null);
    await expect(submitCompletedLiveChatTurn(page, 'Check balance')).rejects.toThrow('did not complete: failed');
    expect(eventLookup).not.toHaveBeenCalled();
  });
});
