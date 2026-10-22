import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type Message, type ToolResultMessage } from '@earendil-works/pi-ai';
import { respond } from '@/agent/providers/mock-responder';
import type { CardView } from '@/banking-sdk';

const trigger = '\u5982\u679c\u8fd9\u4e2a\u6708\u5a31\u4e50\u6d88\u8d39\u8d85\u8fc72000\u5143\uff0c\u5c31\u628a\u5a31\u4e50\u6d88\u8d39\u9650\u989d\u8c03\u6574\u4e3a1500\u5143';
const cards: CardView[] = [{ id: 'card_credit', type: 'CREDIT', network: 'VISA', numberMasked: '****6688', status: 'ACTIVE',
  creditLimit: '30000.00', availableLimit: '28500.00', monthlyLimit: '5000.00', linkedAccountStatus: 'NOT_APPLICABLE',
  usable: true, limits: [] }];
const user = (content: string): Message => ({ role: 'user', content, timestamp: 0 });

describe('mock explicit conditional workflow proposals', () => {
  it('queries the current card resources before proposing a card limit effect', () => {
    const proposal = respond({ messages: [user(trigger)] });
    expect(proposal.content.find(part => part.type === 'toolCall')).toMatchObject({ name: 'get_cards', arguments: {} });
  });

  it('uses the actual card lookup ID and explicit category/month/threshold in the resulting complete DAG', () => {
    const lookup = fauxAssistantMessage([fauxToolCall('get_cards', {}, { id: 'card-lookup' })], { stopReason: 'toolUse' });
    const result: ToolResultMessage = { role: 'toolResult', toolName: 'get_cards', toolCallId: 'card-lookup',
      content: [{ type: 'text', text: 'Current owned cards.' }], details: JSON.parse(JSON.stringify(cards)), isError: false, timestamp: 1 };
    const proposal = respond({ messages: [user(trigger), lookup, result] });
    const call = proposal.content.find(part => part.type === 'toolCall');
    expect(call).toMatchObject({ name: 'submit_plan', arguments: { goal: trigger, nodes: [
      { id: 'analyze', kind: 'tool', tool: 'analyze_spending', args: { month: '2026-09' }, dependencies: [] },
      { id: 'check', kind: 'condition', dependencies: ['analyze'], condition: { path: 'analyze.categoryTotals.\u5a31\u4e50', op: '>', value: '2000' } },
      { id: 'setlimit', kind: 'tool', tool: 'set_card_limit', dependencies: ['check'], args: { cardId: 'card_credit', category: '\u5a31\u4e50', amount: '1500' } },
    ] } });
  });

  it('keeps a read-only condition as a note without inventing a limit or bank effect', () => {
    const proposal = respond({ messages: [user('\u5982\u679c\u8fd9\u4e2a\u6708\u6d88\u8d39\u8d85\u8fc72000\u5143\u5c31\u63d0\u9192\u6211')] });
    const call = proposal.content.find(part => part.type === 'toolCall');
    expect(call).toMatchObject({ name: 'submit_plan', arguments: { nodes: [
      { kind: 'tool', tool: 'analyze_spending' }, { kind: 'condition' }, { kind: 'note' },
    ] } });
  });
});
