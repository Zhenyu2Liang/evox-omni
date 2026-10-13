import Decimal from 'decimal.js';
import { AppError } from './errors';
import { assertMinorUnits } from './money';

/** Exact decimal values cross storage and JSON boundaries as canonical text. */
export type DecimalAmount = string;

// Two bounded operands fit within this precision without rounding multiplication or addition.
const FinancialDecimal = Decimal.clone({ precision: 120, rounding: Decimal.ROUND_HALF_UP });
const MAX_INTEGER_DIGITS = 40;
const MAX_FRACTION_DIGITS = 18;

/** Normalize bounded decimal text without accepting binary numeric inputs. */
export function decimalText(input: string): DecimalAmount {
  if (typeof input !== 'string') throw new AppError('VALIDATION', 'Financial decimals must be decimal text.');
  const text = input;
  if (text.length > 128 || !/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) {
    throw new AppError('VALIDATION', 'Invalid financial decimal text.');
  }
  const value = new FinancialDecimal(text);
  if (!value.isFinite() || value.abs().gte('1e40') || value.decimalPlaces() > MAX_FRACTION_DIGITS) {
    throw new AppError('VALIDATION', `Financial decimals allow ${MAX_INTEGER_DIGITS} integer digits and ${MAX_FRACTION_DIGITS} fractional digits.`);
  }
  return value.isZero() ? '0' : value.toFixed();
}

export function nonNegativeDecimal(input: string): DecimalAmount {
  const text = decimalText(input);
  if (new FinancialDecimal(text).isNegative()) throw new AppError('VALIDATION', 'Financial value must be nonnegative.');
  return text;
}

export function addDecimal(left: string, right: string): DecimalAmount {
  return decimalText(new FinancialDecimal(decimalText(left)).plus(decimalText(right)).toFixed());
}

export function subtractDecimal(left: string, right: string): DecimalAmount {
  return decimalText(new FinancialDecimal(decimalText(left)).minus(decimalText(right)).toFixed());
}

export function multiplyDecimal(left: string, right: string): DecimalAmount {
  return decimalText(new FinancialDecimal(decimalText(left)).times(decimalText(right)).toFixed());
}

/** Reject nonterminating or over-scale division instead of silently rounding a business value. */
export function divideDecimal(left: string, right: string): DecimalAmount {
  const denominator = new FinancialDecimal(decimalText(right));
  if (denominator.isZero()) throw new AppError('VALIDATION', 'Financial division by zero is invalid.');
  return decimalText(new FinancialDecimal(decimalText(left)).dividedBy(denominator).toFixed());
}

/** Convert the dimensionless annual yield ratio only at the display boundary. */
export function rateRatioToPercent(ratio: string): DecimalAmount {
  return multiplyDecimal(nonNegativeDecimal(ratio), '100');
}

/** Demo CNY settlement policy: round HALF_UP once, then enforce the booked-money range. */
export function valuationToMinor(valuation: string): bigint {
  const value = new FinancialDecimal(nonNegativeDecimal(valuation));
  return assertMinorUnits(BigInt(value.times('100').toFixed(0, Decimal.ROUND_HALF_UP)));
}

/** Preserve valuation precision in presentation, with at least two currency decimal places. */
export function formatDecimalCNY(input: string): string {
  const value = new FinancialDecimal(decimalText(input));
  const [integer, fraction] = value.abs().toFixed(Math.max(2, value.decimalPlaces())).split('.');
  return `${value.isNegative() ? '-' : ''}¥${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

interface DecimalParts { coefficient: bigint; scale: number; }

function parseDecimal(input: string | number | bigint): DecimalParts {
  if (typeof input === 'number' && (!Number.isFinite(input) || Math.abs(input) > Number.MAX_SAFE_INTEGER / 100)) {
    throw new Error('Numeric decimal inputs must preserve cent precision; use decimal text for large values.');
  }
  const text = String(input);
  if (text.length > 2000) throw new Error('Decimal input exceeds the supported length.');
  const match = /^([+-]?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new Error('Invalid decimal text.');
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000) throw new Error('Decimal exponent exceeds the supported range.');
  const fraction = match[3] ?? '';
  let coefficient = BigInt(match[2] + fraction) * (match[1] === '-' ? -1n : 1n);
  let scale = fraction.length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  return { coefficient, scale };
}

/** Compare decimal values by aligned integer coefficients, including JSON numeric inputs. */
export function compareDecimal(left: string | number | bigint, right: string | number | bigint): -1 | 0 | 1 {
  const a = parseDecimal(left);
  const b = parseDecimal(right);
  const scale = Math.max(a.scale, b.scale);
  const leftInteger = a.coefficient * 10n ** BigInt(scale - a.scale);
  const rightInteger = b.coefficient * 10n ** BigInt(scale - b.scale);
  return leftInteger < rightInteger ? -1 : leftInteger > rightInteger ? 1 : 0;
}
