import { describe, expect, it } from 'vitest';
import { maskAwarePhoneMatch, searchPhoneMatch } from '@/lib/phone';

describe('phone identity', () => {
  it.each([
    ['13900000002', '13900000002'], ['13900000002', '139****0002'],
    ['139****0002', '13900000002'], ['139****0002', '139****0002'],
  ])('matches complete normalized phone identities %s against %s', (value, stored) => {
    expect(maskAwarePhoneMatch(value, stored)).toBe(true);
  });

  it.each(['0002', '139', '2', '1390002', '13900000000002', '113900000002', '13900000002x', '139**0002', '13912345678'])('rejects incomplete or incompatible phone identity %s', value => {
    expect(maskAwarePhoneMatch(value, '139****0002')).toBe(false);
  });

  it('allows partial phone search without treating the search text as an identity', () => {
    expect(searchPhoneMatch('0002', '139****0002')).toBe(true);
    expect(maskAwarePhoneMatch('0002', '139****0002')).toBe(false);
  });
});
