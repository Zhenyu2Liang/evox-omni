/**
 * `redeem_investment` — the server-owned 赎回口径 (`mode`) contract.
 *
 * A redemption always states its 口径: `SHARES` (redeem a share count), `AMOUNT` (redeem a CNY
 * amount, converted to shares at the published net value) or `ALL` (close the position). There is no
 * default 口径 and no 「赎回本金 + 额外收益」 interpretation, so a request that only carries an amount —
 * e.g. the user saying "赎回 2000" — is refused with a clarification instead of being read as a
 * principal. That decision lives in the TOOL layer, before any SDK call.
 *
 * Pure unit spec (no database): the SDK is partially mocked so parameter forwarding, the口径 guards
 * and the model-facing summaries can be asserted in isolation. The plan-parameter validator is the
 * REAL one, so schema acceptance/rejection is exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const investment = vi.hoisted(() => ({
  redeemInvestment: vi.fn(),
  subscribeInvestment: vi.fn(),
  listHoldings: vi.fn(),
}));

vi.mock('@/banking-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/banking-sdk')>();
  return {
    ...actual,
    banking: {
      ...actual.banking,
      investment: {
        ...actual.banking.investment,
        redeemInvestment: investment.redeemInvestment,
        subscribeInvestment: investment.subscribeInvestment,
        listHoldings: investment.listHoldings,
      },
    },
  };
});

import {
  RedeemInvestmentParams,
  createRedeemInvestmentTool,
  runGetInvestmentHoldings,
  runRedeemInvestment,
  runSubscribeInvestment,
} from '@/agent/tools/investment';
import { validateBankingParameters } from '@/agent/tools/plan-parameters';
import { AGENT_TOOL_NAMES } from '@/lib/contracts/tool-catalog';
import { AppError } from '@/lib/errors';

/** The server contract's clarification — there is no default 口径, so this must be asked. */
const CLARIFY = '赎回需要明确口径：请确认按「份额」还是按「金额」赎回';
/** Every simulated profit figure carries this notice. */
const SIMULATED_NOTICE = '收益为模拟估算，不承诺保本。';
/** A fact the recorded data cannot support is named, never invented. */
const INSUFFICIENT = '历史数据不足';

/** A complete SHARES-mode SDK redemption snapshot — every financial value is exact decimal text. */
const REDEEMED = {
  success: true,
  holdingId: 'holding_1',
  productId: 'product_1',
  amount: '1000.00',
  newBalance: '5000.00',
  sourceAccountId: 'account_1',
  occurredAt: 1_700_000_000_000,
  mode: 'SHARES',
  redeemedShares: '1000',
  remainingShares: '4000',
  netValuePerUnit: '0.988',
  // 2023-11-14T22:13:20Z → 2023-11-15 in the UTC+08:00 business calendar.
  netValueDate: 1_700_000_000_000,
  feeAmount: '0.00',
  feeRule: 'SIMULATED_NONE',
  realizedProfit: '-12.00',
  remainingCost: '4000.00',
  partial: true,
};

describe('redeem_investment — required 赎回口径', () => {
  beforeEach(() => vi.resetAllMocks());

  it('is an agent-visible capability that publishes mode as REQUIRED and no retired principal field', () => {
    expect(AGENT_TOOL_NAMES).toContain('redeem_investment');
    expect(createRedeemInvestmentTool('owner').name).toBe('redeem_investment');

    expect(Object.keys(RedeemInvestmentParams.properties).sort()).toEqual([
      'amount', 'expectedNetValue', 'expectedNetValueDate', 'expectedSettlementAmount', 'expectedShares',
      'holdingId', 'mode', 'shares',
    ]);
    const required = (RedeemInvestmentParams as { required?: string[] }).required ?? [];
    expect([...required].sort()).toEqual(['holdingId', 'mode']);
    // The principal口径 is gone: a redemption states shares or an amount, never 「赎回本金」.
    expect(Object.keys(RedeemInvestmentParams.properties)).not.toContain('redeemAmount');
    expect(Object.keys(RedeemInvestmentParams.properties)).not.toContain('expectedRedemptionAmount');
  });

  it('accepts each explicit 口径 and the confirmed snapshot through the real plan validator', () => {
    for (const args of [
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1000.000000' },
      { holdingId: 'holding_1', mode: 'AMOUNT', amount: '2000.00' },
      { holdingId: 'holding_1', mode: 'ALL' },
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1000', expectedShares: '1000',
        expectedNetValue: '0.9880', expectedNetValueDate: 1_700_000_000_000, expectedSettlementAmount: '988.00' },
    ]) {
      expect(() => validateBankingParameters('redeem_investment', args, 'call')).not.toThrow();
    }
  });

  it('rejects a call with no 口径 and the retired redeemAmount / expectedRedemptionAmount', () => {
    for (const args of [
      { holdingId: 'holding_1' },
      { holdingId: 'holding_1', amount: '2000.00' },
      { holdingId: 'holding_1', mode: 'PRINCIPAL' },
      { holdingId: 'holding_1', redeemAmount: '2000.00' },
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1000', redeemAmount: '2000.00' },
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1000', expectedRedemptionAmount: '2000.00' },
    ]) {
      expect(() => validateBankingParameters('redeem_investment', args, 'call')).toThrow(AppError);
    }
  });

  it('rejects over-precise, signed or numeric share counts and net values without coercion', () => {
    for (const args of [
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1.0000001' },     // 7 fractional digits
      { holdingId: 'holding_1', mode: 'SHARES', shares: '-1' },
      { holdingId: 'holding_1', mode: 'SHARES', shares: 1 },
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1e3' },
      { holdingId: 'holding_1', mode: 'ALL', expectedNetValue: '0.98765' }, // 5 fractional digits
      { holdingId: 'holding_1', mode: 'ALL', expectedNetValue: '-0.988' },
      { holdingId: 'holding_1', mode: 'AMOUNT', amount: '2000.000' },
    ]) {
      expect(() => validateBankingParameters('redeem_investment', args, 'call')).toThrow(AppError);
    }
  });

  it('asks the caller to state the 口径 instead of reading an amount as a principal', async () => {
    // "赎回 2000" names an amount, not a口径 — the tool must not settle it as a principal payout
    // plus an extra profit payment.
    for (const args of [{ holdingId: 'holding_1' }, { holdingId: 'holding_1', amount: '2000.00' }]) {
      const result = await runRedeemInvestment('owner', args, { idempotencyKey: 'run-key' });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('VALIDATION');
      expect(result.error).toContain(CLARIFY);
    }
    expect(investment.redeemInvestment).not.toHaveBeenCalled();
  });

  it('refuses the retired redeemAmount before the SDK is reached', async () => {
    const result = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', redeemAmount: '2000.00' }, { idempotencyKey: 'run-key' });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION');
    expect(result.error).toContain(CLARIFY);
    expect(investment.redeemInvestment).not.toHaveBeenCalled();
  });

  it('refuses a 口径 whose own input is missing or mixed with another', async () => {
    for (const args of [
      { holdingId: 'holding_1', mode: 'SHARES' },                                  // no shares
      { holdingId: 'holding_1', mode: 'AMOUNT' },                                  // no amount
      { holdingId: 'holding_1', mode: 'ALL', shares: '1000' },                     // ALL accepts neither
      { holdingId: 'holding_1', mode: 'ALL', amount: '1000.00' },
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1000', amount: '1000.00' }, // mixed
      { holdingId: 'holding_1', mode: 'AMOUNT', amount: '1000.00', shares: '1000' },
      { holdingId: 'holding_1', mode: 'SHARES', shares: '0' },                     // nothing to redeem
      { holdingId: 'holding_1', mode: 'AMOUNT', amount: '0.00' },
    ]) {
      const result = await runRedeemInvestment('owner', args, { idempotencyKey: 'run-key' });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('VALIDATION');
    }
    expect(investment.redeemInvestment).not.toHaveBeenCalled();
  });

  it('refuses over-precise share and net value text before the SDK too', async () => {
    const shares = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1.0000001' }, { idempotencyKey: 'run-key' });
    expect(shares.errorCode).toBe('VALIDATION');
    expect(shares.error).toContain('份额最多允许 6 位小数');

    const netValue = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'ALL', expectedNetValue: '0.98765' }, { idempotencyKey: 'run-key' });
    expect(netValue.errorCode).toBe('VALIDATION');
    expect(netValue.error).toContain('净值最多允许 4 位小数');

    expect(investment.redeemInvestment).not.toHaveBeenCalled();
  });

  it('settles a SHARES redemption, forwarding the 口径 and its canonical share count', async () => {
    investment.redeemInvestment.mockResolvedValue(REDEEMED);
    const result = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'SHARES', shares: '1000.000000' }, { idempotencyKey: 'run-key' });

    const forwarded = investment.redeemInvestment.mock.calls[0][0] as Record<string, unknown>;
    expect(forwarded).toEqual({
      userId: 'owner', holdingId: 'holding_1', mode: 'SHARES', shares: '1000', idempotencyKey: 'run-key',
    });
    // No retired principal field and no amount leak into a share-count redemption.
    expect(Object.keys(forwarded).sort()).toEqual(['holdingId', 'idempotencyKey', 'mode', 'shares', 'userId']);

    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      '已按份额赎回持仓 holding_1；赎回份额 1000 份；成交净值 0.9880 元/份（净值日期 2023-11-15）；'
      + '预计到账 ¥1,000.00；费用口径 SIMULATED_NONE（模拟环境不收取赎回费，赎回费 ¥0.00）；'
      + '剩余份额 4000 份；剩余成本 ¥4,000.00；已实现收益 -¥12.00；账户余额 ¥5,000.00。'
      + SIMULATED_NOTICE,
    );
  });

  it('settles an AMOUNT redemption, forwarding canonical exact CNY text', async () => {
    investment.redeemInvestment.mockResolvedValue({ ...REDEEMED, mode: 'AMOUNT' });
    const result = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'AMOUNT', amount: '2000' }, { idempotencyKey: 'run-key' });

    expect(investment.redeemInvestment).toHaveBeenCalledWith({
      userId: 'owner', holdingId: 'holding_1', mode: 'AMOUNT', amount: '2000.00', idempotencyKey: 'run-key',
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('已按金额赎回持仓 holding_1');
    expect(result.summary).toContain('赎回份额 1000 份');
    expect(result.summary).toContain('成交净值 0.9880 元/份');
  });

  it('settles an ALL redemption and reports the closed holding without a share or amount argument', async () => {
    investment.redeemInvestment.mockResolvedValue({
      ...REDEEMED, mode: 'ALL', redeemedShares: '5000', remainingShares: '0', remainingCost: '0.00',
    });
    const result = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'ALL' }, { idempotencyKey: 'run-key' });

    expect(investment.redeemInvestment).toHaveBeenCalledWith({
      userId: 'owner', holdingId: 'holding_1', mode: 'ALL', idempotencyKey: 'run-key',
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('已全部赎回持仓 holding_1');
    expect(result.summary).toContain('剩余份额 0 份（持仓已结清）');
    expect(result.summary).toContain('剩余成本 ¥0.00');
  });

  it('canonicalizes the confirmed snapshot to the SDK storage text and forwards the net value date', async () => {
    investment.redeemInvestment.mockResolvedValue(REDEEMED);
    await runRedeemInvestment('owner', {
      holdingId: 'holding_1', mode: 'SHARES', shares: '5050.000000',
      expectedShares: '5050.000000', expectedNetValue: '0.9880',
      expectedNetValueDate: 1_700_000_000_000, expectedSettlementAmount: '4989.4',
    }, { idempotencyKey: 'run-key' });

    // The SDK's storage readers require canonical text (`'5050.000000'` / `'0.9880'` would be
    // rejected as malformed), so the tool normalizes before the write.
    expect(investment.redeemInvestment).toHaveBeenCalledWith({
      userId: 'owner', holdingId: 'holding_1', mode: 'SHARES', shares: '5050',
      expectedShares: '5050', expectedNetValue: '0.988', expectedNetValueDate: 1_700_000_000_000,
      expectedSettlementAmount: '4989.40', idempotencyKey: 'run-key',
    });
  });

  it('rejects a snapshot net value date that is not an integer epoch millisecond', async () => {
    const result = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'ALL', expectedNetValueDate: 1.5 }, { idempotencyKey: 'run-key' });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('VALIDATION');
    expect(result.error).toContain('epoch');
    expect(investment.redeemInvestment).not.toHaveBeenCalled();
  });

  it('keeps a typed SDK refusal model-visible instead of a fabricated success', async () => {
    investment.redeemInvestment.mockRejectedValue(new AppError('CONFLICT', '可赎回份额不足。'));
    const result = await runRedeemInvestment('owner',
      { holdingId: 'holding_1', mode: 'SHARES', shares: '999999' }, { idempotencyKey: 'run-key' });

    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('CONFLICT');
    expect(result.error).toBe('可赎回份额不足。');
  });

  it('reports the seven holding facts and names a legacy record as 历史数据不足', async () => {
    investment.listHoldings.mockResolvedValue([
      {
        id: 'holding_1', productId: 'product_1', productName: '稳健理财', riskLevel: 'R2', amount: '5000.00',
        shares: '5000', latestNetValue: '0.988', latestNetValueDate: 1_700_000_000_000,
        marketValue: '4940', profit: '-60', profitRate: '-0.012', realizedProfit: '0', cumulativeProfit: '-60',
        valueBasis: 'NET_VALUE',
      },
      // A migrated record with no usable shares or net value: no number may be invented for it.
      { id: 'holding_2', productId: 'product_2', productName: '旧持仓', riskLevel: 'R1', amount: '100.00',
        valueBasis: 'HISTORICAL_DATA_INSUFFICIENT' },
    ]);

    const result = await runGetInvestmentHoldings('owner', {});
    for (const fact of ['持仓份额 5000 份', '最新净值 0.9880 元/份（净值日期 2023-11-15）', '持仓市值 ¥4,940.00',
      '剩余持仓成本 ¥5,000.00', '持仓收益 -¥60.00', '持仓收益率 -1.20%', '累计收益 -¥60.00']) {
      expect(result.summary).toContain(fact);
    }
    // The unvaluable holding states the gap instead of a fabricated share count, value or return.
    expect(result.summary).toContain(`最新净值 ${INSUFFICIENT}`);
    expect(result.summary).toContain(`持仓市值 ${INSUFFICIENT}`);
    expect(result.summary).toContain('持仓份额 ' + INSUFFICIENT);
    expect(result.summary).toContain('剩余持仓成本 ¥100.00');
    expect(result.summary).toContain(SIMULATED_NOTICE);
  });

  it('reports the subscribed shares and the executed net value of a subscription', async () => {
    investment.subscribeInvestment.mockResolvedValue({
      success: true, holdingId: 'holding_1', productId: 'product_1', amount: '1000.00', newBalance: '4000.00',
      sourceAccountId: 'account_1', occurredAt: 1_700_000_000_000, subscribedShares: '1012.145748',
      totalShares: '1012.145748',
    });
    investment.listHoldings.mockResolvedValue([{
      id: 'holding_1', productId: 'product_1', productName: '稳健理财', riskLevel: 'R2', amount: '1000.00',
      shares: '1012.145748', latestNetValue: '0.988', latestNetValueDate: 1_700_000_000_000,
      marketValue: '1000', profit: '0', profitRate: '0', cumulativeProfit: '0', valueBasis: 'NET_VALUE',
      purchases: [{ amount: '1000.00', at: 1_700_000_000_000, totalPrincipal: '1000.00', marketValue: '1000',
        shares: '1012.145748', netValuePerUnit: '0.988', netValueDate: 1_700_000_000_000, newBalance: '4000.00',
        sourceAccountId: 'account_1' }],
    }]);

    const result = await runSubscribeInvestment('owner',
      { productId: 'product_1', amount: '1000.00' }, { idempotencyKey: 'run-key' });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('申购份额 1012.145748 份');
    expect(result.summary).toContain('成交净值 0.9880 元/份（净值日期 2023-11-15）');
    expect(result.summary).toContain('持仓总份额 1012.145748 份');
    expect(result.summary).toContain(SIMULATED_NOTICE);
  });

  it('never invents a subscription net value when the purchase record cannot be read', async () => {
    investment.subscribeInvestment.mockResolvedValue({
      success: true, holdingId: 'holding_1', productId: 'product_1', amount: '1000.00', newBalance: '4000.00',
      sourceAccountId: 'account_1', occurredAt: 1_700_000_000_000, subscribedShares: '1012.145748',
    });
    investment.listHoldings.mockRejectedValue(new AppError('TOOL_FAILED', 'read failed'));

    // The purchase is already committed, so an unreadable record must not turn it into a failure.
    const result = await runSubscribeInvestment('owner',
      { productId: 'product_1', amount: '1000.00' }, { idempotencyKey: 'run-key' });

    expect(result.ok).toBe(true);
    expect(result.summary).toContain('申购份额 1012.145748 份');
    expect(result.summary).toContain(`成交净值 ${INSUFFICIENT}`);
  });
});
