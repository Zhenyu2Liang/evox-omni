import { DEMO_NOW } from './constants';
import { monthRange, previousMonthRange, todayRange } from './date';

/**
 * The single source of "now" for the running app (the DEMO CLOCK — see the root ROOT DECISION).
 * Returns the pinned demo instant (`DEMO_NOW`) unless an explicit override is supplied, so every
 * relative-date path (本月/上月/今日 windows, daily-transfer window, scheduled tasks, system prompt)
 * stays coherent regardless of the real system clock.
 *
 * `override` (epoch ms or `Date`) exists purely so tests can inject a fixed instant.
 *
 * DO NOT use this for SECURITY timing that must reflect ELAPSED REAL time — see {@link realNow}.
 */
export function demoNow(override?: number | Date): number {
  if (override === undefined) return DEMO_NOW;
  return override instanceof Date ? override.getTime() : override;
}

/**
 * The server's REAL wall clock, in epoch ms (`Date.now()`).
 *
 * WHY THIS EXISTS — and how it DIFFERS from {@link demoNow} (they are NOT interchangeable):
 *   - `demoNow()` is the PINNED demo instant (`DEMO_NOW`, 2026-09-25 12:00 local). Use it for EVERY
 *     business / UI date: 本月/上月/今日 windows, the spending analysis, the daily-transfer window,
 *     scheduled-task due dates and the system prompt's "today". Substituting the real clock here
 *     would break the staged demo (the stage machine's own date is arbitrary).
 *   - `realNow()` is the ACTUAL server wall clock. Use it ONLY for security timing that must reflect
 *     elapsed real time — the circuit-breaker lock timestamp and the unlock cooldown gate
 *     (`now >= lockedAt + RESET_COOLDOWN_MS`). A lock stamped or timed with the pinned demo clock
 *     could never "elapse" in real time, so security cooldown timing uses the real clock.
 *
 * Rule of thumb: business dates → `demoNow()`; security elapsed-time gates → `realNow()`.
 */
export function realNow(): number {
  return Date.now();
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
