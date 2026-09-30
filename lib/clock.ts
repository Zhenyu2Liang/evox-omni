import { DEMO_NOW } from './constants';
import { monthRange, previousMonthRange, todayRange } from './date';

/**
 * The single source of "now" for the running app (the DEMO CLOCK — see the root ROOT DECISION).
 * Returns the pinned demo instant (`DEMO_NOW`) unless an explicit override is supplied, so every
 * relative-date path (本月/上月/今日 windows, daily-transfer window, scheduled tasks, system prompt)
 * stays coherent regardless of the real system clock.
 *
 * `override` (epoch ms or `Date`) exists purely so tests can inject a fixed instant.
 */
export function demoNow(override?: number | Date): number {
  if (override === undefined) return DEMO_NOW;
  return override instanceof Date ? override.getTime() : override;
}

/** Local-day range `[start, end)` of the demo clock (overridable for tests). */
export function demoTodayRange(override?: number | Date): { start: Date; end: Date } {
  return todayRange(new Date(demoNow(override)));
}

/** Local-month range `[start, end)` of the demo clock (overridable for tests). */
export function demoMonthRange(override?: number | Date): { start: Date; end: Date } {
  return monthRange(new Date(demoNow(override)));
}

/** Previous local-month range `[start, end)` of the demo clock (overridable for tests). */
export function demoPreviousMonthRange(override?: number | Date): { start: Date; end: Date } {
  return previousMonthRange(new Date(demoNow(override)));
}
