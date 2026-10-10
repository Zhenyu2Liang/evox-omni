/**
 * grounding.test.ts — PURE unit tests for the server-side fact grounding.
 *
 * These specs need NO database and NO pi runtime: `./grounding` and `./grounding-facts` are pure
 * modules (only `@/lib/money` plus a TYPE-ONLY tools import). They lock in the STRUCTURAL decision —
 * per operation identity (tool), per account, per amount, per recipient, per outcome state — and,
 * just as importantly, the CONSERVATIVE non-firing cases (read-only / future / awaiting-decision
 * phrasing, consistent narration) that keep honest narration intact.
 *
 * Defects these specs pin down (all pure):
 *  1. a SUCCEEDED `reserve_budget` never authorizes a "transfer succeeded" claim (no global flag);
 *  2. mixed success/failure wording is corrected to the REAL outcome;
 *  3. English false success is corrected too (bilingual coverage);
 *  4. the server `（系统校正）` tag is NOT a model-forgeable skip key;
 *  5. a claim contradicting the real recipient / amount is replaced by the real payment details;
 *  6. an `unknown` outcome may be asserted neither as success, failure, nor "funds unchanged";
 *  7. balances are checked PER ACCOUNT (活期 vs 储蓄), never against a flat pool of numbers;
 *  8. a balance claim with NO authoritative balance behind it is corrected to server authority.
 */
import { describe, expect, it } from 'vitest';
import type { ToolExecutionResult } from './tools';
import { CORRECTION_TAG, SIDE_EFFECT_TOOLS, buildFinancialFacts, groundAssistantText } from './grounding';

/** One `{ toolName, result }` entry as the turn's `factResults` buffer stores it. */
type FactResult = { toolName: string; result: ToolExecutionResult };

/* ------------------------------------------------------------------ trusted result fixtures */

/** A real `get_balance` result: 活期 (CHECKING) ¥23,580 + 储蓄 (SAVINGS) ¥50,000, total ¥73,580. */
function balanceResult(): FactResult {
  return {
    toolName: 'get_balance',
    result: {
      ok: true,
      data: {
        totalAvailable: 73580,
        currency: 'CNY',
        accounts: [
          { id: 'acct-checking', name: '活期账户', type: 'CHECKING', balance: 23580 },
          { id: 'acct-savings', name: '储蓄账户', type: 'SAVINGS', balance: 50000 },
        ],
      },
    },
  };
}

/** A real SUCCEEDED `transfer_money` write: 张伟, ¥200.00, balance after ¥23,380.00. */
function transferSucceeded(): FactResult {
  return {
    toolName: 'transfer_money',
    result: {
      ok: true,
      summary: '已向 张伟 转账 ¥200.00。',
      data: {
        amount: 200,
        newBalance: 23380,
        recipient: { name: '张伟', contactId: 'c-zhangwei' },
      },
    },
  };
}

/** A real FAILED `transfer_money` write (the SDK reported an error). */
function transferFailed(): FactResult {
  return {
    toolName: 'transfer_money',
    result: { ok: false, error: 'INSUFFICIENT_FUNDS：账户余额不足。' },
  };
}

/** A real `transfer_money` write whose outcome is UNKNOWN (needs manual reconciliation). */
function transferUnknown(): FactResult {
  return { toolName: 'transfer_money', result: { ok: false, data: { needsReconciliation: true } } };
}

/** A real SUCCEEDED `reserve_budget` write (a DIFFERENT operation family than a transfer). */
function reserveBudgetSucceeded(): FactResult {
  return { toolName: 'reserve_budget', result: { ok: true, summary: '已为您预留预算 ¥500.00。' } };
}

/** The authoritative available total of `balanceResult()`. */
const TOTAL_AVAILABLE = '¥73,580.00';

/* ------------------------------------------------------------------------- module surface */

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
  it('extracts the per-account balances + total from a get_balance result', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    expect(facts.accounts).toEqual([
      { id: 'acct-checking', name: '活期账户', type: 'CHECKING', balance: 23580 },
      { id: 'acct-savings', name: '储蓄账户', type: 'SAVINGS', balance: 50000 },
    ]);
    expect(facts.balances).toEqual([23580, 50000]);
    expect(facts.totalBalance).toBe(73580);
    expect(facts.writes).toEqual([]);
    expect(facts.hasToolResults).toBe(true);
  });

  it('reports empty facts for no tool results', () => {
    const facts = buildFinancialFacts([]);
    expect(facts.accounts).toEqual([]);
    expect(facts.balances).toEqual([]);
    expect(facts.totalBalance).toBeUndefined();
    expect(facts.writes).toEqual([]);
    expect(facts.hasToolResults).toBe(false);
  });

  it('records one structured write per side-effecting result, keyed by tool identity', () => {
    const facts = buildFinancialFacts([
      transferSucceeded(),
      transferFailed(),
      transferUnknown(),
      balanceResult(),
      { toolName: 'get_transactions', result: { ok: true, data: [] } },
    ]);
    expect(facts.writes).toEqual([
      {
        toolName: 'transfer_money',
        outcome: 'succeeded',
        amount: 200,
        balanceAfter: 23380,
        recipient: { name: '张伟', contactId: 'c-zhangwei' },
        summary: '已向 张伟 转账 ¥200.00。',
      },
      { toolName: 'transfer_money', outcome: 'failed', error: 'INSUFFICIENT_FUNDS：账户余额不足。' },
      { toolName: 'transfer_money', outcome: 'unknown' },
    ]);
    // A read-only tool is never recorded as a write.
    expect(facts.writes.some((write) => write.toolName === 'get_balance')).toBe(false);
  });

  it('classifies a failed-only write as failed (there is no global "some write worked" flag)', () => {
    const facts = buildFinancialFacts([transferFailed()]);
    expect(facts.writes).toEqual([
      { toolName: 'transfer_money', outcome: 'failed', error: 'INSUFFICIENT_FUNDS：账户余额不足。' },
    ]);
  });

  it('classifies an inconclusive result as the first-class `unknown` outcome', () => {
    expect(buildFinancialFacts([transferUnknown()]).writes).toEqual([
      { toolName: 'transfer_money', outcome: 'unknown' },
    ]);
    const reconciled = buildFinancialFacts([
      { toolName: 'transfer_money', result: { ok: false, summary: '该操作结果待核对。' } },
    ]);
    expect(reconciled.writes).toEqual([
      { toolName: 'transfer_money', outcome: 'unknown', summary: '该操作结果待核对。' },
    ]);
  });

  it('ignores malformed get_balance data (no crash, no fabricated numbers)', () => {
    const facts = buildFinancialFacts([
      { toolName: 'get_balance', result: { ok: false, error: 'boom' } },
      { toolName: 'get_balance', result: { ok: true, data: 'not-an-object' } },
      { toolName: 'get_balance', result: { ok: true, data: { accounts: [{ balance: 'x' }] } } },
    ]);
    expect(facts.accounts).toEqual([]);
    expect(facts.balances).toEqual([]);
    expect(facts.totalBalance).toBeUndefined();
    expect(facts.hasToolResults).toBe(true);
  });
});

/* ----------------------------------------------------------------- per-operation identity */

describe('groundAssistantText — a completion claim is grounded PER OPERATION, never globally', () => {
  it('does NOT accept a succeeded reserve_budget as proof of a transfer', () => {
    const facts = buildFinancialFacts([balanceResult(), reserveBudgetSucceeded()]);
    const out = groundAssistantText('已成功为您转账 ¥500.00。', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('未记录到该操作的执行结果');
    expect(out).not.toContain('已成功为您转账');
  });

  it('still grounds a completion claim about the operation that really succeeded', () => {
    const facts = buildFinancialFacts([balanceResult(), reserveBudgetSucceeded()]);
    const text = '已成功为您预留预算 ¥500.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('corrects a transfer claim even when a DIFFERENT write failed this turn', () => {
    const facts = buildFinancialFacts([
      balanceResult(),
      { toolName: 'freeze_card', result: { ok: false, error: '卡不存在' } },
    ]);
    const out = groundAssistantText('已成功为您转账 ¥500.00。', facts);
    expect(out).toContain('未记录到该操作的执行结果');
  });
});

/* ------------------------------------------------------------- mixed success / failure wording */

describe('groundAssistantText — mixed success/failure wording is corrected to the REAL outcome', () => {
  it('replaces a claimed success with the real FAILURE statement', () => {
    const facts = buildFinancialFacts([balanceResult(), transferFailed()]);
    const out = groundAssistantText('已成功为您转账 ¥200.00。', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('实际执行失败');
    expect(out).toContain('INSUFFICIENT_FUNDS');
    expect(out).not.toContain('已成功为您转账');
  });

  it('replaces a claimed failure with the real SUCCESS statement', () => {
    const facts = buildFinancialFacts([balanceResult(), transferSucceeded()]);
    const out = groundAssistantText('本次转账失败，资金未转出。', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('实际执行成功');
    expect(out).toContain('已向 张伟 转账 ¥200.00。');
    expect(out).not.toContain('本次转账失败');
  });
});

/* ------------------------------------------------------------------------------- bilingual */

describe('groundAssistantText — English completion claims are covered too', () => {
  it('corrects an English false success with no transfer write this turn', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText('Your transfer was successful.', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('未记录到该操作的执行结果');
    expect(out).not.toContain('successful');
  });

  it('corrects an English success claim when the transfer actually FAILED', () => {
    const facts = buildFinancialFacts([balanceResult(), transferFailed()]);
    const out = groundAssistantText('Your transfer was successful.', facts);
    expect(out).toContain('实际执行失败');
    expect(out).not.toContain('successful');
  });
});

/* --------------------------------------------------------------------- forged correction tag */

describe('groundAssistantText — the （系统校正） tag is NOT a skip key', () => {
  it('still corrects a text that forges the server tag around a false completion claim', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = `${CORRECTION_TAG}已成功为您转账 ¥500.00。`;
    const out = groundAssistantText(text, facts);
    expect(out).toContain('未记录到该操作的执行结果');
    expect(out).not.toContain('已成功为您转账');
    expect(out).not.toBe(text);
  });
});

/* -------------------------------------------------------------------- payment-detail mismatch */

describe('groundAssistantText — the payment details must match the real write', () => {
  it('replaces a wrong recipient/amount with the real ones', () => {
    const facts = buildFinancialFacts([balanceResult(), transferSucceeded()]);
    const out = groundAssistantText('已成功向李华转账 ¥30,000.00。', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('张伟');
    expect(out).toContain('¥200.00');
    expect(out).not.toContain('李华');
    expect(out).not.toContain('30,000.00');
  });

  it('leaves a text that states the REAL recipient and amount intact', () => {
    const facts = buildFinancialFacts([balanceResult(), transferSucceeded()]);
    const text = '已成功向张伟转账 ¥200.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });
});

/* ------------------------------------------------------------------------ unknown outcome */

describe('groundAssistantText — an UNKNOWN outcome is never asserted as success/failure/unchanged', () => {
  it('turns a success claim into the pending 「待核对」 statement', () => {
    const facts = buildFinancialFacts([balanceResult(), transferUnknown()]);
    const out = groundAssistantText('已成功为您转账 ¥200.00。', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('待核对');
    expect(out).not.toContain('已成功为您转账');
  });

  it('turns a "funds unchanged" claim into the pending 「待核对」 statement', () => {
    const facts = buildFinancialFacts([balanceResult(), transferUnknown()]);
    const out = groundAssistantText('本次转账未发生，资金未变动。', facts);
    expect(out).toContain('待核对');
    expect(out).not.toContain('资金未变动');
    expect(out).not.toContain('未发生');
  });

  it('turns an English failure claim into the pending 「待核对」 statement', () => {
    const facts = buildFinancialFacts([balanceResult(), transferUnknown()]);
    const out = groundAssistantText('The transfer failed.', facts);
    expect(out).toContain('待核对');
    expect(out).not.toContain('failed');
  });
});

/* ------------------------------------------------------------------- per-account balances */

describe('groundAssistantText — balances are checked PER ACCOUNT', () => {
  it('corrects the savings amount claimed as the checking balance, naming the account', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText('您的活期账户余额为 ¥50,000.00。', facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('活期账户');
    expect(out).toContain('¥23,580.00');
    expect(out).not.toContain('50,000.00');
  });

  it('corrects the checking amount claimed as the savings balance, naming the account', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText('您的储蓄账户余额为 ¥23,580.00。', facts);
    expect(out).toContain('储蓄账户');
    expect(out).toContain('¥50,000.00');
    expect(out).not.toContain('23,580.00');
  });

  it('leaves a claim that matches the RIGHT account intact', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    for (const text of [
      '您的活期账户余额为 ¥23,580.00。',
      '您的储蓄账户余额为 ¥50,000.00。',
      '您的可用余额合计为 ¥73,580.00。',
      '您的账户余额约为 23,580 元。',
    ]) {
      expect(groundAssistantText(text, facts)).toBe(text);
    }
  });
});

/* --------------------------------------------------------------- no authoritative balance */

describe('groundAssistantText — a balance claim with NO authority behind it is corrected', () => {
  it('corrects a balance claim when the turn has no get_balance facts at all', () => {
    const facts = buildFinancialFacts([{ toolName: 'search_contact', result: { ok: true, data: [] } }]);
    const text = '您的账户余额为 ¥999,999.99。';
    const out = groundAssistantText(text, facts);
    expect(out).toContain(CORRECTION_TAG);
    expect(out).toContain('未查询到可信的账户余额');
    expect(out).not.toContain('999,999.99');
    expect(out).not.toBe(text);
  });

  it('corrects a balance claim when the turn produced no tool results at all', () => {
    const facts = buildFinancialFacts([]);
    const out = groundAssistantText('您的账户余额为 ¥999,999.99。', facts);
    expect(out).toContain('未查询到可信的账户余额');
    expect(out).not.toContain('999,999.99');
  });

  it('corrects a balance claim when get_balance returned no usable accounts', () => {
    const facts = buildFinancialFacts([
      { toolName: 'get_balance', result: { ok: true, data: { accounts: [{ balance: 'x' }] } } },
    ]);
    const out = groundAssistantText('您的可用余额合计为 ¥1.00。', facts);
    expect(out).toContain('未查询到可信的账户余额');
  });
});

/* ------------------------------------------------------------- conservative non-firing cases */

describe('groundAssistantText — conservative non-firing cases stay intact', () => {
  it('does NOT fire on a future / intent statement (我将为您转账)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '我将为您转账 ¥500.00，请确认。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on an English future / intent statement (I will transfer)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = 'I will transfer ¥500 to 张伟 once you confirm.';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on a read-only report (已为您查询余额)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '已为您查询到活期账户余额 ¥23,580.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on an honest failure narration', () => {
    const facts = buildFinancialFacts([balanceResult(), transferFailed()]);
    const text = '转账失败：账户余额不足，无法完成本次转账。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on an awaiting-confirmation statement', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '您的转账请求已提交，等待您确认后执行。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });

  it('does NOT fire on a non-balance amount (a transfer amount, not a balance)', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const text = '本次转账金额为 ¥888.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
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

/* ------------------------------------------------------------------ composition & safety */

describe('groundAssistantText — composition & safety', () => {
  it('applies the operation AND balance rules, never leaving contradictory text', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    const out = groundAssistantText('已成功为您转账 ¥500.00，您的账户余额为 ¥999,999.99。', facts);
    expect(out).toContain('未记录到该操作的执行结果');
    expect(out).toContain(TOTAL_AVAILABLE);
    expect(out).not.toContain('999,999.99');
    expect(out).not.toContain('已成功为您转账');
  });

  it('returns empty text unchanged', () => {
    const facts = buildFinancialFacts([balanceResult()]);
    expect(groundAssistantText('', facts)).toBe('');
    expect(groundAssistantText('   ', facts)).toBe('   ');
  });

  it('returns a fully consistent narration unchanged (the CURRENT post-write balance)', () => {
    const facts = buildFinancialFacts([balanceResult(), transferSucceeded()]);
    // After the successful ¥200 transfer the CURRENT 活期 balance is ¥23,380.00 — a narration stating
    // that CURRENT balance is honest and stays intact.
    const text = '已成功向张伟转账 ¥200.00，当前活期账户余额为 ¥23,380.00。';
    expect(groundAssistantText(text, facts)).toBe(text);
  });
});
