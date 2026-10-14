import { describe, expect, it } from 'vitest';
import { buildFinancialFacts } from '@/agent/grounding-facts';

describe('structured write outcomes', () => {
  it('does not derive an unknown outcome from explanatory summary text', () => {
    const facts = buildFinancialFacts([{ toolName: 'freeze_card', result: {
      ok: true, data: { status: 'FROZEN' }, summary: 'The card was frozen; needs reconciliation describes a different state.',
    } }]);
    expect(facts.writes[0].outcome).toBe('succeeded');
  });

  it.each([
    { outcome: 'unknown' }, { needsReconciliation: true }, { status: 'needs_reconciliation' },
  ])('retains explicit unknown outcome evidence %j', data => {
    const facts = buildFinancialFacts([{ toolName: 'freeze_card', result: { ok: true, data } }]);
    expect(facts.writes[0].outcome).toBe('unknown');
  });

  it('does not derive an unknown outcome from error text', () => {
    const facts = buildFinancialFacts([{ toolName: 'freeze_card', result: {
      ok: false, error: 'No operation occurred. The needs reconciliation status was not entered.',
    } }]);
    expect(facts.writes[0].outcome).toBe('failed');
  });
});
