export const BUSINESS_TIME_ZONE = 'Asia/Shanghai';
const BUSINESS_OFFSET_MS = 8 * 60 * 60 * 1000;

/** Civil-time construction independent of the deployment host's time zone. */
export function businessDate(year: number, month: number, day = 1, hour = 0, minute = 0): Date {
  return new Date(Date.UTC(year, month, day, hour, minute) - BUSINESS_OFFSET_MS);
}

/** Read civil calendar components in the fixed banking business time zone. */
export function businessCalendarParts(instant: Date | number): { year: number; month: number; day: number } {
  const shifted = new Date((instant instanceof Date ? instant.getTime() : instant) + BUSINESS_OFFSET_MS);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/** Start of the business calendar day containing the supplied instant. */
export function startOfDay(t: Date): Date {
  const shifted = new Date(t.getTime() + BUSINESS_OFFSET_MS);
  return businessDate(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

/** Half-open range [start, end) covering the local calendar day of `now` (defaults to new Date()). Pure. */
export function todayRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = startOfDay(now);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Half-open range [start, end) covering the local calendar month of `now`. Pure. */
export function monthRange(now: Date = new Date()): { start: Date; end: Date } {
  const shifted = new Date(now.getTime() + BUSINESS_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  return { start: businessDate(year, month), end: businessDate(year, month + 1) };
}

/** Half-open range [start, end) covering the previous local calendar month of `now`. Pure. */
export function previousMonthRange(now: Date = new Date()): { start: Date; end: Date } {
  const shifted = new Date(now.getTime() + BUSINESS_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  return { start: businessDate(year, month - 1), end: businessDate(year, month) };
}

/** Zero-pads a number to `width` digits. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Formats a timestamp (Date or epoch ms) as `YYYY-MM-DD HH:mm` in local time. Pure. */
export function formatDateTime(ts: Date | number): string {
  const d = new Date((ts instanceof Date ? ts.getTime() : ts) + BUSINESS_OFFSET_MS);
  const date = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  return `${date} ${time}`;
}
