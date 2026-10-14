import { describe, expect, it } from 'vitest';
import { projectPlanApprovals, type PlanApprovalEvidence } from '@/app/agent/plan-approvals';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';
import type { PendingActionSummary } from '@/lib/contracts/security';

const summary: PendingActionSummary = { title: 'Freeze credit card', toolName: 'freeze_card', tier: 'RED',
  requiresMfa: true, fields: [{ label: 'Card', value: '6688' }] };
const plan: TaskPlan = { id: 'plan', sessionId: 'session', goal: 'Freeze two cards', status: 'waiting_confirmation',
  createdAt: 10, updatedAt: 30,
  nodes: ['first', 'second'].map(id => ({ id, name: id, kind: 'tool', tool: 'freeze_card', dependencies: [] })),
  results: [{ id: 'first', name: 'first', tool: 'freeze_card', status: 'success', output: { cardId: 'credit' } },
    { id: 'second', name: 'second', tool: 'freeze_card', status: 'waiting_verification', output: { pendingActionId: 'action-second' } }],
};
const owner: ChatMessage = { id: 'owner', role: 'tool', timestamp: 10, content: '', cards: [{ type: 'plan', plan }] };
const action = (id: string, nodeId: string, status: string): PlanApprovalEvidence => ({ id, taskId: plan.id, nodeId,
  toolName: 'freeze_card', riskLevel: 'RED', requiresMfa: true, summaryJson: JSON.stringify(summary), status });

describe('issued plan permission records', () => {
  it('restores terminal and current permissions from actions after completed output loses its action ID', () => {
    const restored = projectPlanApprovals([owner, { id: 'later', role: 'assistant', content: 'Anything else?', timestamp: 50 }],
      plan, [action('action-first', 'first', 'executed'), action('action-second', 'second', 'awaiting_mfa')]);
    expect(restored[0].cards).toHaveLength(3);
    expect(restored[0].cards?.slice(1)).toMatchObject([
      { type: 'mfa', actionId: 'action-first', status: 'executed' },
      { type: 'mfa', actionId: 'action-second', status: 'awaiting_mfa' },
    ]);
    expect(restored[1].cards).toEqual([]);
  });

  it('does not invent authorization records from successful nodes', () => {
    expect(projectPlanApprovals([owner], plan, [])[0].cards).toEqual(owner.cards);
  });

  it('ignores unrelated task, node and tool identities', () => {
    const rows = [{ ...action('foreign', 'first', 'executed'), taskId: 'other-plan' },
      action('unknown-node', 'missing', 'executed'), { ...action('wrong-tool', 'first', 'executed'), toolName: 'unfreeze_card' }];
    expect(projectPlanApprovals([owner], plan, rows)[0].cards).toEqual(owner.cards);
  });

  it('moves duplicate stale permission copies back to their original owner and uses durable status', () => {
    const stale = { type: 'mfa' as const, actionId: 'action-first', action: summary };
    const messages = [owner, { id: 'later', role: 'tool' as const, content: '', timestamp: 50, cards: [stale, stale] }];
    const first = projectPlanApprovals(messages, plan, [action('action-first', 'first', 'cancelled')]);
    const repeated = projectPlanApprovals(first, plan, [action('action-first', 'first', 'cancelled')]);
    expect(repeated).toEqual(first);
    expect(repeated[0].cards?.[1]).toMatchObject({ actionId: 'action-first', status: 'cancelled' });
    expect(repeated[1].cards).toEqual([]);
  });

  it('attaches the next live decision to the matching plan owner and retains the first outcome', () => {
    const messages = projectPlanApprovals([owner], plan, [action('action-first', 'first', 'executed')]);
    const state = reduceAgentEvents(initialChatUIState({ messages }), [
      { type: 'mfa_required', actionId: 'action-second', action: { ...summary, actionId: 'action-second' } },
      { type: 'action_settled', actionId: 'action-second', status: 'executed' },
    ]);
    expect(state.messages[0].cards?.slice(1)).toMatchObject([
      { type: 'mfa', actionId: 'action-first', status: 'executed' },
      { type: 'mfa', actionId: 'action-second', status: 'executed' },
    ]);
    expect(state.pendingAction).toBeUndefined();
  });

  it('does not guess that an unrelated active plan owns a permission event', () => {
    const state = reduceAgentEvents(initialChatUIState({ messages: [owner] }), [
      { type: 'mfa_required', actionId: 'unknown-action', action: summary },
    ]);
    expect(state.messages[0].cards).toEqual(owner.cards);
    expect(state.pendingAction?.actionId).toBe('unknown-action');
  });
});
