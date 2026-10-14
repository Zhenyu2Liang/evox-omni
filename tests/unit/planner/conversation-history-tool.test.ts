import { describe, expect, it, vi } from 'vitest';
import { createSearchConversationHistoryTool, runSearchConversationHistory } from '@/agent/tools/conversation-history';
import { searchConversationHistory } from '@/agent/conversation-history-search';
import { catalogEntry } from '@/lib/contracts/tool-catalog';
import { toCards } from '@/agent/card-emitter';

vi.mock('@/agent/conversation-history-search', () => ({ searchConversationHistory: vi.fn() }));

describe('read-only exact conversation history capability', () => {
  it('binds owner and session in the tool closure rather than the model arguments', async () => {
    const page = { matches: [{ messageId: 'old', role: 'user', text: 'Transfer -10 CNY.', index: 0, timestamp: 1 }], hasMore: false };
    vi.mocked(searchConversationHistory).mockResolvedValueOnce(page as Awaited<ReturnType<typeof searchConversationHistory>>);
    const tool = createSearchConversationHistoryTool('owner', 'owned-session');
    expect(tool.parameters).toHaveProperty('additionalProperties', false);
    const result = await tool.execute('history-call', { query: '-10', limit: 2 });
    expect(searchConversationHistory).toHaveBeenLastCalledWith({ userId: 'owner', sessionId: 'owned-session',
      query: '-10', limit: 2, beforeIndex: undefined });
    expect(result.details).toEqual(page);
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('-10') });
    expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('do not prove bank execution') });
  });

  it('does not guess a conversation when trusted session injection is missing', async () => {
    expect(await runSearchConversationHistory('owner', { query: '-10', sessionId: 'foreign' }))
      .toMatchObject({ ok: false, errorCode: 'SECURITY_DENIED' });
  });

  it('is a green read without a bank receipt or a business result card', () => {
    expect(catalogEntry('search_conversation_history')).toMatchObject({ effect: 'read', defaultTier: 'GREEN',
      replay: { safety: 'read_only', requiresReceipt: false } });
    expect(toCards('search_conversation_history', { ok: true, data: { matches: [] } })).toEqual([]);
    expect(toCards('search_conversation_history', { ok: false, error: 'No historical match' })).toEqual([]);
  });
});
