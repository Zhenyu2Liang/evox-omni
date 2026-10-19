import { describe, expect, it } from 'vitest';
import { advanceConversationIntent, declareConversationIntent, intentRequestText, requiresDeclaredPlan } from '@/agent/intent-context';

describe('turn interpretation and original user context', () => {
  it('preserves each latest message verbatim without resolving references or appending old requests', () => {
    const first = advanceConversationIntent(undefined, 'Transfer -10 CNY to Alice.', { id: 'first' });
    const declared = declareConversationIntent(first, 'operation', ['transfer_money']);
    const text = 'Why did I say -10? Use the same amount as an example.';
    const second = advanceConversationIntent(declared, text, { id: 'second' });
    expect(second.id).toBe('second');
    expect(second.requestText).toBe(text);
    expect(second.latestMessage).toBe(text);
    expect(intentRequestText(second)).toBe(text);
    expect(second.purpose).toBe('undecided');
    expect(second.steps).toEqual([]);
    expect(first.requestText).toBe('Transfer -10 CNY to Alice.');
  });

  it('does not rewrite short clarifications into a fabricated banking instruction', () => {
    const previous = declareConversationIntent(advanceConversationIntent(undefined, 'Transfer to Alice.'), 'operation', ['transfer_money']);
    const next = advanceConversationIntent(previous, '200 CNY');
    expect(next.requestText).toBe('200 CNY');
    expect(next.steps).toEqual([]);
    expect(next.id).not.toBe(previous.id);
  });

  it('preserves declared operation repeats and order without manufacturing amounts or recipients', () => {
    const initial = advanceConversationIntent(undefined, 'Original operation request.');
    const declared = declareConversationIntent(initial, 'operation', ['reserve_budget', 'transfer_money', 'transfer_money']);
    expect(declared.steps.map(step => step.tool)).toEqual(['reserve_budget', 'transfer_money', 'transfer_money']);
    expect(declared.steps).toEqual([{ key: 'step-1', tool: 'reserve_budget' },
      { key: 'step-2', tool: 'transfer_money' }, { key: 'step-3', tool: 'transfer_money' }]);
    expect(declared.latestMessage).toBe(initial.latestMessage);
    expect(requiresDeclaredPlan(declared)).toBe(true);
  });

  it('permits relevant reads during advice but rejects a banking write declaration', () => {
    const current = advanceConversationIntent(undefined, 'Help analyze subscriptions.');
    expect(declareConversationIntent(current, 'advice', ['list_subscriptions']).purpose).toBe('advice');
    expect(() => declareConversationIntent(current, 'advice', ['cancel_subscription'])).toThrow();
    expect(() => declareConversationIntent(current, 'query', ['transfer_money'])).toThrow();
  });

  it.each(['unknown_tool', 'submit_plan', 'constructor'])('rejects unavailable or non-banking capability %s', operation => {
    expect(() => declareConversationIntent(advanceConversationIntent(undefined, 'Original request.'), 'operation', [operation])).toThrow();
  });

  it('allows a repeated identical declaration but prevents a mid-turn permission expansion', () => {
    const current = advanceConversationIntent(undefined, 'Explain subscription pricing.');
    const declared = declareConversationIntent(current, 'advice', ['list_subscriptions']);
    expect(declareConversationIntent(declared, 'advice', ['list_subscriptions'])).toEqual(declared);
    expect(() => declareConversationIntent(declared, 'operation', ['cancel_subscription'])).toThrow('cannot change');
    expect(() => declareConversationIntent(declared, 'advice', ['get_balance'])).toThrow('cannot change');
  });

  it('treats workflow and protocol presentation as immutable scoped declaration fields', () => {
    const current = advanceConversationIntent(undefined, 'Original request.');
    expect(() => declareConversationIntent(current, 'advice', [], { workflow: true })).toThrow();
    expect(() => declareConversationIntent(current, 'operation', [], { allowProtocolExamples: true })).toThrow();
    const workflow = declareConversationIntent(current, 'operation', ['create_scheduled_task'], { workflow: true });
    expect(requiresDeclaredPlan(workflow)).toBe(true);
    expect(() => declareConversationIntent(workflow, 'operation', ['create_scheduled_task'])).toThrow('cannot change');
    const explanation = declareConversationIntent(current, 'conversation', [], { allowProtocolExamples: true });
    expect(() => declareConversationIntent(explanation, 'conversation', [])).toThrow('cannot change');
  });

  it('does not require a multi-step plan for a single ordinary operation', () => {
    const single = declareConversationIntent(advanceConversationIntent(undefined, 'Transfer 10 CNY.'), 'operation', ['transfer_money']);
    expect(requiresDeclaredPlan(single)).toBe(false);
    expect(requiresDeclaredPlan(undefined)).toBe(false);
  });

  it('binds unknown write counts after prerequisite reads and locks the complete sequence', () => {
    const preparation = declareConversationIntent(advanceConversationIntent(undefined, 'Cancel all active subscriptions.'),
      'operation', ['list_subscriptions']);
    const final = declareConversationIntent(preparation, 'operation', ['cancel_subscription', 'cancel_subscription'], { workflow: true });
    expect(final.id).toBe(preparation.id);
    expect(final.latestMessage).toBe('Cancel all active subscriptions.');
    expect(requiresDeclaredPlan(final)).toBe(true);
    expect(() => declareConversationIntent(final, 'operation', ['cancel_subscription'], { workflow: true })).toThrow('cannot change');
    expect(() => declareConversationIntent(final, 'operation', ['list_subscriptions'])).toThrow('cannot change');
    expect(() => declareConversationIntent(preparation, 'advice', ['list_subscriptions'])).toThrow('cannot change');
  });
});
