import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { runTurn, confirmAction, verifyAction, loadSession, getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { scriptedProvider } from '@/tests/helpers/scripted-provider';
import { INVESTMENT_FLOW_CATEGORY } from '@/banking-sdk/categories';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { resetDatabase, getTestPrisma, disconnectTestPrisma } from '@/tests/helpers/db';

beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const config = { llmMode: 'live' as const, llmProvider: 'deepseek', llmModel: 'scripted', demoUserId: 'user_liming' };
const node = (id: string, tool: string, args: Record<string, unknown>, dependencies: string[] = []): TaskNodeSpec =>
  ({ id, name: id, kind: 'tool', tool, args, dependencies });
const call = (tool: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(tool, args as JsonObject)], { stopReason: 'toolUse' });
const transferNodes = () => [node('first', 'transfer_money', { contactId: 'contact_zhangwei', amount: '100.17' }),
  node('second', 'transfer_money', { contactId: 'contact_wangfang', amount: '200.29' }, ['first'])];
async function submit(nodes: TaskNodeSpec[], operations: string[]) {
  const session = await getOrCreateSession('user_liming');
  const request = 'Original request is preserved without reinterpretation.';
  const declaration = declareConversationIntent(advanceConversationIntent(undefined, request), 'operation', operations);
  return runSubmitPlan('user_liming', { goal: 'Declared workflow', nodes }, { sessionId: session.sessionId,
    userRequest: () => request, conversationIntent: () => declaration,
    runTool: (toolName, args, ctx) => executeGatedTool({ sessionId: session.sessionId, userId: 'user_liming', toolName, args, userRequest: request, ...ctx }) });
}
async function noEntry() {
  expect(await getTestPrisma().pendingAction.count()).toBe(0);
  expect(await getTestPrisma().agentTask.count()).toBe(0);
  expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

describe('raw wording and declared owned-resource workflows', () => {
  it.each(['Do not add a remark.', 'Do not debit twice.', 'Do not add another transfer.'])('preserves the qualifier %s while executing only the two declared transfer nodes', async qualifier => {
    const request = 'Transfer the two selected amounts to the two saved recipients. ' + qualifier;
    const script = scriptedProvider({ purpose: 'operation', operations: ['transfer_money', 'transfer_money'] }, [
      call('submit_plan', { goal: 'Two transfers', nodes: transferNodes() }), fauxAssistantMessage('Review both transfers.'),
    ]);
    const result = await runTurn({ message: request }, { config, provider: script.provider });
    expect(await getTestPrisma().agentTaskNode.count()).toBe(2);
    const first = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'first' } });
    const callsBefore = script.calls();
    expect((await confirmAction(first.id, { deps: { config, provider: script.provider } })).ok).toBe(true);
    const second = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'second' } });
    expect((await confirmAction(second.id, { deps: { config, provider: script.provider } })).ok).toBe(true);
    expect(script.calls()).toBe(callsBefore);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2327954n);
    expect((await loadSession(result.sessionId))?.transcript.find(message => message.role === 'user')?.content).toBe(request);
    expect(await getTestPrisma().transaction.count({ where: { amountMinor: { in: [-10017n, -20029n] }, channel: 'TRANSFER' } })).toBe(2);
  });

  it('binds an exact owned holding, requires MFA, credits once, then offers the saved transfer', async () => {
    const nodes = [node('redeem', 'redeem_investment', { holdingId: 'holding_wenjiana', mode: 'ALL' }),
      node('transfer', 'transfer_money', { contactId: 'contact_zhangwei', amount: '100.17' }, ['redeem'])];
    const script = scriptedProvider({ purpose: 'operation', operations: ['redeem_investment', 'transfer_money'] }, [
      call('submit_plan', { goal: 'Redemption then transfer', nodes }), fauxAssistantMessage('Review the holding and transfer.'),
    ]);
    await runTurn({ message: 'Redeem the selected holding and then transfer 100.17 CNY.' }, { config, provider: script.provider });
    const first = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'redeem' } });
    expect(first.status).toBe('awaiting_mfa');
    expect(JSON.parse(first.argsJson)).toMatchObject({ holdingId: 'holding_wenjiana', mode: 'ALL', expectedShares: '5050', expectedNetValue: '1', expectedSettlementAmount: '5050.00' });
    await verifyAction(first.id, '000000', { deps: { config, provider: script.provider } });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    const callsBefore = script.calls();
    expect((await verifyAction(first.id, '123456', { deps: { config, provider: script.provider } })).ok).toBe(true);
    const second = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { nodeId: 'transfer' } });
    expect((await confirmAction(second.id, { deps: { config, provider: script.provider } })).ok).toBe(true);
    await verifyAction(first.id, '123456', { deps: { config, provider: script.provider } });
    expect(script.calls()).toBe(callsBefore);
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2852983n);
    expect(await getTestPrisma().transaction.count({ where: { direction: 'CREDIT', category: INVESTMENT_FLOW_CATEGORY } })).toBe(1);
    expect(await getTestPrisma().transaction.count({ where: { amountMinor: -10017n, channel: 'TRANSFER' } })).toBe(1);
  });

  it.each(['WJA001', 'Stable product name', 'unknown-holding'])('rejects selector %s in the holding ID field before an automatic budget', async holdingId => {
    const result = await submit([node('budget', 'reserve_budget', { name: 'must-not-land', amount: '2.22' }),
      node('redeem', 'redeem_investment', { holdingId, mode: 'ALL' }, ['budget'])], ['reserve_budget', 'redeem_investment']);
    expect(result.ok).toBe(false);
    expect(await getTestPrisma().budget.count({ where: { name: 'must-not-land' } })).toBe(0);
    await noEntry();
  });

  it.each(['foreign', 'inactive', 'undeclared-product-field'])('rejects %s holding parameters before earlier effects', async scenario => {
    const db = getTestPrisma();
    let holdingId = 'holding_wenjiana';
    if (scenario === 'foreign') {
      await db.user.create({ data: { id: 'scope_other', name: 'Other', phone: '13800009091' } });
      await db.investmentHolding.create({ data: { id: 'foreign_holding', userId: 'scope_other', productId: 'prod_wenjiana', principalAmountMinor: 100000n } });
      holdingId = 'foreign_holding';
    } else if (scenario === 'inactive') {
      await db.investmentHolding.update({ where: { id: holdingId }, data: { status: 'REDEEMED' } });
    }
    const args = scenario === 'undeclared-product-field' ? { holdingId, productId: 'prod_huobi', mode: 'ALL' } : { holdingId, mode: 'ALL' };
    const result = await submit([node('budget', 'reserve_budget', { name: 'must-not-land', amount: '2.22' }),
      node('redeem', 'redeem_investment', args, ['budget'])], ['reserve_budget', 'redeem_investment']);
    expect(result.ok).toBe(false);
    expect(await db.budget.count({ where: { name: 'must-not-land' } })).toBe(0);
    await noEntry();
  });

  it('keeps holdings of the same product distinct by their exact IDs and explicit dependency order', async () => {
    await getTestPrisma().investmentHolding.create({ data: { id: 'another_holding', userId: 'user_liming', productId: 'prod_wenjiana', principalAmountMinor: 100000n } });
    const result = await submit([node('second', 'redeem_investment', { holdingId: 'another_holding', mode: 'ALL' }, ['first']),
      node('first', 'redeem_investment', { holdingId: 'holding_wenjiana', mode: 'ALL' })], ['redeem_investment', 'redeem_investment']);
    expect(result.ok).toBe(true);
    const action = await getTestPrisma().pendingAction.findFirstOrThrow();
    expect(action.nodeId).toBe('first');
    expect(JSON.parse(action.argsJson).holdingId).toBe('holding_wenjiana');
  });
});
