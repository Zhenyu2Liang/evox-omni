import { describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { AgentRunJournal, beginRun } from '@/agent/durable';
import { continueDurableRun, restoreWaitingCheckpoint } from '@/agent/durable/continuation';
import { recoverOwnedRun } from '@/agent/durable/service';
import { encodeCheckpoint } from '@/agent/durable/checkpoint';
import { runtimeRequestDigest } from '@/agent/durable/serialization';
import { completeModelRequest, saveRunCheckpoint, startModelRequest } from '@/lib/db/repositories/agentRun';
import { getOrCreateSession, loadSession } from '@/agent/session';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { toolPresentationId } from '@/agent/tool-presentation-identity';
import type { AppConfig } from '@/lib/config';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import fixtures from '@/tests/fixtures/conversation.zh-CN.json';

useFreshDatabase();
const config: AppConfig = { llmMode: 'live', llmProvider: 'checkpoint-test', llmModel: 'checkpoint-model', demoUserId: 'user_liming' };

function provider() {
  const mock = fauxProvider();
  const models = createModels(); models.setProvider(mock.provider);
  return { mock, runtime: { model: mock.getModel(), streamFn: models.streamSimple.bind(models) } };
}

async function expectNoWrites() {
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  expect(await getTestPrisma().agentTask.count()).toBe(0);
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

describe('typed conversation and independent tool presentation survive durable continuation', () => {
  it.each([false, true])('recovers the original interpretation after a crash with declaration checkpoint saved=%s', async saved => {
    const text = 'Explain how transfer approval works without making a payment.';
    const prose = 'Approval belongs to an individual proposed payment. This explanation does not make a payment.';
    const snapshot = await getOrCreateSession(config.demoUserId);
    snapshot.intent = advanceConversationIntent(undefined, text);
    snapshot.agentState.messages.push({ role: 'user', content: [{ type: 'text', text }], timestamp: 1 });
    const { mock, runtime } = provider();
    snapshot.agentState.model = runtime.model;
    mock.setResponses([fauxAssistantMessage(prose)]);
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: `interpretation-crash-${saved}`, request: { kind: 'input', message: text },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const args = { purpose: 'conversation', operations: [] };
    const source = fauxAssistantMessage([fauxToolCall('describe_turn', args, { id: 'original-interpretation' })], { stopReason: 'toolUse' });
    const input = { messages: snapshot.agentState.messages, requestIntent: snapshot.intent };
    const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
    await completeModelRequest(admitted.lease, model.id, JSON.stringify(source), checkpoint);
    const invocation = await getTestPrisma().toolInvocation.create({ data: {
      runId: admitted.run.id, modelRequestId: model.id, ordinal: 0, callId: 'original-interpretation', toolName: 'describe_turn',
      argsJson: JSON.stringify(args), requestDigest: runtimeRequestDigest('describe_turn', args), operationKey: 'original-interpretation',
      replaySafety: 'read_only', status: 'started', maxAttempts: 3, attempt: 1,
    } });
    if (saved) {
      snapshot.intent = declareConversationIntent(snapshot.intent, 'conversation', []);
      await saveRunCheckpoint(admitted.lease, 'turn_intent', encodeCheckpoint(snapshot, config));
    }
    await new AgentRunJournal(admitted.lease).finish('interrupted');
    const response = await recoverOwnedRun(admitted.run.id, { userId: snapshot.userId, sessionId: snapshot.sessionId }, undefined,
      { config, provider: runtime });
    expect(response.run.status, JSON.stringify(response.outcomes)).toBe('completed');
    expect(response.outcomes).toContainEqual({ invocationId: invocation.id, action: 'retried' });
    const stored = await loadSession(snapshot.sessionId);
    expect(stored?.intent).toMatchObject({ id: snapshot.intent.id, purpose: 'conversation', latestMessage: text });
    expect(stored?.transcript.map(message => message.role)).toEqual(['user', 'assistant']);
    expect(stored?.transcript.at(-1)?.content).toBe(prose);
    expect(mock.state.callCount).toBe(1);
    const recovered = await getTestPrisma().toolInvocation.findUniqueOrThrow({ where: { id: invocation.id } });
    expect(recovered).toMatchObject({ status: 'completed', attempt: 2, callId: 'original-interpretation', modelRequestId: model.id });
    expect(JSON.parse(recovered.resultJson!)).toMatchObject({ ok: true, data: { purpose: 'conversation', operations: [], intentId: snapshot.intent.id } });
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: admitted.run.id } })).toBe(1);
    await expectNoWrites();
  });

  it.each(['YELLOW', 'RED'] as const)('restores the missing %s authorization tool entry after a crash without rerunning the bank operation', async tier => {
    const text = 'Transfer the declared amount after my approval.';
    const amount = tier === 'RED' ? '2000.00' : '200.00';
    const snapshot = await getOrCreateSession(config.demoUserId);
    snapshot.intent = declareConversationIntent(advanceConversationIntent(undefined, text), 'operation', ['transfer_money']);
    snapshot.agentState.messages.push({ role: 'user', content: text, timestamp: 1 });
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: `waiting-presentation-${tier}`, request: { kind: 'input', message: text },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const args = { name: fixtures.recipient, amount };
    const source = fauxAssistantMessage([fauxToolCall('transfer_money', args, { id: 'waiting-call' })], { stopReason: 'toolUse' });
    const input = { messages: snapshot.agentState.messages, requestIntent: snapshot.intent };
    const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
    await completeModelRequest(admitted.lease, model.id, JSON.stringify(source), checkpoint);
    const status = tier === 'RED' ? 'waiting_verification' : 'waiting_confirmation';
    const invocation = await getTestPrisma().toolInvocation.create({ data: {
      runId: admitted.run.id, modelRequestId: model.id, ordinal: 0, callId: 'waiting-call', toolName: 'transfer_money',
      argsJson: JSON.stringify(args), requestDigest: runtimeRequestDigest('transfer_money', args), operationKey: 'original-waiting-transfer',
      replaySafety: 'idempotent', status, resultJson: JSON.stringify({ ok: false }),
    } });
    const action = await getTestPrisma().pendingAction.create({ data: {
      sessionId: snapshot.sessionId, userId: snapshot.userId, invocationId: invocation.id, toolName: 'transfer_money',
      argsJson: JSON.stringify(args), riskLevel: tier, requiresMfa: tier === 'RED', status: tier === 'RED' ? 'awaiting_mfa' : 'pending',
      summaryJson: JSON.stringify({ title: 'Transfer', toolName: 'transfer_money', tier, requiresMfa: tier === 'RED', amount,
        fields: [{ label: 'Amount', value: amount }] }),
    } });
    const journal = new AgentRunJournal(admitted.lease);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    await restoreWaitingCheckpoint(run, journal, [invocation], { config });
    const stored = await loadSession(snapshot.sessionId);
    expect(stored?.transcript.map(message => message.role)).toEqual(['user', 'tool']);
    const entry = stored?.transcript[1];
    const messageId = toolPresentationId(run.id, model.id, 'waiting-call');
    expect(entry).toMatchObject({ id: messageId, content: '',
      toolEvents: [{ toolCallId: 'waiting-call', toolName: 'transfer_money', messageId, actionId: action.id, status: 'blocked' }] });
    expect(entry?.cards).toHaveLength(1);
    if (tier === 'RED') expect(entry?.cards?.[0]).toMatchObject({ type: 'mfa', actionId: action.id, action: { tier: 'RED', amount } });
    else expect(entry?.cards?.[0]).toMatchObject({ type: 'confirmation', action: { actionId: action.id, tier: 'YELLOW', amount } });
    expect(stored?.agentState.messages.some(message => message.role === 'toolResult' &&
      message.toolCallId === 'waiting-call' && message.isError)).toBe(true);
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: run.id } })).toBe(1);
    expect(await getTestPrisma().pendingAction.count()).toBe(1);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    const events = await getTestPrisma().agentRunEvent.findMany({ where: { runId: run.id, channel: 'ui' } });
    expect(events.some(event => event.eventType === 'message_end' && JSON.parse(event.payloadJson).message.id === messageId)).toBe(true);
    const committed = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: run.id } });
    await restoreWaitingCheckpoint(committed, journal, [invocation], { config });
    expect((await loadSession(snapshot.sessionId))?.transcript).toEqual(stored?.transcript);
    expect(await getTestPrisma().agentRunEvent.count({ where: { runId: run.id, channel: 'ui' } })).toBe(events.length);
    await journal.finish(status);
  });

  it('passes the original signed question to the model after input-stage recovery rather than making a lexical decision', async () => {
    const text = 'Explain why -10 is an invalid amount, without initiating a transfer.';
    const prose = 'The minus sign means a negative value. A bank transfer requires a positive amount, but discussing -10 does not authorize a payment.';
    const snapshot = await getOrCreateSession(config.demoUserId);
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: 'signed-explanation-recovery', request: { kind: 'input', message: text },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const { mock, runtime } = provider();
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'conversation', operations: [] })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(prose),
    ]);
    const journal = new AgentRunJournal(admitted.lease);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    const result = await continueDurableRun(run, journal, [], { config, provider: runtime });
    await journal.finish(result);
    expect(result).toBe('completed');
    expect(mock.state.callCount).toBe(2);
    const stored = await loadSession(snapshot.sessionId);
    expect(stored?.intent?.purpose).toBe('conversation');
    expect(stored?.transcript.at(-1)?.content).toBe(prose);
    expect(stored?.transcript.filter(message => message.role === 'user' && message.content === text)).toHaveLength(1);
    expect(stored?.agentState.messages.some(message => message.role === 'user' &&
      (typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('')) === text)).toBe(true);
    expect(stored?.transcript.some(message => message.role === 'tool')).toBe(false);
    await expectNoWrites();
  });

  it('refuses an undeclared stale transfer from a completed model response and keeps the corrective discussion', async () => {
    const text = 'Tell me about the previous discussion.';
    const prose = 'The previous transfer was a topic of discussion. I can explain it without resuming it.';
    const snapshot = await getOrCreateSession(config.demoUserId);
    const { mock, runtime } = provider();
    snapshot.intent = declareConversationIntent(advanceConversationIntent(undefined, text), 'conversation', []);
    snapshot.agentState.model = runtime.model;
    snapshot.agentState.messages.push({ role: 'user', content: text, timestamp: 1 });
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: 'undeclared-write-recovery', request: { kind: 'input', message: text },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const source = fauxAssistantMessage([fauxToolCall('transfer_money', { name: fixtures.recipient, amount: '200.00' }, { id: 'stale-call' })], { stopReason: 'toolUse' });
    const input = { messages: snapshot.agentState.messages, requestIntent: snapshot.intent };
    const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
    await completeModelRequest(admitted.lease, model.id, JSON.stringify(source), checkpoint);
    mock.setResponses([fauxAssistantMessage(prose)]);
    const journal = new AgentRunJournal(admitted.lease);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    const result = await continueDurableRun(run, journal, [], { config, provider: runtime });
    await journal.finish(result);
    expect(result).toBe('completed');
    const stored = await loadSession(snapshot.sessionId);
    expect(stored?.transcript.at(-1)?.content).toBe(prose);
    expect(stored?.transcript.filter(message => message.role === 'tool')).toMatchObject([
      { toolEvents: [{ toolName: 'transfer_money', status: 'blocked' }] },
    ]);
    expect(stored?.agentState.messages.some(message => message.role === 'assistant' &&
      message.content.some(block => block.type === 'toolCall' && block.id === 'stale-call'))).toBe(true);
    await expectNoWrites();
  });

  it('rebuilds the original completed query entry before the recovered reply without calling the query again', async () => {
    const text = 'Read the accounts and explain the result.';
    const prose = 'The recorded query returned an account list. This answer explains that recorded result.';
    const snapshot = await getOrCreateSession(config.demoUserId);
    const { mock, runtime } = provider();
    snapshot.intent = declareConversationIntent(advanceConversationIntent(undefined, text), 'query', ['get_balance']);
    snapshot.agentState.model = runtime.model;
    snapshot.agentState.messages.push({ role: 'user', content: text, timestamp: 1 });
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: 'completed-query-presentation-recovery', request: { kind: 'input', message: text },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const args = {};
    const source = fauxAssistantMessage([fauxToolCall('get_balance', args, { id: 'balance-call' })], { stopReason: 'toolUse' });
    const input = { messages: snapshot.agentState.messages, requestIntent: snapshot.intent };
    const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
    await completeModelRequest(admitted.lease, model.id, JSON.stringify(source), checkpoint);
    const invocation = await getTestPrisma().toolInvocation.create({ data: {
      runId: admitted.run.id, modelRequestId: model.id, ordinal: 0, callId: 'balance-call', toolName: 'get_balance',
      argsJson: '{}', requestDigest: runtimeRequestDigest('get_balance', args), operationKey: 'original-query',
      replaySafety: 'read_only', status: 'completed', resultJson: JSON.stringify({ ok: true, data: { accounts: [] }, summary: 'Recorded account query.' }),
    } });
    mock.setResponses([fauxAssistantMessage(prose)]);
    const journal = new AgentRunJournal(admitted.lease);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    const result = await continueDurableRun(run, journal, [invocation], { config, provider: runtime });
    await journal.finish(result);
    expect(result).toBe('completed');
    expect(mock.state.callCount).toBe(1);
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: run.id } })).toBe(1);
    const stored = await loadSession(snapshot.sessionId);
    expect(stored?.transcript.map(message => message.role)).toEqual(['user', 'tool', 'assistant']);
    expect(stored?.transcript[1]).toMatchObject({ id: toolPresentationId(run.id, model.id, 'balance-call'),
      content: '', cards: [{ type: 'balance', data: { accounts: [] } }], toolEvents: [{ status: 'success' }] });
    expect(stored?.transcript[2]).toMatchObject({ content: prose, cards: [], toolEvents: [] });
    await expectNoWrites();
  });
});
