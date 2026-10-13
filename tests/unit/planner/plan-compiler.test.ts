import { describe, expect, it } from 'vitest';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { compileRequestedPlan } from '@/agent/tools/plan-compiler';
import { scheduledTime } from '@/lib/scheduled-time';

const tools = new Set(['analyze_spending', 'set_card_limit', 'create_scheduled_task']);
const spendingRequest = '\u5982\u679c\u672c\u6708\u5a31\u4e50\u6d88\u8d39\u8d85\u8fc72000';
const conditionPlan = (): TaskNodeSpec[] => [
  { id: 'analysis', name: 'Analyze spending', kind: 'tool', tool: 'analyze_spending',
    args: { month: '2020-01' }, dependencies: [] },
  { id: 'condition', name: 'Evaluate condition', kind: 'condition', dependencies: ['analysis'],
    condition: { path: 'analysis.total', op: '<', value: '99999' } },
  { id: 'limit', name: 'Update limit', kind: 'tool', tool: 'set_card_limit',
    args: { cardId: 'card', amount: '1500.00' }, dependencies: ['condition'] },
];

describe('trusted plan compilation', () => {
  it('binds the requested category, threshold, operator and period independently of model fields', () => {
    const compiled = compileRequestedPlan(conditionPlan(), tools, spendingRequest);
    expect(compiled[0].args?.month).toBe('2026-09');
    expect(compiled[1].condition).toEqual({
      path: 'analysis.categoryTotals.\u5a31\u4e50', op: '>', value: '2000',
    });
  });

  it('binds first-person monthly consumption to the total rather than inventing a category', () => {
    const request = '\u5982\u679c\u6211\u8fd9\u4e2a\u6708\u6d88\u8d39\u8d85\u8fc72000\uff0c\u5c31\u628a\u4fe1\u7528\u5361\u5a31\u4e50\u9650\u989d\u8c03\u6574\u52301500\u5143';
    const compiled = compileRequestedPlan(conditionPlan(), tools, request);
    expect(compiled[0].args?.month).toBe('2026-09');
    expect(compiled[1].condition).toEqual({ path: 'analysis.total', op: '>', value: '2000' });
  });

  it.each([
    ['\u6211\u7684\u672c\u6708\u603b\u6d88\u8d39', '2026-09', undefined],
    ['\u6211\u4e0a\u4e2a\u6708\u6d88\u8d39\u603b\u989d', '2026-08', undefined],
    ['2026\u5e748\u6708\u7684\u6240\u6709\u652f\u51fa', '2026-08', undefined],
    ['\u6211\u8fd9\u4e2a\u6708\u7684\u5a31\u4e50\u6d88\u8d39', '2026-09', '\u5a31\u4e50'],
  ])('separates pronouns and calendar phrases from a finite category: %s', (subject, month, category) => {
    const compiled = compileRequestedPlan(conditionPlan(), tools, `\u5982\u679c${subject}\u8d85\u8fc72000`);
    expect(compiled[0].args?.month).toBe(month);
    expect(compiled[1].condition!.path).toBe(category ? `analysis.categoryTotals.${category}` : 'analysis.total');
  });

  it('rejects unsupported category text before creating a financial workflow', () => {
    const request = '\u5982\u679c\u672c\u6708\u865a\u6784\u7c7b\u522b\u6d88\u8d39\u8d85\u8fc72000';
    expect(() => compileRequestedPlan(conditionPlan(), tools, request)).toThrow('supported analysis category');
  });

  it('rejects an output reference that cannot exist according to the output contract', () => {
    const nodes = conditionPlan();
    nodes[1].condition!.path = 'analysis.invalid.amount';
    expect(() => compileRequestedPlan(nodes, tools, '')).toThrow('unsupported output field');
  });

  it('allows two scheduled steps with distinct requested times', () => {
    const prefix = '\u521b\u5efa';
    const suffix = '\u7684\u63d0\u9192';
    const request = `${prefix}2099\u5e7411\u670822\u65e509:00${suffix}\uff0c${prefix}2099\u5e7411\u670823\u65e510:00${suffix}`;
    const nodes: TaskNodeSpec[] = [
      { id: 'first', name: 'First reminder', kind: 'tool', tool: 'create_scheduled_task', dependencies: [],
        args: { name: 'first', kind: 'REMINDER', runAtLocal: '2099-11-22T09:00' } },
      { id: 'second', name: 'Second reminder', kind: 'tool', tool: 'create_scheduled_task', dependencies: [],
        args: { name: 'second', kind: 'REMINDER', runAtLocal: '2099-11-23T10:00' } },
    ];
    const compiled = compileRequestedPlan(nodes, tools, request);
    expect(compiled.map(node => node.args?.runAt)).toEqual([
      Date.parse('2099-11-22T09:00:00+08:00'), Date.parse('2099-11-23T10:00:00+08:00'),
    ]);
    expect(scheduledTime(compiled[1].args!, request)).toBe(Date.parse('2099-11-23T10:00:00+08:00'));
  });

  it('rejects a duplicate scheduled node that omits the second requested time', () => {
    const request = '\u521b\u5efa2099\u5e7411\u670822\u65e509:00\u63d0\u9192\uff0c\u521b\u5efa2099\u5e7411\u670823\u65e510:00\u63d0\u9192';
    const nodes: TaskNodeSpec[] = ['first', 'second'].map(id => ({ id, name: id, kind: 'tool',
      tool: 'create_scheduled_task', dependencies: [], args: { runAtLocal: '2099-11-22T09:00' } }));
    expect(() => compileRequestedPlan(nodes, tools, request)).toThrow('one-to-one');
  });

  it('rejects an extra scheduled node for a single explicitly timed reminder', () => {
    const request = '\u521b\u5efa2099\u5e7411\u670822\u65e509:00\u63d0\u9192';
    const nodes: TaskNodeSpec[] = ['first', 'second'].map(id => ({ id, name: id, kind: 'tool',
      tool: 'create_scheduled_task', dependencies: [], args: { runAtLocal: '2099-11-22T09:00' } }));
    expect(() => compileRequestedPlan(nodes, tools, request)).toThrow('distinct scheduled step');
  });
});
