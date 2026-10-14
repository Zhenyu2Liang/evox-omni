import { describe, expect, it } from 'vitest';
import { contentText, createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type ToolCall } from '@earendil-works/pi-ai';
import { loadSession, runTurn, type ModelRuntime } from '@/agent';
import { AgentRunJournal, beginRun } from '@/agent/durable';
import { continueDurableRun } from '@/agent/durable/continuation';
import { encodeCheckpoint } from '@/agent/durable/checkpoint';
import { runtimeRequestDigest } from '@/agent/durable/serialization';
import { getOrCreateSession, saveSession } from '@/agent/session';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { confirmAction } from '@/agent/confirmation';
import { CONVERSATION_GENERATION_FAILED } from '@/agent/conversational-response';
import type { AppConfig } from '@/lib/config';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import { completeModelRequest, startModelRequest } from '@/lib/db/repositories/agentRun';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import fixtures from '@/tests/fixtures/dialogue-turns.zh-CN.json';
import regressions from '@/tests/fixtures/dialogue-regressions.zh-CN.json';
import retiredDraft from '@/tests/fixtures/retired-draft-dialogue.zh-CN.json';
import advice from '@/tests/fixtures/advisory-dialogue.zh-CN.json';

useFreshDatabase();

const config: AppConfig = { llmMode: 'live', llmProvider: 'dialogue-regression', llmModel: 'dialogue-model', demoUserId: 'user_liming' };

function toolCall(name: string, args: ToolCall['arguments'] = {}): FauxResponseStep {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
}

/** Undeclared-provider tests intentionally omit the control call and exercise the real denial. */
function undeclaredProvider(steps: FauxResponseStep[]): { provider: ModelRuntime; calls(): number } {
  const registration = fauxProvider();
  const models = createModels();
  models.setProvider(registration.provider);
  registration.setResponses(steps);
  return { provider: { model: registration.getModel(), streamFn: models.streamSimple.bind(models) },
    calls: () => registration.state.callCount };
}

function finalContent(response: ChatTurnResponse): string {
  return response.events.flatMap(event => event.type === 'message_end' && event.message.role === 'assistant'
    ? [event.message.content] : []).filter(Boolean).at(-1) ?? '';
}

function hasAuthorization(response: ChatTurnResponse): boolean {
  return response.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required');
}

async function expectNoMutation(): Promise<void> {
  const db = getTestPrisma();
  expect(await db.executionReceipt.count()).toBe(0);
  expect(await db.agentTask.count()).toBe(0);
  expect(await db.agentTaskNode.count()).toBe(0);
  expect((await db.scheduledTask.findMany({ orderBy: { id: 'asc' }, select: { id: true } })).map(task => task.id))
    .toEqual(['task_birthday_reminder', 'task_rent_transfer']);
  expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  expect(await db.pendingAction.count({ where: { toolName: { in: ['transfer_money', 'cancel_subscription', 'freeze_card',
    'set_card_limit', 'subscribe_investment', 'redeem_investment', 'create_scheduled_task'] } } })).toBe(0);
}

async function expectNoAuthorization(): Promise<void> {
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  await expectNoMutation();
}

const forbiddenDiscussionCalls: { name: string; args: ToolCall['arguments'] }[] = [
  { name: 'list_subscriptions', args: {} },
  { name: 'transfer_money', args: { contactId: 'contact_zhangwei', amount: '200.37' } },
  { name: 'create_scheduled_task', args: { name: 'Unexpected task', kind: 'TRANSFER', runAtLocal: '2026-11-01T09:00',
    payload: { contactId: 'contact_zhangwei', amount: '200.37' } } },
  { name: 'submit_plan', args: { goal: 'Unexpected transfer', nodes: [{ id: 'transfer', name: 'Transfer', kind: 'tool',
    dependencies: [], tool: 'transfer_money', args: { contactId: 'contact_zhangwei', amount: '200.37' } }] } },
];

describe('structured turn purposes through Pi, persistence and authorization', () => {
  it.each([
    { request: fixtures.walletQuestion, reply: fixtures.walletAnswer },
    { request: fixtures.casualRequest, reply: fixtures.casualAnswer },
    { request: fixtures.capabilityQuestion, reply: fixtures.capabilityAnswer },
    { request: 'Can you create scheduled tasks?', reply: 'Yes. I can explain scheduled tasks.\n\n**Tell me the timing and details when you want to arrange one.**' },
  ])('preserves natural Markdown for $request after a real purpose declaration', async ({ request, reply }) => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(reply)]);
    const response = await runTurn({ message: request }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    expect(finalContent(response)).toBe(reply);
    expect(response.events.flatMap(event => event.type === 'text_delta' ? [event.delta] : []).join('')).toBe(reply);
    expect(response.events.filter(event => event.type === 'error')).toEqual([]);
    expect(response.events.some(event => event.type === 'tool_start' || event.type === 'plan_update')).toBe(false);
    expect(hasAuthorization(response)).toBe(false);
    const saved = await loadSession(response.sessionId);
    expect(saved?.intent).toMatchObject({ purpose: 'conversation', requestText: request, steps: [] });
    expect(saved?.transcript.at(-1)?.content).toBe(reply);
    expect(saved?.transcript.some(message => message.toolEvents?.some(tool => tool.toolName === 'describe_turn'))).toBe(false);
    expect((await getOrCreateSession(config.demoUserId, response.sessionId)).transcript.at(-1)?.content).toBe(reply);
    expect(await getTestPrisma().toolInvocation.count({ where: { toolName: 'describe_turn' } })).toBe(1);
    await expectNoAuthorization();
  });

  it.each([fixtures.fabricatedBalance, fixtures.fabricatedSuccess, retiredDraft.candidate,
    '**Scheduled tasks** (REMINDER/PAYMENT/TRANSFER) use sourceAccountId. Please provide an amount.',
    'A complete reply whose final word is for'])
  ('does not rewrite ordinary prose or trigger extra generation because of wording: %s', async reply => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(reply)]);
    const response = await runTurn({ message: fixtures.casualRequest }, { config, provider: script.provider });
    expect(finalContent(response)).toBe(reply);
    expect(script.calls()).toBe(2);
    const saved = await loadSession(response.sessionId);
    expect(saved?.replyRepair).toBeUndefined();
    expect(saved?.transcript.at(-1)?.content).toBe(reply);
    await expectNoAuthorization();
  });

  it.each(forbiddenDiscussionCalls)('denies $name during a declared capability discussion without authorizing it', async ({ name, args }) => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [toolCall(name, args), fauxAssistantMessage(fixtures.capabilityAnswer)]);
    const response = await runTurn({ message: fixtures.capabilityQuestion }, { config, provider: script.provider });
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === name && event.toolEvent.status === 'blocked')).toBe(true);
    expect(finalContent(response)).toBe(fixtures.capabilityAnswer);
    expect(script.calls()).toBe(3);
    expect(hasAuthorization(response)).toBe(false);
    expect(response.events.some(event => event.type === 'plan_update')).toBe(false);
    await expectNoAuthorization();
  });

  it.each(forbiddenDiscussionCalls)('denies undeclared $name even when the original request sounds like an operation', async ({ name, args }) => {
    const script = undeclaredProvider([toolCall(name, args), fauxAssistantMessage('The proposed operation has not executed.')]);
    const response = await runTurn({ message: fixtures.transferRequest }, { config, provider: script.provider });
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === name && event.toolEvent.status === 'blocked')).toBe(true);
    expect(hasAuthorization(response)).toBe(false);
    expect((await loadSession(response.sessionId))?.intent?.purpose).toBe('undecided');
    await expectNoAuthorization();
  });

  it('cannot turn a declaration into banking consent or silently execute a transfer', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
    ]);
    const response = await runTurn({ message: fixtures.transferRequest }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    expect(hasAuthorization(response)).toBe(true);
    expect(await getTestPrisma().pendingAction.count({ where: { toolName: 'transfer_money', status: 'pending' } })).toBe(1);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    const saved = await loadSession(response.sessionId);
    expect(saved?.intent?.steps.map(step => step.tool)).toEqual(['transfer_money']);
    const owner = saved?.transcript.find(message => message.toolEvents?.some(tool => tool.toolName === 'transfer_money'));
    expect(owner).toMatchObject({ role: 'tool', content: '' });
    expect(owner?.cards?.some(card => card.type === 'confirmation')).toBe(true);
    expect(saved?.transcript.filter(message => message.role === 'assistant').every(message => !message.cards?.length && !message.toolEvents?.length)).toBe(true);
  });

  it('cannot change a discussion into an operation by redeclaring purpose inside the same turn', async () => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [
      toolCall('describe_turn', { purpose: 'operation', operations: ['transfer_money'] }),
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
      fauxAssistantMessage(fixtures.capabilityAnswer),
    ]);
    const response = await runTurn({ message: fixtures.capabilityQuestion }, { config, provider: script.provider });
    expect((await loadSession(response.sessionId))?.intent?.purpose).toBe('conversation');
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === 'transfer_money' && event.toolEvent.status === 'blocked')).toBe(true);
    expect(hasAuthorization(response)).toBe(false);
    expect(finalContent(response)).toBe(fixtures.capabilityAnswer);
    await expectNoAuthorization();
  });

  it('rejects a standalone first write when the declaration requires a complete repeated-operation plan', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money', 'transfer_money'], workflow: true }, [
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '10.00' }),
    ]);
    const response = await runTurn({ message: 'Transfer 10 to Zhang Wei and another 20 to Mom.' }, { config, provider: script.provider });
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === 'transfer_money' && event.toolEvent.status === 'blocked')).toBe(true);
    expect(hasAuthorization(response)).toBe(false);
    expect((await loadSession(response.sessionId))?.intent?.steps.map(step => step.tool)).toEqual(['transfer_money', 'transfer_money']);
    await expectNoAuthorization();
  });

  it.each(['-10.00', '0.00'])('rejects invalid structured transfer amount %s at the business boundary', async amount => {
    const request = `Transfer ${amount} to Zhang Wei`;
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount }), fauxAssistantMessage('A transfer amount must be positive.'),
    ]);
    const response = await runTurn({ message: request }, { config, provider: script.provider });
    expect(script.calls()).toBeGreaterThanOrEqual(2);
    expect(hasAuthorization(response)).toBe(false);
    const saved = await loadSession(response.sessionId);
    expect(saved?.transcript.some(message => message.role === 'user' && message.content === request)).toBe(true);
    expect(saved?.agentState.messages.some(message => message.role === 'user' && contentText(message.content) === request)).toBe(true);
    await expectNoAuthorization();
  });

  it('does not use an isolated amount to authorize model-invented recipients or gated reads', async () => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.00' }),
      fauxAssistantMessage('What would you like to do with that amount?'),
    ]);
    const response = await runTurn({ message: fixtures.amountOnly }, { config, provider: script.provider });
    expect(hasAuthorization(response)).toBe(false);
    expect(finalContent(response)).toBe('What would you like to do with that amount?');
    await expectNoAuthorization();
  });

  it('retains old user wording while a new discussion has a new declared purpose', async () => {
    const draft = await runTurn({ message: fixtures.draftTransfer }, { config,
      provider: scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] },
        [fauxAssistantMessage('How much would you like to transfer?')]).provider });
    const answer = await runTurn({ sessionId: draft.sessionId, message: fixtures.walletQuestion }, { config,
      provider: scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(fixtures.walletAnswer)]).provider });
    const saved = await loadSession(answer.sessionId);
    expect(saved?.intent).toMatchObject({ purpose: 'conversation', requestText: fixtures.walletQuestion, steps: [] });
    expect(saved?.transcript.filter(message => message.role === 'user' && message.content === fixtures.draftTransfer)).toHaveLength(1);
    const requests = await getTestPrisma().modelRequest.findMany({ where: { runId: answer.runId }, orderBy: { ordinal: 'asc' } });
    expect(requests).toHaveLength(2);
    expect(requests.every(request => JSON.parse(request.inputJson).messages.some((message: { role: string; content: unknown }) =>
      message.role === 'user' && JSON.stringify(message.content).includes(fixtures.draftTransfer)))).toBe(true);
    expect(finalContent(answer)).toBe(fixtures.walletAnswer);
    await expectNoAuthorization();
  });

  it('restores a previously lost user message from the transcript without duplicating it', async () => {
    const first = await runTurn({ message: regressions.negativeTransfer }, { config,
      provider: scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage('The signed value is preserved in our conversation.')]).provider });
    const previous = await loadSession(first.sessionId);
    if (!previous) throw new Error('Missing saved conversation');
    previous.agentState.messages = previous.agentState.messages.filter(message => message.role !== 'user');
    await saveSession(previous);
    const response = await runTurn({ sessionId: first.sessionId, message: regressions.recallQuestion }, { config,
      provider: scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(regressions.recallAnswer)]).provider });
    expect(finalContent(response)).toBe(regressions.recallAnswer);
    const requests = await getTestPrisma().modelRequest.findMany({ where: { runId: response.runId }, orderBy: { ordinal: 'asc' } });
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      const input = JSON.parse(request.inputJson) as { messages: { role: string; content: string | { type: 'text'; text: string }[] }[] };
      expect(input.messages.filter(message => message.role === 'user' && contentText(message.content) === regressions.negativeTransfer)).toHaveLength(1);
    }
    await expectNoAuthorization();
  });

  it('keeps query results and later financial analysis in separate messages without replacing the prose', async () => {
    const script = scriptedProvider({ purpose: 'query', operations: ['get_balance'] }, [toolCall('get_balance'), fauxAssistantMessage(fixtures.fabricatedBalance)]);
    const response = await runTurn({ message: fixtures.balanceRequest }, { config, provider: script.provider });
    expect(script.calls()).toBe(3);
    expect(finalContent(response)).toBe(fixtures.fabricatedBalance);
    const saved = await loadSession(response.sessionId);
    const tool = saved?.transcript.find(message => message.role === 'tool' && message.toolEvents?.[0].toolName === 'get_balance');
    expect(tool?.toolEvents?.[0].status).toBe('success');
    expect(tool?.cards?.find(card => card.type === 'balance')).toMatchObject({ type: 'balance', data: { totalAvailable: '73580.00' } });
    expect(saved?.transcript.at(-1)?.content).toBe(fixtures.fabricatedBalance);
    expect(saved?.transcript.findIndex(message => message.id === tool?.id)).toBeLessThan(saved!.transcript.length - 1);
    expect(saved?.replyRepair).toBeUndefined();
    await expectNoAuthorization();
  });

  it('allows a green read to support a declared explanation without creating a write authorization', async () => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [toolCall('get_balance'), fauxAssistantMessage(fixtures.balanceExplanation)]);
    const response = await runTurn({ message: fixtures.walletQuestion }, { config, provider: script.provider });
    expect(script.calls()).toBe(3);
    expect(finalContent(response)).toBe(fixtures.balanceExplanation);
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === 'get_balance' && event.toolEvent.status === 'success')).toBe(true);
    await expectNoAuthorization();
  });
});

describe('declared advice reads and authorization continuation', () => {
  it('continues current advice after one authorized read and never reissues that query', async () => {
    const script = scriptedProvider({ purpose: 'advice', operations: ['list_subscriptions'] }, [toolCall('list_subscriptions'), fauxAssistantMessage(advice.analysisAnswer)]);
    const response = await runTurn({ message: advice.subscriptionAdvice }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    expect(hasAuthorization(response)).toBe(true);
    const db = getTestPrisma();
    const before = await db.subscription.findMany({ orderBy: { id: 'asc' } });
    const pending = await db.pendingAction.findFirstOrThrow({ where: { sessionId: response.sessionId, toolName: 'list_subscriptions' } });
    const confirmed = await confirmAction(pending.id, { sessionId: response.sessionId, userId: config.demoUserId, deps: { config, provider: script.provider } });
    expect(confirmed.ok).toBe(true);
    expect(script.calls()).toBe(3);
    expect(finalContent({ sessionId: response.sessionId, events: confirmed.events })).toBe(advice.analysisAnswer);
    expect(await db.toolInvocation.count({ where: { toolName: 'list_subscriptions' } })).toBe(1);
    expect(await db.subscription.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    expect((await loadSession(response.sessionId))?.replyContext).toMatchObject({ purpose: 'advice', requestText: advice.subscriptionAdvice });
    await expectNoMutation();
  });

  it('uses a saved authorized query for later advice without opening another gate', async () => {
    const queryScript = scriptedProvider({ purpose: 'query', operations: ['list_subscriptions'] }, [toolCall('list_subscriptions'), fauxAssistantMessage('The query is complete.')]);
    const query = await runTurn({ message: regressions.subscriptionQuery }, { config, provider: queryScript.provider });
    const db = getTestPrisma();
    const pending = await db.pendingAction.findFirstOrThrow({ where: { sessionId: query.sessionId, toolName: 'list_subscriptions' } });
    expect((await confirmAction(pending.id, { sessionId: query.sessionId, userId: config.demoUserId, deps: { config, provider: queryScript.provider } })).ok).toBe(true);
    const before = await db.subscription.findMany({ orderBy: { id: 'asc' } });
    const script = scriptedProvider({ purpose: 'advice', operations: [] }, [fauxAssistantMessage(regressions.analysisAnswer)]);
    const response = await runTurn({ sessionId: query.sessionId, message: regressions.analysisFollowUp }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    expect(finalContent(response)).toBe(regressions.analysisAnswer);
    expect(hasAuthorization(response)).toBe(false);
    expect(await db.pendingAction.count()).toBe(1);
    expect(await db.subscription.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    await expectNoMutation();
  });

  it('does not reopen an old advice question after a newer user turn precedes confirmation', async () => {
    const script = scriptedProvider({ purpose: 'advice', operations: ['list_subscriptions'] }, [toolCall('list_subscriptions'), fauxAssistantMessage(advice.analysisAnswer)]);
    const query = await runTurn({ message: advice.subscriptionAdvice }, { config, provider: script.provider });
    await runTurn({ sessionId: query.sessionId, message: fixtures.casualRequest }, { config,
      provider: scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(fixtures.casualAnswer)]).provider });
    const db = getTestPrisma();
    const pending = await db.pendingAction.findFirstOrThrow({ where: { sessionId: query.sessionId, toolName: 'list_subscriptions' } });
    expect((await confirmAction(pending.id, { sessionId: query.sessionId, userId: config.demoUserId, deps: { config, provider: script.provider } })).ok).toBe(true);
    expect(script.calls()).toBe(2);
    const saved = await loadSession(query.sessionId);
    expect(saved?.transcript.some(message => message.content === fixtures.casualAnswer)).toBe(true);
    expect(saved?.transcript.at(-1)?.content).not.toBe(advice.analysisAnswer);
    expect(saved?.replyContext).toBeUndefined();
    await expectNoMutation();
  });

  it.each(['cancel_subscription', 'submit_plan'])('refuses %s during advice without changing subscriptions', async name => {
    const args: ToolCall['arguments'] = name === 'cancel_subscription' ? { subscriptionId: 'sub_netflix' }
      : { goal: 'Unexpected cancellation', nodes: [{ id: 'cancel', name: 'Cancel subscription', kind: 'tool', dependencies: [],
        tool: 'cancel_subscription', args: { subscriptionId: 'sub_netflix' } }] };
    const script = scriptedProvider({ purpose: 'advice', operations: [] }, [toolCall(name, args), fauxAssistantMessage(advice.analysisAnswer)]);
    const db = getTestPrisma();
    const before = await db.subscription.findMany({ orderBy: { id: 'asc' } });
    const response = await runTurn({ message: advice.subscriptionAdvice }, { config, provider: script.provider });
    expect(script.calls()).toBe(3);
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === name && event.toolEvent.status === 'blocked')).toBe(true);
    expect(finalContent(response)).toBe(advice.analysisAnswer);
    expect(hasAuthorization(response)).toBe(false);
    expect(await db.subscription.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    await expectNoAuthorization();
  });

  it('keeps advice restrictions after read confirmation even if the next model response proposes cancellation', async () => {
    const script = scriptedProvider({ purpose: 'advice', operations: ['list_subscriptions'] }, [toolCall('list_subscriptions'),
      toolCall('cancel_subscription', { subscriptionId: 'sub_netflix' }), fauxAssistantMessage(advice.analysisAnswer)]);
    const query = await runTurn({ message: advice.subscriptionAdvice }, { config, provider: script.provider });
    const db = getTestPrisma();
    const before = await db.subscription.findMany({ orderBy: { id: 'asc' } });
    const pending = await db.pendingAction.findFirstOrThrow({ where: { sessionId: query.sessionId, toolName: 'list_subscriptions' } });
    const confirmed = await confirmAction(pending.id, { sessionId: query.sessionId, userId: config.demoUserId, deps: { config, provider: script.provider } });
    expect(confirmed.ok).toBe(true);
    expect(script.calls()).toBe(4);
    expect(confirmed.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === 'cancel_subscription' && event.toolEvent.status === 'blocked')).toBe(true);
    expect(finalContent({ sessionId: query.sessionId, events: confirmed.events })).toBe(advice.analysisAnswer);
    expect(confirmed.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required' || event.type === 'plan_update')).toBe(false);
    expect(await db.subscription.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
    await expectNoMutation();
  });
});

describe('protocol-only corrective generation and completed-request recovery', () => {
  it.each(['{"guidance":{"code":"unknown"}}', '<think>Private reasoning</think>', '{"role":"assistant","content":"Encoded reply"}'])
  ('corrects a complete protocol envelope while retaining its archive: %s', async candidate => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(candidate), fauxAssistantMessage(fixtures.walletAnswer)]);
    const response = await runTurn({ message: fixtures.walletQuestion }, { config, provider: script.provider });
    expect(script.calls()).toBe(3);
    expect(finalContent(response)).toBe(fixtures.walletAnswer);
    expect(response.events.flatMap(event => event.type === 'text_delta' ? [event.delta] : []).join('')).toBe(fixtures.walletAnswer);
    const saved = await loadSession(response.sessionId);
    expect(saved?.replyRepair).toMatchObject({ phase: 'completed', attempt: 1 });
    expect(saved?.agentState.messages.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === candidate))).toBe(true);
    expect(saved?.transcript.some(message => message.content === candidate)).toBe(false);
    await expectNoAuthorization();
  });

  it('permits a complete protocol teaching example only with a typed declaration flag', async () => {
    const example = '{"role":"assistant","content":"Protocol example"}';
    const script = scriptedProvider({ purpose: 'conversation', operations: [], allowProtocolExamples: true }, [fauxAssistantMessage(example)]);
    const response = await runTurn({ message: 'Show a protocol example.' }, { config, provider: script.provider });
    expect(finalContent(response)).toBe(example);
    expect(script.calls()).toBe(2);
    expect((await loadSession(response.sessionId))?.replyRepair).toBeUndefined();
    await expectNoAuthorization();
  });

  it('does not let format correction become a financial write or a gated-read authorization', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      fauxAssistantMessage('{"role":"assistant","content":"Invalid protocol"}'),
      toolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
      fauxAssistantMessage('No transfer was executed during output correction.'),
    ]);
    const response = await runTurn({ message: fixtures.transferRequest }, { config, provider: script.provider });
    expect(response.events.some(event => event.type === 'tool_end' && event.toolEvent.toolName === 'transfer_money' && event.toolEvent.status === 'blocked')).toBe(true);
    expect(hasAuthorization(response)).toBe(false);
    expect(finalContent(response)).toBe('No transfer was executed during output correction.');
    await expectNoAuthorization();
  });

  it.each(['length', 'error'] as const)('reports provider stop %s without initiating an automatic planning retry', async stopReason => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage('Partial reply', {
      stopReason, ...(stopReason === 'error' ? { errorMessage: 'Network connection interrupted' } : {}),
    })]);
    const response = await runTurn({ message: fixtures.casualRequest }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    expect(finalContent(response)).toBe(CONVERSATION_GENERATION_FAILED);
    expect(response.events.some(event => event.type === 'error')).toBe(true);
    expect((await loadSession(response.sessionId))?.replyRepair).toBeUndefined();
    await expectNoAuthorization();
  });

  it('replays an already completed conversational response after a crash without a new model request', async () => {
    const snapshot = await getOrCreateSession(config.demoUserId);
    // This checkpoint represents the state after the completed declaration, before the final model response.
    snapshot.intent = declareConversationIntent(advanceConversationIntent(undefined, fixtures.capabilityQuestion), 'conversation', []);
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: 'completed-conversation-recovery', request: { kind: 'input', message: fixtures.capabilityQuestion },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const input = { messages: [{ role: 'user', content: fixtures.capabilityQuestion, timestamp: 1 }] };
    const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
    await completeModelRequest(admitted.lease, model.id, JSON.stringify(fauxAssistantMessage(fixtures.capabilityAnswer)), checkpoint);
    const journal = new AgentRunJournal(admitted.lease);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage('This generation must not run.')]);
    const status = await continueDurableRun(run, journal, [], { config, provider: script.provider });
    expect(status).toBe('completed');
    await journal.finish(status);
    expect(script.calls()).toBe(0);
    expect(await getTestPrisma().modelRequest.count({ where: { runId: run.id } })).toBe(1);
    const saved = await loadSession(snapshot.sessionId);
    expect(saved?.transcript.filter(message => message.role === 'user').map(message => message.content)).toEqual([fixtures.capabilityQuestion]);
    expect(saved?.transcript.at(-1)?.content).toBe(fixtures.capabilityAnswer);
    const events = await getTestPrisma().agentRunEvent.findMany({ where: { runId: run.id, channel: 'ui' }, orderBy: { sequence: 'asc' } });
    expect(events.filter(event => event.eventType === 'text_delta').map(event => JSON.parse(event.payloadJson).delta).join('')).toBe(fixtures.capabilityAnswer);
    await expectNoAuthorization();
  });

  it('retains the declared discussion restriction when recovering a completed unexpected transfer proposal', async () => {
    const snapshot = await getOrCreateSession(config.demoUserId);
    snapshot.intent = declareConversationIntent(advanceConversationIntent(undefined, fixtures.capabilityQuestion), 'conversation', []);
    const checkpoint = encodeCheckpoint(snapshot, config);
    const admitted = await beginRun({ sessionId: snapshot.sessionId, userId: snapshot.userId,
      requestId: 'blocked-conversation-recovery', request: { kind: 'input', message: fixtures.capabilityQuestion },
      expectedRevision: snapshot.revision, checkpointJson: checkpoint });
    if (!admitted.lease) throw new Error('Missing run lease');
    const input = { messages: [{ role: 'user', content: fixtures.capabilityQuestion, timestamp: 1 }] };
    const model = await startModelRequest(admitted.lease, runtimeRequestDigest('model_request', input), JSON.stringify(input), checkpoint);
    await completeModelRequest(admitted.lease, model.id, JSON.stringify(fauxAssistantMessage([
      fauxToolCall('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
    ], { stopReason: 'toolUse' })), checkpoint);
    const journal = new AgentRunJournal(admitted.lease);
    const run = await getTestPrisma().agentRun.findUniqueOrThrow({ where: { id: admitted.run.id } });
    // The checkpoint already contains the declaration; this provider only supplies its continuation.
    const script = undeclaredProvider([fauxAssistantMessage(fixtures.capabilityAnswer)]);
    const status = await continueDurableRun(run, journal, [], { config, provider: script.provider });
    expect(status).toBe('completed');
    await journal.finish(status);
    expect(script.calls()).toBe(1);
    expect((await loadSession(snapshot.sessionId))?.transcript.at(-1)?.content).toBe(fixtures.capabilityAnswer);
    const events = await getTestPrisma().agentRunEvent.findMany({ where: { runId: run.id, channel: 'ui' } });
    expect(events.some(event => event.eventType === 'tool_end' && JSON.parse(event.payloadJson).toolEvent.status === 'blocked')).toBe(true);
    expect(events.some(event => event.eventType === 'confirmation_required' || event.eventType === 'mfa_required' || event.eventType === 'plan_update')).toBe(false);
    await expectNoAuthorization();
  });
});
