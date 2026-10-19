import { describe, expect, it } from 'vitest';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { compileRequestedPlan } from '@/agent/tools/plan-compiler';
import { scheduledTime } from '@/lib/scheduled-time';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';

const tools = new Set(['analyze_spending', 'set_card_limit', 'create_scheduled_task', 'reserve_budget', 'transfer_money']);
const intent = (operations: string[]) => declareConversationIntent(advanceConversationIntent(undefined, 'Original raw request.'), 'operation', operations);
const conditionPlan = (): TaskNodeSpec[] => [
  { id: 'analysis', name: 'Analyze spending', kind: 'tool', tool: 'analyze_spending', args: { month: '2020-01' }, dependencies: [] },
  { id: 'condition', name: 'Evaluate condition', kind: 'condition', dependencies: ['analysis'], condition: { path: 'analysis.total', op: '<', value: '99999' } },
  { id: 'limit', name: 'Update limit', kind: 'tool', tool: 'set_card_limit', args: { cardId: 'card', category: 'shopping', amount: '1500.00' }, dependencies: ['condition'] },
];

describe('structured plan compilation', () => {
  it('uses success dependencies without inventing a positive-spending threshold', () => {
    const nodes: TaskNodeSpec[] = [
      { id: 'read', name: 'Read spending', kind: 'tool', tool: 'analyze_spending', args: { month: '2026-09' }, dependencies: [] },
      { id: 'limit', name: 'Set limit', kind: 'tool', tool: 'set_card_limit', args: { cardId: 'card_debit', category: '购物', amount: '900.50' }, dependencies: ['read'] },
      { id: 'budget', name: 'Register budget', kind: 'tool', tool: 'reserve_budget', args: { name: 'Budget', amount: '219.87' }, dependencies: ['limit'] },
    ];
    const compiled = compileRequestedPlan(nodes, tools, '每一步成功后再做下一步', intent(['set_card_limit', 'reserve_budget']));
    expect(compiled).toEqual(nodes);
    expect(compiled.every(node => node.kind !== 'condition')).toBe(true);
  });
  it('preserves explicit month, condition and dependencies without reinterpreting the raw request', () => {
    const original = conditionPlan();
    const compiled = compileRequestedPlan(original, tools, 'Different user wording and numbers 2000 2026-09.', intent(['set_card_limit']));
    expect(compiled).toEqual(original);
    expect(compiled[0].args?.month).toBe('2020-01');
    expect(compiled[1].condition).toEqual({ path: 'analysis.total', op: '<', value: '99999' });
  });

  it('rejects unsupported output references using the output contract', () => {
    const nodes = conditionPlan();
    nodes[1].condition!.path = 'analysis.invalid.amount';
    expect(() => compileRequestedPlan(nodes, tools, '', intent(['set_card_limit']))).toThrow('unsupported output field');
  });

  it('rejects a numeric threshold for an exact decimal output', () => {
    const nodes = conditionPlan();
    nodes[1].condition!.value = 100;
    expect(() => compileRequestedPlan(nodes, tools, '', intent(['set_card_limit']))).toThrow();
  });

  it('rejects write omissions and additional writes against the structured declaration', () => {
    expect(() => compileRequestedPlan(conditionPlan(), tools, '', intent(['set_card_limit', 'create_scheduled_task']))).toThrow('declared banking writes');
    expect(() => compileRequestedPlan(conditionPlan(), tools, '', intent([]))).toThrow('declared banking writes');
  });

  it('rejects dependency ordering that reverses the declared write sequence', () => {
    const nodes: TaskNodeSpec[] = [
      { id: 'budget', name: 'Reserve budget', kind: 'tool', tool: 'reserve_budget', args: { name: 'budget', amount: '1.00' }, dependencies: ['transfer'] },
      { id: 'transfer', name: 'Transfer', kind: 'tool', tool: 'transfer_money', args: { contactId: 'contact', amount: '1.00' }, dependencies: [] },
    ];
    expect(() => compileRequestedPlan(nodes, tools, '', intent(['reserve_budget', 'transfer_money']))).toThrow('declared order');
  });

  it('rejects banking writes in a discussion-purpose declaration', () => {
    const discussion = declareConversationIntent(advanceConversationIntent(undefined, 'Explain a limit.'), 'conversation', []);
    expect(() => compileRequestedPlan(conditionPlan(), tools, '', discussion)).toThrow('does not permit');
  });

  it('normalizes explicit civil dates without assigning dates from user prose', () => {
    const nodes: TaskNodeSpec[] = ['first', 'second'].map((id, index) => ({ id, name: id, kind: 'tool', tool: 'create_scheduled_task', dependencies: [],
      args: { name: id, kind: 'REMINDER', runAtLocal: index ? '2099-11-23T10:00' : '2099-11-22T09:00' } }));
    const compiled = compileRequestedPlan(nodes, tools, 'Unrelated dates in ordinary prose.', intent(['create_scheduled_task', 'create_scheduled_task']));
    expect(compiled.map(node => node.args?.runAt)).toEqual([Date.parse('2099-11-22T09:00:00+08:00'), Date.parse('2099-11-23T10:00:00+08:00')]);
    expect(nodes[0].args?.runAt).toBeUndefined();
  });
});

describe('explicit scheduled time fields', () => {
  it('accepts a future integer epoch and its matching civil time', () => {
    const runAt = Date.parse('2099-11-22T09:00:00+08:00');
    expect(scheduledTime({ runAt })).toBe(runAt);
    expect(scheduledTime({ runAt, runAtLocal: '2099-11-22T09:00' })).toBe(runAt);
  });

  it.each([{ runAt: '4109461200000' }, { runAt: 1.5 }, { runAt: true }, { runAt: 0 }, {},
    { runAtLocal: '2099-02-30T09:00' }, { runAtLocal: '2099-11-22T25:00' },
    { runAtLocal: '2099-11-22T09:00', runAt: Date.parse('2099-11-23T09:00:00+08:00') }])('rejects malformed, absent, past or inconsistent explicit time %j', args => {
    expect(() => scheduledTime(args)).toThrow();
  });
});
