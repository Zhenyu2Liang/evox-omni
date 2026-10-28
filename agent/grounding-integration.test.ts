/** Provider prose, typed tool evidence and actual banking effects have separate authority. */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { cancelAction, confirmAction, loadSession, resumeTurn, runTurn, verifyAction } from '@/agent';
import type { AgentStreamEvent, ChatMessage } from '@/lib/contracts/agent';
import { scriptedProvider, type ScriptedTurnDeclaration } from '@/tests/helpers/scripted-provider';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const config = { llmMode: 'live' as const, llmProvider: 'deepseek', llmModel: 'scripted', demoUserId: DEMO_USER_ID };
const tool = (name: string, args: JsonObject) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
const messages = (events: readonly AgentStreamEvent[]): ChatMessage[] => {
  const map = new Map<string, ChatMessage>();
  for (const event of events) if (event.type === 'message_end') map.set(event.message.id, event.message);
  return [...map.values()];
};
const lastProse = (events: readonly AgentStreamEvent[]) => messages(events).filter(message => message.role === 'assistant').at(-1)?.content;
const toolRows = (events: readonly AgentStreamEvent[]) => messages(events).filter(message => message.role === 'tool');

async function noFinancialEffects(beforeTransactions: number) {
  const db = getTestPrisma();
  expect(await db.transaction.count()).toBe(beforeTransactions);
  expect(await db.executionReceipt.count()).toBe(0);
  expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

async function parkTransfer(amount: string) {
  const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money'] }, [
    tool('transfer_money', { contactId: 'contact_zhangwei', amount }),
    fauxAssistantMessage('Review the operation card to continue.'),
  ]);
  const turn = await runTurn({ message: 'Transfer the explicitly selected amount to the saved contact.' }, { config, provider: script.provider });
  const action = await getTestPrisma().pendingAction.findFirstOrThrow();
  return { turn, action, script };
}

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);

describe('separate model prose and authoritative tool entries', () => {
  it.each([
    'Your balance is 999999.99 CNY.',
    'The transfer has completed successfully.',
    'An explanation may quote the phrase: the operation completed successfully.',
  ])('preserves independent explanation and replaces unsupported balance or outcome assertions: %s', async prose => {
    const before = await getTestPrisma().transaction.count();
    const script = scriptedProvider({ purpose: 'query', operations: ['get_balance'] }, [tool('get_balance', {}), fauxAssistantMessage(prose)]);
    const turn = await runTurn({ message: 'Read my account balances and explain them.' }, { config, provider: script.provider });
    if (prose.startsWith('An explanation')) expect(lastProse(turn.events)).toBe(prose);
    else {
      expect(lastProse(turn.events)).toContain('23,580.00');
      expect(lastProse(turn.events)).toContain('73,580.00');
      expect(lastProse(turn.events)).not.toContain('999999.99');
      expect(lastProse(turn.events)).not.toContain('completed successfully');
    }
    const rows = toolRows(turn.events);
    expect(rows).toHaveLength(1);
    expect(rows[0].toolEvents).toMatchObject([{ toolName: 'get_balance', status: 'success' }]);
    expect(rows[0].cards).toContainEqual({ type: 'balance', data: expect.objectContaining({ totalAvailable: '73580.00' }) });
    expect(messages(turn.events).filter(message => message.role === 'assistant').every(message => !message.cards?.length && !message.toolEvents?.length)).toBe(true);
    expect(messages(turn.events).findIndex(message => message.role === 'tool')).toBeLessThan(messages(turn.events).findLastIndex(message => message.role === 'assistant'));
    const saved = await loadSession(turn.sessionId);
    expect(saved?.transcript.filter(message => message.role === 'assistant').at(-1)?.content).toBe(lastProse(turn.events));
    expect(saved?.agentState.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === prose))).toBe(true);
    await noFinancialEffects(before);
  });

  it('does not treat a completion claim without any tool call as a bank instruction', async () => {
    const before = await getTestPrisma().transaction.count();
    const prose = 'I have transferred 500 CNY to Alice.';
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, [fauxAssistantMessage(prose)]);
    const turn = await runTurn({ message: 'Explain how a transfer works.' }, { config, provider: script.provider });
    expect(lastProse(turn.events)).toBe('本轮尚未创建待确认操作，也未执行任何新的银行操作。');
    expect(toolRows(turn.events)).toEqual([]);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    await noFinancialEffects(before);
  });

  it.each([
    { purpose: 'query', operations: ['list_investments'], toolName: 'list_investments', card: 'investments' },
    { purpose: 'query', operations: ['analyze_spending'], toolName: 'analyze_spending', card: 'spending' },
  ] as const)('keeps the $toolName result card before the complete Markdown answer', async scenario => {
    const declaration: ScriptedTurnDeclaration = { purpose: scenario.purpose, operations: scenario.operations };
    const prose = '**Analysis**\n\n- Explain the observed data.\n- Distinguish facts from assumptions.';
    const script = scriptedProvider(declaration, [tool(scenario.toolName, {}), fauxAssistantMessage(prose)]);
    const turn = await runTurn({ message: 'Show the requested data and explain it.' }, { config, provider: script.provider });
    expect(lastProse(turn.events)).toBe(prose);
    const row = toolRows(turn.events).find(message => message.toolEvents?.some(event => event.toolName === scenario.toolName));
    expect(row?.cards?.some(card => card.type === scenario.card)).toBe(true);
    expect(messages(turn.events).indexOf(row!)).toBeLessThan(messages(turn.events).findIndex(message => message.content === prose));
  });

  it('keeps separately completed prose around a tool call in its original event order', async () => {
    const introduction = 'I will read the current balance first.';
    const conclusion = 'The query is complete; consider the saved result card.';
    const script = scriptedProvider({ purpose: 'query', operations: ['get_balance'] }, [
      fauxAssistantMessage([{ type: 'text', text: introduction }, fauxToolCall('get_balance', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage(conclusion),
    ]);
    const turn = await runTurn({ message: 'Read the balance.' }, { config, provider: script.provider });
    const timeline = messages(turn.events);
    expect(timeline.filter(message => message.role === 'assistant').map(message => message.content)).toEqual([introduction, conclusion]);
    const toolIndex = timeline.findIndex(message => message.role === 'tool');
    expect(timeline.findIndex(message => message.content === introduction)).toBeLessThan(toolIndex);
    expect(toolIndex).toBeLessThan(timeline.findIndex(message => message.content === conclusion));
  });

  it('rejects a write proposal during a query regardless of its accompanying success claim', async () => {
    const before = await getTestPrisma().transaction.count();
    const script = scriptedProvider({ purpose: 'query', operations: ['get_balance'] }, [
      tool('transfer_money', { contactId: 'contact_zhangwei', amount: '500.00' }),
      fauxAssistantMessage('The transfer has completed.'),
    ]);
    const turn = await runTurn({ message: 'Read my balance.' }, { config, provider: script.provider });
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(toolRows(turn.events).flatMap(message => message.toolEvents ?? [])).toContainEqual(expect.objectContaining({ toolName: 'transfer_money', status: 'blocked' }));
    await noFinancialEffects(before);
  });
});

describe('authorization and write receipts remain server-owned', () => {
  it.each([['200.00', 'pending'], ['2000.00', 'awaiting_mfa']] as const)('parks %s before any debit and records the authoritative %s state', async (amount, status) => {
    const before = await getTestPrisma().transaction.count();
    const { action, turn } = await parkTransfer(amount);
    expect(action.status).toBe(status);
    expect(turn.events.some(event => event.type === (status === 'pending' ? 'confirmation_required' : 'mfa_required'))).toBe(true);
    expect(toolRows(turn.events).flatMap(message => message.toolEvents ?? [])).toContainEqual(expect.objectContaining({ toolName: 'transfer_money', status: 'blocked', actionId: action.id }));
    await noFinancialEffects(before);
  });

  it('confirms the saved transfer exactly once and does not invoke a model to decide whether it succeeded', async () => {
    const { action, turn, script } = await parkTransfer('200.00');
    const callsBefore = script.calls();
    const outcome = await confirmAction(action.id, { deps: { config, provider: script.provider } });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('executed');
    expect(script.calls()).toBe(callsBefore);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2338000n);
    expect(await getTestPrisma().executionReceipt.count()).toBe(1);
    await confirmAction(action.id, { deps: { config, provider: script.provider } });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2338000n);
    expect(await getTestPrisma().transaction.count({ where: { channel: 'TRANSFER', amountMinor: -20000n } })).toBe(1);
    const saved = await loadSession(turn.sessionId);
    expect(saved?.agentState.messages.some(message => message.role === 'toolResult' && message.toolName === 'transfer_money')).toBe(true);
  });

  it('keeps an unknown authorized outcome in the tool status without executing another transfer', async () => {
    const before = await getTestPrisma().transaction.count();
    const { turn } = await parkTransfer('200.00');
    const row = toolRows(turn.events)[0];
    const script = scriptedProvider({ purpose: 'conversation', operations: [] }, []);
    const resumed = await resumeTurn({ sessionId: turn.sessionId, toolName: 'transfer_money', toolCallId: row.toolEvents![0].toolCallId,
      toolResult: { ok: false, data: { needsReconciliation: true } } }, { config, provider: script.provider });
    expect(script.calls()).toBe(0);
    expect(toolRows(resumed.events).flatMap(message => message.toolEvents ?? [])).toContainEqual(expect.objectContaining({ status: 'needs_reconciliation' }));
    await noFinancialEffects(before);
  });

  it('failed strong-verification execution records a failure and cannot fabricate a debit', async () => {
    const before = await getTestPrisma().transaction.count();
    const { action, script } = await parkTransfer('30000.01');
    const outcome = await verifyAction(action.id, '123456', { deps: { config, provider: script.provider } });
    expect(outcome.ok).toBe(false);
    expect(outcome.status).toBe('failed');
    expect((await getTestPrisma().pendingAction.findUniqueOrThrow({ where: { id: action.id } })).status).toBe('failed');
    await noFinancialEffects(before);
  });

  it('cancels the pending transfer without a debit or model continuation', async () => {
    const before = await getTestPrisma().transaction.count();
    const { action, turn, script } = await parkTransfer('200.00');
    const callsBefore = script.calls();
    const outcome = await cancelAction(action.id, { sessionId: turn.sessionId });
    expect(outcome.ok).toBe(true);
    expect(outcome.status).toBe('cancelled');
    expect(script.calls()).toBe(callsBefore);
    await noFinancialEffects(before);
  });
});
