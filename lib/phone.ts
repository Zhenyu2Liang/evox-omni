/**
 * Phone-number matching & masking helpers — the shared kernel of the demo's MASKED-stored phones.
 *
 * The seed stores `Contact.phone` values in MASKED form (e.g. `139****0002`), while the model/user
 * supplies RAW numbers (e.g. `13900000002`). These helpers let a raw value MATCH a masked stored
 * value and let any phone be rendered safely (first-3 + `****` + last-4) so a raw number is never
 * emitted on a confirmation card. Pure, side-effect-free and never throwing.
 */

/** Escape a literal fragment so it can be embedded in a RegExp source safely. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * MASK-AWARE phone match against a stored phone. TRUE iff any of:
 *   - the value IS the stored phone (covers `contactId:"139****0002"` matching stored `139****0002`);
 *   - the stored DIGITS (all `*` stripped) contain the value digits (the existing partial behaviour,
 *     e.g. `phone:"0002"` vs stored `139****0002` → `1390002` contains `0002`);
 *   - the value digits contain the stored digits (reverse partial, defensive);
 *   - a WILDCARD pattern built from the stored phone — fragments split on `*` joined with `\d*`,
 *     anchored — matches the value (`phone:"13900000002"` vs `139****0002` → `^139\d*0002$`).
 * Never throws: empty digit strings are ignored and the pattern is built from escaped literals.
 */
export function maskAwarePhoneMatch(value: string, stored: string): boolean {
  if (value === stored) return true;

  const valueDigits = value.replace(/\*/g, '');
  const storedDigits = stored.replace(/\*/g, '');
  if (valueDigits !== '' && storedDigits !== '') {
    if (storedDigits.includes(valueDigits)) return true;
    if (valueDigits.includes(storedDigits)) return true;
  }

  const fragments = stored.split('*').filter((fragment) => fragment !== '');
  if (fragments.length === 0) return false;
  const pattern = `^${fragments.map(escapeRegExp).join('\\d*')}$`;
  try {
    return new RegExp(pattern).test(valueDigits);
  } catch {
    // The pattern is built exclusively from escaped literal fragments; a throw is impossible, but a
    // non-matching (rather than thrown) result keeps resolution fail-closed.
    return false;
  }
}

/**
 * 手机号脱敏: keep the first 3 and last 4 characters, mask the middle with `****` (e.g. `139****0002`).
 * Safe for ANY input — never throws and never reveals more than first-3 + last-4; a string too short to
 * keep both is masked from index 3 (or fully masked). Never emit a raw phone on a confirmation card.
 */
export function maskPhone(phone: string): string {
  const value = typeof phone === 'string' ? phone : '';
  if (value.length <= 7) return value.length <= 3 ? '****' : `${value.slice(0, 3)}****`;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
