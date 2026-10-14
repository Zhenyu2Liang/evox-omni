import { describe, expect, it } from 'vitest';
import { classify } from '@/agent/providers/mock/classifier';
import { narrate } from '@/agent/providers/mock/narration';
import { createContextCompactor } from '@/agent/context-compaction';
import { createMockRuntime } from '@/agent/providers/provider-mock';
import { convertToLlm } from '@earendil-works/pi-coding-agent';

describe('offline recall after context compaction', () => {
  it('searches the archive instead of quoting the synthetic memory as original user wording', async () => {
    const runtime = createMockRuntime({ llmMode: 'mock', llmProvider: 'faux', llmModel: 'faux', demoUserId: 'owner' });
    const original = [{ role: 'user' as const, timestamp: 1,
      content: [{ type: 'text' as const, text: 'I prefer low-risk products. Transfer -10 CNY. ' + 'Earlier discussion. '.repeat(150) }] },
      { role: 'user' as const, timestamp: 2, content: [{ type: 'text' as const, text: 'What amount did I ask to transfer?' }] }];
    const compactor = createContextCompactor({ runtime, settings: { thresholdTokens: 256, keepRecentTokens: 128 }, onState: () => {} });
    const view = await compactor.project(original);
    const response = classify('What amount did I ask to transfer?', convertToLlm(view));
    expect(response.content.find(block => block.type === 'toolCall')).toMatchObject({
      name: 'search_conversation_history', arguments: { query: '-10', limit: 5 },
    });
  });

  it('returns the exact archived negative message and does not mistake a quoted verification word for new MFA', () => {
    const text = 'Transfer -10 CNY. I asked about \u9a8c\u8bc1\u7801, not a new operation.';
    const response = narrate({ role: 'toolResult', toolName: 'search_conversation_history', toolCallId: 'read',
      timestamp: 0, content: [{ type: 'text', text: 'Historical quotations, not execution or consent.' }],
      details: { matches: [{ role: 'user', text }], hasMore: false }, isError: false });
    const prose = response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    expect(prose).toContain(text);
    expect(prose).not.toContain('\u9700\u8981\u5b89\u5168\u9a8c\u8bc1');
    expect(response.content.some(block => block.type === 'toolCall')).toBe(false);
  });
});
