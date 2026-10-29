import { describe, expect, it } from 'vitest';
import { hasExplicitTimeChoice, guardScheduledTimeChoice } from '@/agent/scheduled-input';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';

describe('customer execution-time prerequisite', () => {
  it.each(['到10月30日给妈妈转账300元', '提交', '确认', '10月30日，不要默认9点', '99点', '2026-10-30'])('requires a time choice for %s', text => {
    expect(hasExplicitTimeChoice(text)).toBe(false);
    const proposed = declareConversationIntent(advanceConversationIntent(undefined, text), 'operation', ['create_scheduled_task'], { needsInput: false });
    expect(guardScheduledTimeChoice(proposed)).toMatchObject({ needsInput: true, requiredInput: 'scheduled_time' });
  });
  it.each(['上午10点', '下午三点半', '23时30分', '2026-10-30T09:00', '晚上九点一刻', '9 AM', 'at 9 tomorrow', '10分钟后', 'in 2 hours'])('recognizes an explicit choice without deriving a command from %s', text => {
    expect(hasExplicitTimeChoice(text)).toBe(true);
    const proposed = declareConversationIntent(advanceConversationIntent(undefined, text), 'operation', ['create_scheduled_task'], { needsInput: false });
    expect(guardScheduledTimeChoice(proposed)).toBe(proposed);
  });
  it('does not turn ordinary discussion or unrelated banking operations into a scheduling question', () => {
    const discussion = declareConversationIntent(advanceConversationIntent(undefined, '定时转账怎么用'), 'conversation', []);
    expect(guardScheduledTimeChoice(discussion)).toBe(discussion);
    const transfer = declareConversationIntent(advanceConversationIntent(undefined, '转给妈妈300元'), 'operation', ['transfer_money'], { needsInput: false });
    expect(guardScheduledTimeChoice(transfer)).toBe(transfer);
  });
});
