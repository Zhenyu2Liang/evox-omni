import { describe, expect, it } from 'vitest';
import { inferConversationGuidance } from './conversation-guidance';
import { renderConversationGuidance } from '../../guidance-messages';
import { parseBankingGuidance } from '../../banking-guidance';
import messages from '../../messages/conversation.zh-CN.json';
import fixtures from '@/tests/fixtures/conversation.zh-CN.json';
import { classify } from './classifier';
import { classifyCardAction } from './card-intents';
import { renderInvalidAmountResponse } from './invalid-amount-response';
import { contentToText } from './conversation';

describe('offline dialogue script and closed presentation vocabulary', () => {
  it.each([[fixtures.greeting, 'greeting'], ['hello', 'greeting'], ['Thank you!', 'acknowledgement'],
    [fixtures.confirmation, 'confirmation_in_chat'], [fixtures.negativeCorrection, 'invalid_amount'],
    [fixtures.cardIncrease, 'card_operation_ambiguous']] as const)
  ('selects a deterministic mock dialogue code for %s', (request, code) => {
    expect(inferConversationGuidance(request)).toBe(code);
    expect(renderConversationGuidance(code)).toBe(messages[code]);
    const response = classify(request, []);
    expect(response.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(contentToText(response.content)).toBe(code === 'invalid_amount'
      ? renderInvalidAmountResponse(request) : renderConversationGuidance(code));
  });

  it('validates the closed protocol without accepting model-authored facts or success templates', () => {
    expect(parseBankingGuidance('{"guidance":{"code":"greeting"}}')).toEqual({ code: 'greeting' });
    expect(parseBankingGuidance('{"guidance":{"code":"greeting","balance":"999999.00"}}')).toBeUndefined();
    expect(parseBankingGuidance('{"guidance":{"code":"transfer_succeeded"}}')).toBeUndefined();
  });

  it.each(['Create a virtual card', 'Add a new credit card', 'Issue a debit card', 'Remove my bank card',
    'Delete my card', 'Apply for a virtual card', 'Close the credit card',
    '\u7533\u8bf7\u4e00\u5f20\u865a\u62df\u5361', '\u6dfb\u52a0\u94f6\u884c\u5361'])
  ('uses page-only card-management guidance in the offline script: %s', request => {
    expect(inferConversationGuidance(request)).toBe('card_management_required');
    const response = classify(request, []);
    expect(response.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(contentToText(response.content)).toBe(renderConversationGuidance('card_management_required'));
    const cardResponse = classifyCardAction(request);
    expect(cardResponse?.content.some(block => block.type === 'toolCall')).toBe(false);
    expect(parseBankingGuidance(contentToText(cardResponse?.content ?? []))).toEqual({ code: 'card_management_required' });
  });

  it.each(['Add 200 to my card', 'Freeze all my cards', 'Set the card category limit to 200', fixtures.cardIncrease])
  ('distinguishes existing-card servicing from manual card issuance in mock scripts: %s', request => {
    expect(inferConversationGuidance(request)).not.toBe('card_management_required');
  });

  it('routes partial-redemption wording to the supported redeem flow instead of the retired unsupported-guidance envelope', () => {
    const response = classify('\u90e8\u5206\u8d4e\u56de100\u5143', []);
    const call = response.content.find(part => part.type === 'toolCall');
    expect(call).toMatchObject({ name: 'redeem_investment', arguments: { holdingId: 'holding_wenjiana', redeemAmount: '100' } });
    expect(parseBankingGuidance(contentToText(response.content))).toBeUndefined();
  });
});
