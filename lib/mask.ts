/**
 * Display masking (展示脱敏) — the single implementation used by every layer.
 * This module has no imports on purpose: domain, agent and UI code can depend on it without
 * creating a cycle, and no caller may re-implement these shapes locally.
 */

/**
 * Masks a phone number for display, preserving the public prefix and suffix.
 *
 * - `null` / `undefined` / non-string / `''` → `''` (an absent value never renders as stars)
 * - length ≤ 3 → `'****'`
 * - length 4–7 → first 3 characters + `'****'`
 * - length > 7 → first 3 characters + `'****'` + last 4 characters
 *
 * Idempotent for already-masked input: `'139****0002'` (length 11) is returned unchanged.
 * The value is never trimmed, so callers keep the responsibility for normalizing input.
 */
export function maskPhone(phone?: string | null): string {
  const value = typeof phone === 'string' ? phone : '';
  if (value.length === 0) return '';
  if (value.length <= 3) return '****';
  if (value.length <= 7) return value.slice(0, 3) + '****';
  return value.slice(0, 3) + '****' + value.slice(-4);
}

/** Keeps the trailing four characters and replaces every earlier one with `*`; short input is returned as-is. */
function maskTail4(value?: string | null): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= 4) return text;
  return '*'.repeat(text.length - 4) + text.slice(-4);
}

/**
 * Masks an account number for display: only the last 4 characters stay visible and the length is
 * preserved character-for-character.
 *
 * - `null` / `undefined` / non-string / `''` → `''`
 * - length ≤ 4 → returned unchanged, so short input never throws
 * - length > 4 → `(length - 4)` stars + last 4 characters
 *
 * Idempotent: `'****8821'` → `'****8821'`. The value is not validated as digits and never trimmed.
 */
export function maskAccountNumber(value?: string | null): string {
  return maskTail4(value);
}

/**
 * Masks a card number for display. Same algorithm and guarantees as {@link maskAccountNumber}:
 * only the last 4 characters stay visible, length is preserved, already-masked and short input are
 * idempotent, and non-digit content is passed through without validation.
 */
export function maskCardNumber(value?: string | null): string {
  return maskTail4(value);
}
