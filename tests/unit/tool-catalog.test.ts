import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG, TOOL_NAMES, catalogEntry, isCatalogToolName } from '@/lib/contracts/tool-catalog';
import { toolReplayPolicy } from '@/agent/durable/retry-policy';

describe('central banking capability catalog', () => {
  it('contains one exhaustive inventory and rejects inherited object properties', () => {
    expect(TOOL_NAMES).toHaveLength(26);
    expect(new Set(TOOL_NAMES).size).toBe(26);
    expect(TOOL_NAMES).toEqual(Object.keys(TOOL_CATALOG));
    expect(isCatalogToolName('__proto__')).toBe(false);
    expect(catalogEntry('unregistered_tool')).toBeUndefined();
  });

  it('keeps permission tier independent from side effects and read retry safety', () => {
    expect(TOOL_CATALOG.reserve_budget).toMatchObject({ effect: 'write', defaultTier: 'GREEN', replay: { requiresReceipt: true } });
    expect(TOOL_CATALOG.list_subscriptions).toMatchObject({ effect: 'read', defaultTier: 'YELLOW', replay: { safety: 'read_only' } });
    expect(TOOL_CATALOG.transfer_money.authorization).toBe('transfer_amount');
    expect(toolReplayPolicy('list_subscriptions')).toEqual({ safety: 'read_only', maxAttempts: 3 });
  });

  it('never advertises write retries without a verified runtime receipt capability', () => {
    for (const name of TOOL_NAMES) {
      const entry = TOOL_CATALOG[name];
      if (entry.effect !== 'write') continue;
      expect(toolReplayPolicy(name)).toEqual({ safety: 'reconcile_only', maxAttempts: 1 });
      expect(toolReplayPolicy(name, { receiptBackedTools: new Set([name]) })).toEqual({ safety: 'idempotent', maxAttempts: 3 });
    }
    expect(toolReplayPolicy('submit_plan', { receiptBackedTools: new Set(['submit_plan']) }).safety).toBe('reconcile_only');
  });
});
