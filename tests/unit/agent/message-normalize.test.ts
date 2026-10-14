import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { findToolCallOwner, normalizeToolResultMessages, validateToolCallIdentities, withRealToolResult } from '@/agent/message-normalize';

describe('confirmation result attribution', () => {
  it('rejects ambiguous or empty call IDs in one response without banning ID reuse across responses', () => {
    const call = fauxToolCall('get_cards', {}, { id: 'reused' });
    expect(() => validateToolCallIdentities(fauxAssistantMessage([call, { ...call, name: 'get_balance' }]))).toThrow('unique nonempty');
    expect(() => validateToolCallIdentities(fauxAssistantMessage([{ ...call, id: '' }]))).toThrow('unique nonempty');
    expect(() => validateToolCallIdentities(fauxAssistantMessage([call]))).not.toThrow();
    expect(() => validateToolCallIdentities(fauxAssistantMessage([call]))).not.toThrow();
  });
  it('rejects a result with the right call ID but a different tool name', () => {
    const call = fauxToolCall('get_cards', {}, { id: 'cards-call' });
    const owner = fauxAssistantMessage([call]);
    const wrong: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, toolName: 'get_balance',
      content: [{ type: 'text', text: 'Unrelated balance data.' }], isError: false, timestamp: 1 };
    const right: ToolResultMessage = { ...wrong, toolName: call.name, content: [{ type: 'text', text: 'Owned card data.' }] };
    expect(normalizeToolResultMessages([owner, wrong, right])).toEqual([owner, right]);
    expect(normalizeToolResultMessages([owner, wrong])).toEqual([owner]);
  });

  it.each(['search_contact', 'transfer_money'])('preserves earlier %s results when a call id is reused', (earlierName) => {
    const previous: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'reused-id', toolName: earlierName,
      content: [{ type: 'text', text: 'earlier factual result' }], isError: false, timestamp: 1,
    };
    const real: ToolResultMessage = {
      role: 'toolResult', toolCallId: 'reused-id', toolName: 'transfer_money',
      content: [{ type: 'text', text: '已转出200.37元' }], isError: false, timestamp: 3,
    };
    const original = [
      fauxAssistantMessage([fauxToolCall(earlierName, {}, { id: 'reused-id' })], { stopReason: 'toolUse' }),
      previous,
      { role: 'user' as const, content: '再转200.37元', timestamp: 2 },
      fauxAssistantMessage([fauxToolCall('transfer_money', { amount: '200.37' }, { id: 'reused-id' })], { stopReason: 'toolUse' }),
      { ...real, isError: true, content: [{ type: 'text' as const, text: '等待确认' }] },
      fauxAssistantMessage('请确认。'),
    ];
    const updated = withRealToolResult(original, real);
    expect(updated).toHaveLength(6);
    expect(updated.slice(0, 4)).toEqual(original.slice(0, 4));
    expect(updated[1]).toEqual(previous);
    expect(updated[4]).toEqual(real);
    expect(updated[5]).toBe(original[5]);
  });

  it('preserves intervening user dialogue and completed read tool chains during a delayed confirmation', () => {
    const transfer = fauxToolCall('transfer_money', { amount: '200.37' }, { id: 'original-transfer' });
    const read = fauxToolCall('get_balance', {}, { id: 'later-read' });
    const blocked: ToolResultMessage = { role: 'toolResult', toolCallId: transfer.id, toolName: transfer.name,
      content: [{ type: 'text', text: 'Waiting for confirmation.' }], isError: true, timestamp: 1 };
    const real: ToolResultMessage = { ...blocked, content: [{ type: 'text', text: 'The original transfer completed.' }], isError: false, timestamp: 9 };
    const tail: AgentMessage[] = [
      fauxAssistantMessage('Review the original transfer card.'),
      { role: 'user', content: 'Tell me a joke.', timestamp: 3 },
      fauxAssistantMessage('A short joke.'),
      { role: 'user', content: 'Query my balance.', timestamp: 4 },
      fauxAssistantMessage([read]),
      { role: 'toolResult', toolCallId: read.id, toolName: read.name,
        content: [{ type: 'text', text: 'A later account query.' }], isError: false, timestamp: 5 },
      fauxAssistantMessage('The balance query is complete.'),
      { role: 'user', content: 'Remember I previously mentioned -200.', timestamp: 7 },
      fauxAssistantMessage('The minus sign is part of your original wording.'),
    ];
    const original = [fauxAssistantMessage([transfer]), blocked, ...tail];
    const saved = JSON.stringify(original);
    const updated = withRealToolResult(original, real);
    expect(updated).toEqual([original[0], real, ...tail]);
    expect(updated.slice(2)).toEqual(tail);
    expect(normalizeToolResultMessages(updated)).toEqual(updated);
    expect(withRealToolResult(updated, real)).toEqual(updated);
    expect(JSON.stringify(original)).toBe(saved);
  });

  it('inserts a missing original result inside its parallel result group and preserves the full later tail', () => {
    const first = fauxToolCall('get_balance', {}, { id: 'first' });
    const second = fauxToolCall('get_cards', {}, { id: 'second' });
    const sibling: ToolResultMessage = { role: 'toolResult', toolCallId: first.id, toolName: first.name,
      content: [{ type: 'text', text: 'Original balance result.' }], isError: false, timestamp: 1 };
    const result: ToolResultMessage = { ...sibling, toolCallId: second.id, toolName: second.name,
      content: [{ type: 'text', text: 'Committed card result.' }] };
    const tail: AgentMessage[] = [{ role: 'user', content: 'What else can you do?', timestamp: 2 }, fauxAssistantMessage('Several banking queries.')];
    const original = [fauxAssistantMessage([first, second]), sibling, ...tail];
    const updated = withRealToolResult(original, result);
    expect(updated).toEqual([original[0], sibling, result, ...tail]);
    expect(normalizeToolResultMessages(updated)).toEqual(updated);
  });

  it('does not invent an orphan result when the original provider call is unavailable', () => {
    const original: AgentMessage[] = [{ role: 'user', content: 'Hello.', timestamp: 1 }, fauxAssistantMessage('Hello.')];
    const real: ToolResultMessage = { role: 'toolResult', toolCallId: 'missing-call', toolName: 'transfer_money',
      content: [{ type: 'text', text: 'A separately recorded committed outcome.' }], isError: false, timestamp: 2 };
    expect(withRealToolResult(original, real)).toEqual(original);
    expect(withRealToolResult([], real)).toEqual([]);
  });

  it('attributes a delayed result to its saved assistant when newer writes reuse the same ID and tool name', () => {
    const oldCall = fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.00' }, { id: 'reused-write' });
    const newCall = fauxToolCall('transfer_money', { amount: '300.00', contactId: 'contact_zhangwei' }, { id: 'reused-write' });
    const original = fauxAssistantMessage([oldCall], { timestamp: 10, stopReason: 'toolUse' });
    const later = fauxAssistantMessage([newCall], { timestamp: 10, stopReason: 'toolUse' });
    const waiting: ToolResultMessage = { role: 'toolResult', toolCallId: oldCall.id, toolName: oldCall.name,
      content: [{ type: 'text', text: 'Original confirmation is still pending.' }], isError: true, timestamp: 11 };
    const nextWaiting: ToolResultMessage = { ...waiting, content: [{ type: 'text', text: 'A later independent confirmation is pending.' }] };
    const newerQuestion: AgentMessage = { role: 'user', content: 'Create another transfer of 300.00.', timestamp: 12 };
    const messages = [original, waiting, newerQuestion, later, nextWaiting, fauxAssistantMessage('Review both operations separately.')];
    const real: ToolResultMessage = { ...waiting, content: [{ type: 'text', text: 'The original 200.00 transfer completed.' }], isError: false };
    const savedOwner = JSON.parse(JSON.stringify(original));
    savedOwner.content[0].arguments = { amount: '200.00', contactId: 'contact_zhangwei' };
    expect(findToolCallOwner(messages, oldCall.id, oldCall.name, savedOwner)).toBe(0);
    expect(withRealToolResult(messages, real, savedOwner)).toEqual([original, real, ...messages.slice(2)]);
    expect(withRealToolResult(messages, real, savedOwner)[4]).toBe(nextWaiting);
  });

  it('distinguishes identical call arguments by original assistant identity and rejects an ambiguous cloned owner', () => {
    const call = fauxToolCall('transfer_money', { amount: '200.00' }, { id: 'reused-identical' });
    const original = fauxAssistantMessage([call], { timestamp: 10, responseId: 'response-first' });
    const later = fauxAssistantMessage([call], { timestamp: 20, responseId: 'response-second' });
    const waiting: ToolResultMessage = { role: 'toolResult', toolCallId: call.id, toolName: call.name,
      content: [{ type: 'text', text: 'Waiting.' }], isError: true, timestamp: 11 };
    const real = { ...waiting, isError: false };
    const messages = [original, waiting, later, waiting];
    expect(withRealToolResult(messages, real, original)).toEqual([original, real, later, waiting]);
    expect(withRealToolResult(messages, real, { ...original, api: 'different-api' })).toEqual(messages);
    expect(withRealToolResult(messages, real, null)).toEqual(messages);
    const ambiguous = [original, waiting, { ...original }, waiting];
    expect(findToolCallOwner(ambiguous, call.id, call.name, original)).toBe(-1);
    expect(withRealToolResult(ambiguous, real, original)).toEqual(ambiguous);
  });
});
