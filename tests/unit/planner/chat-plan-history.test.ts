import { describe, expect, it } from 'vitest';
import { beginAgentRequest, initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { historyPlan, isActionablePlan, placePlanInHistory } from '@/lib/chat-plan-history';
import type { ChatMessage, AgentStreamEvent } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';

const plan: TaskPlan = { id: 'plan-one', sessionId: 'session', goal: 'Freeze both cards', status: 'waiting_confirmation',
  nodes: [], results: [], createdAt: 20, updatedAt: 20, generation: 1 };
const message = (id: string, timestamp: number, role: ChatMessage['role'] = 'assistant'): ChatMessage =>
  ({ id, role, content: '', timestamp });
const snapshots = (messages: ChatMessage[]) => messages.flatMap(message => message.cards ?? []).filter(card => card.type === 'plan');

describe('plan ownership in conversation history', () => {
  it('rejects an older nonterminal snapshot inside the same execution generation', () => {
    const paused = { ...plan, status: 'paused' as const, updatedAt: 40 };
    const initial = initialChatUIState({ messages: placePlanInHistory([], paused), activePlan: paused });
    const next = reduceAgentEvents(initial, [{ type: 'plan_update', plan: { ...plan, status: 'running', updatedAt: 30 } }]);
    expect(next).toBe(initial);
    expect(historyPlan(next.messages, plan.id)?.status).toBe('paused');
  });

  it('accepts a newer execution generation despite an older timestamp after a clock adjustment', () => {
    const running = { ...plan, status: 'running' as const, updatedAt: 40, generation: 2 };
    const initial = initialChatUIState({ messages: placePlanInHistory([], running), activePlan: running });
    const next = reduceAgentEvents(initial, [{ type: 'plan_update', plan: { ...plan, status: 'paused', updatedAt: 30, generation: 3 } }]);
    expect(historyPlan(next.messages, plan.id)).toMatchObject({ status: 'paused', updatedAt: 30, generation: 3 });
  });

  it('retains legitimate arrival-order updates with the same generation and timestamp', () => {
    const running = { ...plan, status: 'running' as const, updatedAt: 40 };
    const initial = initialChatUIState({ messages: placePlanInHistory([], running), activePlan: running });
    const next = reduceAgentEvents(initial, [{ type: 'plan_update', plan: { ...running, status: 'waiting_confirmation' } },
      { type: 'plan_update', plan: { ...running, status: 'success' } }]);
    expect(historyPlan(next.messages, plan.id)).toMatchObject({ status: 'success', updatedAt: 40, generation: 1 });
  });

  it('keeps completion on the original turn after an unrelated request instead of a footer plan', () => {
    const owner = message('plan-owner', 10, 'tool');
    let state = reduceAgentEvents(initialChatUIState(), [
      { type: 'message_start', message: owner }, { type: 'message_end', message: owner },
      { type: 'plan_update', plan, messageId: owner.id }, { type: 'card', card: { type: 'plan', plan }, messageId: owner.id },
      { type: 'plan_update', plan: { ...plan, status: 'success', updatedAt: 30 } },
    ]);
    state = beginAgentRequest({ ...state, messages: [...state.messages, message('new-user', 40, 'user')] });
    state = reduceAgentEvents(state, [{ type: 'message_start', message: message('new-reply', 41) },
      { type: 'message_end', message: { ...message('new-reply', 41), content: 'Which purchase do you mean?' } }]);
    expect(snapshots(state.messages)).toHaveLength(1);
    expect(historyPlan(state.messages, plan.id)?.status).toBe('success');
    expect(state.messages[0].cards?.[0]).toMatchObject({ type: 'plan', plan: { status: 'success' } });
    expect(state.messages.at(-1)?.cards).toEqual([]);
    expect(isActionablePlan(state.activePlan!)).toBe(false);
  });

  it('preserves client-folded progress when the owning provider message is republished', () => {
    const owner = message('plan-owner', 10, 'tool');
    const state = reduceAgentEvents(initialChatUIState(), [{ type: 'message_start', message: owner },
      { type: 'plan_update', plan: { ...plan, status: 'success', updatedAt: 30 }, messageId: owner.id }, { type: 'message_end', message: owner }]);
    expect(snapshots(state.messages)).toHaveLength(1);
    expect(historyPlan(state.messages, plan.id)?.status).toBe('success');
  });

  it('hydrates a completed snapshot once at its original location before newer messages', () => {
    const owner = { ...message('owner', 10, 'tool'), cards: [{ type: 'plan' as const, plan }] };
    const refreshed = placePlanInHistory([owner, message('new-user', 40, 'user'), message('new-reply', 41)],
      { ...plan, status: 'success', updatedAt: 35 });
    const repeated = placePlanInHistory(refreshed, { ...plan, status: 'success', updatedAt: 35 });
    expect(snapshots(repeated)).toHaveLength(1);
    expect(repeated[0].cards?.[0]).toMatchObject({ plan: { status: 'success' } });
    expect(repeated.at(-1)?.cards).toEqual([]);
  });

  it('rejects stale generations even after another plan becomes the latest active plan', () => {
    const older = { ...plan, status: 'success' as const, generation: 3, updatedAt: 30 };
    const newer = { ...plan, id: 'plan-two', createdAt: 40, updatedAt: 40 };
    let state = initialChatUIState({ messages: placePlanInHistory([], older), activePlan: newer });
    state = reduceAgentEvents(state, [{ type: 'plan_update', plan: { ...plan, generation: 2, updatedAt: 99 } }]);
    expect(historyPlan(state.messages, plan.id)?.status).toBe('success');
    expect(state.activePlan?.id).toBe(newer.id);
  });

  it('stamps event-only generations so a superseded executor cannot replace history', () => {
    const withoutGeneration = { ...plan, generation: undefined };
    const state = reduceAgentEvents(initialChatUIState(), [
      { type: 'plan_update', plan: withoutGeneration, generation: 5 },
      { type: 'plan_update', plan: { ...withoutGeneration, updatedAt: 99 }, generation: 4 },
    ]);
    expect(historyPlan(state.messages, plan.id)?.generation).toBe(5);
    expect(historyPlan(state.messages, plan.id)?.updatedAt).toBe(20);
  });

  it('does not attach an orphaned plan to an unrelated current reply', () => {
    const projected = placePlanInHistory([message('old-user', 10, 'user'), message('new-user', 40, 'user'), message('new-reply', 41)], plan);
    expect(projected.map(message => message.id)).toEqual(['old-user', `plan-history-${plan.id}`, 'new-user', 'new-reply']);
    expect(projected[1].role).toBe('system');
    expect(projected.at(-1)?.cards).toEqual([]);
  });

  it('keeps exact ownership when another assistant is streaming during a historical message update', () => {
    const owner = message('old-owner', 10, 'tool');
    const current = message('current-reply', 40);
    const initial = initialChatUIState({ messages: [owner] });
    const events: AgentStreamEvent[] = [{ type: 'message_start', message: current },
      { type: 'text_delta', delta: 'Current reply' },
      { type: 'message_end', message: { ...owner, cards: [{ type: 'plan', plan }] } }];
    const state = reduceAgentEvents(initial, events);
    expect(state.currentAssistantId).toBe(current.id);
    expect(state.streamingText).toBe('Current reply');
    expect(state.messages[0].cards?.[0]).toMatchObject({ type: 'plan' });
    expect(state.messages[1].cards).toEqual([]);
  });

  it('does not move a cancelled record back into a pending state', () => {
    const cancelled = { ...plan, status: 'cancelled' as const };
    const state = reduceAgentEvents(initialChatUIState({ messages: placePlanInHistory([], cancelled) }),
      [{ type: 'plan_update', plan: { ...plan, generation: 9 } }]);
    expect(historyPlan(state.messages, plan.id)?.status).toBe('cancelled');
  });

  it('does not reopen a successful plan from stale same-generation message snapshots', () => {
    const completed = { ...plan, status: 'success' as const, updatedAt: 30 };
    const state = reduceAgentEvents(initialChatUIState({ messages: placePlanInHistory([], completed) }),
      [{ type: 'plan_update', plan: { ...plan, updatedAt: 99 } }]);
    expect(historyPlan(state.messages, plan.id)?.status).toBe('success');
  });

  it('allows an explicit cancellation of a completed record-creation plan', () => {
    const completed = { ...plan, status: 'success' as const, updatedAt: 30 };
    const state = reduceAgentEvents(initialChatUIState({ messages: placePlanInHistory([], completed) }),
      [{ type: 'plan_update', plan: { ...plan, status: 'cancelled', updatedAt: 99 } }]);
    expect(historyPlan(state.messages, plan.id)?.status).toBe('cancelled');
  });
});
