import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getOrCreateSession, runTurn } from '@/agent';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseStep, type JsonObject } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@/agent/providers/types';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import * as runRepository from '@/lib/db/repositories/agentRun';
import { recordRiskSignal } from '@/security/incidents';
import { isLocked } from '@/security/circuit-breaker';
import { issueChallenge, verify } from '@/security/mfa';
import { executeGatedTool } from '@/agent/confirmation';
import { readRunPresentation } from '@/agent/durable';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import { turnDeclaration, type ScriptedTurnDeclaration } from '@/tests/helpers/scripted-provider';

const userId = 'user_liming';
beforeEach(resetDatabase);
afterEach(() => vi.restoreAllMocks());
afterAll(disconnectTestPrisma);

function scriptedRuntime(declaration: ScriptedTurnDeclaration, steps: FauxResponseStep[]): ModelRuntime {
  const provider = fauxProvider();
  const models = createModels();
  models.setProvider(provider.provider);
  provider.setResponses([turnDeclaration(declaration), ...steps]);
  return { model: provider.getModel(), streamFn: models.streamSimple.bind(models) };
}

function toolStep(toolName: string, args: JsonObject): FauxResponseStep {
  return fauxAssistantMessage([fauxToolCall(toolName, args)], { stopReason: 'toolUse' });
}

it('refuses a bank effect when its started event cannot become durable', async () => {
  const session = await getOrCreateSession(userId);
  const budgetsBefore = await getTestPrisma().budget.count();
  vi.spyOn(runRepository, 'startInvocationWithEvent').mockRejectedValue(new Error('Journal unavailable'));
  await expect(runTurn({ sessionId: session.sessionId, requestId: 'event-storage-failure', message: 'Create a budget of 0.17 CNY.' }, {
    provider: scriptedRuntime({ purpose: 'operation', operations: ['reserve_budget'] }, [toolStep('reserve_budget', { name: 'Blocked budget', amount: '0.17' })]),
  })).rejects.toThrow('Journal unavailable');
  expect(await getTestPrisma().budget.count()).toBe(budgetsBefore);
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
  expect(await getTestPrisma().toolInvocation.count()).toBe(0);
  expect((await getTestPrisma().agentSession.findUniqueOrThrow({ where: { id: session.sessionId } })).activeRunId).toBeNull();
  expect((await getTestPrisma().agentRun.findFirstOrThrow()).status).toBe('failed');
});

it('deduplicates repeated incident delivery and locks the shared account on the third distinct unauthorized access', async () => {
  const first = await getOrCreateSession(userId);
  const second = await getOrCreateSession(userId);
  for (let index = 1; index <= 2; index++) await recordRiskSignal({ sessionId: first.sessionId,
    kind: 'unauthorized_resource_access', dedupeKey: `signal-${index}`, message: 'An unauthorized resource access was rejected.' });
  await recordRiskSignal({ sessionId: first.sessionId, kind: 'unauthorized_resource_access',
    dedupeKey: 'signal-2', message: 'An unauthorized resource access was rejected.' });
  expect(await isLocked(second.sessionId)).toBe(false);
  await recordRiskSignal({ sessionId: second.sessionId, kind: 'unauthorized_resource_access',
    dedupeKey: 'signal-3', message: 'An unauthorized resource access was rejected.' });
  expect(await isLocked(first.sessionId)).toBe(true);
  expect(await isLocked(second.sessionId)).toBe(true);
  expect(await getTestPrisma().riskSignal.count()).toBe(3);
  expect(await getTestPrisma().securityEvent.count({ where: { kind: 'CIRCUIT_BREAKER_TRIPPED' } })).toBe(1);
});

it('expires strong verification on wall time and rejects a challenge when the bound amount changes', async () => {
  const session = await getOrCreateSession(userId);
  const outcome = await executeGatedTool({ sessionId: session.sessionId, userId, toolName: 'transfer_money',
    args: { contactId: 'contact_zhangwei', amount: '2000.00' }, userRequest: 'Transfer 2000.00 CNY.' });
  const actionId = outcome.pendingActionId!;
  await getTestPrisma().mfaChallenge.update({ where: { actionId }, data: { expiresAt: new Date(Date.now() - 1) } });
  expect(await verify(actionId, '123456')).toMatchObject({ ok: false, error: { code: 'MFA_FAILED' } });
  await issueChallenge(actionId);
  await getTestPrisma().pendingAction.update({ where: { id: actionId }, data: { argsJson: '{"contactId":"contact_zhangwei","amount":"2000.01"}' } });
  expect(await verify(actionId, '123456')).toMatchObject({ ok: false, error: { code: 'MFA_FAILED' } });
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
});

it('replays a transport request from its run journal and preserves separate prose and tool events', async () => {
  const session = await getOrCreateSession(userId);
  const request = { sessionId: session.sessionId, requestId: 'repeat-balance', message: 'Read my balance.' };
  const runtime = scriptedRuntime({ purpose: 'query', operations: ['get_balance'] }, [toolStep('get_balance', {}), fauxAssistantMessage('Balance read completed.')]);
  const original = await runTurn(request, { provider: runtime });
  const repeated = await runTurn(request, { provider: scriptedRuntime({ purpose: 'query', operations: ['get_balance'] }, []) });
  expect(repeated.runId).toBe(original.runId);
  expect(repeated.events).toEqual(original.events);
  expect(await getTestPrisma().agentRun.count()).toBe(1);
  const raw = await getTestPrisma().agentRunEvent.findMany({ where: { runId: original.runId, channel: 'raw' } });
  expect(raw.some(event => event.eventType === 'tool_execution_start')).toBe(true);
  const page = await readRunPresentation(original.runId!, userId, 0, 500);
  expect(page.events.map(event => event.payload)).toEqual(original.events);
  expect(page.events.every(event => event.channel === 'ui')).toBe(true);
});

it('publishes an authoritative balance tool entry before the complete unmodified provider prose', async () => {
  const session = await getOrCreateSession(userId);
  const delivered: AgentStreamEvent[] = [];
  const turn = await runTurn({ sessionId: session.sessionId, requestId: 'live-presentation', message: 'Read my balance.' }, {
    config: { llmMode: 'live', llmProvider: 'deepseek', llmModel: 'scripted', demoUserId: userId },
    provider: scriptedRuntime({ purpose: 'query', operations: ['get_balance'] }, [toolStep('get_balance', {}), fauxAssistantMessage('The balance is 999999.99.')]),
    onEvent(event) { delivered.push(event); },
  });
  expect(delivered).toEqual(turn.events);
  expect(JSON.stringify(delivered)).toContain('999999.99');
  const state = reduceAgentEvents(initialChatUIState(), delivered);
  expect(state.messages.flatMap(message => message.cards ?? []).filter(card => card.type === 'balance')).toHaveLength(1);
  expect(delivered.findIndex(event => event.type === 'tool_start')).toBeLessThan(delivered.findIndex(event => event.type === 'card'));
  const balance = state.messages.find(message => message.role === 'tool' && message.cards?.some(card => card.type === 'balance'));
  expect(balance?.cards).toContainEqual({ type: 'balance', data: expect.objectContaining({ totalAvailable: '73580.00' }) });
  const prose = state.messages.find(message => message.role === 'assistant' && message.content === 'The balance is 999999.99.');
  expect(prose).toBeDefined();
  expect(state.messages.indexOf(balance!)).toBeLessThan(state.messages.indexOf(prose!));
  expect(await getTestPrisma().executionReceipt.count()).toBe(0);
});
