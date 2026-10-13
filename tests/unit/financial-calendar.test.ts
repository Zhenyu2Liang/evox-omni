import { describe, expect, it } from 'vitest';
import { businessCalendarParts, businessDate, formatDateTime, monthRange, startOfDay } from '@/lib/date';

describe('banking business calendar', () => {
  it('constructs civil dates with the banking offset independent of the host', () => {
    expect(businessDate(2026, 8, 1).toISOString()).toBe('2026-08-31T16:00:00.000Z');
    expect(formatDateTime(businessDate(2026, 8, 25, 12, 0))).toBe('2026-09-25 12:00');
  });

  it('classifies a UTC month-end instant into the next banking month and day', () => {
    const instant = new Date('2026-09-30T16:30:00.000Z');
    expect(businessCalendarParts(instant)).toEqual({ year: 2026, month: 9, day: 1 });
    const range = monthRange(instant);
    expect(range.start.toISOString()).toBe('2026-09-30T16:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(startOfDay(instant).toISOString()).toBe(range.start.toISOString());
  });
});
