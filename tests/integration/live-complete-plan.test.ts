import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { runTurn, confirmAction, loadSession, getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import type { AppConfig } from '@/lib/config';

const config: AppConfig = { llmMode: 'live', llmProvider: 'deepseek', llmModel: 'scripted', demoUserId: 'user_liming' };
const request = 'Transfer two explicitly selected amounts to two saved contacts.';
const db = getTestPrisma;
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const node = (id: string, contactId: string, amount: unknown, dependencies: string[] = []) => ({ id, name: id, kind: 'tool', tool: 'transfer_money',
  args: { contactId, amount, remark: 'Shared lunch' }, dependencies });
const nodes = () => [node('first', 'contact_zhangwei', '100.17'), node('second', 'contact_wangfang', '200.29', ['first'])];
const call = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(tool, args as JsonObject)], { stopReason: 'toolUse' });
async function unchanged() {
  expect(await db().pendingAction.count()).toBe(0);
  expect(await db().agentTask.count()).toBe(0);
  expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

describe('declared complete plan before first authorization', () => {
  it('rejects a separate transfer for a declared two-write request without automatic planning retry', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money', 'transfer_money'] }, [
      call('transfer_money', { contactId: 'contact_zhangwei', amount: '100.17' }),
    ]);
    const result = await runTurn({ message: request }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    await unchanged();
    expect(result.events.some(event => event.type === 'confirmation_required' || event.type === 'mfa_required')).toBe(false);
    const saved = (await loadSession(result.sessionId))!;
    expect(saved.transcript.every(message => message.retryRequest === undefined)).toBe(true);
    expect(result.events.filter(event => event.type === 'tool_end').map(event => event.toolEvent)).toContainEqual(expect.objectContaining({ toolName: 'transfer_money', status: 'blocked' }));
  });

  it('accepts a complete declared DAG and confirms each saved leg exactly once', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money', 'transfer_money'] }, [
      call('submit_plan', { goal: 'Shared lunch', nodes: nodes() }),
      fauxAssistantMessage('Review the saved workflow.'),
    ]);
    const result = await runTurn({ message: request }, { config, provider: script.provider });
    const plan = await db().agentTask.findFirstOrThrow({ include: { nodes: true } });
    expect(plan.nodes).toHaveLength(2);
    expect(await db().pendingAction.count()).toBe(1);
    const first = await db().pendingAction.findFirstOrThrow({ where: { nodeId: 'first' } });
    const callsBefore = script.calls();
    expect((await confirmAction(first.id, { deps: { config, provider: script.provider } })).ok).toBe(true);
    const second = await db().pendingAction.findFirstOrThrow({ where: { nodeId: 'second' } });
    expect(JSON.parse(second.argsJson)).toMatchObject({ contactId: 'contact_wangfang', amount: '200.29' });
    expect((await confirmAction(second.id, { deps: { config, provider: script.provider } })).ok).toBe(true);
    expect(script.calls()).toBe(callsBefore);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2327954n);
    expect(await db().transaction.count({ where: { channel: 'TRANSFER', direction: 'DEBIT', amountMinor: { in: [-10017n, -20029n] } } })).toBe(2);
    await confirmAction(first.id, { deps: { config, provider: script.provider } });
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2327954n);
    expect((await loadSession(result.sessionId))?.transcript.filter(message => message.role === 'user')).toHaveLength(1);
  });

  it('rejects a partial workflow before its automatic budget can execute', async () => {
    const budget = { id: 'budget', name: 'Budget', kind: 'tool', tool: 'reserve_budget', args: { name: 'coverage-test', amount: '3.33' }, dependencies: [] };
    const script = scriptedProvider({ purpose: 'operation', operations: ['reserve_budget', 'transfer_money', 'transfer_money'] }, [
      call('submit_plan', { goal: 'Partial workflow', nodes: [budget, nodes()[0]] }),
      fauxAssistantMessage('The last declared operation is missing from this candidate.'),
    ]);
    await runTurn({ message: request }, { config, provider: script.provider });
    expect(script.calls()).toBe(2);
    expect(await db().budget.count({ where: { name: 'coverage-test' } })).toBe(0);
    await unchanged();
  });

  it.each([
    ['missing leg', [nodes()[0]]],
    ['unknown recipient', [nodes()[0], node('second', 'unknown-contact', '200.29', ['first'])]],
    ['fractional cent', [node('first', 'contact_zhangwei', '100.171'), nodes()[1]]],
    ['numeric amount', [node('first', 'contact_zhangwei', 100.17), nodes()[1]]],
    ['duplicate leg', [...nodes(), node('extra', 'contact_zhangwei', '100.17')]],
  ])('rejects %s before persistence or money changes', async (_, proposed) => {
    const session = await getOrCreateSession(config.demoUserId);
    const declaration = declareConversationIntent(advanceConversationIntent(undefined, request), 'operation', ['transfer_money', 'transfer_money']);
    const result = await runSubmitPlan(config.demoUserId, { goal: 'Complete declared transfers', nodes: proposed }, {
      sessionId: session.sessionId, userRequest: () => request, conversationIntent: () => declaration,
      runTool: (toolName, args, ctx) => executeGatedTool({ sessionId: session.sessionId, userId: config.demoUserId, toolName, args, userRequest: request, ...ctx }),
    });
    expect(result.ok).toBe(false);
    await unchanged();
  });

  it('uses explicit graph dependencies for equal-amount recipients without rewriting node order from the sentence', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money', 'transfer_money'] }, [
      call('submit_plan', { goal: 'Equal amounts', nodes: [node('second', 'contact_wangfang', '100.17', ['first']), node('first', 'contact_zhangwei', '100.17')] }),
      fauxAssistantMessage('Review the two exact recipients.'),
    ]);
    await runTurn({ message: request }, { config, provider: script.provider });
    const action = await db().pendingAction.findFirstOrThrow();
    expect(action.nodeId).toBe('first');
    expect(JSON.parse(action.argsJson).contactId).toBe('contact_zhangwei');
    expect(await db().agentTaskNode.count()).toBe(2);
  });

  it('does not broaden a single-write declaration into a workflow because other operations appear in raw prose', async () => {
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
      call('transfer_money', { contactId: 'contact_zhangwei', amount: '100.17' }),
      fauxAssistantMessage('Review the selected transfer.'),
    ]);
    await runTurn({ message: 'Do not transfer to the second contact; transfer only to the selected contact.' }, { config, provider: script.provider });
    expect(await db().pendingAction.count()).toBe(1);
    expect(await db().agentTask.count()).toBe(0);
    expect(script.calls()).toBe(2);
  });
});
