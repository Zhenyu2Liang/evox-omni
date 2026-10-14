import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, normalizeContext } from '@earendil-works/pi-ai';
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from '@earendil-works/pi-ai';
import { respondWithGuidance } from '@/agent/providers/mock-responder';

const tools = [{ name: 'describe_turn' }, { name: 'get_cards' }, { name: 'freeze_card' }];
const user = (content: string): Message => ({ role: 'user', content, timestamp: 0 });
const result = (toolName: string, data: unknown, isError = false): ToolResultMessage => ({
  role: 'toolResult', toolName, toolCallId: `call_${toolName}`, content: [{ type: 'text', text: 'Recorded result' }],
  details: data, isError, timestamp: 1,
}) as ToolResultMessage;
function call(reply: AssistantMessage): ToolCall | undefined {
  return reply.content.find(part => part.type === 'toolCall');
}

function complete(messages: Message[], reply: AssistantMessage, data: unknown): void {
  const invocation = call(reply);
  if (!invocation) throw new Error('The fixture expected an actual tool proposal.');
  messages.push(reply, { ...result(invocation.name, data), toolCallId: invocation.id });
}

function completeDeclaration(messages: Message[], reply: AssistantMessage): void {
  expect(call(reply)?.name).toBe('describe_turn');
  complete(messages, reply, call(reply)?.arguments);
}
function declared(text: string): Message[] {
  const input = user(text);
  const reply = respondWithGuidance({ messages: [input], tools });
  const messages = [input];
  completeDeclaration(messages, reply);
  return messages;
}

describe('offline model declarations through the real registered control tool', () => {
  it('uses Pi normalized system tool deltas rather than assuming top-level tools reach the provider', () => {
    const context = normalizeContext({ messages: [user('Hello')], tools: [{ name: 'describe_turn', description: 'Declare purpose',
      parameters: { type: 'object', properties: {} } }] });
    expect(call(respondWithGuidance(context))).toMatchObject({ name: 'describe_turn', arguments: { purpose: 'conversation', operations: [] } });
    const removed: Message = { role: 'system', content: '', timestamp: 1, toolsRemoved: [{ name: 'describe_turn' }] };
    expect(call(respondWithGuidance({ messages: [...context.messages, removed] }))).toBeUndefined();
  });
  it.each([
    ['Hello', 'conversation', []],
    ['Show my balance', 'query', ['get_balance']],
    ['Which subscriptions should I cancel?', 'advice', []],
  ])('declares purpose before banking calls for %s', (text, purpose, operations) => {
    const reply = respondWithGuidance({ messages: [user(text as string)], tools });
    expect(reply.content).toHaveLength(1);
    expect(reply.stopReason).toBe('toolUse');
    expect(call(reply)).toMatchObject({ name: 'describe_turn', arguments: { purpose, operations } });
  });

  it('does not narrate metadata as the final answer and renews it for each new user message', () => {
    const messages = declared('Hello');
    const reply = respondWithGuidance({ messages, tools });
    expect(call(reply)).toBeUndefined();
    expect(reply.content.some(part => part.type === 'text' && part.text.includes('describe_turn'))).toBe(false);
    const next = respondWithGuidance({ messages: [...messages, reply, user('Show my balance')], tools });
    expect(call(next)).toMatchObject({ name: 'describe_turn', arguments: { purpose: 'query' } });
  });

  it('submits a declared read-only workflow without repeating the preparation declaration', () => {
    const messages = declared('\u5e2e\u6211\u8ba1\u5212\u4e00\u4e0b\u67e5\u8be2\u4f59\u989d');
    const plan = respondWithGuidance({ messages, tools });
    expect(call(plan)).toMatchObject({ name: 'submit_plan' });
    complete(messages, plan, { id: 'read-plan', status: 'success' });
    expect(call(respondWithGuidance({ messages, tools }))).toBeUndefined();
  });

  it('marks mock workflow requests explicitly and does not turn page-only issuance into a write', () => {
    const messages = [user('Plan and freeze all my bank cards')];
    const lookup = respondWithGuidance({ messages, tools });
    expect(call(lookup)?.name).toBe('get_cards');
    complete(messages, lookup, [{ id: 'credit', type: 'CREDIT' }, { id: 'debit', type: 'DEBIT' }]);
    expect(call(respondWithGuidance({ messages, tools }))?.arguments.workflow).toBe(true);
    expect(call(respondWithGuidance({ messages: [user('Create a virtual card')], tools })))
      .toMatchObject({ name: 'describe_turn', arguments: { purpose: 'conversation', operations: [] } });
  });

  it('looks up actual card IDs before proposing a freeze, including IDs outside seed fixtures', () => {
    const text = '\u51bb\u7ed3\u6211\u7684\u4fe1\u7528\u5361';
    const messages = [user(text)];
    const lookup = respondWithGuidance({ messages, tools });
    expect(call(lookup)?.name).toBe('get_cards');
    complete(messages, lookup, [{ id: 'owned-real-credit', type: 'CREDIT', numberMasked: '****6688' }]);
    const declaration = respondWithGuidance({ messages, tools });
    expect(call(declaration)).toMatchObject({ name: 'describe_turn', arguments: { purpose: 'operation', operations: ['freeze_card'] } });
    completeDeclaration(messages, declaration);
    const freeze = respondWithGuidance({ messages, tools });
    expect(call(freeze)).toMatchObject({ name: 'freeze_card', arguments: { cardId: 'owned-real-credit' } });
  });

  it('declares and freezes every actual card after a fresh read, including an added virtual card', () => {
    const cards = [
      { id: 'actual-credit', type: 'CREDIT', numberMasked: '****6688' },
      { id: 'actual-debit', type: 'DEBIT', numberMasked: '****8821' },
      { id: 'new-virtual', type: 'VIRTUAL', numberMasked: '****1111' },
    ];
    const messages: Message[] = [user('An earlier card query'), result('get_cards', cards.slice(0, 2)),
      user('Plan and freeze all my bank cards')];
    const lookup = respondWithGuidance({ messages, tools });
    expect(call(lookup)?.name).toBe('get_cards');
    complete(messages, lookup, cards);
    const declaration = respondWithGuidance({ messages, tools });
    expect(call(declaration)).toMatchObject({ name: 'describe_turn', arguments: {
      purpose: 'operation', operations: ['freeze_card', 'freeze_card', 'freeze_card'], workflow: true,
    } });
    completeDeclaration(messages, declaration);
    const plan = call(respondWithGuidance({ messages, tools }));
    expect(plan?.name).toBe('submit_plan');
    expect(plan?.arguments.nodes).toEqual(cards.map((card, index) => expect.objectContaining({
      id: `freeze_${index + 1}`, tool: 'freeze_card', args: { cardId: card.id },
    })));
  });

  it('keeps a gated resource lookup read-only until its authorized result permits the final declaration', () => {
    const messages = [user('\u53d6\u6d88Netflix\u8ba2\u9605')];
    const preparation = respondWithGuidance({ messages, tools });
    expect(call(preparation)).toMatchObject({ name: 'describe_turn', arguments: {
      purpose: 'operation', operations: ['list_subscriptions'],
    } });
    completeDeclaration(messages, preparation);
    const lookup = respondWithGuidance({ messages, tools });
    expect(call(lookup)?.name).toBe('list_subscriptions');
    const blocked = result('list_subscriptions', undefined, true);
    blocked.toolCallId = call(lookup)!.id;
    const waiting = respondWithGuidance({ messages: [...messages, lookup, blocked], tools });
    expect(call(waiting)).toBeUndefined();
    complete(messages, lookup, [{ id: 'actual-netflix', name: 'Netflix' }]);
    const final = respondWithGuidance({ messages, tools });
    expect(call(final)).toMatchObject({ name: 'describe_turn', arguments: {
      purpose: 'operation', operations: ['cancel_subscription'],
    } });
    completeDeclaration(messages, final);
    expect(call(respondWithGuidance({ messages, tools })))
      .toMatchObject({ name: 'cancel_subscription', arguments: { subscriptionId: 'actual-netflix' } });
  });

  it('does not broaden an unspecified two-card request to three owned cards', () => {
    const messages = [user('\u51bb\u7ed3\u4e24\u5f20\u94f6\u884c\u5361')];
    const lookup = respondWithGuidance({ messages, tools });
    expect(call(lookup)?.name).toBe('get_cards');
    complete(messages, lookup, [{ id: 'credit', type: 'CREDIT' }, { id: 'debit', type: 'DEBIT' }, { id: 'virtual', type: 'VIRTUAL' }]);
    const next = respondWithGuidance({ messages, tools });
    if (call(next)?.name === 'describe_turn') {
      expect(call(next)?.arguments.operations).not.toContain('freeze_card');
      completeDeclaration(messages, next);
    }
    expect(call(respondWithGuidance({ messages, tools }))).toBeUndefined();
  });

  it.each([
    ['\u7533\u8d2d\u7a33\u5065\u7406\u8d22A 100\u5143', 'list_investments', 'subscribe_investment',
      [{ id: 'owned-real-product', name: '\u7a33\u5065\u7406\u8d22A', code: 'ACTUAL' }], { productId: 'owned-real-product', amount: '100' }],
    ['\u8d4e\u56de\u7a33\u5065\u7406\u8d22A', 'get_investment_holdings', 'redeem_investment',
      [{ id: 'owned-real-holding', productName: '\u7a33\u5065\u7406\u8d22A' }], { holdingId: 'owned-real-holding' }],
    ['\u53d6\u6d88Netflix\u8ba2\u9605', 'list_subscriptions', 'cancel_subscription',
      [{ id: 'owned-real-subscription', name: 'Netflix' }], { subscriptionId: 'owned-real-subscription' }],
  ] as const)('binds %s to the recorded resource identity', (text, readTool, writeTool, rows, args) => {
    const messages = [user(text)];
    let lookup = respondWithGuidance({ messages, tools });
    if (readTool === 'list_subscriptions') {
      expect(call(lookup)).toMatchObject({ name: 'describe_turn', arguments: { purpose: 'operation', operations: ['list_subscriptions'] } });
      completeDeclaration(messages, lookup);
      lookup = respondWithGuidance({ messages, tools });
    }
    expect(call(lookup)?.name).toBe(readTool);
    complete(messages, lookup, rows);
    const declaration = respondWithGuidance({ messages, tools });
    expect(call(declaration)).toMatchObject({ name: 'describe_turn', arguments: { purpose: 'operation', operations: [writeTool] } });
    completeDeclaration(messages, declaration);
    const proposal = respondWithGuidance({ messages, tools });
    expect(call(proposal)).toMatchObject({ name: writeTool, arguments: args });
  });

  it('does not substitute another product or repeat a failed lookup', () => {
    const messages = [user('\u7533\u8d2d\u672a\u77e5\u4ea7\u54c1 100\u5143')];
    const lookup = respondWithGuidance({ messages, tools });
    const proposal = respondWithGuidance({ messages: [...messages, lookup,
      result('list_investments', [{ id: 'different', name: '\u7a33\u5065\u7406\u8d22A' }])], tools });
    expect(call(proposal)).toBeUndefined();
    const failed = respondWithGuidance({ messages: [...messages, lookup, result('list_investments', [], true)], tools });
    expect(call(failed)).toBeUndefined();
  });

  it('does not mistake a control call from an earlier turn for the new declaration', () => {
    const old = fauxAssistantMessage([fauxToolCall('describe_turn', { purpose: 'operation', operations: ['freeze_card'] })]);
    const reply = respondWithGuidance({ messages: [user('Previous request'), old, result('describe_turn', {}), user('Hello')], tools });
    expect(call(reply)).toMatchObject({ name: 'describe_turn', arguments: { purpose: 'conversation', operations: [] } });
  });
});
