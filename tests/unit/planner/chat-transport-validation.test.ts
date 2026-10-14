import { describe, expect, it } from 'vitest';
import { isAgentStreamEvent, isChatMessage, isTaskPlan } from '@/components/chat/transport-validation';
import { isChatHistoryPage } from '@/components/chat/history';
import type { ChatMessage } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';

const message: ChatMessage = { id: 'assistant', role: 'assistant', content: 'Complete **analysis** with 4.125%.', timestamp: 10 };
const plan: TaskPlan = { id: 'plan', sessionId: 'session', goal: 'Read balances', status: 'running', createdAt: 1, updatedAt: 2,
  nodes: [{ id: 'node', name: 'Read balances', kind: 'tool', tool: 'get_balance', dependencies: [] }],
  results: [{ id: 'node', name: 'Read balances', tool: 'get_balance', status: 'running' }] };

describe('renderer-safe transport boundaries', () => {
  it('accepts complete assistant prose without rewriting or truncating financial strings', () => {
    const input = { ...message, content: `${message.content}\n\n${'Complete paragraph. '.repeat(500)}` };
    expect(isChatMessage(input)).toBe(true);
    expect(isAgentStreamEvent({ type: 'message_end', message: input })).toBe(true);
    expect(input.content).toContain('4.125%');
  });

  it('accepts only the closed public reply progress phases', () => {
    for (const phase of ['generating', 'checking', 'repairing']) expect(isAgentStreamEvent({ type: 'reply_progress', phase })).toBe(true);
    expect(isAgentStreamEvent({ type: 'reply_progress', phase: 'Private internal prompt correction' })).toBe(false);
  });

  it.each([
    { type: 'message_end', message: { ...message, content: { analysis: 'Private protocol object' } } },
    { type: 'message_start', message: { ...message, role: 'invalid' } },
    { type: 'message_end', message: { ...message, timestamp: 8_640_000_000_000_001 } },
    { type: 'text_delta', delta: { text: 'Invalid delta' } },
    { type: 'tool_end', toolEvent: { toolCallId: 'call', toolName: 'get_balance', status: 'completed' } },
    { type: 'tool_start', toolEvent: { toolName: 'get_balance', status: 'started' } },
    { type: 'confirmation_required', actionId: 'action', action: { fields: {} } },
    { type: 'card', card: { type: 'spending', data: { byCategory: [] } } },
    { type: 'card', card: { type: 'subscriptions', data: [{ name: 'Subscription', amount: 68 }] } },
    { type: 'card', card: { type: 'invented', data: [] } },
    { type: 'plan_update', plan: { ...plan, results: [{ id: 'node', name: 'Read balances', status: 'finished' }] } },
    { type: 'error', message: { private: 'detail' } },
    { type: 'unknown' },
  ])('rejects malformed frame before it reaches a component: %j', input => {
    expect(isAgentStreamEvent(input)).toBe(false);
  });

  it('requires complete task snapshots for independently restored plan cards', () => {
    expect(isTaskPlan(plan)).toBe(true);
    expect(isTaskPlan({ id: 'plan', nodes: [], results: [] })).toBe(false);
    expect(isTaskPlan({ ...plan, nodes: [{ id: 'node', name: 'Invalid node' }] })).toBe(false);
  });

  it('validates nested cards and tool events in older history pages', () => {
    const page = { messages: [message], hasMore: false, revision: 1, historyGeneration: 'current' };
    expect(isChatHistoryPage(page)).toBe(true);
    expect(isChatHistoryPage({ ...page, messages: [{ ...message, cards: [{ type: 'balance', data: {} }] }] })).toBe(false);
    expect(isChatHistoryPage({ ...page, messages: [{ ...message, toolEvents: [{ toolName: 'get_balance' }] }] })).toBe(false);
  });

  it('accepts canonical query cards and a locked verification card', () => {
    expect(isChatMessage({ ...message, role: 'system', content: '', cards: [
      { type: 'subscriptions', data: [{ id: 'subscription', name: 'Subscription', amount: '68.00', cycle: 'MONTHLY', nextChargeAt: 10, status: 'ACTIVE', remind: false }] },
      { type: 'spending', data: { month: '2026-10', total: '123.00', prevTotal: '100.00', momChangePct: '23', byCategory: [{ category: 'Food', amount: '123.00', share: '100' }],
        monthlyTrend: [{ month: '2026-10', amount: '123.00' }], topMerchant: null, largest: null } },
      { type: 'mfa', actionId: 'action', status: 'locked' },
    ] })).toBe(true);
  });

  it('requires a stable single-call owner and keeps assistant prose separate from business cards', () => {
    const row = { id: 'tool-row', role: 'tool', content: '', timestamp: 1,
      toolEvents: [{ messageId: 'tool-row', toolCallId: 'call', toolName: 'list_subscriptions', status: 'success' }],
      cards: [{ type: 'subscriptions', data: [] }] };
    expect(isChatMessage(row)).toBe(true);
    expect(isAgentStreamEvent({ type: 'message_start', message: row })).toBe(true);
    expect(isAgentStreamEvent({ type: 'card', messageId: row.id, card: row.cards[0] })).toBe(true);
    expect(isAgentStreamEvent({ type: 'plan_update', messageId: row.id, plan })).toBe(true);
    expect(isChatMessage({ ...row, content: 'Private result protocol' })).toBe(false);
    expect(isChatMessage({ ...row, toolEvents: [] })).toBe(false);
    expect(isChatMessage({ ...row, toolEvents: [row.toolEvents[0], row.toolEvents[0]] })).toBe(false);
    expect(isChatMessage({ ...row, toolEvents: [{ ...row.toolEvents[0], messageId: 'different-row' }] })).toBe(false);
    expect(isChatMessage({ ...message, cards: row.cards })).toBe(false);
    expect(isChatMessage({ ...message, toolEvents: row.toolEvents })).toBe(false);
  });
});
