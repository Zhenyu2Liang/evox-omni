import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { runSubmitPlan } from '@/agent/tools/planning';
import { executeGatedTool, confirmAction, verifyAction, cancelAction } from '@/agent/confirmation';
import { getDemoSession } from '@/agent/session';
import { advanceConversationIntent, declareConversationIntent } from '@/agent/intent-context';
import type { TaskNodeSpec, TaskPlan } from '@/lib/contracts/task';
import { POST as acknowledge } from '@/app/api/transactions/[id]/acknowledge/route';
import { getTestPrisma, useFreshDatabase } from '../helpers/db';

useFreshDatabase();
const db = getTestPrisma;
const userId = 'user_liming';
const node = (id: string, tool: string, args: Record<string, unknown>, dependencies: string[] = []): TaskNodeSpec => ({ id, name: id, kind: 'tool', tool, args, dependencies });
async function submit(nodes: TaskNodeSpec[]) {
  const { sessionId } = await getDemoSession(userId);
  const intent = declareConversationIntent(advanceConversationIntent(undefined, '用户明确指定顺序与条件'), 'operation', nodes.filter(n => n.kind === 'tool').map(n => n.tool!), { workflow: true });
  const result = await runSubmitPlan(userId, { goal: '复合操作', nodes }, { sessionId, conversationIntent: () => intent,
    runTool: (toolName, args, context) => executeGatedTool({ sessionId, userId, toolName, args, userRequest: '复合操作', ...context }) });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  return { sessionId, plan: result.data as TaskPlan };
}
async function action(taskId: string, nodeId: string) { return db().pendingAction.findFirstOrThrow({ where: { taskId, nodeId } }); }
async function limit(cardId: string) { return db().cardLimit.findFirst({ where: { cardId, category: '购物' } }); }

describe('compound operations using customer card selectors', () => {
  it('analyzes, parks the selected debit limit, then creates one exact budget only after success', async () => {
    const { sessionId, plan } = await submit([
      node('spending', 'analyze_spending', { month: '2026-09' }),
      node('limit', 'set_card_limit', { cardType: 'DEBIT', category: '购物', amount: '900.50' }, ['spending']),
      node('budget', 'reserve_budget', { name: '顺序演示预算', amount: '219.87' }, ['limit']),
    ]);
    const approval = await action(plan.id, 'limit');
    expect(JSON.parse(approval.argsJson)).toMatchObject({ cardId: 'card_debit', amount: '900.50' });
    expect(JSON.parse(approval.argsJson).cardType).toBeUndefined();
    expect(await db().budget.count({ where: { name: '顺序演示预算' } })).toBe(0);
    expect((await confirmAction(approval.id, { sessionId, userId })).ok).toBe(true);
    expect((await limit('card_debit'))?.amountMinor).toBe(90050n);
    expect((await db().budget.findFirstOrThrow({ where: { name: '顺序演示预算' } })).amountMinor).toBe(21987n);
    await confirmAction(approval.id, { sessionId, userId });
    expect(await db().budget.count({ where: { name: '顺序演示预算' } })).toBe(1);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
  it.each([['50000', false], ['0', true]] as const)('compares exact entertainment totals against %s before creating a credit-card decision', async (threshold, applies) => {
    const before = await db().cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } });
    const { sessionId, plan } = await submit([
      node('spending', 'analyze_spending', { month: '2026-09' }),
      { id: 'condition', name: '娱乐消费条件', kind: 'condition', dependencies: ['spending'], condition: { path: 'spending.categoryTotals.娱乐', op: '>', value: threshold } },
      node('limit', 'set_card_limit', { cardType: 'CREDIT', category: '娱乐', amount: '1200.00' }, ['condition']),
    ]);
    expect(await db().pendingAction.count({ where: { taskId: plan.id } })).toBe(applies ? 1 : 0);
    if (applies) {
      const approval = await action(plan.id, 'limit');
      expect(JSON.parse(approval.argsJson).cardId).toBe('card_credit');
      await confirmAction(approval.id, { sessionId, userId });
    }
    const after = await db().cardLimit.findFirstOrThrow({ where: { cardId: 'card_credit', category: '娱乐' } });
    expect(after.amountMinor).toBe(applies ? 120000n : before.amountMinor);
    const stored = await db().agentTaskNode.findFirstOrThrow({ where: { taskId: plan.id, nodeId: 'limit' } });
    expect(stored.status).toBe(applies ? 'success' : 'skipped');
  });
  it('freezes virtual 7788 then credit 6688 through separate ordered verification gates', async () => {
    await db().card.create({ data: { id: 'card_virtual_7788', userId, type: 'VIRTUAL', numberMasked: '****7788', linkedAccountId: 'acct_checking', monthlyLimitMinor: 500000n } });
    const { sessionId, plan } = await submit([
      node('first', 'freeze_card', { cardTail: '7788' }), node('second', 'freeze_card', { cardTail: '6688' }, ['first']),
    ]);
    const first = await action(plan.id, 'first');
    expect(first.requiresMfa).toBe(true);
    expect(JSON.parse(first.argsJson).cardId).toBe('card_virtual_7788');
    expect(await db().pendingAction.count({ where: { taskId: plan.id, nodeId: 'second' } })).toBe(0);
    await verifyAction(first.id, '000000', { sessionId, userId });
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_virtual_7788' } })).status).toBe('ACTIVE');
    await verifyAction(first.id, '123456', { sessionId, userId });
    const second = await action(plan.id, 'second');
    expect(second.requiresMfa).toBe(true);
    expect(JSON.parse(second.argsJson).cardId).toBe('card_credit');
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('ACTIVE');
    await verifyAction(second.id, '123456', { sessionId, userId });
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('FROZEN');
    expect((await db().card.findUniqueOrThrow({ where: { id: 'card_virtual_7788' } })).status).toBe('FROZEN');
  });
  it('does not substitute the real debit card for a mismatched type and suffix', async () => {
    const { sessionId } = await getDemoSession(userId);
    const result = await runSubmitPlan(userId, { goal: '歧义卡片', nodes: [node('freeze', 'freeze_card', { cardType: 'DEBIT', cardTail: '6688' })] },
      { sessionId, runTool: (toolName, args, context) => executeGatedTool({ sessionId, userId, toolName, args, userRequest: '歧义卡片', ...context }) });
    expect(result.ok).toBe(false);
    expect(await db().agentTask.count()).toBe(0);
    expect(await db().pendingAction.count()).toBe(0);
  });
  it('canceling the limit prevents the dependent budget', async () => {
    const { sessionId, plan } = await submit([
      node('limit', 'set_card_limit', { cardType: 'DEBIT', category: '购物', amount: '900.50' }),
      node('budget', 'reserve_budget', { name: '不应登记', amount: '219.87' }, ['limit']),
    ]);
    await cancelAction((await action(plan.id, 'limit')).id, { sessionId, userId });
    expect(await db().budget.count({ where: { name: '不应登记' } })).toBe(0);
  });
  it('acknowledges the owned anomaly once with JSON without changing money or its anomaly flag', async () => {
    const request = () => new NextRequest('http://localhost/api/transactions/tx_anomaly_apple/acknowledge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const context = { params: Promise.resolve({ id: 'tx_anomaly_apple' }) };
    expect((await acknowledge(request(), context)).status).toBe(200);
    expect((await acknowledge(request(), context)).status).toBe(200);
    expect(await db().auditLog.count({ where: { toolName: 'acknowledge_transaction' } })).toBe(1);
    expect((await db().transaction.findUniqueOrThrow({ where: { id: 'tx_anomaly_apple' } })).isAnomaly).toBe(true);
    expect((await db().account.findUniqueOrThrow({ where: { id: 'acct_checking' } })).balanceMinor).toBe(2358000n);
  });
});
