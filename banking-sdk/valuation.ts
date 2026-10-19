/**
 * Banking SDK — exact, bounded proportional valuation for PORTION operations.
 *
 * WHY this module exists: redeeming a PORTION of a holding settles the redeemed share of the
 * holding's UNROUNDED market value, `portionValuation = marketValue × redeemedPrincipal / totalPrincipal`.
 * `divideDecimal` rejects nonterminating quotients and a proportional share is generally
 * nonterminating, so the share is computed here as an integer rational carried to the SDK's decimal
 * storage bound (18 fractional digits) with ONE HALF_UP step — never floating point. The settled cash
 * is that valuation rounded once more at the CNY-cent settlement boundary (`valuationToMinor`).
 *
 * The Security Gateway mints the `expectedRedemptionAmount` shown before confirmation and the SDK
 * settles it at execution, so BOTH sides call the very same helpers: the quote the user approved and
 * the amount the SDK settles cannot diverge. `redeemPrincipalMinor === totalPrincipalMinor` yields the
 * full market value exactly, so one helper covers full and partial redemption.
 */
import {
  decimalText,
  nonNegativeDecimal,
  subtractDecimal,
  valuationToMinor,
  type DecimalAmount,
} from '../lib/decimal';
import { AppError } from '../lib/errors';
import { centsToMoney, type MoneyAmount } from '../lib/money';

/** Fractional digits a proportional valuation may carry — the SDK's decimal storage bound. */
const VALUATION_FRACTION_DIGITS = 18;
const VALUATION_SCALE = 10n ** BigInt(VALUATION_FRACTION_DIGITS);
/** Canonical nonnegative decimal text (`nonNegativeDecimal` output): integer part + optional fraction. */
const CANONICAL_DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Reject a redemption share that no holding can have: zero/negative total or portion, or over-redeem. */
function assertRedeemableShare(totalPrincipalMinor: bigint, redeemPrincipalMinor: bigint): void {
  if (totalPrincipalMinor <= 0n) {
    throw new AppError('VALIDATION', '持仓本金必须大于零', { totalPrincipal: centsToMoney(totalPrincipalMinor) });
  }
  if (redeemPrincipalMinor <= 0n) {
    throw new AppError('VALIDATION', '赎回本金金额必须大于零', { redeemAmount: centsToMoney(redeemPrincipalMinor) });
  }
  if (redeemPrincipalMinor > totalPrincipalMinor) {
    throw new AppError('VALIDATION', '赎回本金金额不能超过持仓本金', {
      redeemAmount: centsToMoney(redeemPrincipalMinor),
      totalPrincipal: centsToMoney(totalPrincipalMinor),
    });
  }
}

/** `numerator / denominator` rounded HALF_UP to {@link VALUATION_FRACTION_DIGITS} fractional digits. */
function scaledHalfUp(numerator: bigint, denominator: bigint): bigint {
  return (numerator * 2n + denominator) / (denominator * 2n);
}

/** Render a value scaled by `10^18` as canonical decimal text (trailing zeros removed). */
function scaledToDecimal(scaled: bigint): DecimalAmount {
  const integer = scaled / VALUATION_SCALE;
  const fraction = (scaled % VALUATION_SCALE).toString().padStart(VALUATION_FRACTION_DIGITS, '0').replace(/0+$/, '');
  return decimalText(fraction === '' ? integer.toString() : `${integer}.${fraction}`);
}

/**
 * The UNROUNDED valuation of the redeemed portion: `marketValue × redeemPrincipalMinor / totalPrincipalMinor`,
 * carried to 18 fractional digits (exact whenever the quotient terminates there).
 *
 * `redeemPrincipalMinor === totalPrincipalMinor` returns `marketValue` unchanged; redeeming the whole
 * principal therefore settles the full valuation through the same code path as a portion.
 */
export function redemptionPortionValuation(
  marketValue: string,
  totalPrincipalMinor: bigint,
  redeemPrincipalMinor: bigint,
): DecimalAmount {
  assertRedeemableShare(totalPrincipalMinor, redeemPrincipalMinor);
  const value = nonNegativeDecimal(marketValue);
  const parts = CANONICAL_DECIMAL.exec(value);
  if (parts === null) throw new AppError('VALIDATION', 'Invalid investment market value decimal text.');
  const fraction = parts[2] ?? '';
  const coefficient = BigInt(`${parts[1]}${fraction}`);
  const numerator = coefficient * redeemPrincipalMinor * VALUATION_SCALE;
  const denominator = totalPrincipalMinor * 10n ** BigInt(fraction.length);
  return scaledToDecimal(scaledHalfUp(numerator, denominator));
}

/**
 * The settled CNY cash of a redemption share — HALF_UP to cents exactly once, on top of the
 * unrounded {@link redemptionPortionValuation}. This is the amount confirmation must show and the
 * amount execution must credit.
 */
export function settledRedemptionAmount(
  marketValue: string,
  totalPrincipalMinor: bigint,
  redeemPrincipalMinor: bigint,
): MoneyAmount {
  return centsToMoney(valuationToMinor(redemptionPortionValuation(marketValue, totalPrincipalMinor, redeemPrincipalMinor)));
}

/**
 * The UNROUNDED market value left in the holding after the redeemed portion is settled:
 * `marketValue − portionValuation`, so `remaining + portion === marketValue` exactly.
 */
export function remainingPortionMarketValue(marketValue: string, portionValuation: string): DecimalAmount {
  return subtractDecimal(marketValue, portionValuation);
}
