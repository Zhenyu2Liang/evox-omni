/**
 * Phone-number semantics (号码解析). Two DIFFERENT questions live here and must never be conflated:
 *
 *  - IDENTITY  (`phoneIdentityMatches`) — "is this input THE SAME phone as this stored contact?".
 *    An identity may authorize money movement, so only two complete numbers that are equal
 *    character-for-character (including the middle four digits) may match.
 *  - CANDIDATE (`phoneCandidateMatches`) — "could this contact be the one the user meant?".
 *    It only narrows a list; the caller must still require a UNIQUE candidate before acting.
 *
 * Display masking has one implementation, `lib/mask.ts`, re-exported here; never copy it.
 */

/** Complete mainland mobile number, e.g. `13800138000`. */
const COMPLETE_PHONE = /^1[3-9]\d{9}$/;
/** Display-masked phone as produced by `maskPhone`, e.g. `138****8000`. */
const MASKED_PHONE = /^1[3-9]\d\*{4}\d{4}$/;
/** Digits-only search fragment typed by a user, e.g. `8000`. */
const DIGIT_FRAGMENT = /^\d{1,11}$/;

/** `true` only for a complete 11-digit mobile number; anything else (masked, fragment, non-string) is `false`. */
export function isCompletePhone(value: unknown): value is string {
  return typeof value === 'string' && COMPLETE_PHONE.test(value);
}

/** `true` only for the exact display-masked shape (`1[3-9]\d` + `****` + 4 digits). */
export function isMaskedPhone(value: unknown): value is string {
  return typeof value === 'string' && MASKED_PHONE.test(value);
}

/** `true` when the value is either a complete or a display-masked phone. */
function isPhoneShape(value: unknown): value is string {
  return isCompletePhone(value) || isMaskedPhone(value);
}

/**
 * A stored contact's phone facets.
 *
 * `full` is the complete number the storage still holds (`null`/absent for history rows that only
 * kept a mask); `display` is the public projection, complete or masked.
 */
export interface PhoneCandidate {
  full?: string | null;
  display?: string | null;
}

/** The stored complete phone, or `null` when only a mask survived. */
function candidateFull(candidate: PhoneCandidate | null | undefined): string | null {
  const full = candidate?.full;
  return typeof full === 'string' && COMPLETE_PHONE.test(full) ? full : null;
}

/** The stored display value; an absent value becomes `''` so no shape test can pass on it. */
function candidateDisplay(candidate: PhoneCandidate | null | undefined): string {
  return typeof candidate?.display === 'string' ? candidate.display : '';
}

/** Both values are phone-shaped and agree on the visible ends (prefix 3 + suffix 4). */
function sharesVisibleEnds(left: unknown, right: unknown): boolean {
  return isPhoneShape(left) && isPhoneShape(right) && left.slice(0, 3) === right.slice(0, 3) &&
    left.slice(-4) === right.slice(-4);
}

/**
 * IDENTITY test — the only phone rule that may decide which recipient receives money.
 *
 * - complete input: `true` only when the candidate's stored complete phone is identical; when
 *   `full` is missing (history row that kept only a mask) the input may match only a candidate
 *   whose `display` is itself that same complete number. A different middle four digits is `false`.
 * - masked or incomplete input: always `false` — a mask or a fragment never identifies anybody.
 * - non-phone shapes (empty, letters, wrong length): `false`, never throws.
 */
export function phoneIdentityMatches(
  input: string | null | undefined,
  candidate: PhoneCandidate | null | undefined,
): boolean {
  const value = typeof input === 'string' ? input : '';
  if (!COMPLETE_PHONE.test(value)) return false;
  const full = candidateFull(candidate);
  // The stored complete number decides alone, so the middle four digits always take part.
  if (full !== null) return full === value;
  // A mask has no middle digits: it can never establish an identity.
  const display = candidateDisplay(candidate);
  return COMPLETE_PHONE.test(display) && display === value;
}

/**
 * CANDIDATE test — narrows the candidate set only; it NEVER establishes an identity.
 *
 * - complete input: same rule as {@link phoneIdentityMatches} when the candidate still stores a
 *   complete number; a history row that kept only a mask stays a candidate when the visible ends
 *   agree (the caller must still confirm a unique, exact match before acting).
 * - masked input: agrees with `full ?? display` on prefix 3 + suffix 4 — the only visible-end
 *   tolerance in this module, and the caller MUST additionally require a unique candidate.
 * - digits-only fragment: substring of the stored digits with `*` removed.
 * - anything else (empty, letters, too long): `false`, never throws.
 */
export function phoneCandidateMatches(
  input: string | null | undefined,
  candidate: PhoneCandidate | null | undefined,
): boolean {
  const stored = candidateFull(candidate) ?? candidateDisplay(candidate);
  const value = typeof input === 'string' ? input : '';
  if (COMPLETE_PHONE.test(value)) {
    // Complete vs complete: character equality, the middle four digits included.
    if (COMPLETE_PHONE.test(stored)) return stored === value;
    return MASKED_PHONE.test(stored) && sharesVisibleEnds(value, stored);
  }
  if (MASKED_PHONE.test(value)) return sharesVisibleEnds(value, stored);
  const fragment = value.trim();
  return DIGIT_FRAGMENT.test(fragment) && stored.replace(/\*/g, '').includes(fragment);
}

/**
 * Legacy export — STRICT phone identity between two concrete stored/typed strings. Pinned to the
 * "stored value is `display`" shape: identical complete numbers only, plus the long-standing
 * tolerance for the very same masked string on both sides.
 *
 * Front-end/UI candidate filtering must use {@link phoneCandidateMatches}; this function must
 * NEVER be used to build a search list, because it deliberately rejects every partial match.
 */
export function maskAwarePhoneMatch(value: string, stored: string): boolean {
  if (phoneIdentityMatches(value, { full: null, display: stored })) return true;
  // Same mask on both sides carries no new information and stays equal (legacy tolerance).
  return isMaskedPhone(value) && isMaskedPhone(stored) && value === stored;
}

/**
 * Search helper (used by contact search) — CANDIDATE filtering only, never an identity claim:
 * a substring hit means "maybe this contact", not "this is the recipient".
 */
export function searchPhoneMatch(query: string, stored: string): boolean {
  return phoneCandidateMatches(query, { full: null, display: stored });
}

/** Display masking lives in `lib/mask.ts`; re-exported so existing `lib/phone` imports keep working. */
export { maskPhone } from './mask';
