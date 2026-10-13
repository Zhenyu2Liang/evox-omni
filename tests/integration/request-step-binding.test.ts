import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeGatedTool, getOrCreateSession, runTurn, loadSession } from '@/agent';
import { createModels, fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { runSubmitPlan } from '@/agent/tools/planning';
import type { TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';
import type { PlanRunTool } from '@/agent/tools/planning';
import { POST as verifyPost } from '@/app/api/actions/[id]/verify/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { actionUrl, idCtx, postJson } from '@/tests/app/harness';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
const db = getTestPrisma;
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const node = (id: string, tool: string, args: Record<string, unknown>, dependencies: string[] = [], after?: string[]): TaskNodeSpec =>
  ({ id, name: id, kind: 'tool', tool, args, dependencies, ...(after ? { after } : {}) });
const runner = (sessionId: string, userRequest: string): PlanRunTool => (toolName, args, ctx) =>
  executeGatedTool({ sessionId, userId, toolName, args, userRequest, ...ctx });
async function decide(sessionId: string, actionId: string, code?: string) {
  const response = await postJson<{ data: { events: { type: string; actionId?: string; action?: { toolName: string } }[] } }>(
    req => (code === undefined ? confirmPost : verifyPost)(req, idCtx(actionId)),
    actionUrl(actionId, code === undefined ? 'confirm' : 'verify'), code === undefined ? {} : { code }, { sessionId });
  expect(response.status).toBe(200);
  return response.data!.data;
}
async function submit(nodes: TaskNodeSpec[], request: string) {
  const { sessionId } = await getOrCreateSession(userId);
  const result = await runSubmitPlan(userId, { goal: 'model labels are not request evidence', nodes },
    { sessionId, runTool: runner(sessionId, request), userRequest: () => request });
  return { sessionId, result, plan: result.data as TaskPlan };
}

describe('request-bound plan execution [integration]', () => {
  it('shows a persisted catalogue-based refusal when an unknown purchase receives only model prose', async () => {
    const mock = fauxProvider(), models = createModels(); models.setProvider(mock.provider);
    mock.setResponses([
      fauxAssistantMessage([fauxToolCall('list_investments', {})], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Here are the available products.'),
    ]);
    const result = await runTurn({ message: '先申购货币基金100.25元，再申购货币基金增强D1000.13元' },
      { provider: { model: mock.getModel(), streamFn: models.streamSimple.bind(models) } });
    const final = result.events.filter(event => event.type === 'message_end').at(-1)!;
    if (final.type !== 'message_end') throw new Error('missing final message');
    expect(final.message.content).toContain('未找到你指定的理财产品');
    expect(final.message.content).toContain('不会自动替换成其他产品');
    expect((await loadSession(result.sessionId))?.transcript.at(-1)?.content).toBe(final.message.content);
    expect(await db().pendingAction.count()).toBe(0);
  });
  it('requires success before a reminder even when the model supplied only an after edge', async () => {
    const request = '先预留66.66元作为测试预算，再从活期账户给张伟转账30000.01元，只有这笔转账成功后才创建2026年11月22日09:00的成功提醒。转账失败时不要创建提醒。';
    const { sessionId, result, plan } = await submit([
      node('budget', 'reserve_budget', { name: 'test-budget', amount: '66.66' }),
      node('transfer', 'transfer_money', { contactId: 'contact_zhangwei', amount: '30000.01' }, ['budget']),
      node('reminder', 'create_scheduled_task', { name: 'must-not-exist', kind: 'REMINDER', runAtLocal: '2026-11-22T09:00' }, [], ['transfer']),
    ], request);
    expect(result.ok).toBe(true);
    const action = await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'transfer' } });
    const response = await decide(sessionId, action.id, '123456');
    const stored = await db().agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
    expect(stored.nodes.find(n => n.nodeId === 'transfer')?.status).toBe('failed');
    expect(stored.nodes.find(n => n.nodeId === 'reminder')?.status).toBe('skipped');
    expect(JSON.parse(stored.nodes.find(n => n.nodeId === 'reminder')!.dependencies ?? '[]')).toContain('transfer');
    expect(await db().pendingAction.count({ where: { taskId: plan.id, nodeId: 'reminder' } })).toBe(0);
    expect(await db().scheduledTask.count({ where: { name: 'must-not-exist' } })).toBe(0);
    expect(response.events.some(event => event.type === 'confirmation_required')).toBe(false);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });

  it('binds two purchases to their own products and amounts and forwards the second MFA once', async () => {
    const request = '先申购货币基金100.25元，再申购稳健理财A1000.13元，请把两步作为同一个计划，每笔都等待我的验证。';
    const { sessionId, result, plan } = await submit([
      node('fund', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }),
      node('investment', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' }, ['fund']),
    ], request);
    expect(result.ok).toBe(true);
    const first = await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'fund' } });
    expect(first.status).toBe('awaiting_mfa');
    await decide(sessionId, first.id, '000000');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    const response = await decide(sessionId, first.id, '123456');
    const second = await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'investment' } });
    expect(JSON.parse(first.argsJson)).toMatchObject({ productId: 'prod_huobi', amount: '100.25' });
    expect(JSON.parse(second.argsJson)).toMatchObject({ productId: 'prod_wenjiana', amount: '1000.13' });
    expect(response.events.filter(event => event.type === 'mfa_required' && event.actionId === second.id)).toHaveLength(1);
    await decide(sessionId, first.id, '123456');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2347975n);
    await decide(sessionId, second.id, '123456');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2247962n);
    expect(await db().investmentHolding.count({ where: { idempotencyKey: { startsWith: `nxe:${plan.id}:` } } })).toBe(2);
    expect(await db().transaction.count({ where: { category: '投资', direction: 'DEBIT' } })).toBe(2);
    expect((await db().agentTask.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe('success');
  });

  it.each([
    ['substituted product', [node('a', 'subscribe_investment', { productId: 'prod_wenjib', amount: '100.25' }), node('b', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' })]],
    ['swapped amounts', [node('a', 'subscribe_investment', { productId: 'prod_huobi', amount: '1000.13' }), node('b', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '100.25' })]],
    ['extra duplicate', [node('a', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }), node('b', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' }), node('extra', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' })]],
    ['missing second purchase', [node('a', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' })]],
  ])('rejects %s before an earlier automatic budget write', async (_, purchases) => {
    const request = '先预留3.33元，再申购货币基金100.25元，最后申购稳健理财A1000.13元';
    const { result } = await submit([node('budget', 'reserve_budget', { name: 'must-not-exist', amount: '3.33' }), ...purchases], request);
    expect(result.ok).toBe(false);
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
    expect(await db().budget.count({ where: { name: 'must-not-exist' } })).toBe(0);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });

  it('accepts two same-amount purchases by distinct codes without confusing code digits with money', async () => {
    const request = '先申购mmf0011000.13元再申购wja0011000.13元，每笔都要验证';
    const { result, plan } = await submit([
      node('second', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' }),
      node('first', 'subscribe_investment', { productId: 'prod_huobi', amount: '1000.13' }),
    ], request);
    expect(result.ok).toBe(true);
    expect(plan.nodes.find(n => n.id === 'second')?.after).toContain('first');
    expect((await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id } })).nodeId).toBe('first');
  });

  it.each([
    { name: '不存在的理财D', substitutedId: 'prod_wenjiana' },
    { name: '货币基金增强D', substitutedId: 'prod_huobi' },
  ])('does not let a valid first product hide unknown $name', async ({ name, substitutedId }) => {
    const request = `先预留3.33元，再申购货币基金100.25元，最后申购${name}1000.13元`;
    const { result } = await submit([
      node('budget', 'reserve_budget', { name: 'must-not-exist', amount: '3.33' }),
      node('fund', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }),
      node('unknown', 'subscribe_investment', { productId: substitutedId, amount: '1000.13' }),
    ], request);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('不会代选');
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
  });

  it('does not turn a negated purchase into an extra authorized step', async () => {
    const { result } = await submit([
      node('not-requested', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' }),
      node('requested', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }),
    ], '不要申购稳健理财A1000.13元，请申购货币基金100.25元');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('否定');
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
  });

  it.each(['成功后，才', '成功，才', '成功后才'])('only opens the reminder on actual success for the %s form', async connector => {
    const request = `先给张伟转账12.34元，只有这笔转账${connector}创建2026年11月22日09:00的转账成功提醒`;
    const { sessionId, result, plan } = await submit([
      node('transfer', 'transfer_money', { contactId: 'contact_zhangwei', amount: '12.34' }),
      node('reminder', 'create_scheduled_task', { name: 'success-reminder', kind: 'REMINDER', runAtLocal: '2026-11-22T09:00' }),
    ], request);
    expect(result.ok).toBe(true);
    expect(await db().pendingAction.count({ where: { taskId: plan.id, nodeId: 'reminder' } })).toBe(0);
    const transfer = await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'transfer' } });
    await decide(sessionId, transfer.id);
    expect((await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'reminder' } })).status).toBe('pending');
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2356766n);
  });

  it('clarifies an ambiguous success prerequisite without trusting model dependency labels', async () => {
    const request = '先预留3.33元，再给张伟转账12.34元和给李华转账56.78元，只有这笔转账成功后才创建2026年11月22日09:00的提醒';
    const { result } = await submit([
      node('budget', 'reserve_budget', { name: 'must-not-exist', amount: '3.33' }),
      node('a', 'transfer_money', { contactId: 'contact_zhangwei', amount: '12.34' }),
      node('b', 'transfer_money', { contactId: 'contact_lihua', amount: '56.78' }),
      node('reminder', 'create_scheduled_task', { name: 'must-not-exist', kind: 'REMINDER', runAtLocal: '2026-11-22T09:00' }, ['a']),
    ], request);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('成功后才执行');
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
  });
});
