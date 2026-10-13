import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type JsonObject } from '@earendil-works/pi-ai';
import { runTurn, confirmAction, loadSession, getOrCreateSession, executeGatedTool } from '@/agent';
import { runSubmitPlan } from '@/agent/tools/planning';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';
import type { AppConfig } from '@/lib/config';

const config: AppConfig = { llmMode: 'live', llmProvider: 'deepseek', llmModel: 'deepseek-flash', demoUserId: 'user_liming' };
const request = '先给张伟转账100.17元，再给王芳转账200.29元，两笔都备注午餐AA。';
const db = getTestPrisma;
beforeEach(resetDatabase);
afterAll(disconnectTestPrisma);
const node = (id: string, name: string, amount: string) => ({ id, name: id, kind: 'tool', tool: 'transfer_money',
  args: { name, amount, remark: '午餐AA' }, dependencies: [] });
const nodes = () => [node('first', '张伟', '100.17'), node('second', '王芳', '200.29')];
const call = (tool: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(tool, args as JsonObject)], { stopReason: 'toolUse' });
function provider(responses: ReturnType<typeof fauxAssistantMessage>[]) {
  const faux = fauxProvider(), models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
  let count = 0;
  return { model: faux.getModel(), streamFn: (...args: Parameters<typeof models.streamSimple>) => {
    count++; return models.streamSimple(...args);
  }, calls: () => count };
}
async function unchanged() {
  expect(await db().pendingAction.count()).toBe(0);
  expect(await db().agentTask.count()).toBe(0);
  expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
}

describe('complete plan before first authorization [integration: live pipeline, controlled model]', () => {
  it('rejects both standalone selections without creating an authorization, then offers a persisted bounded retry', async () => {
    const runtime = provider([call('transfer_money', { name: '张伟', amount: '100.17' }), call('transfer_money', { name: '王芳', amount: '200.29' })]);
    const result = await runTurn({ message: request }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    await unchanged();
    expect(result.events.some(e => e.type === 'confirmation_required' || e.type === 'mfa_required')).toBe(false);
    const final = (await loadSession(result.sessionId))!.transcript.at(-1)!;
    expect(final.content).toContain('完整计划尚未通过校验');
    expect(final.content).toContain('未执行本次写操作');
    expect(final.retryRequest).toBe(request);
    expect(final.cards?.some(c => c.type === 'transfer')).not.toBe(true);
  });
  it('recovers the first standalone selection into a complete persisted DAG, resumes without model calls and debits each leg once', async () => {
    const runtime = provider([call('transfer_money', { name: '张伟', amount: '100.17' }), call('submit_plan', { goal: '午餐AA', nodes: nodes() })]);
    const result = await runTurn({ message: request }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    const plan = await db().agentTask.findFirstOrThrow({ include: { nodes: true } });
    expect(plan.nodes).toHaveLength(2);
    expect(await db().pendingAction.count()).toBe(1);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
    const first = await db().pendingAction.findFirstOrThrow({ where: { nodeId: 'first' } });
    expect((await confirmAction(first.id, { deps: { config, provider: runtime } })).ok).toBe(true);
    const second = await db().pendingAction.findFirstOrThrow({ where: { nodeId: 'second' } });
    expect(JSON.parse(second.argsJson)).toMatchObject({ contactId: 'contact_wangfang', amount: '200.29' });
    expect((await confirmAction(second.id, { deps: { config, provider: runtime } })).ok).toBe(true);
    expect(runtime.calls()).toBe(2);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2327954n);
    expect(await db().transaction.count({ where: { channel: 'TRANSFER', direction: 'DEBIT', amountMinor: { in: [-10017n, -20029n] } } })).toBe(2);
    expect((await db().agentTask.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe('success');
    const saved = (await loadSession(result.sessionId))!;
    expect(saved.transcript.filter(m => m.role === 'user')).toHaveLength(1);
    const calls = new Set(saved.agentState.messages.flatMap(m => m.role === 'assistant' ? m.content.flatMap(p => p.type === 'toolCall' ? [p.id] : []) : []));
    expect(saved.agentState.messages.filter(m => m.role === 'toolResult').every(m => m.role === 'toolResult' && calls.has(m.toolCallId))).toBe(true);
    await confirmAction(first.id, { deps: { config, provider: runtime } });
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2327954n);
  });
  it('corrects a partial DAG before its automatic budget can execute', async () => {
    const budget = { id: 'budget', name: 'b', kind: 'tool', tool: 'reserve_budget', args: { name: 'coverage-test', amount: '3.33' }, dependencies: [] };
    const runtime = provider([call('submit_plan', { goal: 'partial', nodes: [budget, nodes()[0]] }),
      call('submit_plan', { goal: 'complete', nodes: [budget, ...nodes()] })]);
    await runTurn({ message: '先预留3.33元作为coverage-test预算，再给张伟转账100.17元，最后给王芳转账200.29元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(await db().agentTask.count()).toBe(1);
    expect(await db().budget.count({ where: { name: 'coverage-test' } })).toBe(1);
    expect(await db().pendingAction.count()).toBe(1);
  });
  it('keeps the earlier automatic budget untouched when both proposed plans omit the last step', async () => {
    const budget = { id: 'budget', name: 'b', kind: 'tool', tool: 'reserve_budget', args: { name: 'coverage-test', amount: '3.33' }, dependencies: [] };
    const partial = () => call('submit_plan', { goal: 'partial', nodes: [budget, nodes()[0]] });
    const runtime = provider([partial(), partial()]);
    await runTurn({ message: '先预留3.33元作为coverage-test预算，再给张伟转账100.17元，最后给王芳转账200.29元' }, { config, provider: runtime });
    expect(runtime.calls()).toBe(2);
    expect(await db().budget.count({ where: { name: 'coverage-test' } })).toBe(0);
    await unchanged();
  });
  it.each([
    ['missing leg', [nodes()[0]]],
    ['swapped amounts', [node('first', '张伟', '200.29'), node('second', '王芳', '100.17')]],
    ['wrong recipient', [nodes()[0], node('second', '张伟', '200.29')]],
    ['fractional cent', [node('first', '张伟', '100.171'), nodes()[1]]],
    ['duplicate leg', [...nodes(), node('extra', '张伟', '100.17')]],
  ])('rejects %s before persisting a plan or changing money', async (_, proposed) => {
    const session = await getOrCreateSession(config.demoUserId);
    const result = await runSubmitPlan(config.demoUserId, { goal: 'untrusted goal says complete', nodes: proposed }, {
      sessionId: session.sessionId, userRequest: () => request,
      runTool: (toolName, args, ctx) => executeGatedTool({ sessionId: session.sessionId, userId: config.demoUserId, toolName, args, userRequest: request, ...ctx }),
    });
    expect(result.ok).toBe(false);
    await unchanged();
  });
  it('matches equal amounts to their distinct recipients even with reversed node order', async () => {
    const runtime = provider([call('submit_plan', { goal: 'two', nodes: [node('second', '王芳', '100.17'), node('first', '张伟', '100.17')] })]);
    await runTurn({ message: '先给张伟转账100.17元，再给王芳转账100.17元' }, { config, provider: runtime });
    expect(JSON.parse((await db().pendingAction.findFirstOrThrow()).argsJson).contactId).toBe('contact_zhangwei');
    expect(await db().agentTaskNode.count()).toBe(2);
  });
  it.each(['给张伟转账100.17元，给王芳转账200.29元', '给张伟转账100.17元和给王芳转账200.29元',
    '先给张伟转100.17元，再给王芳转200.29元'])('also requires a plan for %s', async message => {
    const runtime = provider([call('transfer_money', { name: '张伟', amount: '100.17' }), call('transfer_money', { name: '王芳', amount: '200.29' })]);
    await runTurn({ message }, { config, provider: runtime });
    await unchanged();
  });
  it('rejects invented amounts when a multi-step request lacks them', async () => {
    const runtime = provider([call('submit_plan', { goal: 'guessed amounts', nodes: nodes() }),
      call('submit_plan', { goal: 'guessed again', nodes: nodes() })]);
    await runTurn({ message: '先给张伟转账，再给王芳转账' }, { config, provider: runtime });
    await unchanged();
  });
  it('blocks a direct gateway runner from partially authorizing the same request', async () => {
    const session = await getOrCreateSession(config.demoUserId);
    const result = await executeGatedTool({ sessionId: session.sessionId, userId: config.demoUserId,
      toolName: 'transfer_money', args: { name: '张伟', amount: '100.17' }, userRequest: request });
    expect(result.ok).toBe(false);
    await unchanged();
  });
  it('preserves a single transfer with contact lookup and does not count a negated instruction as another write', async () => {
    const runtime = provider([call('search_contact', { query: '张伟' }), call('transfer_money', { name: '张伟', amount: '100.17' })]);
    await runTurn({ message: '不要给王芳转账200.29元，给张伟转账100.17元' }, { config, provider: runtime });
    expect(await db().pendingAction.count()).toBe(1);
    expect(await db().agentTask.count()).toBe(0);
    expect(runtime.calls()).toBe(2);
  });
});
