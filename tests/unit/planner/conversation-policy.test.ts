import { describe, expect, it } from 'vitest';
import { isConversationalRequest } from '@/agent/providers/mock/conversation-policy';
import { classify } from '@/agent/providers/mock/classifier';
import { respondWithGuidance } from '@/agent/providers/mock-responder';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import fixtures from '../../fixtures/conversation-policy.zh-CN.json';

describe('conversational requests and business intent', () => {
  it.each(fixtures.conversational)('keeps conversation outside business planning: %s', request => {
    expect(isConversationalRequest(request)).toBe(true);
  });

  it.each(fixtures.banking)('preserves an explicit banking request: %s', request => {
    expect(isConversationalRequest(request)).toBe(false);
  });

  it.each([fixtures.walletQuestion, fixtures.smallTalk, fixtures.scheduledQuestion])('answers conversational mock requests without a tool: %s', request => {
    const response = classify(request, []);
    expect(response.content.every(block => block.type === 'text')).toBe(true);
    expect(response.content.some(block => block.type === 'text' && block.text.length > 0)).toBe(true);
  });

  it.each([fixtures.walletQuestion, fixtures.smallTalk, fixtures.scheduledQuestion])('preserves conversation through the public guidance wrapper: %s', request => {
    const response = respondWithGuidance({ messages: [{ role: 'user', content: request, timestamp: 0 }] });
    const text = response.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('');
    expect(response.content.every(block => block.type === 'text')).toBe(true);
    expect(text).not.toContain('missing_details');
    expect(text).not.toContain('guidance');
  });

  it.each([fixtures.amount, fixtures.transferWithoutRecipient, fixtures.explicitRepeat])('does not revive a historical transfer after unrelated discussion: %s', request => {
    const messages: Message[] = [
      { role: 'user', content: fixtures.completeTransfer, timestamp: 0 },
      fauxAssistantMessage([fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200' }, { id: 'old_transfer' })]),
      { role: 'user', content: fixtures.smallTalk, timestamp: 1 },
      { role: 'user', content: request, timestamp: 2 },
    ];
    const response = respondWithGuidance({ messages });
    expect(response.content.every(block => block.type === 'text')).toBe(true);
  });
});
