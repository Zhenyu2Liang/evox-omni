/**
 * PURE (no DB, no model) spec for the phone layers of `lib/phone.ts`.
 *
 * The frozen distinction under test:
 *  - IDENTITY (`phoneIdentityMatches` / legacy `maskAwarePhoneMatch`) may decide a recipient and so
 *    only ever accepts two equal COMPLETE numbers (middle four digits included).
 *  - CANDIDATE (`phoneCandidateMatches` / `searchPhoneMatch`) only narrows a list; a mask's visible
 *    ends may widen the candidate set, but a candidate is never an identity.
 */
import { describe, expect, it } from 'vitest';
import {
  isCompletePhone,
  isMaskedPhone,
  maskAwarePhoneMatch,
  maskPhone,
  phoneCandidateMatches,
  phoneIdentityMatches,
  searchPhoneMatch,
} from '@/lib/phone';

/** `13811118000` / `13899998000`: same prefix and suffix, different middle four digits. */
const COMPLETE_A = '13811118000';
const COMPLETE_B = '13899998000';
/** The display mask both complete numbers above produce. */
const MASKED_A = '138****8000';
/** `13911118000`: same suffix as `MASKED_A` but a different 3-digit prefix. */
const OTHER_PREFIX_FULL = '13911118000';

describe('phone shapes', () => {
  it('recognizes only complete 11-digit mobile numbers', () => {
    expect(isCompletePhone('13900000002')).toBe(true);
    expect(isCompletePhone(MASKED_A)).toBe(false);
    expect(isCompletePhone('0002')).toBe(false);
    expect(isCompletePhone('138001380001')).toBe(false);
    expect(isCompletePhone('23800138000')).toBe(false);
    expect(isCompletePhone('')).toBe(false);
    expect(isCompletePhone(13800138000)).toBe(false);
    expect(isCompletePhone(null)).toBe(false);
  });

  it('recognizes only the exact display-masked shape', () => {
    expect(isMaskedPhone(MASKED_A)).toBe(true);
    expect(isMaskedPhone(COMPLETE_A)).toBe(false);
    expect(isMaskedPhone('138**8000')).toBe(false);
    expect(isMaskedPhone('138*****800')).toBe(false);
    expect(isMaskedPhone(undefined)).toBe(false);
  });
});

describe('phoneIdentityMatches — only two equal complete numbers identify', () => {
  it('matches a complete input against the same stored complete number', () => {
    expect(phoneIdentityMatches(COMPLETE_A, { full: COMPLETE_A, display: maskPhone(COMPLETE_A) })).toBe(true);
  });

  it('rejects a different middle four digits even when prefix and suffix agree', () => {
    expect(phoneIdentityMatches(COMPLETE_A, { full: COMPLETE_B, display: MASKED_A })).toBe(false);
    expect(phoneIdentityMatches('13900000002', { full: '13911110002' })).toBe(false);
  });

  it('accepts a history row whose display is itself the same complete number', () => {
    expect(phoneIdentityMatches(COMPLETE_A, { full: null, display: COMPLETE_A })).toBe(true);
    expect(phoneIdentityMatches(COMPLETE_A, { display: COMPLETE_A })).toBe(true);
  });

  it('never establishes identity from the masked form, even for a unique candidate', () => {
    expect(phoneIdentityMatches(MASKED_A, { full: COMPLETE_A })).toBe(false);
    expect(phoneIdentityMatches(MASKED_A, { display: MASKED_A })).toBe(false);
    expect(phoneIdentityMatches('8000', { full: COMPLETE_A })).toBe(false);
    expect(phoneIdentityMatches('138', { full: COMPLETE_A })).toBe(false);
  });

  it('treats a mask that maps to two different complete numbers as never matching either', () => {
    const candidates = [
      { full: COMPLETE_A, display: maskPhone(COMPLETE_A) },
      { full: COMPLETE_B, display: maskPhone(COMPLETE_B) },
    ];
    // One mask, two real numbers: identity must refuse both sides of the ambiguity.
    expect(candidates.map((candidate) => phoneIdentityMatches(MASKED_A, candidate))).toEqual([false, false]);
    // Both stay candidates, which is exactly why the caller has to ask the user to clarify.
    expect(candidates.filter((candidate) => phoneCandidateMatches(MASKED_A, candidate))).toHaveLength(2);
  });
});

describe('maskAwarePhoneMatch — strict identity, legacy export name kept', () => {
  it('keeps identical masks equal', () => {
    expect(maskAwarePhoneMatch(MASKED_A, MASKED_A)).toBe(true);
    expect(maskAwarePhoneMatch('139****0002', '139****0002')).toBe(true);
  });

  it('rejects the masked-vs-complete pairs the old implementation accepted', () => {
    expect(maskAwarePhoneMatch(MASKED_A, COMPLETE_B)).toBe(false);
    expect(maskAwarePhoneMatch(COMPLETE_B, MASKED_A)).toBe(false);
    expect(maskAwarePhoneMatch('13900000002', '139****0002')).toBe(false);
    expect(maskAwarePhoneMatch('139****0002', '13900000002')).toBe(false);
  });

  it('rejects complete numbers that differ anywhere, including the middle four digits', () => {
    expect(maskAwarePhoneMatch(COMPLETE_A, COMPLETE_B)).toBe(false);
    expect(maskAwarePhoneMatch('13900000002', '13911110002')).toBe(false);
    expect(maskAwarePhoneMatch(COMPLETE_A, COMPLETE_A)).toBe(true);
  });

  it('rejects masks that differ in their visible ends and every non-phone shape', () => {
    expect(maskAwarePhoneMatch(MASKED_A, '138****9000')).toBe(false);
    expect(maskAwarePhoneMatch('', '')).toBe(false);
    expect(maskAwarePhoneMatch('123', '123')).toBe(false);
    expect(maskAwarePhoneMatch('0002', '139****0002')).toBe(false);
    expect(maskAwarePhoneMatch('13900000000002', '13900000000002')).toBe(false);
  });
});

describe('phoneCandidateMatches — narrows the list, never identifies', () => {
  it('keeps both same-ended complete numbers as candidates for one mask', () => {
    expect(phoneCandidateMatches(MASKED_A, { full: COMPLETE_A })).toBe(true);
    expect(phoneCandidateMatches(MASKED_A, { full: COMPLETE_B })).toBe(true);
    expect(phoneCandidateMatches(MASKED_A, { full: OTHER_PREFIX_FULL })).toBe(false);
  });

  it('rejects a different complete number at the candidate layer too', () => {
    expect(phoneCandidateMatches(COMPLETE_A, { full: COMPLETE_B })).toBe(false);
    expect(phoneCandidateMatches(COMPLETE_A, { full: COMPLETE_A })).toBe(true);
  });

  it('compares a mask against full ?? display', () => {
    expect(phoneCandidateMatches(MASKED_A, { full: null, display: COMPLETE_A })).toBe(true);
    expect(phoneCandidateMatches(MASKED_A, { display: COMPLETE_B })).toBe(true);
    expect(phoneCandidateMatches(MASKED_A, { display: OTHER_PREFIX_FULL })).toBe(false);
  });

  it('matches a digits-only fragment as a substring of the stored digits', () => {
    expect(phoneCandidateMatches('8000', { display: MASKED_A })).toBe(true);
    expect(phoneCandidateMatches('138', { display: MASKED_A })).toBe(true);
    expect(phoneCandidateMatches('1', { display: MASKED_A })).toBe(true);
    expect(phoneCandidateMatches('1111', { display: MASKED_A })).toBe(false);
    expect(phoneCandidateMatches('9999', { display: MASKED_A })).toBe(false);
    expect(phoneCandidateMatches('1111', { display: COMPLETE_A })).toBe(true);
  });

  it('accepts no non-phone input shape', () => {
    const rejected = ['', 'abcdefghijk', '138-0013-8000', '138001380001', '*', '138***8000', '138**8000'];
    for (const value of rejected) {
      expect(phoneCandidateMatches(value, { full: COMPLETE_A, display: MASKED_A })).toBe(false);
      expect(phoneIdentityMatches(value, { full: COMPLETE_A, display: MASKED_A })).toBe(false);
      expect(maskAwarePhoneMatch(value, MASKED_A)).toBe(false);
      expect(searchPhoneMatch(value, MASKED_A)).toBe(false);
    }
  });
});

describe('phoneCandidateMatches — history rows that kept only a mask', () => {
  const historical = { full: null, display: MASKED_A };

  it('cannot identify a typed complete number but still keeps the row as a candidate', () => {
    expect(phoneIdentityMatches(COMPLETE_A, historical)).toBe(false);
    expect(phoneCandidateMatches(COMPLETE_A, historical)).toBe(true);
    expect(phoneCandidateMatches(OTHER_PREFIX_FULL, historical)).toBe(false);
  });

  it('cannot identify a typed mask but still keeps the row as a candidate', () => {
    expect(phoneIdentityMatches(MASKED_A, historical)).toBe(false);
    expect(phoneCandidateMatches(MASKED_A, historical)).toBe(true);
    expect(phoneCandidateMatches(MASKED_A, { full: null, display: COMPLETE_B })).toBe(true);
    expect(phoneCandidateMatches(MASKED_A, { full: null, display: OTHER_PREFIX_FULL })).toBe(false);
  });
});

describe('searchPhoneMatch — candidate filtering with the legacy signature', () => {
  it('keeps the historical fragment behaviour', () => {
    expect(searchPhoneMatch('0002', '139****0002')).toBe(true);
    expect(searchPhoneMatch('139****0002', '139****0002')).toBe(true);
    expect(searchPhoneMatch('13900000002', '139****0002')).toBe(true);
    expect(searchPhoneMatch('9999', '139****0002')).toBe(false);
    expect(searchPhoneMatch('', '139****0002')).toBe(false);
  });

  it('still declines to identify anything', () => {
    expect(maskAwarePhoneMatch('0002', '139****0002')).toBe(false);
    expect(maskAwarePhoneMatch('13900000002', '139****0002')).toBe(false);
  });
});

describe('no full number leaks out of the phone layer', () => {
  it('answers with booleans only, so a masked store cannot spell out the hidden digits', () => {
    const historical = { full: null, display: MASKED_A };
    const answers = [
      phoneIdentityMatches(COMPLETE_A, historical),
      phoneCandidateMatches(COMPLETE_A, historical),
      maskAwarePhoneMatch(COMPLETE_A, MASKED_A),
      searchPhoneMatch('8000', MASKED_A),
      isCompletePhone(MASKED_A),
      isMaskedPhone(MASKED_A),
    ];
    expect(answers.every((answer) => typeof answer === 'boolean')).toBe(true);
    expect(JSON.stringify(answers)).not.toContain(COMPLETE_A.slice(3, 7));
  });
});
