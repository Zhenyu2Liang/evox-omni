/** Start of the local day containing `t`, i.e. 00:00:00.000. Pure. */
export function startOfDay(t: Date): Date {
  throw new Error('not implemented');
}

/** Half-open range [start, end) covering the local calendar day of `now` (defaults to new Date()). Pure. */
export function todayRange(now?: Date): { start: Date; end: Date } {
  throw new Error('not implemented');
}

/** Half-open range [start, end) covering the local calendar month of `now`. Pure. */
export function monthRange(now?: Date): { start: Date; end: Date } {
  throw new Error('not implemented');
}

/** Half-open range [start, end) covering the previous local calendar month of `now`. Pure. */
export function previousMonthRange(now?: Date): { start: Date; end: Date } {
  throw new Error('not implemented');
}

/** Formats a timestamp (Date or epoch ms) as `YYYY-MM-DD HH:mm` in local time. Pure. */
export function formatDateTime(ts: Date | number): string {
  throw new Error('not implemented');
}
