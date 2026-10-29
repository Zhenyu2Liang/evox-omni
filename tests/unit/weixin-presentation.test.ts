import { describe, expect, it, vi } from 'vitest';
import type { ChatCard, AgentStreamEvent } from '../../lib/contracts/agent';
import type { TaskPlan } from '../../lib/contracts/task';
import { renderBusinessCard, renderAttention } from '../../channels/weixin/presentation';
import { handleChannelCommand } from '../../channels/weixin/commands';
import { renderAction, renderEvents, BankingHttpClient, type BankingChannel } from '../../channels/weixin/banking-client';
import { emptyState } from '../../channels/weixin/state';

const time = Date.UTC(2026, 8, 25, 4);
const product = { id: 'p', name: '稳健理财A', code: 'WJA001', riskLevel: 'R2', annualYieldRate: '0.0325', termDays: 90, minAmount: '1000.00' };
const transaction = { id: 'tx', merchant: '咖啡店', amount: '-28.50', category: '餐饮', occurredAt: time, direction: 'DEBIT' };
const plan: TaskPlan = { id: 'plan_1', sessionId: 'demo:user', goal: '分析后设置限额', status: 'waiting_confirmation', createdAt: time, updatedAt: time,
  nodes: [{ id: 'n', name: '调整限额', kind: 'tool', dependencies: [], tool: 'set_card_limit', args: { credential: 'NEVER_DISPLAY' } }],
  results: [{ id: 'n', name: '调整限额', status: 'waiting_confirmation', output: { pendingActionId: 'action_1', token: 'NEVER_DISPLAY' } }] };
const summary = { title: '设置限额', toolName: 'set_card_limit' as const, tier: 'YELLOW' as const, requiresMfa: false, fields: [{ label: '金额', value: '¥100.25' }] };

const cases: Array<[ChatCard, string]> = [
  [{ type: 'balance', data: { accounts: [{ name: '活期', numberMasked: '****8821', balance: '23580.00' }], totalAvailable: '23580.00' } }, '¥23,580.00'],
  [{ type: 'transfer', data: { success: true, recipient: { name: '张伟', phone: '13912340002' }, amount: '200.37', newBalance: '23379.63', transactionId: 'tx1' } }, '¥23,379.63'],
  [{ type: 'transactions', data: [transaction] }, '咖啡店'],
  [{ type: 'spending', data: { month: '2026-09', bookedTotal: '100.25', flaggedTotal: '20.00', prevTotal: '90.00', momChangePct: '11.39', byCategory: [{ category: '餐饮', amount: '100.25', share: '100' }] } }, '¥100.25'],
  [{ type: 'anomaly', data: { scanned: 10, anomalies: [{ transaction, reason: '异常消费' }] } }, '异常消费'],
  [{ type: 'cards', data: [{ id: 'v', type: 'VIRTUAL', numberMasked: '****7788', status: 'ACTIVE', linkedAccountNumber: '****8821', accountAvailableBalance: '23380.00', payableAmount: '87.66', monthlyLimit: '100.00', limits: [] }] }, '¥87.66'],
  [{ type: 'investments', data: { products: [product] } }, '3.25%'],
  [{ type: 'investments', data: { holdings: [{ productName: '稳健理财A', status: 'HOLDING', amount: '4000.00', shares: '4199.864825', latestNetValue: '1.0357', latestNetValueDate: time, marketValue: '4118.906666666666666667', profit: '118.906666666666666667', profitRate: '0.029726666666666667', cumulativeProfit: '118.906666666666666667', valueBasis: 'NET_VALUE' }] } }, '¥4,118.91'],
  [{ type: 'subscriptions', data: [{ name: 'Netflix', status: 'ACTIVE', amount: '68.00', cycle: 'MONTHLY', nextChargeAt: time, remind: true }] }, '已开启'],
  [{ type: 'contacts', data: [{ name: '张伟', phone: '13912340002' }] }, '139****0002'],
  [{ type: 'dashboard', data: { totalAssets: '80000.50', checkingBalance: '23580.00', creditAvailable: '18000.00', monthSpend: '1250.60', month: '2026-09', asOf: time } }, '¥18,000.00'],
  [{ type: 'scheduled', created: true, data: [{ name: '缴费提醒', kind: 'REMINDER', runAt: time, status: 'SCHEDULED', requiresConfirmation: false }] }, '2026-09-25 12:00'],
  [{ type: 'receipt', data: { kind: 'budget', name: '生日预算', amount: '300.50', status: 'RESERVED' } }, '不冻结'],
  [{ type: 'receipt', data: { kind: 'investmentRedemption', success: true, amount: '1059.45', newBalance: '24639.45', occurredAt: time } }, '¥1,059.45'],
  [{ type: 'receipt', data: { kind: 'investmentPurchase', success: true, amount: '1000.00', newBalance: '22580.00', occurredAt: time } }, '理财申购成功'],
  [{ type: 'plan', plan }, '/暂停 plan_1'],
  [{ type: 'error', message: '余额不足' }, '余额不足'],
];

describe('微信完整业务结果展示', () => {
  it('numbers separate transaction blocks and retains multiline recorded notes', () => {
    const text = renderBusinessCard({ type: 'transactions', data: [
      { ...transaction, remark: '打车\n返程' }, { ...transaction, id: 'second', merchant: '便利店' },
    ] });
    expect(text).toContain('1. ');
    expect(text).toContain('\n\n2. ');
    expect(text).toContain('备注：打车\n返程');
    expect(text).toContain('-¥28.50');
  });
  it('does not imply every undispatched schedule is still in the future', () => {
    const text = renderBusinessCard({ type: 'scheduled', created: false, data: [{ name: '已到期待分发', kind: 'TRANSFER', runAt: time, status: 'SCHEDULED', requiresConfirmation: true }] });
    expect(text).toContain('状态：待执行');
    expect(text).not.toContain('尚未到期');
  });
  it('localizes sensitive subscription confirmation once while preserving the original decision commands', () => {
    const action = { title: 'Read active subscriptions.', toolName: 'list_subscriptions' as const, tier: 'YELLOW' as const,
      requiresMfa: false, fields: [{ label: '操作', value: 'Read active subscriptions.' }, { label: '风险等级', value: '🟡 黄色' }] };
    const events: AgentStreamEvent[] = [{ type: 'confirmation_required', actionId: 'subscription_original', action }];
    const result = renderEvents(events);
    expect(result.text).toContain('查询当前有效订阅。');
    expect(result.text).not.toContain('Read active subscriptions.');
    expect(result.text).not.toContain('YELLOW');
    expect(result.text.match(/风险等级：/g)).toHaveLength(1);
    expect(result.text.match(/查询当前有效订阅。/g)).toHaveLength(1);
    expect(result.text).toContain('/确认 subscription_original');
    expect(result.text).toContain('/取消 subscription_original');
    expect(result.text).toContain('尚未执行');
    expect(result.actionIds).toEqual(['subscription_original']);
  });
  it('translates known action fields without rewriting user-authored notes or monetary facts', () => {
    const result = renderAction('original', { ...summary, fields: [
      { label: '金额', value: '¥100.25' }, { label: '备注', value: 'Read active subscriptions. / YELLOW' },
    ] });
    expect(result).toContain('金额：¥100.25');
    expect(result).toContain('备注：Read active subscriptions. / YELLOW');
  });
  it('also localizes historical attention titles without reopening the original approval', () => {
    const result = renderAttention({ id: 'read', sessionId: 's', toolName: 'list_subscriptions', args: {}, tier: 'YELLOW',
      requiresMfa: false, status: 'confirmed', createdAt: time, updatedAt: time, attention: 'recoverable',
      summary: { ...summary, toolName: 'list_subscriptions', title: 'Read active subscriptions.' } });
    expect(result).toContain('查询当前有效订阅。');
    expect(result).not.toContain('Read active subscriptions.');
    expect(result).not.toContain('/确认');
  });
  it.each(cases)('仅有 %j 卡片时仍展示真实结果', (card, expected) => {
    const events: AgentStreamEvent[] = [{ type: 'card', card }];
    const result = renderEvents(events);
    expect(result.text).toContain(expected); expect(result.text).not.toContain('NEVER_DISPLAY');
    expect(result.text).not.toContain('13912340002');
  });
  it('重复 card 与最终消息中的卡片只发一份', () => {
    const card = cases[0][0];
    const result = renderEvents([{ type: 'card', card }, { type: 'message_end', message: { id: 'm', role: 'tool', content: '', timestamp: time, cards: [card] } }]);
    expect(result.text.match(/账户余额/g)).toHaveLength(1);
  });
  it('已经结算后到达的旧确认卡不得重新显示入口', () => {
    expect(renderEvents([{ type: 'action_settled', actionId: 'a', status: 'executed' },
      { type: 'confirmation_required', actionId: 'a', action: summary }]).actionIds).toEqual([]);
  });
  it('成功资金操作后不再显示之前查询的旧余额', () => {
    const result = renderEvents([{ type: 'card', card: cases[0][0] },
      { type: 'tool_end', toolEvent: { toolName: 'transfer_money', toolCallId: 't', status: 'success' } },
      { type: 'card', card: cases[1][0] }]);
    expect(result.text).toContain('¥23,379.63'); expect(result.text).not.toContain('¥23,580.00');
  });
  it('已取消订阅不再提示下一次扣费', () => {
    const result = renderBusinessCard({ type: 'subscriptions', data: [{ name: 'Netflix', status: 'CANCELLED', amount: '68.00', cycle: 'MONTHLY', nextChargeAt: time, remind: false }] });
    expect(result).toContain('已取消'); expect(result).not.toContain('下次扣费');
  });
  it('低 generation 的任务事件不覆盖新状态，不输出参数或原始 output', () => {
    const result = renderEvents([{ type: 'plan_update', plan: { ...plan, status: 'paused', generation: 2 } },
      { type: 'plan_update', plan: { ...plan, status: 'running', generation: 1 } }]);
    expect(result.text).toContain('已暂停'); expect(result.text).not.toContain('NEVER_DISPLAY');
  });
  it.each(['processing', 'recoverable', 'reconciliation'] as const)('待办 %s 不被说成尚未执行或要求重新确认', attention => {
    const result = renderAttention({ id: 'a', sessionId: 's', toolName: 'transfer_money', args: {}, tier: 'RED', requiresMfa: true,
      status: 'confirmed', summary, createdAt: time, updatedAt: time, attention });
    expect(result).not.toContain('尚未执行'); expect(result).not.toContain('/确认');
    if (attention === 'recoverable') expect(result).toContain('/恢复操作 a');
  });
  it('字段畸形不猜测金额，不输出原始 JSON', () => {
    expect(renderBusinessCard({ type: 'balance', data: { secret: 'NEVER_DISPLAY' } })).toContain('字段不完整');
  });
  it('计划被拒时展示与网页相同的公开提示，不回显模型诊断', () => {
    const result = renderEvents([{ type: 'message_end', message: { id: 'm', role: 'assistant', content: '', timestamp: time,
      toolEvents: [{ toolName: 'submit_plan', toolCallId: 'p', status: 'blocked', summary: 'chat.error.planNotSubmitted', debugDetail: 'PRIVATE_ERROR', debugArguments: { token: 'PRIVATE_TOKEN' } }] } }]);
    expect(result.text).toContain('任务');
    expect(result.text).not.toContain('本次请求已处理');
    expect(result.text).not.toContain('PRIVATE_');
    expect(result.text).not.toContain('chat.error.');
  });
});

describe('微信持仓按「净值 + 份额」展示', () => {
  const holding = { id: 'h1', productId: 'p', product, productName: '稳健理财A', riskLevel: 'R2', status: 'HOLDING', boughtAt: time,
    amount: '5000.00', shares: '4999.864825', latestNetValue: '1.0357', latestNetValueDate: time,
    marketValue: '5178.3599992525', profit: '178.3599992525', profitRate: '0.0356719998505',
    realizedProfit: '0.00', cumulativeProfit: '178.3599992525', valueBasis: 'NET_VALUE' };
  it('展示份额、最新净值与净值日期、市值、剩余成本、收益、收益率和累计收益', () => {
    const text = renderBusinessCard({ type: 'investments', data: { holdings: [holding] } });
    expect(text).toContain('稳健理财A：持有中');
    expect(text).toContain('持仓份额 4999.864825 份');
    expect(text).toContain('最新净值 1.0357 元/份（2026-09-25）');
    expect(text).toContain('持仓市值 ¥5,178.36');
    expect(text).toContain('剩余持仓成本 ¥5,000.00');
    expect(text).toContain('持仓收益 ¥178.36');
    expect(text).toContain('持仓收益率 3.57%');
    expect(text).toContain('累计收益 ¥178.36');
    expect(text).toContain('收益为模拟估算，不承诺保本');
    expect(text).not.toContain('估算）');
  });
  it('派生估算的持仓标注估算', () => {
    const text = renderBusinessCard({ type: 'investments', data: { holdings: [{ ...holding, valueBasis: 'MIGRATED_ESTIMATE' }] } });
    expect(text).toContain('持仓市值 ¥5,178.36（估算）');
  });
  it('历史数据不足的持仓只展示已有事实，不伪造收益', () => {
    const text = renderBusinessCard({ type: 'investments', data: { holdings: [{ ...holding, shares: undefined, latestNetValue: undefined,
      latestNetValueDate: undefined, marketValue: '5000.00', profit: undefined, profitRate: undefined, cumulativeProfit: undefined,
      valueBasis: 'HISTORICAL_DATA_INSUFFICIENT' }] } });
    expect(text).toContain('持仓份额 历史数据不足');
    expect(text).toContain('最新净值 历史数据不足');
    expect(text).toContain('持仓市值 ¥5,000.00（历史数据不足）');
    expect(text).toContain('剩余持仓成本 ¥5,000.00');
    expect(text).toContain('持仓收益 历史数据不足');
    expect(text).toContain('持仓收益率 历史数据不足');
    expect(text).toContain('累计收益 历史数据不足');
    expect(text).not.toContain('%');
  });
  it('没有持仓时不追加收益声明', () => {
    expect(renderBusinessCard({ type: 'investments', data: { holdings: [] } })).toBe('理财持仓\n没有持仓。');
  });
});

function setup() {
  const state = emptyState();
  const action = { id: 'action_1', sessionId: 'demo:user', toolName: 'set_card_limit' as const, args: {}, tier: 'YELLOW' as const,
    requiresMfa: false, status: 'pending' as const, summary, createdAt: time, updatedAt: time };
  const bank: BankingChannel = { chat: vi.fn(), actions: vi.fn().mockResolvedValue([action]), settle: vi.fn(),
    plans: vi.fn().mockResolvedValue([plan]), plan: vi.fn().mockResolvedValue(plan), controlPlan: vi.fn().mockResolvedValue(plan),
    schedules: vi.fn().mockResolvedValue({ tasks: [], notifications: [{ id: 'note', scheduledTaskId: 'schedule', message: '应缴费', createdAt: time }] }),
    tickSchedules: vi.fn().mockResolvedValue({ evaluatedAt: time, dispatches: [{ scheduledTaskId: 'schedule', status: 'AWAITING_CONFIRMATION', workflowId: plan.id }] }) };
  return { state, bank };
}
describe('微信工作流、恢复与到期入口', () => {
  it.each([['暂停', 'pause'], ['继续', 'resume'], ['重试', 'retry'], ['取消任务', 'cancel'], ['回退记录', 'rollback']] as const)('显式 /%s 复用服务端 %s', async (verb, action) => {
    const { bank, state } = setup(); await handleChannelCommand('/任务', bank, state);
    const reply = await handleChannelCommand(`/${verb} plan_1`, bank, state);
    expect(bank.controlPlan).toHaveBeenCalledWith('plan_1', action);
    expect(reply).toContain('确认：/确认\n'); expect(state.offered.action_1).toMatchObject({ shortId: 1 });
  });
  it('未展示的任务不直接控制', async () => {
    const { bank, state } = setup(); expect(await handleChannelCommand('/继续 unknown', bank, state)).toContain('先发送 /任务');
    expect(bank.controlPlan).not.toHaveBeenCalled();
  });
  it('网页发起的操作先在 /待办 展示详情后，才成为可确认操作', async () => {
    const { bank, state } = setup(); expect(state.offered.action_1).toBeUndefined();
    expect(await handleChannelCommand('/待办', bank, state)).toContain('¥100.25'); expect(state.offered.action_1.confirmed).toBe(false);
  });
  it('显式检查到期展示通知和到期付款的真实确认入口，不自动确认', async () => {
    const { bank, state } = setup(); const reply = await handleChannelCommand('/检查到期', bank, state);
    expect(reply).toContain('应缴费'); expect(reply).toContain('确认：/确认\n');
    expect(bank.tickSchedules).toHaveBeenCalledOnce(); expect(bank.settle).not.toHaveBeenCalled();
  });
  it('HTTP 调用的工作流与恢复参数不能绕开既有接口', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const client = new BankingHttpClient('http://127.0.0.1:3000', async (url, init) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(JSON.stringify({ ok: true, data: { plans: [], events: [] } }));
    });
    await client.controlPlan('plan_1', 'resume'); await client.tickSchedules(); await client.settle('action_1', 'recover');
    expect(calls).toEqual([{ url: 'http://127.0.0.1:3000/api/tasks/plan_1', body: { action: 'resume' } },
      { url: 'http://127.0.0.1:3000/api/schedules/tick', body: {} }, { url: 'http://127.0.0.1:3000/api/actions/action_1/recover', body: {} }]);
  });
});
