import { describe, expect, it } from 'vitest';
import { beginAgentRequest, initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { createTurnBuffer, publishAuthorizedToolOutcome } from '@/agent/turns/buffer';
import type { AgentStreamEvent, ChatMessage, ToolEventView } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import { StreamingText } from '@/components/chat/StreamingText';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '@/lib/i18n/shared';

const subscriptionCall: ToolEventView = { messageId: 'subscription-row', toolCallId: 'subscription-call', toolName: 'list_subscriptions', status: 'started' };

function assistant(id: string, toolEvents: ToolEventView[] = []): ChatMessage {
  return { id, role: 'assistant', content: '', timestamp: 1, toolEvents };
}

function toolMessage(id: string, event: ToolEventView = subscriptionCall): ChatMessage {
  return { id, role: 'tool', content: '', timestamp: 1, toolEvents: [{ ...event, messageId: id }], cards: [] };
}

function serialized(events: AgentStreamEvent[]): AgentStreamEvent[] {
  return JSON.parse(JSON.stringify(events)) as AgentStreamEvent[];
}

describe('tool event lifecycle and owner correlation', () => {
  it('does not let tool lifecycle frames steal an active prose stream', () => {
    const row = toolMessage('subscription-row');
    const state = reduceAgentEvents(initialChatUIState(), [
      { type: 'message_start', message: assistant('analysis') }, { type: 'text_delta', delta: 'Complete preview' },
      { type: 'message_start', message: row },
      { type: 'tool_end', toolEvent: { ...subscriptionCall, status: 'success' } },
      { type: 'message_end', message: row },
    ]);
    expect(state.currentAssistantId).toBe('analysis');
    expect(state.streamingText).toBe('Complete preview');
    expect(state.messages[1].toolEvents?.[0].status).toBe('success');
  });

  it('never assigns unowned calls or result cards to unrelated prose', () => {
    const state = reduceAgentEvents(initialChatUIState(), [
      { type: 'message_start', message: assistant('analysis') },
      { type: 'tool_start', toolEvent: { ...subscriptionCall, messageId: undefined } },
      { type: 'card', card: { type: 'subscriptions', data: [] } },
      { type: 'card', messageId: 'analysis', card: { type: 'subscriptions', data: [] } },
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].cards).toEqual([]);
    expect(state.messages[0].toolEvents).toEqual([]);
  });

  it('publishes result rows in call order before a later prose message and refreshes them by stable ID', () => {
    const first = toolMessage('first-row');
    const second = toolMessage('second-row', { ...subscriptionCall, toolCallId: 'second-call' });
    const completed: ChatMessage = { ...first, cards: [{ type: 'subscriptions', data: [] }],
      toolEvents: [{ ...first.toolEvents![0], status: 'success' }] };
    const state = reduceAgentEvents(initialChatUIState(), [
      { type: 'message_start', message: first }, { type: 'message_end', message: completed },
      { type: 'message_start', message: second },
      { type: 'card', messageId: second.id, card: { type: 'contacts', data: [] } },
      { type: 'message_start', message: assistant('analysis') },
      { type: 'message_end', message: { ...assistant('analysis'), content: 'The complete analysis.' } },
      { type: 'message_end', message: completed },
    ]);
    expect(state.messages.map(message => [message.id, message.role])).toEqual([
      ['first-row', 'tool'], ['second-row', 'tool'], ['analysis', 'assistant'],
    ]);
    expect(state.messages[0]).toEqual(completed);
    expect(state.messages[1].cards).toEqual([{ type: 'contacts', data: [] }]);
    expect(state.messages[2].cards).toEqual([]);
  });

  it('starts a new assistant with an empty text buffer and ignores duplicate starts without wiping history', () => {
    let state = reduceAgentEvents(initialChatUIState({ busy: true }), [
      { type: 'message_start', message: assistant('first') }, { type: 'text_delta', delta: 'First partial reply' },
      { type: 'message_start', message: assistant('second') },
    ]);
    expect(state.streamingText).toBe('');
    expect(state.currentAssistantId).toBe('second');
    state = reduceAgentEvents(state, [{ type: 'text_delta', delta: 'Second reply' },
      { type: 'message_start', message: assistant('second') }]);
    expect(state.streamingText).toBe('Second reply');
    const ended = reduceAgentEvents(state, [{ type: 'message_end', message: { ...assistant('second'), content: 'Complete authoritative second reply' } }]);
    const replayed = reduceAgentEvents(ended, [{ type: 'message_start', message: assistant('second') }, { type: 'text_delta', delta: 'Stale delta' }]);
    expect(replayed.messages.find(message => message.id === 'second')?.content).toBe('Complete authoritative second reply');
    expect(replayed.streamingText).toBe('');
    expect(replayed.currentAssistantId).toBeUndefined();
  });

  it('ignores deltas without an active owner and lets message_end replace the preview with full authoritative prose', () => {
    const text = 'Complete authoritative paragraph. '.repeat(80);
    const state = reduceAgentEvents(initialChatUIState(), [
      { type: 'text_delta', delta: 'Orphaned delta' }, { type: 'message_start', message: assistant('active') },
      { type: 'text_delta', delta: 'Preview' }, { type: 'message_end', message: { ...assistant('active'), content: text } },
      { type: 'text_delta', delta: 'Late suffix' }, { type: 'done' },
    ]);
    expect(state.messages[0].content).toBe(text);
    expect(state.streamingText).toBe('');
    expect(state.busy).toBe(false);
  });

  it('does not let a historical start steal the current streaming owner or remove its completed cards', () => {
    const old = { ...assistant('old'), content: 'Original complete answer', cards: [{ type: 'mfa' as const, actionId: 'action', status: 'executed' }] };
    const state = reduceAgentEvents(initialChatUIState({ messages: [old] }), [
      { type: 'message_start', message: assistant('current') }, { type: 'text_delta', delta: 'Current preview' },
      { type: 'message_start', message: assistant('old') },
    ]);
    expect(state.currentAssistantId).toBe('current');
    expect(state.streamingText).toBe('Current preview');
    expect(state.messages[0]).toBe(old);
  });

  it('reports reply phases without previewing unpublished text and clears progress on completion', () => {
    const active = initialChatUIState({ busy: true });
    for (const phase of ['generating', 'checking', 'repairing'] as const) {
      const state = reduceAgentEvents(active, [{ type: 'reply_progress', phase }]);
      expect(state.replyPhase).toBe(phase);
      expect(state.streamingText).toBe('');
      const markup = renderToStaticMarkup(createElement(StreamingText, { text: '', active: true, phase }));
      expect(markup).toContain(createTranslator('zh-CN')(`chat.replyProgress.${phase}`));
      expect(markup).not.toContain('data-assistant-content');
    }
    const done = reduceAgentEvents(active, [{ type: 'reply_progress', phase: 'repairing' }, { type: 'done' }, { type: 'reply_progress', phase: 'generating' }]);
    expect(done.replyPhase).toBeUndefined();
    expect(beginAgentRequest({ ...active, replyPhase: 'checking' }).replyPhase).toBeUndefined();
  });

  it('settles an independent call before the subsequent assistant analysis is published', () => {
    const message = toolMessage('subscription-row');
    const events: AgentStreamEvent[] = [
      { type: 'message_start', message }, { type: 'message_end', message },
      { type: 'tool_start', toolEvent: subscriptionCall },
      { type: 'tool_end', toolEvent: { ...subscriptionCall, status: 'success', summary: 'Six subscriptions found' } },
      { type: 'message_start', message: assistant('final-message') },
      { type: 'message_end', message: { ...assistant('final-message'), content: 'Subscription result' } },
      { type: 'done' },
    ];
    const state = reduceAgentEvents(initialChatUIState(), serialized(events));
    expect(state.messages[0].toolEvents).toEqual([{ ...subscriptionCall, status: 'success', summary: 'Six subscriptions found' }]);
    expect(state.messages[1].toolEvents).toEqual([]);
    expect(state.toolEvents[0].status).toBe('success');
  });

  it('preserves the latest terminal outcome when an older message snapshot arrives', () => {
    const message = toolMessage('subscription-row');
    const initial = initialChatUIState({ messages: [{ ...message, cards: [{ type: 'subscriptions', data: [] }] }] });
    const next = reduceAgentEvents(initial, [
      { type: 'tool_end', toolEvent: { ...subscriptionCall, status: 'success' } },
      { type: 'message_end', message },
      { type: 'tool_start', toolEvent: subscriptionCall },
    ]);
    expect(next.messages[0].toolEvents?.[0].status).toBe('success');
    expect(next.messages[0].cards).toEqual([{ type: 'subscriptions', data: [] }]);
    expect(next.toolEvents[0].status).toBe('success');
    expect(initial.messages[0].toolEvents?.[0].status).toBe('started');
  });

  it('starts a new request with no stale footer activity and preserves the historical call', () => {
    const blocked: ToolEventView = { ...subscriptionCall, status: 'blocked', actionId: 'subscription-action' };
    const state = initialChatUIState({ toolEvents: [blocked], messages: [toolMessage('old-message', blocked)],
      streamingText: 'Old text', lastBlockedToolName: 'list_subscriptions' });
    const next = beginAgentRequest(state);
    expect(next.toolEvents).toEqual([]);
    expect(next.streamingText).toBe('');
    expect(next.lastBlockedToolName).toBeUndefined();
    expect(next.messages).toEqual(state.messages);
    expect(next.busy).toBe(true);
  });

  it('does not end another active response when an authorized historical message snapshot arrives', () => {
    const current = assistant('current-message');
    const old = toolMessage('old-message', { ...subscriptionCall, status: 'success', actionId: 'old-action' });
    const state = reduceAgentEvents(initialChatUIState({ messages: [old] }), [
      { type: 'message_start', message: current }, { type: 'text_delta', delta: 'Current reply' },
      { type: 'message_end', message: old },
    ]);
    expect(state.currentAssistantId).toBe('current-message');
    expect(state.streamingText).toBe('Current reply');
  });

  it('keeps reused provider call IDs attached to their explicitly identified tool rows', () => {
    const older = toolMessage('old-message', { ...subscriptionCall, status: 'success' });
    const newer = toolMessage('new-message');
    const state = reduceAgentEvents(beginAgentRequest(initialChatUIState({ messages: [older] })), [
      { type: 'message_start', message: newer }, { type: 'message_end', message: newer },
      { type: 'tool_start', toolEvent: { ...subscriptionCall, messageId: newer.id } },
      { type: 'tool_end', toolEvent: { ...subscriptionCall, messageId: newer.id, status: 'blocked', actionId: 'new-action' } },
    ]);
    expect(state.messages[0].toolEvents?.[0]).toEqual({ ...subscriptionCall, messageId: older.id, status: 'success' });
    expect(state.messages[1].toolEvents?.[0]).toEqual({ ...subscriptionCall, messageId: newer.id, status: 'blocked', actionId: 'new-action' });
  });

  it.each([
    ['executed', 'success'], ['failed', 'error'], ['cancelled', 'cancelled'], ['needs_reconciliation', 'needs_reconciliation'],
  ] as const)('settles only the exact authorized action as %s', (status, toolStatus) => {
    const oldCall: ToolEventView = { ...subscriptionCall, status: 'blocked', actionId: 'old-action' };
    const newCall: ToolEventView = { ...subscriptionCall, status: 'blocked', actionId: 'new-action' };
    const state = initialChatUIState({ messages: [assistant('old-message', [oldCall]), assistant('new-message', [newCall])], toolEvents: [newCall] });
    const settled = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'old-action', status }]);
    expect(settled.messages[0].toolEvents?.[0].status).toBe(toolStatus);
    expect(settled.messages[1].toolEvents?.[0]).toEqual(newCall);
    expect(settled.toolEvents).toEqual([newCall]);
  });

  it('publishes and persists the committed outcome on its exact original provider call', () => {
    const older = toolMessage('old-message', { ...subscriptionCall, status: 'blocked', actionId: 'old-action' });
    const newer = toolMessage('new-message', { ...subscriptionCall, status: 'blocked', actionId: 'new-action' });
    const transcript = [older, newer];
    const buffer = createTurnBuffer();
    publishAuthorizedToolOutcome(buffer, transcript, { sessionId: 'session', toolCallId: subscriptionCall.toolCallId,
      toolName: 'list_subscriptions', actionId: 'old-action', toolResult: { ok: true, data: [], summary: 'Six subscriptions found' } });
    expect(transcript[0].toolEvents?.[0]).toEqual({ ...subscriptionCall, messageId: older.id, actionId: 'old-action', status: 'success', summary: 'Six subscriptions found' });
    expect(transcript[1].toolEvents?.[0].status).toBe('blocked');
    expect(buffer.events).toMatchObject([
      { type: 'tool_end', toolEvent: { actionId: 'old-action', status: 'success' } },
      { type: 'card', messageId: older.id, card: { type: 'subscriptions', data: [] } },
      { type: 'message_end', message: { id: 'old-message', toolEvents: [{ status: 'success' }] } },
    ]);
    const ui = reduceAgentEvents(initialChatUIState({ messages: [older, newer] }), serialized(buffer.events));
    expect(ui.messages[0].toolEvents?.[0].status).toBe('success');
    expect(ui.messages[1].toolEvents?.[0].status).toBe('blocked');
  });

  it('does not settle a separately stamped action with identical financial details', () => {
    const action: PendingActionSummary = { actionId: 'old-action', title: 'Read subscriptions', toolName: 'list_subscriptions', tier: 'YELLOW', requiresMfa: false, fields: [] };
    const state = initialChatUIState({ pendingAction: { kind: 'confirmation', actionId: 'old-action', summary: action },
      messages: [{ ...assistant('cards'), cards: [
        { type: 'confirmation', action },
        { type: 'confirmation', action: { ...action, actionId: 'new-action' } },
      ] }] });
    const next = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'old-action', status: 'executed' }]);
    expect(next.messages[0].cards?.[0]).toHaveProperty('action.status', 'executed');
    expect(next.messages[0].cards?.[1]).not.toHaveProperty('action.status');
  });

  it('does not reopen a settled card when a historical provider snapshot is replayed', () => {
    const action: PendingActionSummary = { actionId: 'subscription-action', title: 'Read subscriptions', toolName: 'list_subscriptions', tier: 'YELLOW', requiresMfa: false, fields: [] };
    const message: ChatMessage = { ...assistant('card'), cards: [{ type: 'confirmation', action }] };
    const settled = reduceAgentEvents(initialChatUIState({ messages: [message] }), [
      { type: 'action_settled', actionId: 'subscription-action', status: 'executed' },
      { type: 'message_end', message },
    ]);
    expect(settled.messages[0].cards?.[0]).toHaveProperty('action.status', 'executed');
  });
});
