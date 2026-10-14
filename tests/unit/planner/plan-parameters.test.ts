import { describe, expect, it } from 'vitest';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { validatePlanParameters } from '@/agent/tools/plan-parameters';
import { SPENDING_CATEGORIES } from '@/lib/contracts/spending';

const node = (tool: string, args: Record<string, unknown>): TaskNodeSpec => ({ id: 'node', name: 'Node', kind: 'tool', tool, args, dependencies: [] });

describe('plan parameter preflight', () => {
  it('accepts exact decimal text without rewriting the proposed parameters', () => {
    const proposed = node('transfer_money', { contactId: 'contact', amount: '100.01' });
    const original = structuredClone(proposed);
    expect(() => validatePlanParameters(proposed)).not.toThrow();
    expect(proposed).toEqual(original);
  });

  it.each([{ amount: 100 }, { amount: '-1.00' }, { amount: '0.00' }, { amount: '1.001' }, {}])('rejects invalid transfer values before the workflow can start %j', args => {
    expect(() => validatePlanParameters(node('transfer_money', { contactId: 'contact', ...args }))).toThrow();
  });

  it('does not accept implicit boolean coercion for subscription controls', () => {
    expect(() => validatePlanParameters(node('set_subscription_reminder', { subscriptionId: 'subscription', enabled: 'true' }))).toThrow();
  });

  it('accepts a zero card limit and rejects a missing required card field', () => {
    expect(() => validatePlanParameters(node('set_card_limit', { cardId: 'card', category: SPENDING_CATEGORIES[0], amount: '0.00' }))).not.toThrow();
    expect(() => validatePlanParameters(node('set_card_limit', { category: SPENDING_CATEGORIES[0], amount: '0.00' }))).toThrow();
  });
});
