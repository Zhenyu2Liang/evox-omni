import { describe, expect, it } from 'vitest';
import { acceptsChatResponse, initialChatUIState, reconcileInterruptedHistory, reduceAgentEvents, restoreActionAttention } from '@/components/chat/useAgentStream';
import type { PendingActionSummary } from '@/lib/contracts/security';

const summary: PendingActionSummary = {
  actionId: 'action-1', title: 'Transfer confirmation', toolName: 'transfer_money', tier: 'YELLOW',
  requiresMfa: false, amount: '200.00', fields: [{ label: 'Amount', value: '200.00' }],
};

describe('action attention convergence', () => {
  it('preserves the current decision and its inline card when restoration times out or fails', () => {
    const card = { type: 'mfa' as const, actionId: 'action-1', action: summary };
    const state = initialChatUIState({ pendingAction: { kind: 'mfa', actionId: 'action-1', summary },
      messages: [{ id: 'owner', role: 'assistant', content: '', timestamp: 1, cards: [card] }],
      pendingReconciliations: [{ actionId: 'uncertain', summary, attention: 'reconciliation' }] });
    const restored = restoreActionAttention(state, [], 0, 0);
    expect(restored.pendingAction).toBe(state.pendingAction);
    expect(restored.messages[0].cards?.[0]).toBe(card);
    expect(restored.pendingReconciliations).toBe(state.pendingReconciliations);
  });
  it.each(['executed', 'failed', 'cancelled', 'locked'] as const)(
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

  it('does not restore a settled verification from a read issued before a request started', () => {
    const initial = initialChatUIState({ pendingAction: { kind: 'mfa', actionId: 'action-1', summary } });
    const settled = reduceAgentEvents(initial, [{ type: 'action_settled', actionId: 'action-1', status: 'executed' }]);
    const refs = [{ id: 'action-1', status: 'awaiting_mfa' as const, tier: 'RED' as const, requiresMfa: true,
      summary, attention: 'decision' as const }];
    expect(restoreActionAttention(settled, refs, 0, 1)).toBe(settled);
    expect(restoreActionAttention(settled, refs, 0, 1).pendingAction).toBeUndefined();
  });

  it('does not reopen an executed or locked action when stale authorization frames are replayed', () => {
    for (const status of ['executed', 'locked'] as const) {
      const state = initialChatUIState({ pendingAction: { kind: 'mfa', actionId: 'action-1', summary } });
      const settled = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'action-1', status }]);
      const replayed = reduceAgentEvents(settled, [
        { type: 'confirmation_required', actionId: 'action-1', action: summary },
        { type: 'mfa_required', actionId: 'action-1', action: { ...summary, requiresMfa: true, tier: 'RED' } },
      ]);
      expect(replayed.pendingAction).toBeUndefined();
      expect(replayed.settledActions?.['action-1']).toBe(status);
    }
  });

  it('ignores a stale restoration row when a loaded card already records a terminal status', () => {
    const state = initialChatUIState({ messages: [{ id: 'owner', role: 'assistant', content: '', timestamp: 1,
      cards: [{ type: 'mfa', actionId: 'action-1', status: 'locked' }] }] });
    const refs = [{ id: 'action-1', status: 'awaiting_mfa' as const, tier: 'RED' as const, requiresMfa: true,
      summary, attention: 'decision' as const }];
    expect(restoreActionAttention(state, refs, 0, 0).pendingAction).toBeUndefined();
  });

  it('fences a task or verification response after clearing history or replacing a request', () => {
    expect(acceptsChatResponse('old', 'new', 1, 1)).toBe(false);
    expect(acceptsChatResponse('same', 'same', 1, 2)).toBe(false);
    expect(acceptsChatResponse('same', 'same', 2, 2)).toBe(true);
  });

  it('restores a saved complete response after disconnect without duplicating the user or moving its plan', () => {
    const state = initialChatUIState({ currentAssistantId: 'assistant', streamingText: 'Incomplete response',
      history: { hasMore: true, nextCursor: 'older', revision: 1, historyGeneration: 'current' },
      messages: [{ id: 'local-user', role: 'user', content: 'Analyze spending', timestamp: 10 },
        { id: 'assistant', role: 'assistant', content: '', timestamp: 11 }] });
    const full = 'Complete response. '.repeat(500);
    const next = reconcileInterruptedHistory(state, { hasMore: false, revision: 2, historyGeneration: 'current', messages: [
      { id: 'server-user', role: 'user', content: 'Analyze spending', timestamp: 10 },
      { id: 'assistant', role: 'assistant', content: full, timestamp: 11 },
    ] }, 10);
    expect(next.messages.map(message => message.id)).toEqual(['local-user', 'assistant']);
    expect(next.messages[1].content).toBe(full);
    expect(next.streamingText).toBe('');
    expect(next.history?.nextCursor).toBe('older');
    expect(state.messages[1].content).toBe('');
  });

  it('does not synthesize a reply or accept a saved response from another conversation generation', () => {
    const state = initialChatUIState({ streamingText: 'Partial response', history: { hasMore: false, revision: 1, historyGeneration: 'current' } });
    expect(reconcileInterruptedHistory(state, { messages: [], hasMore: false, revision: 2, historyGeneration: 'old' }, 10)).toBe(state);
    expect(reconcileInterruptedHistory(state, { messages: [], hasMore: false, revision: 2, historyGeneration: 'current' }, 10).messages).toEqual([]);
  });

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

  it('dismisses the live MFA popup when a failed verification settles the same action as locked', () => {
    const state = initialChatUIState({
      pendingAction: { kind: 'mfa', actionId: 'action-1', summary: { ...summary, tier: 'RED', requiresMfa: true } },
    });
    // The server's 3-wrong-codes path emits an error (MFA failed) AND an action_settled locked for this id.
    const next = reduceAgentEvents(state, [
      { type: 'error', message: 'MFA failed: too many attempts', code: 'MFA_FAILED' },
      { type: 'action_settled', actionId: 'action-1', status: 'locked' },
    ]);
    expect(next.pendingAction).toBeUndefined();
    expect(next.settledActions?.['action-1']).toBe('locked');
    expect(next.error).toBe('MFA failed: too many attempts');
    expect(next.errorCode).toBe('MFA_FAILED');
    // The fold is non-mutating: the input keeps its live decision and no settlement record.
    expect(state.pendingAction).toBeDefined();
    expect(state.settledActions).toBeUndefined();
    expect(state.error).toBeUndefined();
  });

  it('never reopens a locked decision on a later attention refresh while still surfacing an unrelated live row', () => {
    const settled = reduceAgentEvents(
      initialChatUIState({ pendingAction: { kind: 'mfa', actionId: 'action-1', summary } }),
      [{ type: 'action_settled', actionId: 'action-1', status: 'locked' }],
    );
    const staleRow = { id: 'action-1', status: 'awaiting_mfa' as const, tier: 'RED' as const, requiresMfa: true,
      summary, attention: 'decision' as const };
    // Same revision: only the settled-action guard keeps the popup closed (a revision-fenced read would
    // return the state untouched for an unrelated reason).
    expect(restoreActionAttention(settled, [staleRow], 0, 0).pendingAction).toBeUndefined();
    // The guard is per-action: a DIFFERENT still-live row in the SAME refresh is still adopted.
    const liveRow = { ...staleRow, id: 'other-action', summary: { ...summary, actionId: 'other-action' } };
    expect(restoreActionAttention(settled, [staleRow, liveRow], 0, 0).pendingAction?.actionId).toBe('other-action');
    // A read issued before a request started is fenced out entirely.
    expect(restoreActionAttention(settled, [staleRow, liveRow], 0, 1)).toBe(settled);
  });
});