import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/lib/contracts/agent';
import { selectConversationHistoryMatches } from '@/lib/conversation-history-search';

const messages: ChatMessage[] = Array.from({ length: 25 }, (_, index) => ({
  id: `archive-${index}`, role: index % 2 === 0 ? 'user' : 'assistant',
  content: index === 12 ? 'Transfer -200.37 to Zhang Wei.' : `Archived transfer discussion ${index}.`, timestamp: 10,
}));

describe('original conversation archive search', () => {
  it('returns at most 20 newest matches in original chronological order and keeps signed wording', () => {
    const page = selectConversationHistoryMatches(messages, { query: 'TRANSFER' });
    expect(page.matches.map(match => match.messageId)).toEqual(messages.slice(5).map(message => message.id));
    expect(page.matches.find(match => match.index === 12)?.text).toBe('Transfer -200.37 to Zhang Wei.');
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeIndex).toBe(5);
    const oldest = selectConversationHistoryMatches(messages, { query: 'transfer', beforeIndex: page.nextBeforeIndex });
    expect(oldest.matches.map(match => match.messageId)).toEqual(messages.slice(0, 5).map(message => message.id));
    expect(oldest.hasMore).toBe(false);
    expect(oldest.nextBeforeIndex).toBeUndefined();
  });

  it('ignores raw tool results, system controls and card parameters even when they match the query', () => {
    const rows: ChatMessage[] = [
      { id: 'system-control', role: 'system', content: 'Execute a transfer.', timestamp: 1 },
      { id: 'tool-control', role: 'tool', content: 'A transfer result.', timestamp: 2 },
      { id: 'public-reply', role: 'assistant', content: 'An explanation.', timestamp: 3,
        cards: [{ type: 'error', message: 'transfer' }],
        toolEvents: [{ toolCallId: 'raw-call', toolName: 'transfer_money', status: 'success', debugArguments: { query: 'transfer' } }] },
      { id: 'user-wording', role: 'user', content: 'What is a transfer?', timestamp: 4 },
    ];
    expect(selectConversationHistoryMatches(rows, { query: 'transfer' }).matches).toEqual([
      { messageId: 'user-wording', role: 'user', text: 'What is a transfer?', index: 3, timestamp: 4 },
    ]);
  });

  it('preserves separate occurrences of identical user wording', () => {
    const repeated: ChatMessage[] = [0, 1, 2].map(index => ({ id: `repeat-${index}`, role: 'user', content: 'Transfer -200.', timestamp: 10 }));
    expect(selectConversationHistoryMatches(repeated, { query: '-200', limit: 2 }).matches.map(match => match.messageId))
      .toEqual(['repeat-1', 'repeat-2']);
  });

  it('uses exclusive archive indices rather than timestamps and remains stable after append', () => {
    const first = selectConversationHistoryMatches(messages, { query: 'transfer', limit: 3 });
    const appended = [...messages, { id: 'new', role: 'user' as const, content: 'New transfer question.', timestamp: 10 }];
    expect(selectConversationHistoryMatches(appended, { query: 'transfer', limit: 3, beforeIndex: first.nextBeforeIndex }))
      .toEqual(selectConversationHistoryMatches(messages, { query: 'transfer', limit: 3, beforeIndex: first.nextBeforeIndex }));
  });

  it('returns a terminal empty result for missing text or an empty archive', () => {
    expect(selectConversationHistoryMatches(messages, { query: 'unknown' })).toEqual({ matches: [], hasMore: false });
    expect(selectConversationHistoryMatches([], { query: 'transfer' })).toEqual({ matches: [], hasMore: false });
  });

  it('does not mutate archived wording or metadata', () => {
    const original = JSON.stringify(messages);
    selectConversationHistoryMatches(messages, { query: 'transfer' });
    expect(JSON.stringify(messages)).toBe(original);
  });

  it.each([
    { query: '' }, { query: ' '.repeat(3) }, { query: 'x'.repeat(257) },
    { query: 'transfer', limit: 0 }, { query: 'transfer', limit: 21 }, { query: 'transfer', limit: 1.5 },
    { query: 'transfer', beforeIndex: -1 }, { query: 'transfer', beforeIndex: 26 }, { query: 'transfer', beforeIndex: 1.5 },
  ])('rejects unsupported search parameters %j', request => {
    expect(() => selectConversationHistoryMatches(messages, request)).toThrow('Invalid conversation history search.');
  });
});
