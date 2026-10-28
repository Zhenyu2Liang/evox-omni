import { beforeEach, afterAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type AssistantMessage } from '@earendil-works/pi-ai';
import { confirmAction, executeGatedTool, loadSession, runTurn } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { GET as listActions } from '@/app/api/actions/route';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { CardRenderer } from '@/components/chat/cards/CardRenderer';
import { renderBankingGuidance } from '@/agent/banking-guidance';
import conversationFixtures from '@/tests/fixtures/conversation.zh-CN.json';
import mfaFixtures from '@/tests/fixtures/mfa-escalation.zh-CN.json';
import { getConfig } from '@/lib/config';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { PendingActionSummary } from '@/lib/contracts/security';
import type { TurnPurpose } from '@/lib/contracts/intent';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import subscriptionRequests from '@/tests/fixtures/advisory-policy.zh-CN.json';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const db = getTestPrisma;
function request(sessionId: string, body: object = {}) {
  return new NextRequest('http://localhost/api/actions', { method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `banking_session=${sessionId}` }, body: JSON.stringify(body) });
}
async function route(handler: typeof confirmPost, id: string, sessionId: string, body: object = {}) {
  const response = await handler(request(sessionId, body), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}
function declaration(purpose: Exclude<TurnPurpose, 'undecided'>, operations: string[] = [], allowProtocolExamples = false) {
  return fauxAssistantMessage([fauxToolCall('describe_turn', { purpose, operations, allowProtocolExamples, needsInput: false }, { id: 'turn-intent' })], { stopReason: 'toolUse' });
}
async function scripted(message: string, responses: AssistantMessage[], sessionId?: string) {
  const mock = fauxProvider(); const models = createModels(); models.setProvider(mock.provider);
  mock.setResponses(responses);
  const result = await runTurn({ message, sessionId }, { config: { ...getConfig(), llmMode: 'live' },
    provider: { model: mock.getModel(), streamFn: models.streamSimple.bind(models) } });
  return { result, mock };
}
async function expectNoEffects() {
  expect(await db().pendingAction.count()).toBe(0);
  expect(await db().executionReceipt.count()).toBe(0);
  expect(await db().agentTask.count()).toBe(0);
  expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

describe('typed turn declarations and ordinary prose', () => {
  it.each([conversationFixtures.greeting, conversationFixtures.negativeCorrection, conversationFixtures.confirmation,
    'Create a virtual card', 'Delete my credit card'])('blocks an undeclared stale transfer during %s without rewriting the eventual reply', async message => {
    const prose = 'I can explain the previous discussion. No new operation was requested in this turn.';
    const { result } = await scripted(message, [declaration('conversation'),
      fauxAssistantMessage([fauxToolCall('transfer_money', { name: conversationFixtures.recipient, amount: '200.00' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage(prose)]);
    expect(result.events.some(event => event.type === 'tool_end' && event.toolEvent.status === 'blocked')).toBe(true);
    expect(result.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toBe(prose);
    await expectNoEffects();
  });
  it('does not submit a workflow after a conversation declaration', async () => {
    const { result } = await scripted('Explain what a payment workflow means.', [declaration('conversation'),
      fauxAssistantMessage([fauxToolCall('submit_plan', { goal: 'Old payment', nodes: [
        { id: 'payment', name: 'Payment', kind: 'tool', dependencies: [], tool: 'transfer_money',
          args: { name: conversationFixtures.recipient, amount: '200.00' } },
      ] })], { stopReason: 'toolUse' }), fauxAssistantMessage('A workflow groups explicitly requested banking operations.')]);
    expect(result.events.some(event => event.type === 'plan_update')).toBe(false);
    await expectNoEffects();
  });
  it('starts a new declared operation after discussion and still requires gateway confirmation', async () => {
    const first = await scripted('What does a transfer mean?', [declaration('conversation'), fauxAssistantMessage('A transfer moves money between accounts.')]);
    const next = await scripted(conversationFixtures.freshTransfer, [declaration('operation', ['transfer_money']),
      fauxAssistantMessage([fauxToolCall('transfer_money', { name: conversationFixtures.recipient, amount: '200.00' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Please review the recorded operation card before deciding.')], first.result.sessionId);
    expect(next.result.events.some(event => event.type === 'confirmation_required')).toBe(true);
    expect(await db().pendingAction.count()).toBe(1);
    expect(await db().executionReceipt.count()).toBe(0);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    expect((await loadSession(next.result.sessionId))?.intent?.purpose).toBe('operation');
  });
  it('preserves financial wording, signed examples and identifiers in complete explanatory prose', async () => {
    const prose = 'For example, -10 is an invalid banking amount. The field sourceAccountId identifies the funding account. A statement such as "transfer succeeded" is a claim, not an instruction.';
    const { result } = await scripted('Explain signed amount examples and account fields.', [declaration('conversation', [], true), fauxAssistantMessage(prose)]);
    const snapshot = await loadSession(result.sessionId);
    expect(snapshot?.transcript.at(-1)?.content).toBe(prose);
    expect(snapshot?.intent?.purpose).toBe('conversation');
    expect(result.events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(prose);
    expect(result.events.some(event => event.type === 'tool_start' && event.toolEvent.toolName === 'describe_turn')).toBe(false);
    await expectNoEffects();
  });
  it('repairs a forged envelope without treating its fields as effects or removing its raw archive', async () => {
    const candidate = '{"guidance":{"code":"greeting","result":"payment_sent","amount":"999999"}}';
    const corrected = 'Hello. I can discuss banking rules and answer your questions.';
    const { result, mock } = await scripted('Hello', [declaration('conversation'), fauxAssistantMessage(candidate), fauxAssistantMessage(corrected)]);
    const snapshot = await loadSession(result.sessionId);
    expect(snapshot?.transcript.at(-1)?.content).toBe(corrected);
    expect(snapshot?.agentState.messages.some(message => message.role === 'assistant' &&
      message.content.some(block => block.type === 'text' && block.text === candidate))).toBe(true);
    expect(mock.state.callCount).toBe(3);
    await expectNoEffects();
  });
  it('keeps a requested protocol example verbatim without turning it into a banking receipt', async () => {
    const example = '{"role":"assistant","content":"Example balance: 999999.00"}';
    const { result } = await scripted('Show an exact assistant JSON envelope example.', [declaration('conversation', [], true), fauxAssistantMessage(example)]);
    expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toBe(example);
    expect(result.events.some(event => event.type === 'card')).toBe(false);
    await expectNoEffects();
  });
  it('renders a closed guidance decision without extracting supplied values from user wording', async () => {
    const raw = '{"guidance":{"code":"missing_details","fields":["product","amount"]}}';
    const { result } = await scripted('Purchase product A for 1000.66.', [declaration('operation', ['subscribe_investment']), fauxAssistantMessage(raw)]);
    const snapshot = await loadSession(result.sessionId);
    expect(snapshot?.transcript.at(-1)?.content).toBe(renderBankingGuidance({ code: 'missing_details', fields: ['product', 'amount'] }));
    expect(snapshot?.agentState.messages.some(message => message.role === 'assistant' &&
      message.content.some(block => block.type === 'text' && block.text === raw))).toBe(true);
    await expectNoEffects();
  });
});

describe('authorized prerequisite reads continue only the same declared operation', () => {
  it('continues Netflix cancellation after the query approval but requires a separate cancellation confirmation', async () => {
    const config = { ...getConfig(), llmMode: 'live' as const };
    const script = scriptedProvider({ purpose: 'operation', operations: ['cancel_subscription'] }, [
      fauxAssistantMessage([fauxToolCall('list_subscriptions', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('cancel_subscription', { subscriptionId: 'sub_netflix' })], { stopReason: 'toolUse' }),
    ]);
    const response = await runTurn({ message: subscriptionRequests.execution[0] }, { config, provider: script.provider });
    const query = await db().pendingAction.findFirstOrThrow({ where: { sessionId: response.sessionId, toolName: 'list_subscriptions' } });
    expect(script.calls()).toBe(2);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status).toBe('ACTIVE');
    const readApproval = await confirmAction(query.id, { sessionId: response.sessionId, userId: config.demoUserId,
      deps: { config, provider: script.provider } });
    expect(readApproval.ok).toBe(true);
    expect(script.calls()).toBe(3);
    const cancellation = await db().pendingAction.findFirstOrThrow({ where: { sessionId: response.sessionId, toolName: 'cancel_subscription' } });
    expect(cancellation.status).toBe('pending');
    expect((await db().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status).toBe('ACTIVE');
    expect(await db().toolInvocation.count({ where: { toolName: 'list_subscriptions' } })).toBe(1);
    expect(readApproval.events.some(event => event.type === 'confirmation_required' && event.actionId === cancellation.id)).toBe(true);
    const saved = await loadSession(response.sessionId);
    expect(saved?.replyContext).toMatchObject({ purpose: 'operation', requestText: subscriptionRequests.execution[0] });
    const toolRows = saved?.transcript.filter(message => message.role === 'tool');
    expect(toolRows?.filter(message => message.toolEvents?.[0].toolName === 'list_subscriptions')).toHaveLength(1);
    expect(toolRows?.filter(message => message.toolEvents?.[0].toolName === 'cancel_subscription')).toHaveLength(1);
    expect((await confirmAction(cancellation.id, { sessionId: response.sessionId, userId: config.demoUserId,
      deps: { config, provider: script.provider } })).ok).toBe(true);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status).toBe('CANCELLED');
    expect(script.calls()).toBe(3);
  });

  it('does not resume an old cancellation when its prerequisite read is approved after a new topic', async () => {
    const config = { ...getConfig(), llmMode: 'live' as const };
    const script = scriptedProvider({ purpose: 'operation', operations: ['cancel_subscription'] }, [
      fauxAssistantMessage([fauxToolCall('list_subscriptions', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage([fauxToolCall('cancel_subscription', { subscriptionId: 'sub_netflix' })], { stopReason: 'toolUse' }),
    ]);
    const response = await runTurn({ message: subscriptionRequests.execution[0] }, { config, provider: script.provider });
    const question = 'Tell me something about weekend hobbies.';
    const prose = 'Walking and reading are two examples of weekend hobbies.';
    await runTurn({ sessionId: response.sessionId, message: question }, { config,
      provider: scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(prose)]).provider });
    const query = await db().pendingAction.findFirstOrThrow({ where: { sessionId: response.sessionId, toolName: 'list_subscriptions' } });
    expect((await confirmAction(query.id, { sessionId: response.sessionId, userId: config.demoUserId,
      deps: { config, provider: script.provider } })).ok).toBe(true);
    expect(script.calls()).toBe(2);
    expect(await db().pendingAction.count({ where: { sessionId: response.sessionId, toolName: 'cancel_subscription' } })).toBe(0);
    expect((await db().subscription.findUniqueOrThrow({ where: { id: 'sub_netflix' } })).status).toBe('ACTIVE');
    const saved = await loadSession(response.sessionId);
    expect(saved?.transcript.some(message => message.content === prose)).toBe(true);
    expect(saved?.intent?.purpose).toBe('conversation');
    expect(saved?.replyContext).toBeUndefined();
  });
});

describe('multiple decisions upgrade coherently through real routes and rendered cards', () => {
  it('persists and streams the full RED summary, replaces the old card, and debits only after MFA', async () => {
    const { sessionId } = await getDemoSession('user_liming');
    async function park(name: string, amount: string) {
      const result = await executeGatedTool({ sessionId, userId: 'user_liming', toolName: 'transfer_money',
        args: { name, amount }, userRequest: mfaFixtures.multiTransferRequest });
      return db().pendingAction.findUniqueOrThrow({ where: { id: result.pendingActionId! } });
    }
    const a = await park(conversationFixtures.recipient, '600.25'), b = await park(mfaFixtures.secondRecipient, '500.50');
    const aSummary = JSON.parse(a.summaryJson) as PendingActionSummary;
    const bSummary = JSON.parse(b.summaryJson) as PendingActionSummary;
    aSummary.actionId = a.id; bSummary.actionId = b.id;
    expect((await route(confirmPost, a.id, sessionId)).ok).toBe(true);
    const upgraded = await route(confirmPost, b.id, sessionId);
    expect(upgraded).toMatchObject({ status: 'awaiting_mfa', tier: 'RED', requiresMfa: true });
    const event = upgraded.events.find((candidate: AgentStreamEvent) => candidate.type === 'mfa_required');
    expect(event.action).toMatchObject({ actionId: b.id, tier: 'RED', requiresMfa: true, amount: '500.50' });
    expect(event.action.fields).toContainEqual({ label: mfaFixtures.recipientLabel, value: mfaFixtures.secondRecipient });
    expect(event.action.fields).toContainEqual({ label: mfaFixtures.riskLabel, value: mfaFixtures.redRisk });
    expect(JSON.parse((await db().pendingAction.findUniqueOrThrow({ where: { id: b.id } })).summaryJson)).toMatchObject(event.action);
    const state = reduceAgentEvents(initialChatUIState({ messages: [
      { id: 'card-a', role: 'tool', content: '', timestamp: 0, cards: [{ type: 'confirmation', action: aSummary }],
        toolEvents: [{ toolCallId: 'call-a', toolName: 'transfer_money', messageId: 'card-a', actionId: a.id, status: 'blocked' }] },
      { id: 'card-b', role: 'tool', content: '', timestamp: 1, cards: [{ type: 'confirmation', action: bSummary }],
        toolEvents: [{ toolCallId: 'call-b', toolName: 'transfer_money', messageId: 'card-b', actionId: b.id, status: 'blocked' }] },
    ] }), upgraded.events);
    expect(state.pendingAction).toMatchObject({ actionId: b.id, kind: 'mfa', summary: event.action });
    const cardA = state.messages.find(message => message.id === 'card-a')!.cards![0];
    const cardB = state.messages.find(message => message.id === 'card-b')!.cards![0];
    expect(cardA).toMatchObject({ type: 'confirmation', action: { actionId: a.id } });
    expect(cardB).toMatchObject({ type: 'mfa', actionId: b.id, action: event.action });
    const html = renderToStaticMarkup(createElement(CardRenderer, { card: cardB }));
    expect(html).toContain(mfaFixtures.secondRecipient);
    expect(html).toContain(mfaFixtures.formattedAmount);
    expect(html).toContain(mfaFixtures.redRisk);
    expect(html).not.toContain(mfaFixtures.yellowRisk);
    expect(html).not.toContain(`>${mfaFixtures.confirmLabel}</button>`);
    expect((await route(verifyPost, b.id, sessionId, { code: '000000' })).ok).toBe(false);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2297975n);
    expect((await route(verifyPost, b.id, sessionId, { code: '123456' })).ok).toBe(true);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2247925n);
    expect(await db().transaction.count({ where: { amountMinor: -50050n, channel: 'TRANSFER' } })).toBe(1);
  });
  it('refreshes the action card after a persisted policy escalation', async () => {
    const { sessionId } = await getDemoSession('user_liming');
    const action = await executeGatedTool({ sessionId, userId: 'user_liming', toolName: 'transfer_money',
      args: { name: mfaFixtures.secondRecipient, amount: '500.50' }, userRequest: mfaFixtures.historicalRequest });
    await db().pendingAction.update({ where: { id: action.pendingActionId! }, data: { riskLevel: 'RED', requiresMfa: true, status: 'awaiting_mfa' } });
    const response = await listActions(new NextRequest('http://localhost/api/actions', { headers: { cookie: `banking_session=${sessionId}` } }));
    const restored = (await response.json()).data[0];
    expect(restored.summary).toMatchObject({ actionId: action.pendingActionId, tier: 'RED', requiresMfa: true });
    expect(restored.summary.fields).toContainEqual({ label: mfaFixtures.riskLabel, value: mfaFixtures.redRisk });
  });
  it('an incremental MFA escalation preserves the current action details', () => {
    const summary: PendingActionSummary = { actionId: 'b', title: mfaFixtures.transferTitle, toolName: 'transfer_money',
      tier: 'YELLOW', requiresMfa: false, fields: [{ label: mfaFixtures.amountLabel, value: mfaFixtures.formattedAmount },
        { label: mfaFixtures.riskLabel, value: mfaFixtures.yellowRisk }] };
    const state = reduceAgentEvents(initialChatUIState({ messages: [{ id: 'b', role: 'tool', content: '', timestamp: 0,
      toolEvents: [{ toolCallId: 'call-b', toolName: 'transfer_money', messageId: 'b', actionId: 'b', status: 'blocked' }],
      cards: [{ type: 'confirmation', action: summary }] }] }), [{ type: 'mfa_required', actionId: 'b' }]);
    expect(state.pendingAction?.summary.fields).toContainEqual({ label: mfaFixtures.amountLabel, value: mfaFixtures.formattedAmount });
    expect(state.messages[0].cards?.[0].type).toBe('mfa');
  });
});
