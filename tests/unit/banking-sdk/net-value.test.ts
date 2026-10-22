/**
 * Unit: banking-sdk/net-value — the pure 「净值 + 份额」 arithmetic (no database, no IO, no clock).
 *
 * WHAT it pins down (`docs/cn/investments.md` is the authoritative contract):
 *   1. Purchase shares are FLOOR-ed at 6 fractional digits: a nonterminating quotient truncates and
 *      one more unit of share precision would exceed the paid amount (shares are never invented).
 *   2. Net value accepts exactly 4 fractional digits and shares exactly 6 — one digit beyond is
 *      rejected, as is malformed text.
 *   3. Settlement rounds HALF_UP to CNY cents EXACTLY ONCE, on the unrounded `shares × netValue`
 *      product (including the exact `.005` boundary).
 *   4. `marketValueFromShares` / `remainingSharesOf` are EXACT, so
 *      `marketValue(total) === marketValue(remaining) + marketValue(redeemed)` and
 *      `remaining + redeemed === total`.
 *   5. A proportional redemption consumes HALF_UP cents and leaves `cost − consumed`, so the two
 *      halves always add back up to the original cost; a full redemption returns the whole cost.
 *   6. Every invalid input throws `AppError('VALIDATION')` with a Chinese message.
 */
import { describe, expect, it } from 'vitest';
import {
  NET_VALUE_DECIMALS,
  REDEMPTION_FEE_RULE,
  SHARE_DECIMALS,
  floorToShares,
  marketValueFromShares,
  profitRateOf,
  redeemedCostMinor,
  remainingSharesOf,
  settlementFromShares,
  sharesFromAmount,
} from '@/banking-sdk/net-value';
import { addDecimal, compareDecimal, subtractDecimal, valuationToMinor } from '@/lib/decimal';
import { AppError } from '@/lib/errors';
import { centsToMoney } from '@/lib/money';

/** Run `run` and assert it threw a `VALIDATION` AppError with a Chinese message. */
function expectValidation(run: () => unknown): AppError {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AppError);
  const appError = caught as AppError;
  expect(appError.code).toBe('VALIDATION');
  expect(appError.message).toMatch(/[\u4e00-\u9fa5]/);
  return appError;
}

describe('net value and shares arithmetic', () => {
  it('exposes the documented precisions and the simulated fee rule', () => {
    expect(NET_VALUE_DECIMALS).toBe(4);
    expect(SHARE_DECIMALS).toBe(6);
    expect(REDEMPTION_FEE_RULE).toBe('SIMULATED_NONE');
  });

  it('floors purchase shares at 6 digits: 2000.00 at net value 1.0234 buys 1954.27008', () => {
    expect(sharesFromAmount('2000.00', '1.0234')).toBe('1954.27008');
    // The floored residual stays on the paid side: the exact product is 128 nanoyuan short of 2000.
    expect(marketValueFromShares('1954.27008', '1.0234')).toBe('1999.999999872');
    expect(compareDecimal(marketValueFromShares('1954.27008', '1.0234'), '2000')).toBe(-1);
    expect(sharesFromAmount('1000.00', '1.2345')).toBe('810.044552');
  });

  it('never rounds shares up: one more unit of share precision would exceed the paid amount', () => {
    expect(compareDecimal(marketValueFromShares('1954.270081', '1.0234'), '2000')).toBe(1);
    expect(compareDecimal(marketValueFromShares('810.044553', '1.2345'), '1000')).toBe(1);
  });

  it('floors a decimal to share precision toward minus infinity and never rounds up', () => {
    expect(floorToShares('1954.2700801')).toBe('1954.27008');
    expect(floorToShares('1954.27008')).toBe('1954.27008');
    expect(floorToShares('12.9999999')).toBe('12.999999');
    expect(floorToShares('-1.2345678')).toBe('-1.234568');
    expect(floorToShares('1.500000')).toBe('1.5');
    expect(floorToShares('0')).toBe('0');
  });

  it('accepts exact 4-dp net values and 6-dp shares and rejects one digit beyond', () => {
    expect(marketValueFromShares('1954.270080', '1.0234')).toBe('1999.999999872');
    expect(sharesFromAmount('1000.00', '1.2345')).toBe('810.044552');
    expectValidation(() => marketValueFromShares('1954.2700801', '1.0234')); // 7-dp shares
    expectValidation(() => marketValueFromShares('1.234567', '1.02345')); // 5-dp net value
    expectValidation(() => sharesFromAmount('1000.00', '1.02345'));
    expectValidation(() => sharesFromAmount('1000.001', '1.0234')); // money keeps at most 2 dp
  });

  it('keeps the market value of a 6-dp × 4-dp product exact, including 10 fractional digits', () => {
    expect(marketValueFromShares('1.234567', '1.2345')).toBe('1.5240729615');
    expect(marketValueFromShares('0.000001', '0.0001')).toBe('0.0000000001');
    expect(marketValueFromShares('100.000000', '1.2345')).toBe('123.45');
    expect(marketValueFromShares('1954.27008', '1.0234')).toBe('1999.999999872');
  });

  it('settles HALF_UP at the exact .005 boundary, rounding once', () => {
    // 2.500000 × 4.9380 = 12.345 exactly → 12.35
    expect(marketValueFromShares('2.500000', '4.9380')).toBe('12.345');
    expect(settlementFromShares('2.500000', '4.9380')).toBe('12.35');
    // Just below / above the boundary must not reach the same cent.
    expect(settlementFromShares('2.500000', '4.9379')).toBe('12.34');
    expect(settlementFromShares('2.500000', '4.9381')).toBe('12.35');
    // 1999.999999872 settles UP to 2000.00: the unrounded product is rounded once, not twice.
    expect(settlementFromShares('1954.27008', '1.0234')).toBe('2000.00');
    expect(settlementFromShares('0.000001', '0.0001')).toBe('0.00');
  });

  it('rounds exactly once: settlement equals valuationToMinor of the exact market value', () => {
    const cases: Array<[string, string]> = [
      ['1954.27008', '1.0234'],
      ['33.333333', '1.2345'],
      ['2.500000', '4.9380'],
      ['0.000001', '0.0001'],
      ['100.000000', '12.3450'],
      ['7.777777', '0.9876'],
    ];
    for (const [shares, netValue] of cases) {
      const marketValue = marketValueFromShares(shares, netValue);
      const settled = settlementFromShares(shares, netValue);
      // The settled cash IS the unrounded product rounded once at the cent boundary…
      expect(settled).toBe(centsToMoney(valuationToMinor(marketValue)));
      // Settlement drifts at most half a cent from the exact value — proof of a single rounding step.
      const drift = subtractDecimal(settled, marketValue);
      const magnitude = drift.startsWith('-') ? drift.slice(1) : drift;
      expect(compareDecimal(magnitude, '0.005')).not.toBe(1);
    }
  });

  it('keeps market value additive over a partial redemption', () => {
    const total = '100.000000';
    const redeemed = '33.333333';
    const netValue = '1.2345';
    const remaining = remainingSharesOf(total, redeemed);
    expect(remaining).toBe('66.666667');
    expect(addDecimal(remaining, redeemed)).toBe('100');
    expect(marketValueFromShares(remaining, netValue)).toBe('82.3000004115');
    expect(marketValueFromShares(redeemed, netValue)).toBe('41.1499995885');
    expect(addDecimal(marketValueFromShares(remaining, netValue), marketValueFromShares(redeemed, netValue)))
      .toBe(marketValueFromShares(total, netValue));
  });

  it('splits cost proportionally and returns the whole cost on a full redemption', () => {
    // 1/3 of the shares consumes 1/3 of the booked cost, HALF_UP to the cent.
    expect(redeemedCostMinor(99999n, '33.333333', '100.000000')).toBe(33333n);
    expect(99999n - redeemedCostMinor(99999n, '33.333333', '100.000000')).toBe(66666n);
    // Full redemption returns exactly the whole cost.
    expect(redeemedCostMinor(123456n, '100.000000', '100.000000')).toBe(123456n);
    // Exact .5 boundaries round HALF_UP away from zero.
    expect(redeemedCostMinor(3n, '50.000000', '100.000000')).toBe(2n);
    expect(redeemedCostMinor(1n, '50.000000', '100.000000')).toBe(1n);
    expect(redeemedCostMinor(0n, '50.000000', '100.000000')).toBe(0n);
  });

  it('reports profit over cost as a dimensionless ratio and leaves a zero cost undefined', () => {
    expect(profitRateOf('23.45', '1000.00')).toBe('0.02345');
    expect(profitRateOf('-23.45', '1000.00')).toBe('-0.02345');
    expect(profitRateOf('0', '1000.00')).toBe('0');
    // A nonterminating quotient is carried to the decimal bound, never rejected or floated.
    expect(profitRateOf('1.00', '3.00')).toBe('0.333333333333333333');
    expect(profitRateOf('-1.00', '3.00')).toBe('-0.333333333333333333');
    expect(profitRateOf('23.45', '0.00')).toBeUndefined();
    expect(profitRateOf('23.45', '0')).toBeUndefined();
  });

  const invalidInputs: Array<[string, () => unknown]> = [
    ['a zero net value', () => sharesFromAmount('100.00', '0')],
    ['a zero net value with cents', () => marketValueFromShares('1.000000', '0.0000')],
    ['a negative net value', () => marketValueFromShares('1.000000', '-1.0234')],
    ['negative shares', () => marketValueFromShares('-1.000000', '1.0234')],
    ['zero shares', () => marketValueFromShares('0.000000', '1.0234')],
    ['zero settlement shares', () => settlementFromShares('0', '1.0234')],
    ['a negative amount', () => sharesFromAmount('-100.00', '1.0234')],
    ['a dust amount that converts to zero shares', () => sharesFromAmount('0.01', '10000.0001')],
    ['a zero amount', () => sharesFromAmount('0.00', '1.0234')],
    ['a malformed net value', () => sharesFromAmount('100.00', 'abc')],
    ['an exponent net value', () => marketValueFromShares('1.000000', '1e-3')],
    ['a currency-suffixed net value', () => marketValueFromShares('1.000000', '¥1.0234')],
    ['an empty net value', () => marketValueFromShares('1.000000', '')],
    ['a malformed share count', () => settlementFromShares('1,000.5', '1.0234')],
    ['an empty decimal', () => floorToShares('')],
    ['an over-redeem', () => remainingSharesOf('10.000000', '10.000001')],
    ['an over-redeem of cost', () => redeemedCostMinor(100n, '10.000001', '10.000000')],
    ['zero total shares', () => remainingSharesOf('0.000000', '0.000000')],
    ['zero total shares for cost', () => redeemedCostMinor(100n, '0.000000', '0.000000')],
    ['zero redeemed shares', () => redeemedCostMinor(100n, '0', '10.000000')],
    ['a negative cost', () => redeemedCostMinor(-1n, '1.000000', '10.000000')],
    ['a negative cost for the rate', () => profitRateOf('1.00', '-1.00')],
  ];

  it.each(invalidInputs)('rejects %s with a Chinese VALIDATION error', (_label, run) => {
    expectValidation(run);
  });
});
