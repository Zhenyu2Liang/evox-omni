import { describe, expect, it } from 'vitest';
import { maskAwarePhoneMatch, phoneCandidateMatches, searchPhoneMatch } from '@/lib/phone';

/**
 * IDENTITY (`maskAwarePhoneMatch`) vs CANDIDATE (`searchPhoneMatch` / `phoneCandidateMatches`).
 *
 * The masked/full pairs below used to be asserted as IDENTITIES — that encoded the very bug this
 * suite now pins: a mask hides the middle four digits, so it may only make a contact a CANDIDATE.
 */
describe('phone identity', () => {
  it.each([
    ['13900000002', '13900000002'],
    ['139****0002', '139****0002'],
  ])('matches the same phone value %s against %s', (value, stored) => {
    expect(maskAwarePhoneMatch(value, stored)).toBe(true);
  });

  it.each([
    ['13900000002', '139****0002'],
    ['139****0002', '13900000002'],
  ])('never treats a masked/full pair %s vs %s as one identity (candidate only)', (value, stored) => {
    // A mask cannot establish who the money goes to: the middle four digits are unknown.
    expect(maskAwarePhoneMatch(value, stored)).toBe(false);
    // It may still narrow a list — visible ends agree here.
    expect(searchPhoneMatch(value, stored)).toBe(true);
    expect(phoneCandidateMatches(value, { full: null, display: stored })).toBe(true);
  });

  it.each(['0002', '139', '2', '1390002', '13900000000002', '113900000002', '13900000002x', '139**0002', '13912345678'])('rejects incomplete or incompatible phone identity %s', value => {
    expect(maskAwarePhoneMatch(value, '139****0002')).toBe(false);
  });

  it('allows partial phone search without treating the search text as an identity', () => {
    expect(searchPhoneMatch('0002', '139****0002')).toBe(true);
    expect(maskAwarePhoneMatch('0002', '139****0002')).toBe(false);
  });
});
