import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { collectConversationEvidence } from '@/agent/conversation-evidence';

function query(details: unknown, isError = false): AgentMessage[] {
  const call = fauxToolCall('get_balance', {}, { id: 'read' });
  return [fauxAssistantMessage([call]), { role: 'toolResult', toolName: 'get_balance', toolCallId: 'read',
    content: [{ type: 'text', text: 'A query result.' }], details, isError, timestamp: 1 } as AgentMessage];
}

describe('conversation evidence', () => {
  it('accepts both successful SDK data and explicit successful result envelopes', () => {
    const data = { totalAvailable: '200.37', accounts: [{ id: 'checking', type: 'CHECKING', balance: '200.37' }] };
    for (const details of [data, { ok: true, data }]) {
      expect(collectConversationEvidence(query(details))).toEqual([{ toolName: 'get_balance', toolCallId: 'read', result: { ok: true, data } }]);
    }
  });

  it('does not trust assistant prose, failed results or orphan tool messages', () => {
    expect(collectConversationEvidence([fauxAssistantMessage('Your balance is $200.37.')])).toEqual([]);
    expect(collectConversationEvidence(query({ balance: '200.37' }, true))).toEqual([]);
    expect(collectConversationEvidence(query({ ok: false, data: { balance: '200.37' } }))).toEqual([]);
    expect(collectConversationEvidence(query({ balance: '200.37' }).slice(1))).toEqual([]);
  });

  it('does not interpret a model-authored plan payload as account evidence', () => {
    const messages = query({ totalAvailable: '999999.00' });
    const call = fauxToolCall('submit_plan', {}, { id: 'read' });
    messages[0] = fauxAssistantMessage([call]);
    messages[1] = { ...messages[1], toolName: 'submit_plan' } as AgentMessage;
    expect(collectConversationEvidence(messages)).toEqual([]);
  });

  it('retains structured unknown write outcomes instead of silently keeping only an old balance', () => {
    const messages = query({ accounts: [{ id: 'checking', type: 'CHECKING', balance: '200.37' }] });
    const call = fauxToolCall('transfer_money', { amount: '10.00' }, { id: 'unknown-write' });
    messages.push(fauxAssistantMessage([call]), { role: 'toolResult', toolName: 'transfer_money', toolCallId: call.id,
      content: [{ type: 'text', text: 'The outcome needs reconciliation.' }],
      details: { ok: false, data: { outcome: 'unknown' } }, isError: true, timestamp: 2 } as AgentMessage);
    const evidence = collectConversationEvidence(messages);
    expect(evidence).toHaveLength(2);
    expect(evidence[1].result).toEqual({ ok: false, data: { outcome: 'unknown' } });
  });
});
