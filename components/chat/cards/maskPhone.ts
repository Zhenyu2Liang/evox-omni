/**
 * Masks a phone number for display (脱敏), degrading gracefully for short/absent input.
 *
 * - absent / empty / whitespace-only → `''`
 * - trimmed length ≤ 4 → fully masked (`'****'`)
 * - trimmed length 5–10 → first 2 + masked middle + last 2 (7 chars → `'13***45'`)
 * - trimmed length ≥ 11 → first 3 + exactly 4 stars + last 4 (11-digit → `'138****5678'`)
 */
export function maskPhone(phone?: string | null): string {
  const trimmed = phone?.trim() ?? '';
  if (trimmed.length === 0) return '';
  if (trimmed.length <= 4) return '****';
  if (trimmed.length <= 10) {
    return trimmed.slice(0, 2) + '*'.repeat(trimmed.length - 4) + trimmed.slice(-2);
  }
  return trimmed.slice(0, 3) + '****' + trimmed.slice(-4);
}
