import { describe, expect, it } from 'vitest';
import { inspectReplyFormat } from '@/agent/reply-format';

describe('complete protocol envelope boundary', () => {
  it.each([
    '{"guidance":{"code":"missing_details","fields":["recipient"],"note":"extra"}}',
    '{"guidance":{"code":"unknown"}}',
    '```json\n{"guidance":{"code":"unknown"}}\n```',
  ])('recognizes a reserved guidance object with an invalid protocol payload: %s', prose => {
    expect(inspectReplyFormat(prose)).toEqual(['guidance_format']);
  });

  it.each(['missing_details', 'ambiguous_selection', 'greeting', 'acknowledgement', 'capabilities'])
  ('does not infer conversational suitability from a valid guidance code: %s', code => {
    expect(inspectReplyFormat(JSON.stringify({ guidance: { code, fields: ['amount'] } }))).toEqual([]);
  });

  it.each(['<think>Private reasoning</think>', '<analysis>Private reasoning</analysis>',
    '{"reasoning_content":"Private reasoning","answer":"Hello"}', '{"thinking":"Private reasoning"}'])
  ('recognizes a complete reasoning envelope: %s', prose => {
    expect(inspectReplyFormat(prose)).toEqual(['reasoning_format']);
  });

  it.each(['{"role":"assistant","content":"Hello"}', '{"type":"assistant","text":"Hello"}',
    '{"assistant":{"content":"Hello"}}', '```json\n{"role":"assistant","content":[{"type":"text","text":"Hello"}]}\n```',
    '{"content":[{"type":"text","text":"Hello"}],"stopReason":"stop","api":"openai-completions","provider":"faux","model":"faux","usage":{}}'])
  ('recognizes a complete assistant message envelope: %s', prose => {
    expect(inspectReplyFormat(prose)).toEqual(['assistant_envelope']);
  });

  it.each(['{"role":"tool","content":"Result"}', '{"toolCallId":"call","toolName":"get_balance","content":"Result"}',
    '{"tool_calls":[{"id":"call","type":"function","function":{"name":"get_balance","arguments":"{}"}}]}'])
  ('recognizes a complete tool envelope: %s', prose => {
    expect(inspectReplyFormat(prose)).toEqual(['tool_envelope']);
  });

  it.each([
    '{"category":"food","amount":"100.00"}', '{"role":"assistant"}', '{"assistant":"person"}',
    '{"toolCallId":"example-ID"}', '{"tool_calls":[{"name":"get_balance"}]}',
    '{"content":[{"type":"text","text":"Hello"}],"stopReason":"stop"}',
    '{"role":"assistant","content":"Hello"', '{"guidance":{"code":"unknown"}',
    'Here is the example:\n```json\n{"role":"assistant","content":"Hello"}\n```',
    '> <think>sample</think>', 'The literal tag is `<analysis>`.',
    'You wrote "<think>sample</think>" earlier.', '<think>quoted tag</think> means reasoning.',
    '<think>quoted tag</think> appears before another example: <think>example</think>',
    'An ordinary analysis mentions amount, recipient, sourceAccountId and REMINDER.',
  ])('keeps ordinary text and incomplete structures outside protocol detection: %s', prose => {
    expect(inspectReplyFormat(prose)).toEqual([]);
  });

  it('permits exact protocol examples only through an explicit typed policy', () => {
    const envelope = '{"role":"assistant","content":"Example"}';
    expect(inspectReplyFormat(envelope)).toEqual(['assistant_envelope']);
    expect(inspectReplyFormat(envelope, { allowProtocolExamples: true })).toEqual([]);
  });
});
