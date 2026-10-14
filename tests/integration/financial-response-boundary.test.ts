import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, fauxText } from '@earendil-works/pi-ai';
import { loadSession, runTurn, confirmAction } from '@/agent';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';

useFreshDatabase();

const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming' };
const call = (name: string, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

describe('explanatory prose and financial execution evidence', () => {
  it.each(['The annual estimate is 3783.60 CNY.', 'A negative amount of -10 is invalid.',
    'You said 200 earlier; this is historical discussion.', 'An example payment succeeded; that is only an example.'])
  ('preserves complete explanation without treating its words as bank effects: %s', async content => {
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(content)]);
    const result = await runTurn({ message: 'Explain the previous discussion.' }, { config, provider: script.provider });
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.at(-1)).toMatchObject({ role: 'assistant', content, cards: [] });
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
    expect(await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).toMatchObject({ balanceMinor: 2358000n });
  });

  it('keeps a prelude, tool result, and final explanation in their original chronological positions', async () => {
    const prelude = 'I will retrieve your balance.';
    const explanation = 'The retrieved values are shown in the account result.';
    const script = scriptedProvider({ purpose: 'query', operations: ['get_balance'] }, [
      fauxAssistantMessage([fauxText(prelude), fauxToolCall('get_balance', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage(explanation),
    ]);
    const result = await runTurn({ message: 'Read my balance.' }, { config, provider: script.provider });
    const messages = result.events.flatMap(event => event.type === 'message_end' ? [event.message] : []);
    expect(messages.map(message => message.role)).toEqual(['assistant', 'tool', 'assistant']);
    expect(messages[0].content).toBe(prelude);
    expect(messages[1].cards?.[0].type).toBe('balance');
    expect(messages[1].toolEvents?.[0]).toMatchObject({ toolName: 'get_balance', status: 'success', messageId: messages[1].id });
    expect(messages[2]).toMatchObject({ content: explanation, cards: [] });
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.filter(message => message.role !== 'user')).toEqual(messages);
    expect(result.events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(prelude + explanation);
  });

  it('uses the actual authorized transfer result and never asks the provider to invent its receipt', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      call('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
    ]);
    const result = await runTurn({ message: 'Transfer 200.37 to Zhang Wei.' }, { config, provider: script.provider });
    const pending = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: result.sessionId } });
    const callsBefore = script.calls();
    const outcome = await confirmAction(pending.id, { sessionId: result.sessionId, userId: config.demoUserId,
      deps: { config, provider: script.provider } });
    expect(outcome.ok).toBe(true);
    expect(script.calls()).toBe(callsBefore);
    expect(await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).toMatchObject({ balanceMinor: 2337963n });
    expect(await getTestPrisma().transaction.count({ where: { accountId: 'acct_checking', amountMinor: -20037n } })).toBe(1);
    const saved = await loadSession(result.sessionId);
    const original = saved?.transcript.find(message => message.role === 'tool' && message.toolEvents?.[0]?.toolName === 'transfer_money');
    expect(original?.toolEvents?.[0].status).toBe('success');
    expect(original?.cards?.some(card => card.type === 'transfer')).toBe(true);
    expect(saved?.transcript.at(-1)?.content).toContain('200.37');
  });
});
