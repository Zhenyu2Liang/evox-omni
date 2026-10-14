import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { ChatHistoryIdentity } from '@/lib/contracts/chat-history';
import { selectChatHistoryPage } from '@/lib/chat-history';

const identity: ChatHistoryIdentity = { userId: 'owner', sessionId: 'demo:owner', revision: 4, historyGeneration: 'history-a' };
const messages: ChatMessage[] = Array.from({ length: 45 }, (_, index) => ({
  id: `message-${index}`, role: index % 2 === 0 ? 'user' : 'assistant', content: `Message ${index}.`, timestamp: 10,
}));

describe('conversation history message pagination', () => {
  it('returns the latest 20 messages and older pages in chronological order without timestamp guesses', () => {
    const newest = selectChatHistoryPage(messages, identity);
    expect(newest.messages).toEqual(messages.slice(25));
    expect(newest.hasMore).toBe(true);
    const older = selectChatHistoryPage(messages, identity, { cursor: newest.nextCursor });
    expect(older.messages).toEqual(messages.slice(5, 25));
    const oldest = selectChatHistoryPage(messages, identity, { cursor: older.nextCursor });
    expect(oldest.messages).toEqual(messages.slice(0, 5));
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextCursor).toBeUndefined();
    expect([...oldest.messages, ...older.messages, ...newest.messages]).toEqual(messages);
  });

  it('keeps old cursors valid after newer turns append or an existing card changes state', () => {
    const newest = selectChatHistoryPage(messages, identity);
    const changed = messages.map(message => message.id === 'message-24'
      ? { ...message, content: 'The original operation has now completed.' } : message);
    changed.push({ id: 'new-message', role: 'user', content: 'New question.', timestamp: 10 });
    const older = selectChatHistoryPage(changed, { ...identity, revision: 9 }, { cursor: newest.nextCursor });
    expect(older.messages.map(message => message.id)).toEqual(messages.slice(5, 25).map(message => message.id));
    expect(older.messages.at(-1)?.content).toBe('The original operation has now completed.');
    expect(older.revision).toBe(9);
  });

  it('counts a complete assistant reply with cards and tool activity as one message', () => {
    const reply: ChatMessage = { id: 'complete-reply', role: 'assistant', content: '', timestamp: 10,
      cards: [{ type: 'balance', data: { accounts: [] } }],
      toolEvents: [{ toolCallId: 'query', toolName: 'get_balance', status: 'success' }] };
    const next = selectChatHistoryPage([...messages, reply], identity, { limit: 1 });
    expect(next.messages).toEqual([reply]);
    expect(next.messages[0]).toBe(reply);
  });

  it('does not mutate or truncate the stored conversation array', () => {
    const before = JSON.stringify(messages);
    const selected = selectChatHistoryPage(messages, identity);
    expect(JSON.stringify(messages)).toBe(before);
    expect(messages).toHaveLength(45);
    expect(selected.messages).not.toBe(messages);
  });

  it('returns an empty terminal page for an empty conversation', () => {
    expect(selectChatHistoryPage([], identity)).toEqual({ messages: [], hasMore: false,
      revision: identity.revision, historyGeneration: identity.historyGeneration });
  });

  it.each(['malformed', '', 'a===', '_', Buffer.from('{"version":2}').toString('base64url')])('rejects malformed cursor %s', cursor => {
    expect(() => selectChatHistoryPage(messages, identity, { cursor })).toThrow('Invalid conversation history cursor.');
  });

  it.each([{ userId: 'other-owner' }, { sessionId: 'another-session' }, { historyGeneration: 'history-b' }, { revision: 3 }])(
    'rejects a cursor from a different owner, session, generation or future revision: %j', changes => {
      const newest = selectChatHistoryPage(messages, identity);
      expect(() => selectChatHistoryPage(messages, { ...identity, ...changes }, { cursor: newest.nextCursor }))
        .toThrow('The conversation history changed.');
    });

  it('rejects a cursor whose stable anchor was removed or duplicated', () => {
    const cursor = selectChatHistoryPage(messages, identity).nextCursor;
    expect(() => selectChatHistoryPage(messages.filter(message => message.id !== 'message-25'), identity, { cursor }))
      .toThrow('The conversation history changed.');
    expect(() => selectChatHistoryPage([...messages, messages[25]], identity, { cursor })).toThrow('The conversation history changed.');
  });

  it.each([0, -1, 1.5, 21, Number.NaN])('rejects unsupported page size %s', limit => {
    expect(() => selectChatHistoryPage(messages, identity, { limit })).toThrow('page size');
  });
});
