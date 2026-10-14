import { describe, expect, it } from 'vitest';
import { isAdvisoryRequest } from '@/agent/providers/mock/advisory-policy';
import { isConversationalRequest } from '@/agent/providers/mock/conversation-policy';
import fixtures from '@/tests/fixtures/advisory-policy.zh-CN.json';

describe('financial advice purpose', () => {
  it.each([...fixtures.advice, 'Which subscriptions should I cancel?', 'Recommend an investment product for me.'])('keeps recommendations read-only: %s', request => {
    expect(isAdvisoryRequest(request)).toBe(true);
    expect(isConversationalRequest(request)).toBe(true);
  });
  it.each([...fixtures.execution, 'Recommend an investment and then buy it.', 'Assess subscriptions, and cancel Netflix.'])('preserves explicit execution instructions: %s', request => {
    expect(isAdvisoryRequest(request)).toBe(false);
    expect(isConversationalRequest(request)).toBe(false);
  });
});
