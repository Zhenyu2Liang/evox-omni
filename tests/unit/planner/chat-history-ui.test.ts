import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { ChatHistoryPage } from '@/lib/contracts/chat-history';
import { ChatWindow } from '@/components/chat/ChatWindow';
import { acceptsHistoryPage, captureHistoryAnchor, isChatHistoryPage, mergeHistoryPage, prependHistoryMessages, restoreHistoryAnchor } from '@/components/chat/history';
import { requestLatestHistory, requestOlderHistory } from '@/components/chat/history-request';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { createTranslator } from '@/lib/i18n/shared';

const message = (id: string, content = id): ChatMessage => ({ id, content, role: 'assistant', timestamp: 1 });
const page = (messages: ChatMessage[], overrides: Partial<ChatHistoryPage> = {}): ChatHistoryPage => ({
  messages, hasMore: false, revision: 2, historyGeneration: 'generation-one', ...overrides,
});

afterEach(() => vi.unstubAllGlobals());

describe('presentation history paging', () => {
  it('prepends archive rows in order without duplicating or overwriting newer streamed content', () => {
    const current = [message('existing', 'Updated result'), message('latest', 'Latest complete reply')];
    const older = [message('oldest'), message('existing', 'Stale result'), message('oldest', 'Duplicate')];
    const result = prependHistoryMessages(current, older);
    expect(result.map(row => row.id)).toEqual(['oldest', 'existing', 'latest']);
    expect(result[1]).toBe(current[0]);
    expect(current.map(row => row.id)).toEqual(['existing', 'latest']);
  });

  it('keeps terminal card and tool states when an overlapping older page arrives during streaming', () => {
    const current: ChatMessage = { ...message('owner', ''), role: 'tool', cards: [{ type: 'mfa', actionId: 'action', status: 'executed' }],
      toolEvents: [{ messageId: 'owner', toolName: 'freeze_card', toolCallId: 'call', actionId: 'action', status: 'success' }] };
    const base = initialChatUIState({ messages: [current], busy: true, streamingText: 'Untruncated live output', mfaAttempts: 2,
      history: { hasMore: true, nextCursor: 'older', revision: 4, historyGeneration: 'generation-one' } });
    const merged = mergeHistoryPage(base, page([message('earlier'), { ...current,
      cards: [{ type: 'mfa', actionId: 'action' }], toolEvents: [{ ...current.toolEvents![0], status: 'started' }] }], { revision: 3 }));
    expect(merged.messages[1]).toBe(current);
    expect(merged.streamingText).toBe(base.streamingText);
    expect(merged.busy).toBe(true);
    expect(merged.mfaAttempts).toBe(2);
    expect(merged.history?.revision).toBe(4);
    const streamed = reduceAgentEvents(merged, [{ type: 'message_end', message: message('live', 'A complete new answer') }]);
    expect(streamed.messages.map(row => row.id)).toEqual(['earlier', 'owner', 'live']);
  });

  it('rejects a page from an earlier reset generation without changing loaded messages or cursor', () => {
    const base = initialChatUIState({ messages: [message('current')], history: {
      hasMore: true, nextCursor: 'cursor', revision: 8, historyGeneration: 'generation-two',
    } });
    expect(acceptsHistoryPage(base.history, page([message('stale')]))).toBe(false);
    expect(mergeHistoryPage(base, page([message('stale')]))).toBe(base);
  });

  it('renders the initial twenty complete messages with a history control, without trimming a reply', () => {
    const long = '**Complete response**\n\n' + 'Full model paragraph. '.repeat(500);
    const messages = Array.from({ length: 20 }, (_, index) => message(`message-${index}`, index === 19 ? long : `Message ${index}`));
    const markup = renderToStaticMarkup(createElement(ChatWindow, { initialHistory: page(messages, { hasMore: true, nextCursor: 'cursor' }) }));
    expect((markup.match(/data-message-id=/g) ?? []).length).toBe(20);
    expect(markup).toContain(createTranslator('zh-CN')('chat.history.loadEarlier'));
    expect((markup.match(/Full model paragraph/g) ?? []).length).toBe(500);
    expect(markup).not.toContain('data-history-complete');
    const complete = renderToStaticMarkup(createElement(ChatWindow, { initialHistory: page(messages) }));
    expect(complete).toContain('data-history-complete');
    expect(complete).not.toContain('data-load-history');
  });

  it('captures and restores a DOM message anchor independently of appended content height', () => {
    let scrollTop = 200;
    let rowTop = 140;
    const rows = [{ dataset: { messageId: 'above' }, getBoundingClientRect: () => ({ top: 40, bottom: 80 }) },
      { dataset: { messageId: 'anchor' }, getBoundingClientRect: () => ({ top: rowTop, bottom: rowTop + 80 }) }];
    const container = { getBoundingClientRect: () => ({ top: 100 }), querySelectorAll: () => rows,
      get scrollTop() { return scrollTop; }, set scrollTop(value: number) { scrollTop = value; } } as unknown as HTMLElement;
    const anchor = captureHistoryAnchor(container);
    expect(anchor).toEqual({ id: 'anchor', offset: 40 });
    rowTop = 500;
    restoreHistoryAnchor(container, anchor!);
    expect(scrollTop).toBe(560);
    rows.length = 0;
    restoreHistoryAnchor(container, anchor!);
    expect(scrollTop).toBe(560);
  });

  it.each([{}, page(Array.from({ length: 21 }, (_, i) => message(String(i)))), page([], { hasMore: true }), page([], { revision: -1 }), page([], { historyGeneration: '' })])('rejects malformed history shape %j', input => {
    expect(isChatHistoryPage(input)).toBe(false);
  });

  it('requests twenty messages with an opaque cursor, without selecting another owner', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data: page([message('old')]) })));
    vi.stubGlobal('fetch', fetcher);
    const abort = new AbortController();
    expect(await requestOlderHistory('/api/chat/history', 'opaque+/=', abort.signal)).toEqual({ kind: 'page', page: page([message('old')]) });
    expect(fetcher).toHaveBeenCalledWith('/api/chat/history?cursor=opaque%2B%2F%3D&limit=20', { cache: 'no-store', signal: abort.signal });
  });

  it('reconciles a disconnected request with a bounded read, without resubmitting the banking action', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ ok: true, data: page([message('saved', 'Complete saved result')]) }));
    vi.stubGlobal('fetch', fetcher);
    expect((await requestLatestHistory('/api/chat/history', new AbortController().signal)).kind).toBe('page');
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0][0]).toBe('/api/chat/history?limit=20');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: 'no-store' });
    expect(fetcher.mock.calls[0][1].method).toBeUndefined();
  });

  it.each([500, 409])('reports HTTP %s without manufacturing an empty replacement page', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Failure', { status })));
    expect(await requestOlderHistory('/api/chat/history', 'cursor', new AbortController().signal)).toEqual({ kind: status === 409 ? 'changed' : 'failed' });
  });

  it('keeps a failed network or malformed envelope retryable', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Network disconnected')).mockResolvedValueOnce(new Response('{"ok":true,"data":{}}'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, data: page([message('old')]) })));
    vi.stubGlobal('fetch', fetcher);
    const abort = new AbortController();
    expect(await requestOlderHistory('/api/chat/history', 'cursor', abort.signal)).toEqual({ kind: 'failed' });
    expect(await requestOlderHistory('/api/chat/history', 'cursor', abort.signal)).toEqual({ kind: 'failed' });
    expect((await requestOlderHistory('/api/chat/history', 'cursor', abort.signal)).kind).toBe('page');
  });
});
