/**
 * `redeem_investment` — optional PARTIAL principal redemption wiring.
 *
 * Pure unit spec (no database): the SDK is partially mocked so the runner's parameter forwarding and
 * its model-facing summary can be asserted in isolation. The plan-parameter validator is the REAL
 * one, so schema acceptance/rejection of `redeemAmount` is exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redeem = vi.hoisted(() => ({ redeemInvestment: vi.fn() }));

vi.mock('@/banking-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/banking-sdk')>();
  return {
    ...actual,
    banking: {
      ...actual.banking,
      investment: { ...actual.banking.investment, redeemInvestment: redeem.redeemInvestment },
    },
  };
});

import { RedeemInvestmentParams, runRedeemInvestment } from '@/agent/tools/investment';
import { validateBankingParameters } from '@/agent/tools/plan-parameters';
import { AppError } from '@/lib/errors';

describe('redeem_investment — optional partial principal', () => {
  beforeEach(() => vi.resetAllMocks());

  it('declares an OPTIONAL redeemAmount while holdingId stays required', () => {
    expect(Object.keys(RedeemInvestmentParams.properties)).toContain('redeemAmount');
    const required = (RedeemInvestmentParams as { required?: string[] }).required ?? [];
    expect(required).toContain('holdingId');
    expect(required).not.toContain('redeemAmount');
  });

  it('accepts a well-formed principal portion and omission through the real plan validator', () => {
    expect(() => validateBankingParameters('redeem_investment', { holdingId: 'h' }, 'call')).not.toThrow();
    expect(() => validateBankingParameters('redeem_investment', { holdingId: 'h', redeemAmount: '100.00' }, 'call')).not.toThrow();
  });

  it('rejects a malformed or non-string principal portion without coercion', () => {
    for (const redeemAmount of ['1.001', 'abc', '-5', 100]) {
      expect(() =>
        validateBankingParameters('redeem_investment', { holdingId: 'h', redeemAmount } as Record<string, unknown>, 'call'),
      ).toThrow(AppError);
    }
  });

  it('forwards a partial principal portion and reports the remaining holding', async () => {
    redeem.redeemInvestment.mockResolvedValue({
      success: true,
      holdingId: 'holding_x',
      productId: 'prod_x',
      amount: '50.50',
      newBalance: '1000.00',
      partial: true,
      redeemedPrincipal: '50.00',
      remainingPrincipal: '50.00',
    });
    const result = await runRedeemInvestment('owner', { holdingId: 'holding_x', redeemAmount: '50.00' });

    expect(redeem.redeemInvestment).toHaveBeenCalledWith({
      userId: 'owner',
      holdingId: 'holding_x',
      redeemAmount: '50.00',
      expectedRedemptionAmount: undefined,
      idempotencyKey: undefined,
    });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('部分赎回');
    expect(result.summary).toContain('¥50.00'); // redeemed principal
    expect(result.summary).toContain('¥50.50'); // settled amount
    expect(result.summary).toContain('剩余本金');
  });

  it('omits the principal portion and keeps full-redemption wording otherwise', async () => {
    redeem.redeemInvestment.mockResolvedValue({
      success: true,
      holdingId: 'holding_x',
      productId: 'prod_x',
      amount: '5050.00',
      newBalance: '28630.00',
    });
    const result = await runRedeemInvestment('owner', { holdingId: 'holding_x' });

    expect(redeem.redeemInvestment).toHaveBeenCalledWith(
      expect.objectContaining({ holdingId: 'holding_x', redeemAmount: undefined }),
    );
    expect(result.ok).toBe(true);
    expect(result.summary).toContain('已赎回持仓 holding_x');
    expect(result.summary).not.toContain('部分赎回');
  });
});
