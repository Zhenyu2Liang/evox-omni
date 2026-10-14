import { describe, expect, it, vi } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { activePlanMessage, createTurnBuffer, publishAuthorizedToolOutcome, readyPresentationEvents } from '@/agent/turns/buffer';
import { createEventHandler } from '@/agent/turns/events';
import { normalizePresentationMessages } from '@/agent/transcript-presentation';
import type { ChatMessage } from '@/lib/contracts/agent';
import { security } from '@/security';
import { renderBankingGuidance } from '@/agent/banking-guidance';

vi.mock('@/security', () => ({ security: { gateway: {
  BLOCK_REASON_PREFIX: 'BLOCK:', securityGateway: { parseBlockReason: () => null },
} } }));

async function runQueries(runId = 'run-1', timestamp = 10, modelRequestId?: string) {
  const buffer = createTurnBuffer('Read both query periods.');
  buffer.events.push({ type: 'session', sessionId: 'session', runId });
  let requestIdentity = modelRequestId;
  const handler = createEventHandler(buffer, () => timestamp, undefined, () => requestIdentity);
  const source = fauxAssistantMessage([
    fauxToolCall('list_subscriptions', { period: 'first' }, { id: 'first-call' }),
    fauxToolCall('list_subscriptions', { period: 'second' }, { id: 'second-call' }),
  ], { timestamp, stopReason: 'toolUse' });
  await handler({ type: 'message_start', message: source });
  await handler({ type: 'message_end', message: source });
  for (const call of source.content.filter(part => part.type === 'toolCall')) {
    await handler({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, args: call.arguments });
  }
  // Completion order can differ from start order, without changing either owner.
  for (const callId of ['second-call', 'first-call']) {
    await handler({ type: 'tool_execution_end', toolCallId: callId, toolName: 'list_subscriptions',
      result: { content: [{ type: 'text', text: `Result for ${callId}` }], details: [{ id: callId }] }, isError: false });
  }
  const reply = fauxAssistantMessage('Here is my complete analysis. Both queries are historical snapshots.', { timestamp: timestamp + 1 });
  requestIdentity = modelRequestId ? `${modelRequestId}:reply` : undefined;
  await handler({ type: 'message_start', message: reply });
  await handler({ type: 'message_end', message: reply });
  return { buffer, source, reply };
}

describe('ordered backend tool presentation', () => {
  it('preserves complete model prose before and after a tool call as separate ordered messages', async () => {
    const buffer = createTurnBuffer('Explain and query the subscriptions.');
    buffer.events.push({ type: 'session', sessionId: 'session', runId: 'ordered-run' });
    const handler = createEventHandler(buffer, () => 1);
    const introductoryText = 'I will query the subscriptions, then explain the recorded amounts in context.';
    const source = fauxAssistantMessage([{ type: 'text', text: introductoryText },
      fauxToolCall('list_subscriptions', {}, { id: 'query' })], { timestamp: 1, stopReason: 'toolUse' });
    await handler({ type: 'message_start', message: source });
    await handler({ type: 'message_end', message: source });
    await handler({ type: 'tool_execution_start', toolCallId: 'query', toolName: 'list_subscriptions', args: {} });
    await handler({ type: 'tool_execution_end', toolCallId: 'query', toolName: 'list_subscriptions',
      result: { content: [{ type: 'text', text: 'No active subscriptions.' }], details: [] }, isError: false });
    const concludingText = 'There are no active subscriptions in this query. This does not establish your historical spending.';
    const conclusion = fauxAssistantMessage(concludingText, { timestamp: 2 });
    await handler({ type: 'message_start', message: conclusion });
    await handler({ type: 'message_end', message: conclusion });
    expect(buffer.assistants.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(buffer.assistants[0].content).toBe(introductoryText);
    expect(buffer.assistants[2].content).toBe(concludingText);
    expect(buffer.assistants.filter(message => message.role === 'assistant').every(message =>
      !message.cards?.length && !message.toolEvents?.length)).toBe(true);
    const starts = buffer.events.filter(event => event.type === 'message_start');
    expect(starts.map(event => event.message.id)).toEqual(buffer.assistants.map(message => message.id));
  });

  it('saves one independent entry per call followed by complete prose, with cards on their exact owner', async () => {
    const { buffer, source, reply } = await runQueries();
    expect(buffer.assistants.map(message => message.role)).toEqual(['tool', 'tool', 'assistant']);
    const [first, second, prose] = buffer.assistants;
    expect(first.toolEvents).toHaveLength(1);
    expect(second.toolEvents).toHaveLength(1);
    expect(first.toolEvents?.[0]).toMatchObject({ toolCallId: 'first-call', messageId: first.id, status: 'success' });
    expect(second.toolEvents?.[0]).toMatchObject({ toolCallId: 'second-call', messageId: second.id, status: 'success' });
    expect(first.cards).toEqual([{ type: 'subscriptions', data: [{ id: 'first-call' }] }]);
    expect(second.cards).toEqual([{ type: 'subscriptions', data: [{ id: 'second-call' }] }]);
    expect(prose.cards).toEqual([]);
    expect(prose.toolEvents).toEqual([]);
    expect(prose.content).toBe(reply.content[0].type === 'text' ? reply.content[0].text : '');
    expect(source.content.filter(part => part.type === 'toolCall')).toHaveLength(2);
    for (const event of buffer.events) {
      if (event.type === 'card') expect([first.id, second.id]).toContain(event.messageId);
      if (event.type === 'tool_start' || event.type === 'tool_end') expect([first.id, second.id]).toContain(event.toolEvent.messageId);
    }
    const endIds = buffer.events.flatMap(event => event.type === 'message_end' && event.message.role === 'tool' ? [event.message.id] : []);
    expect(endIds).toEqual([second.id, first.id]);
  });

  it('recreates stable call owners after recovery and separates reused call IDs across model responses and runs', async () => {
    const original = await runQueries();
    const recovered = await runQueries();
    const nextResponse = await runQueries('run-1', 20);
    const nextRun = await runQueries('run-2');
    const ids = (run: Awaited<ReturnType<typeof runQueries>>) => run.buffer.assistants.filter(message => message.role === 'tool').map(message => message.id);
    expect(ids(recovered)).toEqual(ids(original));
    expect(ids(nextResponse)).not.toEqual(ids(original));
    expect(ids(nextRun)).not.toEqual(ids(original));
  });

  it('uses durable model request identity when two responses have identical content and timestamps', async () => {
    const first = await runQueries('run-1', 10, 'model-request-1');
    const second = await runQueries('run-1', 10, 'model-request-2');
    const restored = await runQueries('run-1', 10, 'model-request-1');
    expect(first.source).toEqual(second.source);
    const ids = (run: Awaited<ReturnType<typeof runQueries>>) => run.buffer.assistants.filter(message => message.role === 'tool').map(message => message.id);
    expect(ids(first)).not.toEqual(ids(second));
    expect(ids(restored)).toEqual(ids(first));
  });

  it('updates an authorized original call rather than a later identical call or the narration', () => {
    const old: ChatMessage = { id: 'original-tool', role: 'tool', content: '', timestamp: 1, cards: [],
      toolEvents: [{ toolCallId: 'reused', toolName: 'list_subscriptions', messageId: 'original-tool', status: 'blocked', actionId: 'old-action' }] };
    const newer: ChatMessage = { ...old, id: 'newer-tool',
      toolEvents: [{ ...old.toolEvents![0], messageId: 'newer-tool', actionId: 'new-action' }] };
    const prose: ChatMessage = { id: 'prose', role: 'assistant', content: 'A later unrelated discussion.', timestamp: 2 };
    const transcript = [old, newer, prose];
    const buffer = createTurnBuffer();
    publishAuthorizedToolOutcome(buffer, transcript, { sessionId: 'session', toolName: 'list_subscriptions',
      toolCallId: 'reused', actionId: 'old-action', toolResult: { ok: true, data: [], summary: 'Query complete.' } });
    expect(old.toolEvents?.[0]).toMatchObject({ messageId: old.id, status: 'success' });
    expect(old.cards).toEqual([{ type: 'subscriptions', data: [] }]);
    expect(newer.toolEvents?.[0].status).toBe('blocked');
    expect(prose.cards).toBeUndefined();
    expect(buffer.events.filter(event => event.type === 'card')).toMatchObject([{ messageId: old.id }]);
    expect(buffer.events.at(-1)).toMatchObject({ type: 'message_end', message: { id: old.id, role: 'tool' } });
  });

  it('preserves an unknown committed outcome instead of displaying a definite failure', () => {
    const message: ChatMessage = { id: 'uncertain-tool', role: 'tool', content: '', timestamp: 1, cards: [],
      toolEvents: [{ toolCallId: 'call', toolName: 'transfer_money', messageId: 'uncertain-tool', status: 'blocked', actionId: 'action' }] };
    const buffer = createTurnBuffer();
    publishAuthorizedToolOutcome(buffer, [message], { sessionId: 'session', toolCallId: 'call', toolName: 'transfer_money',
      actionId: 'action', toolResult: { ok: false, data: { outcome: 'unknown' } } });
    expect(message.toolEvents?.[0].status).toBe('needs_reconciliation');
    expect(message.cards).toEqual([]);
  });

  it('keeps sequential workflow authorizations attached to the same original plan entry', () => {
    const message: ChatMessage = { id: 'plan-tool', role: 'tool', content: '', timestamp: 1,
      toolEvents: [{ toolCallId: 'plan-call', toolName: 'submit_plan', messageId: 'plan-tool', status: 'success', actionId: 'first-action' }],
      cards: [{ type: 'mfa', actionId: 'first-action' }, { type: 'mfa', actionId: 'second-action' }] };
    const buffer = createTurnBuffer();
    publishAuthorizedToolOutcome(buffer, [message], { sessionId: 'session', toolCallId: 'plan-call', toolName: 'submit_plan',
      resultToolName: 'freeze_card', actionId: 'second-action', toolResult: { ok: true, data: { id: 'second-card', status: 'FROZEN' } } });
    expect(message.toolEvents?.[0]).toMatchObject({ actionId: 'second-action', messageId: message.id });
    expect(message.cards?.at(-1)).toEqual({ type: 'cards', data: [{ id: 'second-card', status: 'FROZEN' }] });
    expect(activePlanMessage(buffer)).toBe(message);
    expect(buffer.events.at(-1)).toMatchObject({ type: 'message_end', message: { id: message.id, role: 'tool' } });
  });

  it('does not expose internal turn declarations as tool rows, cards or business facts', async () => {
    const buffer = createTurnBuffer('Explain banking rules.');
    const handler = createEventHandler(buffer, () => 1);
    await handler({ type: 'tool_execution_start', toolCallId: 'meta', toolName: 'describe_turn', args: { purpose: 'conversation' } });
    await handler({ type: 'tool_execution_update', toolCallId: 'meta', toolName: 'describe_turn', args: {}, partialResult: { content: [], details: {} } });
    await handler({ type: 'tool_execution_end', toolCallId: 'meta', toolName: 'describe_turn', result: { content: [], details: {} }, isError: false });
    expect(buffer.events).toEqual([]);
    expect(buffer.assistants).toEqual([]);
    expect(buffer.factResults).toEqual([]);
  });

  it('ends the independent tool entry even when its presentation adapter fails', async () => {
    const buffer = createTurnBuffer();
    const handler = createEventHandler(buffer, () => 1);
    const parser = vi.spyOn(security.gateway.securityGateway, 'parseBlockReason').mockImplementationOnce(() => {
      throw new Error('The presentation parser failed.');
    });
    try {
      await handler({ type: 'tool_execution_start', toolCallId: 'failed', toolName: 'get_balance', args: {} });
      await handler({ type: 'tool_execution_end', toolCallId: 'failed', toolName: 'get_balance',
        result: { content: [{ type: 'text', text: 'Operation failed.' }], details: {} }, isError: true });
    } finally { parser.mockRestore(); }
    expect(buffer.assistants[0].toolEvents?.[0].status).toBe('error');
    expect(buffer.events.some(event => event.type === 'message_end' && event.message.id === buffer.assistants[0].id)).toBe(true);
    expect(buffer.events.some(event => event.type === 'error')).toBe(true);
  });

  it('publishes complete text in event order while withholding an unfinished later candidate', async () => {
    const { buffer } = await runQueries();
    const next: ChatMessage = { id: 'unfinished', role: 'assistant', content: '', timestamp: 99, cards: [], toolEvents: [] };
    buffer.events.push({ type: 'message_start', message: next }, { type: 'text_delta', delta: 'Unpublished draft' });
    const visible = readyPresentationEvents(buffer);
    expect(visible.some(event => event.type === 'message_start' && event.message.id === next.id)).toBe(false);
    expect(visible.some(event => event.type === 'text_delta' && event.delta === 'Unpublished draft')).toBe(false);
    expect(visible.filter(event => event.type === 'message_start').map(event => event.message.role)).toEqual(['tool', 'tool', 'assistant']);
    expect(visible.some(event => event.type === 'text_delta' && event.delta.includes('complete analysis'))).toBe(true);
  });

  it('does not derive a server clarification or replace a complete operational explanation from user keywords', () => {
    const buffer = createTurnBuffer('Transfer money and explain the available funding rules.');
    expect(buffer.serverGuidance).toBeUndefined();
    expect(buffer.conversational).toBe(true);
  });

  it('renders a validated closed guidance code without inferring missing fields from user text', async () => {
    const buffer = createTurnBuffer('Purchase product A for 1000.66.');
    const handler = createEventHandler(buffer, () => 1);
    const reply = fauxAssistantMessage('{"guidance":{"code":"missing_details","fields":["product","amount"]}}');
    await handler({ type: 'message_start', message: reply });
    await handler({ type: 'message_end', message: reply });
    expect(buffer.current?.content).toBe(renderBankingGuidance({ code: 'missing_details', fields: ['product', 'amount'] }));
    expect(reply.content[0]).toEqual({ type: 'text', text: '{"guidance":{"code":"missing_details","fields":["product","amount"]}}' });
    expect(buffer.factResults).toEqual([]);
  });

  it('splits saved mixed presentations without changing the original prose or assigning ambiguous cards to a random call', () => {
    const legacy: ChatMessage = { id: 'mixed', role: 'assistant', content: 'Complete original explanation.', timestamp: 1,
      toolEvents: [
        { toolCallId: 'a', toolName: 'list_subscriptions', status: 'success' },
        { toolCallId: 'b', toolName: 'list_subscriptions', status: 'blocked', actionId: 'action-b' },
      ], cards: [{ type: 'subscriptions', data: [] }, { type: 'mfa', actionId: 'action-b' }] };
    const result = normalizePresentationMessages([legacy]);
    expect(result.map(message => message.role)).toEqual(['tool', 'tool', 'system', 'assistant']);
    expect(result[0].cards).toEqual([]);
    expect(result[1].cards).toEqual([{ type: 'mfa', actionId: 'action-b' }]);
    expect(result[2].cards).toEqual([{ type: 'subscriptions', data: [] }]);
    expect(result[3]).toMatchObject({ id: legacy.id, content: legacy.content, cards: [], toolEvents: [] });
    expect(normalizePresentationMessages(result)).toEqual(result);
    expect(legacy.toolEvents).toHaveLength(2);
    expect(legacy.cards).toHaveLength(2);
  });
});
