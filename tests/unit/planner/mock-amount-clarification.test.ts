import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { classifyActionFollowUp } from '@/agent/providers/mock/action-follow-up';

describe('offline structured amount clarification', () => {
  it('continues the immediately preceding product request using original guidance JSON', () => {
    const response = classifyActionFollowUp('1000.66\u5143', [
      { role: 'user', content: '\u7533\u8d2d\u7a33\u5065\u7406\u8d22A', timestamp: 0 },
      fauxAssistantMessage('{"guidance":{"code":"missing_details","fields":["amount"]}}'),
      { role: 'user', content: '1000.66\u5143', timestamp: 1 },
    ]);
    expect(response?.content.find(block => block.type === 'toolCall')).toMatchObject({
      name: 'subscribe_investment', arguments: { productId: 'prod_wenjiana', amount: '1000.66' },
    });
  });

  it('does not treat a different field clarification as approval to supply an amount', () => {
    expect(classifyActionFollowUp('1000.66\u5143', [
      { role: 'user', content: '\u7533\u8d2d\u7a33\u5065\u7406\u8d22A', timestamp: 0 },
      fauxAssistantMessage('{"guidance":{"code":"missing_details","fields":["product"]}}'),
      { role: 'user', content: '1000.66\u5143', timestamp: 1 },
    ])).toBeUndefined();
  });

  it('does not revive an older product request after unrelated dialogue', () => {
    expect(classifyActionFollowUp('1000.66\u5143', [
      { role: 'user', content: '\u7533\u8d2d\u7a33\u5065\u7406\u8d22A', timestamp: 0 },
      fauxAssistantMessage('{"guidance":{"code":"missing_details","fields":["amount"]}}'),
      { role: 'user', content: 'Tell me a joke.', timestamp: 1 }, fauxAssistantMessage('A natural joke.'),
      { role: 'user', content: '1000.66\u5143', timestamp: 2 },
    ])).toBeUndefined();
  });
});
