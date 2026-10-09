/**
 * grounding.test.ts — PURE unit tests for `./grounding` (server-side fact grounding).
 *
 * These specs need NO database and NO pi runtime: `./grounding` is a pure module (it imports only
 * `@/lib/money` plus a TYPE-ONLY tools import). They lock in the two grounding rules:
 *  - FALSE-SUCCESS: a completion claim about a state-changing op with no successful write is
 *    replaced by a server statement;
 *  - BALANCE-CONTRADICTION: a balance-labeled amount matching no authoritative amount is replaced
 *    by a server statement built from the authoritative total;
 * and — just as importantly — the CONSERVATIVE non-firing cases (read-only / future / failure
 * phrasing, consistent text) that keep honest narration intact.
 */
import { describe, expect, it } from 'vitest';
import type { ToolExecutionResult } from './tools';
import { SIDE_EFFECT_TOOLS, buildFinancialFacts, groundAssistantText } from './grounding';

/** One `{ toolName, result }` entry as `TurnBuffer.factResults` stores it. */
type FactResult = { toolName: string; result: ToolExecutionResult };

/** A real `get_balance` result: 活期 23580, 储蓄 50000, totalAvailable 73580. */
function balanceResult(): FactResult {
  return {
    toolName: 'get_balance',
    result: {
      ok: true,
      data: {
        totalAvailable: 73580,
        currency: 'CNY',
        accounts: [{ balance: 23580 }, { balance: 50000 }],
      },
    },
  };
}

/** The authoritative amounts a balance claim may match: 23580 / 50000 / 73580. */
const AUTHORITATIVE = '¥73,580.00';

describe('SIDE_EFFECT_TOOLS', () => {
  it('contains the gated/state-changing write tools', () => {
    for (const name of [
      'transfer_money',
      'reserve_budget',
      'set_card_limit',
      'cancel_subscription',
      'freeze_card',
      'apply_virtual_card',
      'set_subscription_reminder',
      'create_scheduled_task',
      'subscribe_investment',
      'redeem_investment',
      'report_lost_card',
      'unfreeze_card',
      'change_password',
    ]) {
      expect(SIDE_EFFECT_TOOLS.has(name)).toBe(true);
    }
  });

  it('does not contain read-only tools', () => {
    expect(SIDE_EFFECT_TOOLS.has('get_balance')).toBe(false);
    expect(SIDE_EFFECT_TOOLS.has('get_transactions')).toBe(false);
    expect(SIDE_EFFECT_TOOLS.has('list_cards')).toBe(false);
  });
});

describe('buildFinancialFacts', () => {
  it('extracts balances + totalBalance from a get_balance result', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    expect(facts.balances).toEqual([23580, 50000]);
    expect(facts.totalBalance).toBe(73580);
    expect(facts.hasToolResults).toBe(true);
    expect(facts.writes).toEqual([]);
    expect(facts.anyWriteSucceeded).toBe(false);
  });

  it('reports empty facts for no tool results', () => {
    const facts = buildFinancialFacts([]);
    expect(facts.balances).toEqual([]);
    expect(facts.totalBalance).toBeUndefined();
    expect(facts.writes).toEqual([]);
    expect(facts.anyWriteSucceeded).toBe(false);
    expect(facts.hasToolResults).toBe(false);
  });

  it('records each side-effecting write and flags anyWriteSucceeded', () => {
    const facts = buildFinancialFacts([
      { toolName: 'transfer_money', result: { ok: true, summary: '转账成功' } },
      { toolName: 'freeze_card', result: { ok: false, error: '卡不存在' } },
      { toolName: 'get_balance', result: { ok: true, data: { totalAvailable: 73580 } } },
    ]);
    expect(facts.writes).toEqual([
      { toolName: 'transfer_money', ok: true, summary: '转账成功' },
      { toolName: 'freeze_card', ok: false },
    ]);
    expect(facts.anyWriteSucceeded).toBe(true);
    expect(facts.totalBalance).toBe(73580);
  });

  it('treats a failed-only write as no successful write', () => {
    const facts = buildFinancialFacts([{ toolName: 'transfer_money', result: { ok: false, error: 'INSUFFICIENT_FUNDS' } }]);
    expect(facts.writes).toEqual([{ toolName: 'transfer_money', ok: false }]);
    expect(facts.anyWriteSucceeded).toBe(false);
  });

  it('ignores malformed get_balance data (no crash, no fabricated numbers)', () => {
    const facts = buildFinancialFacts([
      { toolName: 'get_balance', result: { ok: false, error: 'boom' } },
      { toolName: 'get_balance', result: { ok: true, data: 'not-an-object' } },
      { toolName: 'get_balance', result: { ok: true, data: { accounts: [{ balance: 'x' }] } } },
    ]);
    expect(facts.balances).toEqual([]);
    expect(facts.totalBalance).toBeUndefined();
    expect(facts.hasToolResults).toBe(true);
  });
});

describe('groundAssistantText — FALSE-SUCCESS rule', () => {
  it('replaces a claimed transfer success when no write succeeded', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText('已成功为您转账 ¥500.00。', facts);
    expect(out).toContain('（系统校正）');
    expect(out).toContain('未检测到任何已成功执行的操作');
    expect(out).not.toContain('已成功为您转账');
  });

  it('does NOT fire when a write DID succeed', () => {
    const facts = buildFinancialFacts([
      { toolName: 'transfer_money', result: { ok: true, summary: '转账成功' } },
    ]);
    const text = '已成功为您转账 ¥500.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on a future / intent statement (将我为您转账)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '我将为您转账 ¥500.00，请确认。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on a read-only report (已为您查询余额)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '已为您查询到活期账户余额 ¥23,580.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on an honest failure narration', () => {
    const facts = buildFinancialFacts([
      balanceResult(),
      { toolName: 'transfer_money', result: { ok: false, error: 'INSUFFICIENT_FUNDS' } },
    ]);
    const text = '转账失败：账户余额不足，无法完成本次转账。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on an awaiting-confirmation statement', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '您的转账请求已提交，等待您确认后执行。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });
});

describe('groundAssistantText — BALANCE-CONTRADICTION rule', () => {
  it('replaces a balance amount that matches no authoritative amount', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText('您的账户余额为 ¥999,999.99。', facts);
    expect(out).toContain('（系统校正）');
    expect(out).toContain(AUTHORITATIVE);
    expect(out).not.toContain('999,999.99');
  });

  it('keeps a message whose balance matches an authoritative account balance', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '您的活期账户余额为 ¥23,580.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('keeps a message whose 余额合计 matches the authoritative total', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '您的可用余额合计为 ¥73,580.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('tolerates thousand separators on a matching amount', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '您的账户余额约为 23,580 元。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire when no get_balance facts exist this turn', () => {
    const facts = buildFinancialFacts([{ toolName: 'search_contact', result: { ok: true, data: [] } }]);
    const text = '您的账户余额为 ¥999,999.99。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on a non-balance amount (a transfer amount, not a balance)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '本次转账金额为 ¥888.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });
});

describe('groundAssistantText — composition & safety', () => {
  it('applies BOTH rules and never leaves contradictory text', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText(
      '已成功为您转账 ¥500.00，您的账户余额为 ¥999,999.99。',
      facts,
    );
    expect(out).toContain('未检测到任何已成功执行的操作');
    expect(out).toContain(AUTHORITATIVE);
    expect(out).not.toContain('999,999.99');
    expect(out).not.toContain('已成功为您转账');
  });

  it('returns empty text unchanged', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    expect(groundAssistantText('', facts)).toBe('');
    expect(groundAssistantText('   ', facts)).toBe('   ');
  });

  it('is idempotent — an already-corrected text is left untouched', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const corrected =
      '（系统校正）未检测到任何已成功执行的操作：资金未发生变动，账户余额保持不变。请以系统卡片中的实际数据为准。';
    expect(groundAssistantText(corrected, facts)).toBe(corrected);
  });

  it('returns a consistent financial narration unchanged', () => {
    const facts = buildFinancialFacts([
      balanceResult(),
      { toolName: 'get_transactions', result: { ok: true, data: [] } },
    ]);
    const text = '您本月已支出 ¥1,234.56，当前活期账户余额为 ¥23,580.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });
});
