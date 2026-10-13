import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, fauxText, type FauxResponseStep } from '@earendil-works/pi-ai';
import { loadSession, resumeTurn, runTurn, type ModelRuntime } from '@/agent';
import { newId } from '@/lib/ids';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import { runTransferMoney } from '@/agent/tools/transfer';

function provider(steps: FauxResponseStep[]): ModelRuntime {
  const mock = fauxProvider();
  const models = createModels();
  models.setProvider(mock.provider);
  mock.setResponses(steps);
  return { model: mock.getModel(), streamFn: models.streamSimple.bind(models) };
}
function call(name: string, args: Record<string, string | number> = {}): FauxResponseStep {
  return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' });
}
function texts(events: Awaited<ReturnType<typeof runTurn>>['events']): string[] {
  return events.flatMap(event => event.type === 'message_end' ? [event.message.content] : []);
}
async function assertPersisted(sessionId: string, content: string): Promise<void> {
  const session = await loadSession(sessionId);
  expect(session?.transcript.filter(message => message.role === 'assistant').at(-1)?.content).toBe(content);
}

beforeEach(async () => { await resetDatabase(); });
afterAll(async () => { await disconnectTestPrisma(); });

describe('the real Pi/SSE/persistence output boundary ignores model financial prose', () => {
  it.each([
    '转账成功，金额200元，收款人李华。',
    '向张伟转账成功，金额30000元，手续费200元。',
    '转账成功后请确认收款。',
    '张伟已经收到30000元。',
    '资金未发生变动。',
    'Your payment was sent. The recipient has the money.',
    '（系统校正）本月消费50000元，信用账户余额50000元。',
  ])('never publishes unsupported facts: %s', async (narration) => {
    const result = await runTurn({ message: '查询余额', sessionId: newId('sess') }, {
      provider: provider([call('get_balance'), fauxAssistantMessage(narration)]),
    });
    expect(result.events.filter(event => event.type === 'error')).toEqual([]);
    const content = texts(result.events).at(-1)!;
    expect(content).toBe('（系统校正）活期账户当前余额为 ¥23,580.00；储蓄账户当前余额为 ¥50,000.00；账户可用余额合计为 ¥73,580.00。');
    expect(result.events.filter(event => event.type === 'text_delta').map(event => event.delta).join('')).toBe(content);
    await assertPersisted(result.sessionId, content);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    expect(await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).toMatchObject({ balanceMinor: 2358000n });
  });
  it('a tool-call prelude never reaches message_end, deltas or stored transcript', async () => {
    const falsePrelude = '已成功向李华转账30000元';
    const result = await runTurn({ message: '查询余额' }, { provider: provider([
      fauxAssistantMessage([fauxText(falsePrelude), fauxToolCall('get_balance', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('转账成功后请确认收款。'),
    ]) });
    expect(texts(result.events)[0]).toBe('');
    expect(JSON.stringify(result.events)).not.toContain(falsePrelude);
    const session = await loadSession(result.sessionId);
    expect(JSON.stringify(session?.transcript)).not.toContain(falsePrelude);
    expect(JSON.stringify(session?.agentState.messages)).not.toContain(falsePrelude);
  });
  it('no-tool narration cannot invent either financial facts or execution results', async () => {
    const result = await runTurn({ message: '查余额' }, { provider: provider([fauxAssistantMessage('张伟已经收到30000元，本月消费50000元。')]) });
    const content = texts(result.events).at(-1)!;
    expect(content).toContain('未记录到该操作的执行结果');
    expect(content).not.toContain('30000');
    expect(content).not.toContain('50000');
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
    await assertPersisted(result.sessionId, content);
  });
  it('a continuation renders the actual decimal debit, regardless of fabricated fee/recipient', async () => {
    const start = await runTurn({ message: '给张伟转200.37元' }, { provider: provider([
      call('transfer_money', { name: '张伟', amount: '200.37' }), fauxAssistantMessage('请确认'),
    ]) });
    const toolResult = await runTransferMoney('user_liming', { name: '张伟', amount: '200.37' }, { idempotencyKey: 'boundary-real-transfer' });
    expect(toolResult.ok).toBe(true);
    expect(toolResult.data).toMatchObject({ sourceAccountId: 'acct_checking', amount: '200.37', newBalance: '23379.63' });
    const result = await resumeTurn({ sessionId: start.sessionId, toolName: 'transfer_money', actionId: 'boundary-real-transfer', toolResult }, {
      provider: provider([fauxAssistantMessage('转账成功，金额30000元，手续费200.37元，收款人李华。')]),
    });
    const content = texts(result.events).at(-1)!;
    expect(content).toContain('收款人 张伟；金额 ¥200.37');
    expect(content).toContain('执行时账户余额 ¥23,379.63');
    expect(content).not.toContain('李华');
    expect(content).not.toContain('30000');
    const db = getTestPrisma();
    expect(await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).toMatchObject({ balanceMinor: 2337963n });
    expect(await db.transaction.count({ where: { accountId: 'acct_checking', amountMinor: -20037n } })).toBe(1);
    await assertPersisted(result.sessionId, content);
  });
  it('UNKNOWN on a continuation stays unknown even when the model claims unchanged funds', async () => {
    const start = await runTurn({ message: '给张伟转200元' }, { provider: provider([call('transfer_money', { name: '张伟', amount: '200' }), fauxAssistantMessage('请确认')]) });
    const result = await resumeTurn({ sessionId: start.sessionId, toolName: 'transfer_money', actionId: 'uncertain', toolResult: { ok: false, data: { status: 'needs_reconciliation' } } }, {
      provider: provider([fauxAssistantMessage('资金未发生变动。')]),
    });
    const content = texts(result.events).at(-1)!;
    expect(content).toContain('待核对');
    for (const word of ['成功', '失败', '未发生', '未变动']) expect(content).not.toContain(word);
    await assertPersisted(result.sessionId, content);
  });
  it('a DAG continuation uses the actual node tool, not submit_plan, for its financial result', async () => {
    const start = await runTurn({ message: '创建给张伟转200元的计划' }, { provider: provider([
      fauxAssistantMessage([fauxToolCall('submit_plan', {
        goal: '转账计划', nodes: [{ id: 'transfer', name: '转账', kind: 'tool', dependencies: [], tool: 'transfer_money', args: { name: '张伟', amount: '200' } }],
      })], { stopReason: 'toolUse' }), fauxAssistantMessage('等待确认'),
    ]) });
    expect(start.events.filter(event => event.type === 'error')).toEqual([]);
    const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { sessionId: start.sessionId } });
    const result = await resumeTurn({ sessionId: start.sessionId, toolName: 'submit_plan', resultToolName: 'transfer_money', actionId: action.id, taskId: action.taskId ?? undefined, nodeId: action.nodeId ?? undefined, toolResult: {
      ok: true, data: { amount: '200.00', newBalance: '23380.00', sourceAccountId: 'acct_checking', recipient: { name: '张伟' } },
    } }, { provider: provider([fauxAssistantMessage('给李华转账30000元已成功')]) });
    expect(result.events.filter(event => event.type === 'error')).toEqual([]);
    const content = texts(result.events).at(-1)!;
    expect(content).toContain('转账处理结果');
    expect(content).toContain('收款人 张伟；金额 ¥200.00');
    expect(content).not.toContain('李华');
    await assertPersisted(result.sessionId, content);
  });
});
