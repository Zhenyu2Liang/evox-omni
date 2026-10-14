import { describe, expect, it } from 'vitest';
import { renderConversationalResponse } from './conversational-response';
import messages from './messages/dialogue.zh-CN.json';

describe('prose presentation remains independent from execution evidence', () => {
  it.each([
    'We can talk about everyday topics. What would you like to discuss?',
    '**Scheduled tasks** are supported, but creation requires confirmation.',
    'Your monthly spending is $315.30. Fitness costs $188.50, so review its usage before cancelling it.',
    'Your current balance is $999999.00. **Recommendation:** review the highest-cost subscription first.',
    'For the earlier request, please provide the amount.',
    'I have transferred $200.37 to Bob, account ending 6688.',
    '**Reminders** (REMINDER): remind me at a chosen time.\n\nThe checking account (primary CHECKING) is the default.',
    'Explain sourceAccountId and the transfer_money schema.',
    'No subscription was cancelled.',
    'A complete reply ending in an ordinary word such as for',
  ])('preserves the full provider prose: %s', prose => {
    expect(renderConversationalResponse(prose)).toBe(prose);
  });

  it('preserves whitespace, Markdown, long paragraphs and exact financial strings', () => {
    const prose = '\n\n**Analysis:** 92233720368547758.07\n\n' + 'Complete model paragraph. '.repeat(500) + '\n';
    expect(renderConversationalResponse(prose)).toBe(prose);
  });

  it('uses the ordinary empty-reply prompt only when no prose exists', () => {
    expect(renderConversationalResponse('')).toBe(messages.emptyReply);
    expect(renderConversationalResponse(' \n\t')).toBe(messages.emptyReply);
  });
});
