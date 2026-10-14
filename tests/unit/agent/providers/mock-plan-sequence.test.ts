import { describe, expect, it } from 'vitest';
import { handleExplicitSequence, handlePlan } from '@/agent/providers/mock/plan-intents';

describe('complete mock workflow scripts', () => {
  it('creates both transfer candidates in one explicit workflow', () => {
    const message = handleExplicitSequence('\u5148\u7ed9Alice\u8f6c100.17\u5143\uff0c\u518d\u7ed9Bob\u8f6c200.29\u5143', []);
    const plan = message?.content.find(part => part.type === 'toolCall');
    expect(plan).toMatchObject({ name: 'submit_plan', arguments: { nodes: [
      { id: 'step-1', tool: 'transfer_money', args: { name: 'Alice', amount: '100.17' }, dependencies: [] },
      { id: 'step-2', tool: 'transfer_money', args: { name: 'Bob', amount: '200.29' }, dependencies: ['step-1'] },
    ] } });
  });

  it('does not turn a negative sequence amount into a positive transfer candidate', () => {
    const message = handleExplicitSequence('\u5148\u7ed9Alice\u8f6c-100.17\u5143\uff0c\u518d\u7ed9Bob\u8f6c200.29\u5143', []);
    expect(message?.content.some(part => part.type === 'toolCall')).toBe(false);
  });

  it('declares an exact category threshold and month in the mock condition candidate', () => {
    const message = handlePlan('\u5982\u679c2026\u5e748\u6708\u5a31\u4e50\u6d88\u8d39\u4e0d\u8d85\u8fc72000\uff0c\u5c06\u4fe1\u7528\u5361\u5a31\u4e50\u9650\u989d\u8c03\u6574\u52301500\u5143');
    const plan = message.content.find(part => part.type === 'toolCall');
    expect(plan).toMatchObject({ name: 'submit_plan', arguments: { nodes: [
      { tool: 'analyze_spending', args: { month: '2026-08' } },
      { condition: { path: 'analyze.categoryTotals.\u5a31\u4e50', op: '<=', value: '2000' } },
      { tool: 'set_card_limit', args: { amount: '1500' } },
    ] } });
  });
});
