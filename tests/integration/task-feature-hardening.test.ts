import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeGatedTool, getOrCreateSession, rollbackTask } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan, preflightRequestedPlan } from '@/agent/tools/planning';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { pausePlan } from '@/planner/lifecycle';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import { SPENDING_CATEGORIES } from '@/lib/contracts/spending';
import { auditStore } from '@/audit/audit-logger';
import type { TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';
import { POST as taskPost, GET as taskGet } from '@/app/api/tasks/[id]/route';
import { POST as confirmPost } from '@/app/api/actions/[id]/confirm/route';
import { idCtx, postJson, getJson, taskUrl, actionUrl } from '@/tests/app/harness';
import { disconnectTestPrisma, getTestPrisma, resetDatabase } from '@/tests/helpers/db';

const userId = 'user_liming';
beforeEach(() => resetDatabase(), 30000);
afterEach(() => vi.restoreAllMocks());
afterAll(() => disconnectTestPrisma());
const node = (id: string, tool: string, args = {}, dependencies: string[] = []): TaskNodeSpec => ({ id, name: id, kind: 'tool', tool, args, dependencies });
const runner = (sessionId: string, request = '') => (tool: string, args: Record<string, unknown>, ctx: { taskId: string; nodeId: string }) =>
  executeGatedTool({ sessionId, userId, toolName: tool as Parameters<typeof executeGatedTool>[0]['toolName'], args,
    userRequest: request, ...ctx });
async function control(sessionId: string, taskId: string, action: string) {
  return postJson<{ ok: boolean; data: TaskPlan }>((req) => taskPost(req, idCtx(taskId)), taskUrl(taskId), { action }, { sessionId });
}
async function confirmNode(sessionId: string, taskId: string, nodeId: string) {
  const action = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { taskId, nodeId, status: 'pending' } });
  const response = await postJson<{ data: { events: { type: string; actionId?: string; action?: { toolName: string } }[] } }>((req) => confirmPost(req, idCtx(action.id)), actionUrl(action.id, 'confirm'), {}, { sessionId });
  expect(response.status).toBe(200);
  const next = response.data!.data.events.find(event => event.type === 'confirmation_required' && event.actionId !== action.id);
  expect(next?.action?.toolName).toBe(nodeId === 'reminder' ? 'transfer_money' : 'set_card_limit');
}
async function partialPlan() {
  const sessionId = (await getDemoSession(userId)).sessionId;
  const result = await runSubmitPlan(userId, { goal: 'partial plan', nodes: [
    node('budget', 'reserve_budget', { name: 'rollback-budget', amount: '99.99' }),
    node('reminder', 'create_scheduled_task', { name: 'rollback-reminder', kind: 'REMINDER', runAtLocal: '2026-11-20T09:00' }, ['budget']),
    node('transfer', 'transfer_money', { name: '张伟', amount: '12.34' }, ['reminder']),
    node('limit', 'set_card_limit', { cardId: 'card_credit', category: '娱乐', amount: '1500.25' }, ['transfer']),
  ] }, { sessionId, runTool: runner(sessionId) });
  expect(result.ok).toBe(true);
  const taskId = (result.data as TaskPlan).id;
  await confirmNode(sessionId, taskId, 'reminder');
  await confirmNode(sessionId, taskId, 'transfer');
  return { sessionId, taskId };
}

describe('trusted product selection', () => {
  it('rejects an unknown product ID before creating a workflow or authorization', async () => {
    await expect(preflightRequestedPlan(userId, { nodes: [node('unknown', 'subscribe_investment', { productId: 'unknown-product', amount: '1000.13' })] }, 'Original request.')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await getTestPrisma().agentTask.count()).toBe(0);
    expect(await getTestPrisma().pendingAction.count()).toBe(0);
  });
  it('preserves explicit product IDs without deriving substitute IDs from raw text', async () => {
    const nodes = [node('compare', 'compare_investments', { productIds: ['prod_wenjiana', 'prod_wenjib'] })];
    expect(await preflightRequestedPlan(userId, { nodes }, 'Unrelated names, quoted examples and codes.')).toEqual(nodes);
  });
  it('preflights the whole plan before a leading automatic write', async () => {
    const sessionId = (await getOrCreateSession(userId)).sessionId;
    const result = await runSubmitPlan(userId, { goal: 'invented goal', nodes: [
      node('a', 'reserve_budget', { name: 'must-not-exist', amount: '3.33' }),
      node('b', 'compare_investments', { productIds: ['prod_wenjiana', 'unknown-product'] }),
    ] }, { sessionId, runTool: runner(sessionId), userRequest: () => '先预留3.33元，再对比稳健理财A和进取理财B' });
    expect(result.ok).toBe(false);
    expect(await getTestPrisma().budget.count({ where: { name: 'must-not-exist' } })).toBe(0);
    expect(await getTestPrisma().agentTask.count()).toBe(0);
  });
});

describe('explicit order without false-condition propagation', () => {
  const request = '先预留99.99元出游预算，再查询2026年9月消费；若消费超过999999元就将信用卡娱乐限额设置为1500.25元；最后创建2026年11月20日09:00的出游提醒';
  const nodes: TaskNodeSpec[] = [
    node('budget', 'reserve_budget', { name: 'ordered-budget', amount: '99.99' }),
    { ...node('spending', 'analyze_spending', { month: '2026-09' }), after: ['budget'] },
    { id: 'condition', name: 'condition', kind: 'condition', dependencies: ['spending'], condition: { path: 'spending.total', op: '>', value: '999999' } },
    node('limit', 'set_card_limit', { cardId: 'card_credit', category: SPENDING_CATEGORIES[3], amount: '1500.25' }, ['condition']),
    { ...node('reminder', 'create_scheduled_task', { name: 'ordered-reminder', kind: 'REMINDER', runAtLocal: '2026-11-20T09:00' }), after: ['spending', 'condition', 'limit'] },
  ];
  it('preserves explicit order edges and offers an independent reminder after a false condition', async () => {
    const sessionId = (await getDemoSession(userId)).sessionId;
    const result = await runSubmitPlan(userId, { goal: 'model goal does not establish order', nodes },
      { sessionId, runTool: runner(sessionId, request), userRequest: () => request,
        conversationIntent: () => declareConversationIntent(advanceConversationIntent(undefined, request), 'operation', ['reserve_budget', 'set_card_limit', 'create_scheduled_task']) });
    expect(result.ok).toBe(true);
    const plan = result.data as TaskPlan;
    expect(plan.nodes.find(n => n.id === 'spending')?.after).toContain('budget');
    expect(plan.nodes.find(n => n.id === 'reminder')?.after).toEqual(expect.arrayContaining(['spending', 'condition', 'limit']));
    expect(plan.results.find(n => n.id === 'condition')?.status).toBe('skipped');
    expect(plan.results.find(n => n.id === 'limit')?.status).toBe('skipped');
    expect(plan.results.find(n => n.id === 'reminder')?.status).toBe('waiting_confirmation');
    expect(await getTestPrisma().pendingAction.count({ where: { toolName: 'set_card_limit' } })).toBe(0);
    const read = await getJson<{ data: TaskPlan }>((req) => taskGet(req, idCtx(plan.id)), taskUrl(plan.id), { sessionId });
    expect(read.status).toBe(200);
    expect(read.data!.data.nodes).toEqual(plan.nodes);
    expect(read.data!.data.generation).toBe(plan.generation);
  });
  it('rejects an omitted declared write before creating task rows', async () => {
    const declaration = declareConversationIntent(advanceConversationIntent(undefined, 'Original two-step request.'), 'operation', ['reserve_budget', 'transfer_money']);
    await expect(preflightRequestedPlan(userId, { nodes: [node('budget', 'reserve_budget', { name: 'must-not-exist', amount: '2.00' })] }, declaration.requestText, declaration)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(await getTestPrisma().agentTask.count()).toBe(0);
  });
});

describe('cancel snapshot and transactional compensation', () => {
  it('forwards the next RED decision with its own complete summary after a YELLOW confirmation', async () => {
    const sessionId = (await getDemoSession(userId)).sessionId;
    const result = await runSubmitPlan(userId, { goal: 'two transfers', nodes: [
      node('small', 'transfer_money', { name: '张伟', amount: '20' }),
      node('large', 'transfer_money', { name: '李华', amount: '1200.12' }, ['small']),
    ] }, { sessionId, runTool: runner(sessionId) });
    const taskId = (result.data as TaskPlan).id;
    const first = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { taskId, nodeId: 'small' } });
    const response = await postJson<{ data: { events: { type: string; actionId?: string; action?: { tier: string; fields: unknown[] } }[] } }>(
      req => confirmPost(req, idCtx(first.id)), actionUrl(first.id, 'confirm'), {}, { sessionId });
    expect(response.status).toBe(200);
    const gate = response.data!.data.events.find(event => event.type === 'mfa_required');
    const next = await getTestPrisma().pendingAction.findFirstOrThrow({ where: { taskId, nodeId: 'large' } });
    expect(gate?.actionId).toBe(next.id);
    expect(gate?.action?.tier).toBe('RED');
    expect(gate?.action?.fields).toContainEqual({ label: '收款人', value: '李华' });
    expect(gate?.action?.fields).toContainEqual({ label: 'Amount', value: '¥1,200.12' });
    expect((await getTestPrisma().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2356000n);
    expect(next.status).toBe('awaiting_mfa');
  });
  it('returns current generation/time after pause, resume, cancel and rejects late nonterminal UI events', async () => {
    const { sessionId, taskId } = await partialPlan();
    await control(sessionId, taskId, 'pause');
    await control(sessionId, taskId, 'resume');
    const response = await control(sessionId, taskId, 'cancel');
    const stored = await getTestPrisma().agentTask.findUniqueOrThrow({ where: { id: taskId } });
    const plan = response.data!.data;
    expect(plan.status).toBe('cancelled');
    expect(plan.generation).toBe(stored.generation);
    expect(plan.updatedAt).toBe(stored.updatedAt.getTime());
    expect(pausePlan({ ...plan, status: 'running' }, { now: () => 1 }).generation).toBe(plan.generation);
    const state = initialChatUIState({ activePlan: plan });
    const next = reduceAgentEvents(state, [{ type: 'plan_update', plan: { ...plan, status: 'waiting_confirmation', generation: (plan.generation ?? 0) + 1 } }]);
    expect(next.activePlan?.status).toBe('cancelled');
  });
  it('reverts only owned budget/task records, keeps transfer facts, and repeats/concurrency do not duplicate audit', async () => {
    const { sessionId, taskId } = await partialPlan();
    await control(sessionId, taskId, 'cancel');
    const db = getTestPrisma();
    const before = await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } });
    const executions = await db.agentTaskNode.findMany({ where: { taskId, status: 'success' }, select: { nodeId: true, output: true } });
    const responses = await Promise.all([control(sessionId, taskId, 'rollback'), control(sessionId, taskId, 'rollback')]);
    expect(responses.map(res => res.status)).toEqual([200, 200]);
    expect((await db.budget.findFirstOrThrow({ where: { name: 'rollback-budget' } })).status).toBe('RELEASED');
    expect((await db.scheduledTask.findFirstOrThrow({ where: { name: 'rollback-reminder' } })).status).toBe('CANCELLED');
    expect((await db.account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(before.balanceMinor);
    expect(await db.transaction.count({ where: { channel: 'TRANSFER', amountMinor: -1234n } })).toBe(1);
    expect(await db.agentTaskNode.findMany({ where: { taskId, status: 'success' }, select: { nodeId: true, output: true } })).toEqual(executions);
    expect(await db.auditLog.count({ where: { toolName: 'rollback_task' } })).toBe(3);
    const transfer = responses[0].data!.data.results.find(row => row.id === 'transfer')!;
    expect(transfer.compensation?.status).toBe('retained');
    const read = await getJson<{ data: TaskPlan }>((req) => taskGet(req, idCtx(taskId)), taskUrl(taskId), { sessionId });
    expect(read.data!.data.results.filter(row => row.compensation?.status === 'reverted')).toHaveLength(2);
  });
  it('fails closed for active plans and other sessions', async () => {
    const { sessionId, taskId } = await partialPlan();
    expect((await control(sessionId, taskId, 'rollback')).status).toBe(409);
    await control(sessionId, taskId, 'cancel');
    const other = (await getOrCreateSession(userId)).sessionId;
    await getTestPrisma().agentTask.update({ where: { id: taskId }, data: { sessionId: other } });
    expect((await control(other, taskId, 'rollback')).status).toBe(403);
    expect((await getTestPrisma().budget.findFirstOrThrow({ where: { name: 'rollback-budget' } })).status).toBe('RESERVED');
  });
  it('rolls back compensation, receipts and audits together when a strict audit write fails', async () => {
    const { sessionId, taskId } = await partialPlan();
    await control(sessionId, taskId, 'cancel');
    const insert = auditStore.insertAuditLog;
    vi.spyOn(auditStore, 'insertAuditLog').mockImplementation((entry, options) => {
      if (entry.toolName === 'rollback_task' && entry.nodeId === 'budget') throw new Error('audit unavailable');
      return insert(entry, options);
    });
    await expect(rollbackTask(sessionId, taskId)).rejects.toThrow('audit unavailable');
    const db = getTestPrisma();
    expect((await db.budget.findFirstOrThrow({ where: { name: 'rollback-budget' } })).status).toBe('RESERVED');
    expect((await db.scheduledTask.findFirstOrThrow({ where: { name: 'rollback-reminder' } })).status).toBe('SCHEDULED');
    expect(await db.auditLog.count({ where: { toolName: 'rollback_task' } })).toBe(0);
    expect(await db.agentTaskNode.count({ where: { taskId, compensation: { not: null } } })).toBe(0);
  });
  it('does not revoke a record whose execution identity was replaced or a budget already used', async () => {
    const { sessionId, taskId } = await partialPlan();
    await control(sessionId, taskId, 'cancel');
    const db = getTestPrisma();
    await db.budget.updateMany({ where: { name: 'rollback-budget' }, data: { status: 'USED' } });
    await db.scheduledTask.updateMany({ where: { name: 'rollback-reminder' }, data: { idempotencyKey: 'foreign-record' } });
    const result = await rollbackTask(sessionId, taskId);
    expect(result.results.filter(row => row.compensation?.status === 'conflict')).toHaveLength(2);
    expect((await db.budget.findFirstOrThrow({ where: { name: 'rollback-budget' } })).status).toBe('USED');
    expect((await db.scheduledTask.findFirstOrThrow({ where: { name: 'rollback-reminder' } })).status).toBe('SCHEDULED');
  });
});
