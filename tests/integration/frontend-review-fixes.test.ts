import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveBankingArgs } from '@/lib/banking-selectors';
import { scheduledTime } from '@/lib/scheduled-time';
import { redactRequest } from '@/lib/sensitive';
import { resetDatabase, getTestPrisma } from '@/tests/helpers/db';
import { DEMO_USER_ID } from '@/tests/helpers/fixtures';
import { newSession, saveSession, loadSession } from '@/agent/session';
import { securityGateway as gateway } from '@/security/security-gateway';
import { banking } from '@/banking-sdk';
import { assertConditionResolvable, validatePlan } from '@/planner/dag';
import { initialChatUIState, reduceAgentEvents } from '@/components/chat/useAgentStream';
import { POST as acknowledge } from '@/app/api/transactions/[id]/acknowledge/route';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { TaskNodeSpec } from '@/lib/contracts/task';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvestmentsCard } from '@/components/chat/cards/InvestmentsCard';
import { MfaCard } from '@/components/chat/cards/MfaCard';
import { withPlanUpdate } from '@/app/api/_lib/agent-bridge';
import { createTask } from '@/lib/db/repositories/task';
import { getTaskPlan } from '@/agent/task-control';
import type { ConfirmationOutcome } from '@/agent';
import { GET as bills } from '@/app/api/bills/route';

beforeEach(resetDatabase);
describe('frontend review: production boundaries', () => {
  it('resolves account names and owned card tails; rejects another owner', async () => {
    expect((await resolveBankingArgs(DEMO_USER_ID, 'transfer_money', { sourceAccountId: '活期账户' })).sourceAccountId).toBe('acct_checking');
    expect((await resolveBankingArgs(DEMO_USER_ID, 'freeze_card', { cardId: '6688' })).cardId).toBe('card_credit');
    await expect(resolveBankingArgs('someone-else', 'freeze_card', { cardId: 'card_credit' })).rejects.toThrow('未找到');
  });
  it('resolves product codes and subscription names, rejects empty/unknown comparisons', async () => {
    expect((await resolveBankingArgs(DEMO_USER_ID, 'subscribe_investment', { productId: 'WJA001' })).productId).toBe('prod_wenjiana');
    expect((await resolveBankingArgs(DEMO_USER_ID, 'set_subscription_reminder', { subscriptionId: 'Netflix' })).subscriptionId).toBe('sub_netflix');
    await expect(resolveBankingArgs(DEMO_USER_ID, 'compare_investments', { productIds: ['unknown'] })).rejects.toThrow('未找到');
  });
  it('rejects ambiguous owned card selectors instead of taking the first', async () => {
    await getTestPrisma().card.create({ data: { userId: DEMO_USER_ID, type: 'CREDIT', numberMasked: '****6688' } });
    await expect(resolveBankingArgs(DEMO_USER_ID, 'freeze_card', { cardId: '6688' })).rejects.toThrow('不唯一');
  });
  it('parks canonical args and displays the same named object before execution', async () => {
    const snapshot = newSession(DEMO_USER_ID); await saveSession(snapshot);
    const result = await gateway.handleToolCall({ sessionId: snapshot.sessionId, userId: DEMO_USER_ID,
      toolName: 'freeze_card', args: { cardId: '6688' }, userRequest: '冻结尾号6688信用卡' });
    expect(result.action?.args.cardId).toBe('card_credit');
    expect(result.action?.summary.fields.some(field => field.value.includes('6688'))).toBe(true);
    expect(result.action?.summary.actionId).toBe(result.action?.id);
    expect((await getTestPrisma().card.findUniqueOrThrow({ where: { id: 'card_credit' } })).status).toBe('ACTIVE');
  });
  it('keeps explicit year and Beijing time even when the model supplies a wrong epoch', () => {
    expect(scheduledTime({ runAt: Date.parse('2025-10-15T09:00:00Z') }, '2026年10月15日上午9点提醒电费')).toBe(Date.parse('2026-10-15T09:00:00+08:00'));
    expect(scheduledTime({ runAtLocal: '2026-10-15T09:00' })).toBe(Date.parse('2026-10-15T09:00:00+08:00'));
    expect(scheduledTime({}, '2026年10月15日下午3点30分提醒电费')).toBe(Date.parse('2026-10-15T15:30:00+08:00'));
    expect(() => scheduledTime({}, '2026年10月15日上午9点及2026年10月16日上午9点')).toThrow('多个执行时间');
    expect(() => scheduledTime({ runAtLocal: '2026-02-30T09:00' })).toThrow();
    expect(() => scheduledTime({ runAt: 100 })).toThrow();
  });
  it('rejects malformed conditions and missing outputs, preserving actual false comparisons', () => {
    const nodes = [{ id: 'n1', name: 'bad', dependencies: [], kind: 'condition', condition: { left: 'n0.total', right: 2000, op: '>' } }] as unknown as TaskNodeSpec[];
    expect(validatePlan(nodes, new Set()).ok).toBe(false);
    expect(() => assertConditionResolvable({ path: 'n1.totalSpending', op: '>', value: 2000 }, { n1: { total: 3000 } })).toThrow('条件无法求值');
    expect(() => assertConditionResolvable({ path: 'n1.total', op: '>', value: 2000 }, { n1: { total: 1000 } })).not.toThrow();
  });
  it('supplies actual product metadata for each holding and totals cash plus active market value', async () => {
    const holdings = await banking.investment.listHoldings(DEMO_USER_ID);
    expect(holdings[0].product?.expectedRate).toBeGreaterThan(0);
    const cash = await banking.account.getBalance(DEMO_USER_ID);
    const overview = await banking.dashboard.getDashboardSummary(DEMO_USER_ID);
    expect(overview.totalAssets).toBeCloseTo(cash.totalAvailable + holdings.reduce((sum, row) => sum + (row.marketValue ?? row.amount), 0), 2);
  });
  it('renders every holding of one product; unknown product metadata is never fabricated as zero', async () => {
    const holdings = await banking.investment.listHoldings(DEMO_USER_ID);
    const original = holdings.find(row => row.productId === 'prod_wenjiana')!;
    const duplicate = { ...original, id: 'another-holding', amount: 1000.66 };
    const html = renderToStaticMarkup(createElement(InvestmentsCard, { data: { holdings: [original, duplicate] } }));
    expect((html.match(/持有金额/g) ?? []).length).toBe(2);
    expect(html).toContain('3.25%');
    const legacy = renderToStaticMarkup(createElement(InvestmentsCard, { data: { holdings: [{ ...original, product: undefined }] } }));
    expect(legacy).toContain('待核对');
    expect(legacy).not.toContain('0.00%');
  });
  it('renders server-provided MFA details and removes terminal verification controls', () => {
    const action = { title: '转账', toolName: 'transfer_money' as const, tier: 'RED' as const, requiresMfa: true,
      fields: [{ label: '收款人', value: '张伟' }, { label: '金额', value: '¥5,000.25' }] };
    const live = renderToStaticMarkup(createElement(MfaCard, { actionId: 'a1', action }));
    expect(live).toContain('张伟'); expect(live).toContain('¥5,000.25'); expect(live).toContain('<input');
    const settled = renderToStaticMarkup(createElement(MfaCard, { actionId: 'a1', action, status: 'executed' }));
    expect(settled).toContain('已执行'); expect(settled).not.toContain('<input'); expect(settled).not.toContain('<button');
  });
  it('persists acknowledgement of exactly the selected owned transaction once, without changing money', async () => {
    const snapshot = newSession(DEMO_USER_ID); await saveSession(snapshot);
    const item = (await banking.transaction.detectAnomaly(DEMO_USER_ID)).anomalies[0];
    const balance = await banking.account.getBalance(DEMO_USER_ID);
    const request = () => new NextRequest('http://localhost/api/transactions/ack', { method: 'POST', headers: { cookie: `banking_session=${snapshot.sessionId}` } });
    for (let i = 0; i < 2; i++) expect((await acknowledge(request(), { params: Promise.resolve({ id: item.transaction.id }) })).status).toBe(200);
    expect(await getTestPrisma().auditLog.count({ where: { toolName: 'acknowledge_transaction' } })).toBe(1);
    expect((await banking.transaction.detectAnomaly(DEMO_USER_ID)).anomalies.find(row => row.transaction.id === item.transaction.id)?.acknowledged).toBe(true);
    expect((await banking.account.getBalance(DEMO_USER_ID)).totalAvailable).toBe(balance.totalAvailable);
    expect((await acknowledge(new NextRequest('http://localhost/ack', { method: 'POST' }), { params: Promise.resolve({ id: item.transaction.id }) })).status).toBe(403);
  });
  it('redacts credentials before persistence and leaves normal password workflow requests usable', async () => {
    expect(redactRequest('当前密码: DontStoreMe123')).not.toContain('DontStoreMe123');
    expect(redactRequest('演示修改密码')).toBe('演示修改密码');
    const snapshot = newSession(DEMO_USER_ID);
    snapshot.transcript = [{ id: 'secret', role: 'user', timestamp: 1, content: '新密码: DontStoreMe123' }];
    await saveSession(snapshot);
    expect((await loadSession(snapshot.sessionId))?.transcript[0].content).not.toContain('DontStoreMe123');
  });
  it('deduplicates cards and settles old MFA independently of a new live action', () => {
    const card = { type: 'mfa' as const, actionId: 'first' };
    const message = { id: 'm1', role: 'assistant' as const, content: '', timestamp: 1, cards: [card, card] };
    let state = reduceAgentEvents(initialChatUIState(), [{ type: 'message_start', message }, { type: 'card', card }, { type: 'message_end', message }, { type: 'mfa_required', actionId: 'second' }]);
    expect(state.messages[0].cards).toHaveLength(1);
    state = reduceAgentEvents(state, [{ type: 'action_settled', actionId: 'first', status: 'executed' } as unknown as AgentStreamEvent]);
    expect(state.messages[0].cards?.[0]).toMatchObject({ status: 'executed' });
    expect(state.pendingAction?.actionId).toBe('second');
  });
  it('finishes a failed retry response with persisted plan state after stale narration', async () => {
    const snapshot = newSession(DEMO_USER_ID); await saveSession(snapshot);
    const task = await createTask({ sessionId: snapshot.sessionId, userId: DEMO_USER_ID, goal: 'retry failure' });
    await getTestPrisma().agentTask.update({ where: { id: task.id }, data: { status: 'failed' } });
    const plan = await getTaskPlan(snapshot.sessionId, task.id);
    const outcome = { ok: false, actionId: 'failed-action', status: 'failed', events: [
      { type: 'card', card: { type: 'plan', plan: { ...plan, status: 'waiting_confirmation' } } },
    ] } as ConfirmationOutcome;
    const result = await withPlanUpdate(outcome, { sessionId: snapshot.sessionId, taskId: task.id });
    const ui = reduceAgentEvents(initialChatUIState(), result.events);
    expect(ui.activePlan?.status).toBe('failed');
    expect(result.events.at(-1)).toMatchObject({ type: 'plan_update', plan: { status: 'failed' } });
  });
  it('filters bill transactions and anomalies to the selected month', async () => {
    const response = await bills(new NextRequest('http://localhost/api/bills?month=2026-08'));
    const body = await response.json();
    expect(body.ok).toBe(true); expect(body.data.analysis.month).toBe('2026-08');
    expect(body.data.transactions.length).toBeGreaterThan(0);
    for (const row of [...body.data.transactions, ...body.data.anomalies.map((item: { transaction: unknown }) => item.transaction)]) {
      expect(new Date(row.occurredAt).getMonth()).toBe(7);
    }
    expect(body.data.anomalies.some((item: { transaction: { merchant: string } }) => item.transaction.merchant === 'Apple Store')).toBe(false);
  });
});
