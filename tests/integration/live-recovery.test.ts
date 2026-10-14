import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runTurn, loadSession } from '@/agent';
import { getTestPrisma, useFreshDatabase } from '@/tests/helpers/db';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import { CONVERSATION_GENERATION_FAILED } from '@/agent/conversational-response';

useFreshDatabase();
const config = { llmMode: 'live' as const, llmProvider: 'faux', llmModel: 'faux', demoUserId: 'user_liming' };
const call = (name: string, args = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });

describe('single original prompt and explicit transport failure', () => {
  it.each(['Transfer 200.37 to Zhang Wei.', 'Which subscriptions can I stop using?', 'Hello.'])
  ('does not infer a second planning request from user wording: %s', async request => {
    const answer = 'Could you clarify what you would like to do?';
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [
      fauxAssistantMessage(answer), call('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
    ]);
    const result = await runTurn({ message: request }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.at(-1)?.content).toBe(answer);
    expect(saved?.agentState.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(saved?.agentState.messages.some(message => message.role === 'user' && (typeof message.content === 'string'
      ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('')) === request)).toBe(true);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  });

  it.each(['Request timed out.', '401 authentication failed.', '503 temporary outage.', 'Malformed response.'])
  ('does not determine automatic retries or change user text from an error string: %s', async errorMessage => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      fauxAssistantMessage('Unpublished partial prose.', { stopReason: 'error', errorMessage }),
      call('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
    ]);
    const result = await runTurn({ message: 'Transfer 200.37 to Zhang Wei.' }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.at(-1)?.content).toBe(CONVERSATION_GENERATION_FAILED);
    expect(saved?.transcript.at(-1)?.retryRequest).toBeUndefined();
    expect(JSON.stringify(saved?.transcript)).not.toContain('Unpublished partial prose.');
    expect(JSON.stringify(saved?.agentState.messages)).toContain('Unpublished partial prose.');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    const model = await getTestPrisma().modelRequest.findFirstOrThrow({ where: { runId: result.runId, status: 'failed' } });
    expect(model.errorCode).toBe('MODEL_PERMANENT');
  });

  it('preserves a completed read card when narration fails without querying again', async () => {
    const script = scriptedProvider({ purpose: 'query', operations: ['get_balance'] }, [
      call('get_balance'), fauxAssistantMessage('Partial explanation.', { stopReason: 'error', errorMessage: 'Network interruption.' }),
    ]);
    const result = await runTurn({ message: 'Read my balance.' }, { config, provider: script.provider });
    const saved = await loadSession(result.sessionId);
    const tool = saved?.transcript.find(message => message.role === 'tool');
    expect(tool?.cards?.[0].type).toBe('balance');
    expect(tool?.toolEvents?.[0].status).toBe('success');
    expect(saved?.transcript.at(-1)?.content).toBe(CONVERSATION_GENERATION_FAILED);
    expect(await getTestPrisma().toolInvocation.count({ where: { runId: result.runId, toolName: 'get_balance' } })).toBe(1);
    expect(script.calls()).toBe(3);
  });

  it('preserves a committed automatic budget and its receipt after failed narration', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['reserve_budget'] }, [
      call('reserve_budget', { name: 'Interruption budget', amount: '66.66' }),
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Timeout.' }),
    ]);
    const result = await runTurn({ message: 'Reserve 66.66 for Interruption budget.' }, { config, provider: script.provider });
    expect(await getTestPrisma().budget.count({ where: { name: 'Interruption budget' } })).toBe(1);
    expect(await getTestPrisma().executionReceipt.count()).toBe(1);
    expect(await getTestPrisma().auditLog.count({ where: { sessionId: result.sessionId, toolName: 'reserve_budget', status: 'success' } })).toBe(1);
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.find(message => message.role === 'tool')?.toolEvents?.[0].status).toBe('success');
    expect(saved?.transcript.at(-1)?.retryRequest).toBeUndefined();
    expect(script.calls()).toBe(3);
  });

  it('a parked action is already a complete tool response and does not need another provider call', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      call('transfer_money', { contactId: 'contact_zhangwei', amount: '200.37' }),
    ]);
    const result = await runTurn({ message: 'Transfer 200.37 to Zhang Wei.' }, { config, provider: script.provider });
    expect(result.events.some(event => event.type === 'confirmation_required')).toBe(true);
    const saved = await loadSession(result.sessionId);
    expect(saved?.transcript.at(-1)?.role).toBe('tool');
    expect(saved?.transcript.at(-1)?.cards?.[0].type).toBe('confirmation');
    expect(script.calls()).toBe(2);
    expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  });
});
