/**
 * Banking SDK — the 「净值 + 份额」 holding model (see `docs/cn/investments.md`).
 *
 * WHY this module exists: an investment position is booked as SHARES × NET VALUE PER UNIT, not as a
 * principal amount. Purchase derives shares by FLOOR-ing the paid amount over the net value, so a buy
 * can never mint shares it did not pay for. Redemption derives the settled cash from
 * shares × net value with ONE HALF_UP step at the CNY-cent boundary (never a re-rounded
 * intermediate), and the proportional cost consumes HALF_UP cents while the untouched remainder is
 * `cost − consumed`, so `consumed + remaining === cost` BY CONSTRUCTION.
 *
 * Every amount is canonical decimal TEXT or a BigInt of minor units: no `Number`, no floating point,
 * no new dependency. BigInt fixed point carries the scale, and the three named boundaries — share
 * FLOOR, settlement cent round, proportional cost cent round — are the ONLY rounding points.
 * `marketValueFromShares` and `remainingSharesOf` are EXACT, which is what keeps
 * `marketValue(total) === marketValue(remaining) + marketValue(redeemed)` and
 * `remainingShares + redeemedShares === totalShares` true.
 *
 * This module is pure (no database, no clock, no IO): the Security Gateway quote and the SDK
 * execution must both call these helpers so the approved amount and the settled amount cannot
 * diverge.
 */
import {
  decimalText,
  multiplyDecimal,
  subtractDecimal,
  valuationToMinor,
  type DecimalAmount,
} from '../lib/decimal';
import { AppError } from '../lib/errors';
import { assertMinorUnits, centsToMoney, moneyToCents, type MoneyAmount } from '../lib/money';

/** Fractional digits of the net value per unit — the smallest net value step is `0.0001`. */
export const NET_VALUE_DECIMALS = 4;
/** Fractional digits of a share count. */
export const SHARE_DECIMALS = 6;
/** Redemption fees are waived by simulation rule; the contract only keeps the field. */
export const REDEMPTION_FEE_RULE = 'SIMULATED_NONE';

/** Fractional digits of a dimensionless ratio — the SDK's decimal storage bound (see `./valuation`). */
const RATIO_FRACTION_DIGITS = 18;
const RATIO_SCALE = 10n ** BigInt(RATIO_FRACTION_DIGITS);
const SHARE_SCALE = 10n ** BigInt(SHARE_DECIMALS);
/** CNY minor units per unit: booked money is BigInt cents. */
const CNY_SCALE = 100n;
/** Plain unsigned/signed decimal text: no exponent, no currency symbol, no whitespace, no `+`. */
const PLAIN_DECIMAL = /^-?\d+(?:\.\d+)?$/;

/** An exact `coefficient / 10^scale` fixed-point value. */
interface Fixed {
  coefficient: bigint;
  scale: number;
}

/**
 * Parse bounded decimal text into BigInt fixed point, rejecting anything the shared decimal contract
 * cannot represent. The sign is PRESERVED so each caller can report its own domain-specific error.
 */
function parseFixed(input: string, label: string, maxFractionDigits: number): Fixed {
  if (typeof input !== 'string') throw new AppError('VALIDATION', `${label}必须以十进制文本给出`);
  if (!PLAIN_DECIMAL.test(input)) {
    throw new AppError('VALIDATION', `${label}必须是不含指数、货币符号或空白的十进制文本`, { value: input });
  }
  let canonical: DecimalAmount;
  try {
    canonical = decimalText(input);
  } catch {
    throw new AppError('VALIDATION', `${label}超出支持的十进制范围`, { value: input });
  }
  const negative = canonical.startsWith('-');
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [integer, fraction = ''] = unsigned.split('.');
  if (fraction.length > maxFractionDigits) {
    throw new AppError('VALIDATION', `${label}最多允许 ${maxFractionDigits} 位小数`, { value: input, maxFractionDigits });
  }
  const magnitude = BigInt(`${integer}${fraction}`);
  return { coefficient: negative ? -magnitude : magnitude, scale: fraction.length };
}

/** A net value per unit: positive, at most {@link NET_VALUE_DECIMALS} fractional digits. */
function parseNetValue(netValue: DecimalAmount): Fixed {
  const fixed = parseFixed(netValue, '净值', NET_VALUE_DECIMALS);
  if (fixed.coefficient <= 0n) throw new AppError('VALIDATION', '净值必须大于零', { netValue });
  return fixed;
}

/** A share count: positive (a holding or a redemption of zero shares has nothing to value). */
function parsePositiveShares(shares: DecimalAmount, label: string): Fixed {
  const fixed = parseFixed(shares, label, SHARE_DECIMALS);
  if (fixed.coefficient <= 0n) throw new AppError('VALIDATION', `${label}必须大于零`, { shares });
  return fixed;
}

/** Booked CNY: non-negative, at most two fractional digits, inside the signed 64-bit money range. */
function parseMoneyMinor(amount: MoneyAmount, label: string): bigint {
  let minor: bigint;
  try {
    minor = moneyToCents(amount);
  } catch {
    throw new AppError('VALIDATION', `${label}不是合法的金额文本`, { value: amount });
  }
  if (minor < 0n) throw new AppError('VALIDATION', `${label}不能为负`, { value: amount });
  return minor;
}

/** Render `coefficient / 10^scale` as canonical decimal text (no trailing zeros, no exponent). */
function fixedToDecimal(coefficient: bigint, scale: number): DecimalAmount {
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  const divisor = 10n ** BigInt(scale);
  const integer = absolute / divisor;
  const fraction = (absolute % divisor).toString().padStart(scale, '0').replace(/0+$/, '');
  return decimalText(`${negative ? '-' : ''}${fraction === '' ? integer.toString() : `${integer}.${fraction}`}`);
}

/** Mathematical FLOOR of `numerator / denominator` (denominator positive): truncation minus one for negatives. */
function floorDivide(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return numerator % denominator < 0n ? quotient - 1n : quotient;
}

/** `numerator / denominator` rounded HALF_UP, i.e. away from zero at the exact `.5` boundary. */
function halfUpDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new AppError('VALIDATION', '除法的分母不能为零');
  const negative = (numerator < 0n) !== (denominator < 0n);
  const absoluteNumerator = numerator < 0n ? -numerator : numerator;
  const absoluteDenominator = denominator < 0n ? -denominator : denominator;
  const rounded = (absoluteNumerator * 2n + absoluteDenominator) / (absoluteDenominator * 2n);
  return negative ? -rounded : rounded;
}

/** Reject redeeming more shares than the holding owns, compared exactly across scales. */
function assertRedeemedWithinTotal(redeemed: Fixed, total: Fixed): void {
  const scale = Math.max(redeemed.scale, total.scale);
  const redeemedAligned = redeemed.coefficient * 10n ** BigInt(scale - redeemed.scale);
  const totalAligned = total.coefficient * 10n ** BigInt(scale - total.scale);
  if (redeemedAligned > totalAligned) {
    throw new AppError('VALIDATION', '赎回份额不能超过持有份额', {
      redeemedShares: fixedToDecimal(redeemed.coefficient, redeemed.scale),
      totalShares: fixedToDecimal(total.coefficient, total.scale),
    });
  }
}

/**
 * FLOOR a decimal amount to {@link SHARE_DECIMALS} fractional digits — truncation toward minus
 * infinity, so a negative value is floored DOWN, never toward zero. Never rounds up.
 */
export function floorToShares(value: DecimalAmount): DecimalAmount {
  const fixed = parseFixed(value, '待取整的份额小数', RATIO_FRACTION_DIGITS);
  if (fixed.scale <= SHARE_DECIMALS) return fixedToDecimal(fixed.coefficient, fixed.scale);
  const divisor = 10n ** BigInt(fixed.scale - SHARE_DECIMALS);
  return fixedToDecimal(floorDivide(fixed.coefficient, divisor), SHARE_DECIMALS);
}

/**
 * `shares = FLOOR(amount / netValue, 6 fractional digits)` — the shares a purchase of `amount` buys.
 *
 * The floored residual is smaller than one share unit, so the exact market value of the returned
 * shares never exceeds the paid amount: the position opens at roughly `0.00` profit.
 * A dust amount whose share count floors to zero is rejected instead of silently becoming a
 * zero-share redemption (see 「赎回口径」 in `docs/cn/investments.md`).
 */
export function sharesFromAmount(amount: MoneyAmount, netValue: DecimalAmount): DecimalAmount {
  const amountMinor = parseMoneyMinor(amount, '申购金额');
  const net = parseNetValue(netValue);
  const numerator = amountMinor * 10n ** BigInt(net.scale) * SHARE_SCALE;
  const denominator = CNY_SCALE * net.coefficient;
  const coefficient = floorDivide(numerator, denominator);
  if (coefficient === 0n) throw new AppError('VALIDATION', '折算份额为零', { amount, netValue });
  return fixedToDecimal(coefficient, SHARE_DECIMALS);
}

/**
 * The UNROUNDED market value of a position: `shares × netValue`, the exact product (a 6-dp share
 * count times a 4-dp net value yields up to 10 fractional digits, which canonical text keeps).
 * Exactness is what makes `marketValue(total) === marketValue(remaining) + marketValue(redeemed)`.
 */
export function marketValueFromShares(shares: DecimalAmount, netValue: DecimalAmount): DecimalAmount {
  parsePositiveShares(shares, '份额');
  parseNetValue(netValue);
  try {
    return multiplyDecimal(shares, netValue);
  } catch {
    throw new AppError('VALIDATION', '持仓市值超出支持的十进制范围', { shares, netValue });
  }
}

/**
 * The settled CNY cash of redeeming `shares`: HALF_UP of `shares × netValue` to cents, rounded
 * EXACTLY ONCE — the unrounded market value is never rounded before settlement.
 */
export function settlementFromShares(shares: DecimalAmount, netValue: DecimalAmount): MoneyAmount {
  return centsToMoney(valuationToMinor(marketValueFromShares(shares, netValue)));
}

/**
 * The booked cost consumed by redeeming `redeemedShares` out of `totalShares`:
 * `HALF_UP(costMinor × redeemedShares / totalShares, 1 cent)`.
 *
 * Returns plain minor units, so the caller derives the remaining cost as
 * `costMinor − redeemedCostMinor(...)` and `consumed + remaining === costMinor` holds by
 * construction — the two halves can never drift apart across redemptions.
 */
export function redeemedCostMinor(
  costMinor: bigint,
  redeemedShares: DecimalAmount,
  totalShares: DecimalAmount,
): bigint {
  if (typeof costMinor !== 'bigint') throw new AppError('VALIDATION', '持仓成本必须以整数分给出');
  if (costMinor < 0n) throw new AppError('VALIDATION', '持仓成本不能为负', { costMinor: costMinor.toString() });
  const total = parsePositiveShares(totalShares, '总份额');
  const redeemed = parsePositiveShares(redeemedShares, '赎回份额');
  assertRedeemedWithinTotal(redeemed, total);
  const numerator = costMinor * redeemed.coefficient * 10n ** BigInt(total.scale);
  const denominator = total.coefficient * 10n ** BigInt(redeemed.scale);
  return assertMinorUnits(halfUpDivide(numerator, denominator));
}

/**
 * `remainingShares = totalShares − redeemedShares`, EXACT (`remaining + redeemed === total`).
 * A full redemption legitimately yields zero remaining shares; the holding is then closed by state.
 */
export function remainingSharesOf(totalShares: DecimalAmount, redeemedShares: DecimalAmount): DecimalAmount {
  const total = parsePositiveShares(totalShares, '总份额');
  const redeemed = parsePositiveShares(redeemedShares, '赎回份额');
  assertRedeemedWithinTotal(redeemed, total);
  return subtractDecimal(fixedToDecimal(total.coefficient, total.scale), fixedToDecimal(redeemed.coefficient, redeemed.scale));
}

/**
 * Unrealized profit over remaining cost as a dimensionless ratio (`profit / cost`), carried to the
 * SDK decimal bound with ONE HALF_UP step because the quotient is generally nonterminating.
 * A zero cost has no rate — the caller renders the holding without a percentage.
 */
export function profitRateOf(profit: DecimalAmount, cost: MoneyAmount): DecimalAmount | undefined {
  const profitFixed = parseFixed(profit, '持仓收益', RATIO_FRACTION_DIGITS);
  const costMinor = parseMoneyMinor(cost, '持仓成本');
  if (costMinor === 0n) return undefined;
  const numerator = profitFixed.coefficient * CNY_SCALE * RATIO_SCALE;
  const denominator = 10n ** BigInt(profitFixed.scale) * costMinor;
  return fixedToDecimal(halfUpDivide(numerator, denominator), RATIO_FRACTION_DIGITS);
}
