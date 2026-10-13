import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from '@earendil-works/pi-ai';
import { withRealToolResult } from '@/agent/message-normalize';

describe('confirmation result attribution', () => {
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
    expect(updated).toHaveLength(5);
    expect(updated.slice(0, 4)).toEqual(original.slice(0, 4));
    expect(updated[1]).toEqual(previous);
    expect(updated[4]).toEqual(real);
  });
});
