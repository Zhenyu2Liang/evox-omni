import { describe, expect, it } from 'vitest';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import type { PendingActionSummary } from '@/lib/contracts/security';

const summary: PendingActionSummary = {
  actionId: 'action-1', title: 'Transfer confirmation', toolName: 'transfer_money', tier: 'YELLOW',
  requiresMfa: false, amount: '200.00', fields: [{ label: 'Amount', value: '200.00' }],
};

describe('action attention convergence', () => {
  it.each(['executed', 'failed', 'cancelled'] as const)(
    'removes a restored recovery control after the server settles the action as %s', status => {
      const state = initialChatUIState({ pendingReconciliations: [
        { actionId: 'action-1', summary, attention: 'recoverable' },
        { actionId: 'other-action', summary: { ...summary, actionId: 'other-action' }, attention: 'processing' },
      ] });
      const next = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'action-1', status }]);
      expect(next.pendingReconciliations.map(row => row.actionId)).toEqual(['other-action']);
      expect(state.pendingReconciliations).toHaveLength(2);
    },
  );

  it('changes a recoverable action into a manual reconciliation entry when its outcome becomes uncertain', () => {
    const state = initialChatUIState({ pendingReconciliations: [{ actionId: 'action-1', summary, attention: 'recoverable' }] });
    const next = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'action-1', status: 'needs_reconciliation' }]);
    expect(next.pendingReconciliations).toEqual([{ actionId: 'action-1', summary, attention: 'reconciliation' }]);
  });

  it('keeps an uncertain outcome visible immediately after settling the active decision', () => {
    const state = initialChatUIState({ pendingAction: { kind: 'confirmation', actionId: 'action-1', summary } });
    const event = { type: 'action_settled' as const, actionId: 'action-1', status: 'needs_reconciliation' as const };
    const next = reduceAgentEvents(state, [event, event]);
    expect(next.pendingAction).toBeUndefined();
    expect(next.pendingReconciliations).toEqual([{ actionId: 'action-1', summary, attention: 'reconciliation' }]);
  });

  it('preserves another live decision while surfacing an older inline action for manual review', () => {
    const state = initialChatUIState({
      pendingAction: { kind: 'confirmation', actionId: 'other-action', summary: { ...summary, actionId: 'other-action' } },
      messages: [{ id: 'message-1', role: 'assistant', content: '', timestamp: 1,
        cards: [{ type: 'confirmation', action: summary }] }],
    });
    const next = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'action-1', status: 'needs_reconciliation' }]);
    expect(next.pendingAction?.actionId).toBe('other-action');
    expect(next.pendingReconciliations).toEqual([{ actionId: 'action-1', summary, attention: 'reconciliation' }]);
  });
});
