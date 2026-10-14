import { describe, expect, it } from 'vitest';
import { MAX_DATE_TIMESTAMP, validateSpendingMonth, validateTransactionQuery } from '@/banking-sdk/read-query';
import { AppError } from '@/lib/errors';

describe('banking read filter validation', () => {
  it('accepts explicit half-open timestamps and a bounded newest-first limit', () => {
    expect(validateTransactionQuery({ from: 0, to: 1, category: '  Shopping  ', limit: 200 }))
      .toEqual({ from: 0, to: 1, category: 'Shopping', limit: 200 });
    expect(validateTransactionQuery({})).toEqual({});
  });

  it.each([
    { from: '0' }, { to: NaN }, { to: Infinity }, { from: 1.5 },
    { from: MAX_DATE_TIMESTAMP + 1 }, { to: -MAX_DATE_TIMESTAMP - 1 },
    { from: 2, to: 1 }, { from: 1, to: 1 }, { category: '   ' },
    { category: 3 }, { category: 'x'.repeat(81) }, { limit: 0 },
    { limit: -2 }, { limit: 201 }, { limit: 1.5 }, { limit: '20' },
    { accountId: 'another-account' },
  ])('rejects malformed filters without widening the query: %j', input => {
    expect(() => validateTransactionQuery(input)).toThrowError(AppError);
    try { validateTransactionQuery(input); } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION');
    }
  });

  it('allows only an absent month or a valid explicit banking month', () => {
    expect(validateSpendingMonth(undefined)).toBeUndefined();
    expect(validateSpendingMonth('2026-09')).toBe('2026-09');
    expect(validateSpendingMonth('0099-12')).toBe('0099-12');
    for (const invalid of ['', ' ', '2026-00', '2026-13', '2026-1', 202609, null, '2026-09-01']) {
      expect(() => validateSpendingMonth(invalid)).toThrowError(AppError);
    }
  });
});
