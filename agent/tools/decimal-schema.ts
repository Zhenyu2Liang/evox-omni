/**
 * Exact decimal parameter schemas for the 「净值 + 份额」 investment contract
 * (see `docs/cn/investments.md`).
 *
 * A share count carries at most {@link SHARE_DECIMALS} fractional digits and a net value per unit at
 * most {@link NET_VALUE_DECIMALS}; both are UNSIGNED plain decimal text, so a negative share, an
 * exponent such as `1e-3` (which the generic decimal parser accepts) or a JavaScript number can never
 * reach the SDK. The pattern is grammar only — financial domains ("positive", "within the held
 * shares", "amount above market value") belong to the security quote and the SDK, not here.
 *
 * `canonical*` normalizes with `decimalText()` before the value reaches the SDK, because the SDK's
 * storage readers require `nonNegativeDecimal(raw) === raw`: `'0.9880'` and `'5050.000000'` must
 * arrive as `'0.988'` and `'5050'`, or every write would be rejected as malformed.
 */
import { Type } from '@earendil-works/pi-ai';
import { NET_VALUE_DECIMALS, SHARE_DECIMALS } from '@/banking-sdk';
import { decimalText, type DecimalAmount } from '@/lib/decimal';
import { AppError } from '@/lib/errors';

/** Unsigned plain decimal text: no sign, no exponent, no currency symbol, no whitespace. */
const PLAIN_UNSIGNED_DECIMAL = /^\d+(?:\.\d+)?$/;

/** Canonical text of an unsigned plain decimal bounded to `maxFractionDigits` fractional digits. */
function boundedDecimal(input: unknown, label: string, maxFractionDigits: number): DecimalAmount {
  if (typeof input !== 'string') throw new AppError('VALIDATION', `${label}必须以十进制文本给出`);
  if (!PLAIN_UNSIGNED_DECIMAL.test(input)) {
    throw new AppError('VALIDATION', `${label}必须是不含符号、指数或货币符号的十进制文本`, { value: input });
  }
  const canonical = decimalText(input);
  const fraction = canonical.split('.')[1] ?? '';
  if (fraction.length > maxFractionDigits) {
    throw new AppError('VALIDATION', `${label}最多允许 ${maxFractionDigits} 位小数`, { value: input, maxFractionDigits });
  }
  return canonical;
}

/** Canonical share count (`FLOOR`-compatible 6-decimal text) — the SDK's storage contract. */
export function canonicalShareCount(input: unknown): DecimalAmount {
  return boundedDecimal(input, '份额', SHARE_DECIMALS);
}

/** Canonical net value per unit (4-decimal text) — the SDK's storage contract. */
export function canonicalNetValue(input: unknown): DecimalAmount {
  return boundedDecimal(input, '净值', NET_VALUE_DECIMALS);
}

/** Share count parameter: exact, non-negative, at most {@link SHARE_DECIMALS} fractional digits. */
export const SharesParameter = Type.String({
  pattern: `^\\d+(?:\\.\\d{1,${SHARE_DECIMALS}})?$`,
  description: `Exact share count as decimal text with at most ${SHARE_DECIMALS} fractional digits; no sign, no exponent.`,
});

/** Net value parameter: exact, non-negative, at most {@link NET_VALUE_DECIMALS} fractional digits. */
export const NetValueParameter = Type.String({
  pattern: `^\\d+(?:\\.\\d{1,${NET_VALUE_DECIMALS}})?$`,
  description: `Exact net value per unit as decimal text with at most ${NET_VALUE_DECIMALS} fractional digits; no sign, no exponent.`,
});
