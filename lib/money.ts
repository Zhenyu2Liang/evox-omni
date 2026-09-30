/** Chinese yuan symbol used for all amounts in the demo. */
export const CNY = '¥';

/** Rounds a money amount to 2 decimals (cent-safe, avoids float drift). */
export function round2(n: number): number {
  if (!Number.isFinite(n)) return n;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Converts a money amount to an integer number of cents. */
function toCents(n: number): number {
  return Math.round((n + Number.EPSILON) * 100);
}

/** Converts an integer number of cents back to a money amount. */
function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Formats an amount as CNY, e.g. `¥1,234.56`.
 * Thousands separators, always 2 decimals; negatives render as `-¥1,234.56`.
 */
export function formatCNY(amount: number): string {
  const rounded = round2(amount);
  const safe = Number.isFinite(rounded) ? rounded : 0;
  const negative = safe < 0;
  const fixed = Math.abs(safe).toFixed(2);
  const dot = fixed.indexOf('.');
  const intPart = fixed.slice(0, dot);
  const decPart = fixed.slice(dot + 1);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${CNY}${grouped}.${decPart}`;
}

/**
 * Parses a user/model supplied amount into a number.
 * Strips `¥`/`￥`, thousands separators and whitespace.
 * Empty / null / undefined yields `0` (never `NaN`).
 * A non-empty, non-numeric string yields `NaN` so callers can reject it explicitly.
 */
export function parseAmount(input: string | number | null | undefined): number {
  if (input === null || input === undefined) return 0;
  if (typeof input === 'number') return Number.isFinite(input) ? input : 0;
  const cleaned = input.replace(/[¥￥,\s]/g, '');
  if (cleaned === '') return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : NaN;
}

/** Cent-safe addition of two money amounts. */
export function addMoney(a: number, b: number): number {
  return fromCents(toCents(a) + toCents(b));
}

/** Cent-safe subtraction of two money amounts (`a - b`). */
export function subtractMoney(a: number, b: number): number {
  return fromCents(toCents(a) - toCents(b));
}
