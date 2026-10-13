import { AppError } from './errors';

/** Canonical CNY decimal text at JSON and presentation boundaries. */
export type MoneyAmount = string;
/** Financial inputs use decimal text and never JavaScript numbers. */
export type MoneyInput = string;
export const CNY = '¥';
export const MAX_MINOR_UNITS = 9_223_372_036_854_775_807n;
export const MIN_MINOR_UNITS = -9_223_372_036_854_775_808n;

function decimalText(input: unknown): string {
  if (typeof input !== 'string') throw new AppError('VALIDATION', 'Money input must be decimal text.');
  const cleaned = input.replace(/[¥￥,\s]/g, '');
  if (cleaned.length > 128) throw new AppError('VALIDATION', 'Money input exceeds the supported length.');
  return cleaned;
}

function parseExactMinor(input: unknown): bigint {
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(decimalText(input));
  if (!match) throw new AppError('VALIDATION', 'Money must have at most two decimal places.');
  const absolute = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'));
  return match[1] === '-' ? -absolute : absolute;
}

/** Parse exact CNY and enforce the signed 64-bit range for database-bound values. */
export function moneyToCents(input: unknown): bigint {
  return assertMinorUnits(parseExactMinor(input));
}

/** Guard the database's signed 64-bit integer range before every persisted value. */
export function assertMinorUnits(minor: bigint): bigint {
  if (minor < MIN_MINOR_UNITS || minor > MAX_MINOR_UNITS) {
    throw new AppError('VALIDATION', 'Money exceeds the supported signed 64-bit range.');
  }
  return minor;
}

/** Format exact minor units without converting them to a JavaScript number. */
export function centsToMoney(minor: bigint): MoneyAmount {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  return `${negative ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
}

/** Normalize a boundary input to canonical two-decimal JSON text. */
export function normalizeMoney(input: MoneyInput): MoneyAmount {
  return centsToMoney(moneyToCents(input));
}

export function normalizeTransferAmount(input: unknown): MoneyAmount {
  const minor = moneyToCents(input);
  if (minor <= 0n) throw new AppError('VALIDATION', 'Transfer amount must be positive.');
  return centsToMoney(minor);
}

export function addMoney(left: MoneyInput, right: MoneyInput): MoneyAmount {
  return centsToMoney(parseExactMinor(left) + parseExactMinor(right));
}

export function subtractMoney(left: MoneyInput, right: MoneyInput): MoneyAmount {
  return centsToMoney(parseExactMinor(left) - parseExactMinor(right));
}

export function absoluteMinor(minor: bigint): bigint {
  return minor < 0n ? -minor : minor;
}

/** Percentage rounded half away from zero to two decimals using integer arithmetic. */
export function percentageRatio(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return '0.00';
  const negative = (numerator < 0n) !== (denominator < 0n);
  const scaled = absoluteMinor(numerator) * 10_000n;
  const divisor = absoluteMinor(denominator);
  const rounded = (scaled + divisor / 2n) / divisor;
  return centsToMoney(negative ? -rounded : rounded);
}

/** Formats a CNY amount; a bigint argument explicitly denotes minor units. */
export function formatCNY(amount: MoneyInput | bigint): string {
  const minor = typeof amount === 'bigint' ? amount : parseExactMinor(amount);
  const [integer, fraction] = centsToMoney(absoluteMinor(minor)).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${minor < 0n ? '-' : ''}${CNY}${grouped}.${fraction}`;
}

/** The only lossy conversion; call exclusively when creating chart coordinates. */
export function moneyToChartNumber(amount: MoneyInput): number {
  return Number(centsToMoney(parseExactMinor(amount)));
}
