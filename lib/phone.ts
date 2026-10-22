/** Recipient binding accepts complete normalized numbers or the exact masked phone shape. */
export function maskAwarePhoneMatch(value: string, stored: string): boolean {
  const complete = /^1[3-9]\d{9}$/;
  const masked = /^1[3-9]\d\*{4}\d{4}$/;
  if ((!complete.test(value) && !masked.test(value)) || (!complete.test(stored) && !masked.test(stored))) return false;
  if (value === stored) return true;
  return (masked.test(value) || masked.test(stored)) && value.slice(0, 3) === stored.slice(0, 3) &&
    value.slice(-4) === stored.slice(-4);
}

/** Search fragments return candidates only; they never establish an executable recipient. */
export function searchPhoneMatch(query: string, stored: string): boolean {
  if (maskAwarePhoneMatch(query, stored)) return true;
  const digits = query.trim();
  return /^\d{1,11}$/.test(digits) && stored.replace(/\*/g, '').includes(digits);
}

/** Display masking lives in `lib/mask.ts`; re-exported so existing `lib/phone` imports keep working. */
export { maskPhone } from './mask';
