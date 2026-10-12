import { describe, expect, it } from 'vitest';
import { buildFinancialFacts, type FactInput } from './grounding-facts';
import { renderFinancialResponse } from './financial-response';

const balance: FactInput = { toolName: 'get_balance', toolCallId: 'balance-1', result: { ok: true, data: {
  totalAvailable: 73580, accounts: [
    { id: 'checking', name: '活期账户', type: 'CHECKING', balance: 23580 },
    { id: 'savings', name: '储蓄账户', type: 'SAVINGS', balance: 50000 },
  ],
} } };
function transfer(id: string, amount = 200, newBalance = 23380): FactInput {
  return { toolName: 'transfer_money', actionId: id, result: { ok: true, data: {
    amount, newBalance, sourceAccountId: 'checking', recipient: { name: '张伟' },
  } } };
}

describe('server-owned financial result presentation', () => {
  it('renders recipient/amount/outcome from the specific real operation', () => {
    const text = renderFinancialResponse([transfer('a')]);
    expect(text).toBe('（系统校正）转账处理结果：第1笔操作实际执行成功；收款人 张伟；金额 ¥200.00；执行时账户余额 ¥23,380.00。');
    expect(text).not.toContain('李华');
    expect(text).not.toContain('30,000');
  });
  it('updates account and total together after a decimal transfer', () => {
    const text = renderFinancialResponse([balance, transfer('a', 200.37, 23379.63)]);
    expect(text).toContain('活期账户当前余额为 ¥23,379.63');
    expect(text).toContain('储蓄账户当前余额为 ¥50,000.00');
    expect(text).toContain('账户可用余额合计为 ¥73,379.63');
    expect(text).not.toContain('73,580.00');
    expect(text).not.toContain('23,580.00');
  });
  it('an explicit savings write never updates checking', () => {
    const entry = transfer('a');
    entry.result.data = { amount: 200, newBalance: 49800, sourceAccountId: 'savings', recipient: { name: '张伟' } };
    const text = renderFinancialResponse([balance, entry]);
    expect(text).toContain('活期账户当前余额为 ¥23,580.00');
    expect(text).toContain('储蓄账户当前余额为 ¥49,800.00');
    expect(text).toContain('账户可用余额合计为 ¥73,380.00');
  });
  it('two identical amounts remain separate operations, success then failure', () => {
    const failed: FactInput = { toolName: 'transfer_money', actionId: 'b', result: { ok: false, error: '余额不足' } };
    const text = renderFinancialResponse([transfer('a'), failed]);
    expect(text).toContain('第1笔操作实际执行成功');
    expect(text).toContain('第2笔操作实际执行失败：余额不足');
    expect(text).not.toContain('第2笔操作实际执行成功');
  });
  it('two identical amounts remain separate operations, failure then success', () => {
    const failed: FactInput = { toolName: 'transfer_money', actionId: 'a', result: { ok: false, error: '余额不足' } };
    const text = renderFinancialResponse([failed, transfer('b')]);
    expect(text).toContain('第1笔操作实际执行失败');
    expect(text).toContain('第2笔操作实际执行成功');
  });
  it('replaying the same action cannot restore an old balance over a later transfer', () => {
    const first = transfer('a');
    const text = renderFinancialResponse([balance, first, transfer('b', 100, 23280), first]);
    expect(text).toContain('账户可用余额合计为 ¥73,280.00');
    expect(text).toContain('活期账户当前余额为 ¥23,280.00');
    expect(text.match(/实际执行成功/g)).toHaveLength(2);
  });
  it('distinct node identities are not deduplicated by equal parameters', () => {
    const a = { ...transfer('a'), actionId: undefined, taskId: 'plan', nodeId: 'a' };
    const b = { ...transfer('b', 200, 23180), actionId: undefined, taskId: 'plan', nodeId: 'b' };
    expect(buildFinancialFacts([a, b, a]).writes).toHaveLength(2);
  });
  it('distinct ledger receipts stay separate when a provider reuses a call id', () => {
    const a: FactInput = { toolName: 'transfer_money', toolCallId: 'reused', result: { ok: true, data: { transactionId: 'tx-a', amount: 200 } } };
    const b: FactInput = { toolName: 'transfer_money', toolCallId: 'reused', result: { ok: true, data: { transactionId: 'tx-b', amount: 200 } } };
    expect(buildFinancialFacts([a, b, a]).writes).toHaveLength(2);
  });
  it('UNKNOWN invalidates the affected current balance and total without claiming failure', () => {
    const unknown: FactInput = { toolName: 'transfer_money', actionId: 'a', sourceAccountId: 'checking', result: {
      ok: false, data: { status: 'needs_reconciliation' }, error: '核对中',
    } };
    const text = renderFinancialResponse([balance, unknown]);
    expect(text).toContain('活期账户当前余额待核对');
    expect(text).toContain('储蓄账户当前余额为 ¥50,000.00');
    expect(text).toContain('账户可用余额合计待核对');
    expect(text).toContain('第1笔操作待核对');
    for (const claim of ['成功', '失败', '资金未变', '未发生', '23,580', '73,580']) expect(text).not.toContain(claim);
  });
  it('an explicit unknown state wins over an inconsistent ok flag', () => {
    const text = renderFinancialResponse([{ toolName: 'transfer_money', result: { ok: true, data: { status: 'needs_reconciliation' } } }]);
    expect(text).toContain('待核对');
    expect(text).not.toContain('成功');
  });
  it('a fresh authoritative query restores the current balance after UNKNOWN', () => {
    const text = renderFinancialResponse([balance, { toolName: 'transfer_money', result: { ok: false, data: { status: 'needs_reconciliation' } } }, balance]);
    expect(text).toContain('活期账户当前余额为 ¥23,580.00');
    expect(text).toContain('账户可用余额合计为 ¥73,580.00');
    expect(text).toContain('操作待核对'); // A balance query does not establish the action's outcome.
  });
  it('unknown can be reconciled under the same action without adding another action', () => {
    const unknown: FactInput = { toolName: 'transfer_money', actionId: 'a', result: { ok: false, data: { status: 'needs_reconciliation' } } };
    const facts = buildFinancialFacts([balance, unknown, transfer('a')]);
    expect(facts.writes).toHaveLength(1);
    expect(facts.writes[0].outcome).toBe('succeeded');
    // Other uncertain accounts remain uncertain until actually queried.
    expect(facts.totalBalance).toBeUndefined();
  });
  it('a read failure cannot be used as account authority', () => {
    const text = renderFinancialResponse([{ ...balance, result: { ...balance.result, ok: false, error: '查询失败' } }]);
    expect(text).toContain('余额查询未取得结果');
    expect(text).not.toContain('73,580');
  });
  it('expense analysis displays the server result, not a balance or write conclusion', () => {
    const text = renderFinancialResponse([{ toolName: 'analyze_spending', result: { ok: true, data: { total: 6937.05 } } }]);
    expect(text).toContain('消费合计 ¥6,937.05');
    expect(text).not.toContain('账户当前余额');
    expect(text).not.toContain('实际执行成功');
  });
  it('a plan goal/summary is model input and never becomes a financial statement', () => {
    const text = renderFinancialResponse([{ toolName: 'submit_plan', result: { ok: true, summary: '已给李华转30000元', data: { status: 'waiting_confirmation', goal: '余额999999' } } }]);
    expect(text).toContain('计划状态：等待确认');
    expect(text).not.toContain('李华');
    expect(text).not.toContain('30000');
    expect(text).not.toContain('999999');
  });
});
