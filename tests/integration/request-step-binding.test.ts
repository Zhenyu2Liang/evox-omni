import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { executeGatedTool } from '@/agent';
import { getDemoSession } from '@/agent/session';
import { runSubmitPlan } from '@/agent/tools/planning';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
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
  const response = await postJson<{ data: { events: { type: string; actionId?: string }[] } }>(
    req => (code === undefined ? confirmPost : verifyPost)(req, idCtx(actionId)),
    actionUrl(actionId, code === undefined ? 'confirm' : 'verify'), code === undefined ? {} : { code }, { sessionId });
  expect(response.status).toBe(200);
  return response.data!.data;
}
async function submit(nodes: TaskNodeSpec[], operations: string[], purpose: 'operation' | 'advice' = 'operation') {
  const { sessionId } = await getDemoSession(userId);
  const request = 'Original user context remains available to the agent.';
  const declaration = declareConversationIntent(advanceConversationIntent(undefined, request), purpose, purpose === 'advice' ? [] : operations);
  const result = await runSubmitPlan(userId, { goal: 'Declared workflow', nodes },
    { sessionId, runTool: runner(sessionId, request), userRequest: () => request, conversationIntent: () => declaration });
  return { sessionId, result, plan: result.data as TaskPlan };
}

describe('structured workflow preflight and execution', () => {
  it('keeps a success-only reminder closed when its transfer fails', async () => {
    const { sessionId, result, plan } = await submit([
      node('budget', 'reserve_budget', { name: 'test-budget', amount: '66.66' }),
      node('transfer', 'transfer_money', { contactId: 'contact_zhangwei', amount: '30000.01' }, ['budget']),
      node('reminder', 'create_scheduled_task', { name: 'must-not-exist', kind: 'REMINDER', runAtLocal: '2026-11-22T09:00' }, ['transfer']),
    ], ['reserve_budget', 'transfer_money', 'create_scheduled_task']);
    expect(result.ok).toBe(true);
    const action = await db().pendingAction.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'transfer' } });
    const response = await decide(sessionId, action.id, '123456');
    const stored = await db().agentTask.findUniqueOrThrow({ where: { id: plan.id }, include: { nodes: true } });
    expect(stored.nodes.find(item => item.nodeId === 'transfer')?.status).toBe('failed');
    expect(stored.nodes.find(item => item.nodeId === 'reminder')?.status).toBe('skipped');
    expect(await db().pendingAction.count({ where: { taskId: plan.id, nodeId: 'reminder' } })).toBe(0);
    expect(await db().scheduledTask.count({ where: { name: 'must-not-exist' } })).toBe(0);
    expect(response.events.some(event => event.type === 'confirmation_required')).toBe(false);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });

  it('binds two exact purchases to independent MFA decisions and replay does not duplicate either debit', async () => {
    const { sessionId, result, plan } = await submit([
      node('fund', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }),
      node('investment', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' }, ['fund']),
    ], ['subscribe_investment', 'subscribe_investment']);
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
    expect((await db().agentTask.findUniqueOrThrow({ where: { id: plan.id } })).status).toBe('success');
  });

  it.each([
    ['missing second purchase', [node('first', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' })]],
    ['extra duplicate purchase', [node('first', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }), node('second', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' }), node('extra', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' })]],
    ['unknown product', [node('first', 'subscribe_investment', { productId: 'prod_huobi', amount: '100.25' }), node('second', 'subscribe_investment', { productId: 'unknown-product', amount: '1000.13' })]],
    ['numeric monetary value', [node('first', 'subscribe_investment', { productId: 'prod_huobi', amount: 100.25 }), node('second', 'subscribe_investment', { productId: 'prod_wenjiana', amount: '1000.13' })]],
  ])('rejects %s before a leading automatic budget can execute', async (_, purchases) => {
    const { result } = await submit([node('budget', 'reserve_budget', { name: 'must-not-exist', amount: '3.33' }), ...purchases],
      ['reserve_budget', 'subscribe_investment', 'subscribe_investment']);
    expect(result.ok).toBe(false);
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
    expect(await db().budget.count({ where: { name: 'must-not-exist' } })).toBe(0);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });

  it('does not permit a write plan during advice', async () => {
    const { result } = await submit([node('budget', 'reserve_budget', { name: 'must-not-exist', amount: '3.33' })], [], 'advice');
    expect(result.ok).toBe(false);
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().budget.count({ where: { name: 'must-not-exist' } })).toBe(0);
  });
});
