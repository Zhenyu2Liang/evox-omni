/** Start of the local day containing `t`, i.e. 00:00:00.000. Pure. */
export function startOfDay(t: Date): Date {
  return new Date(t.getFullYear(), t.getMonth(), t.getDate());
}

/** Half-open range [start, end) covering the local calendar day of `now` (defaults to new Date()). Pure. */
export function todayRange(now: Date = new Date()): { start: Date; end: Date } {
  const start = startOfDay(now);
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { start, end };
}

/** Half-open range [start, end) covering the local calendar month of `now`. Pure. */
export function monthRange(now: Date = new Date()): { start: Date; end: Date } {
  const year = now.getFullYear();
  const month = now.getMonth();
  return { start: new Date(year, month, 1), end: new Date(year, month + 1, 1) };
}

/** Half-open range [start, end) covering the previous local calendar month of `now`. Pure. */
export function previousMonthRange(now: Date = new Date()): { start: Date; end: Date } {
  const year = now.getFullYear();
  const month = now.getMonth();
  return { start: new Date(year, month - 1, 1), end: new Date(year, month, 1) };
}

/** Zero-pads a number to `width` digits. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** Formats a timestamp (Date or epoch ms) as `YYYY-MM-DD HH:mm` in local time. Pure. */
export function formatDateTime(ts: Date | number): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${date} ${time}`;
}
