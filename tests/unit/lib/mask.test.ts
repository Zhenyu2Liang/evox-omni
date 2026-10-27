/**
 * mask.test.ts — PURE (no DB, no model) unit spec for `lib/mask.ts`, the single display-masking
 * implementation (展示脱敏).
 *
 * Frozen contract under test:
 *  - `maskAccountNumber` / `maskCardNumber`: keep the last 4 characters, replace every earlier
 *    character with `*`, preserve the total length, be idempotent for already-masked input and
 *    return short input (length ≤ 4) unchanged instead of throwing.
 *  - `maskPhone`: `null` / `undefined` / `''` → `''`, otherwise first 3 + `****` + last 4.
 *  - `lib/phone.ts` RE-EXPORTS `maskPhone` from `lib/mask.ts`; it does not hold a second copy.
 */
import { describe, expect, it } from 'vitest';
import { maskAccountNumber, maskCardNumber, maskPhone } from '@/lib/mask';
import { maskPhone as maskPhoneFromPhoneModule } from '@/lib/phone';

const ACCOUNT = '6222021234568821';
const MASKED_ACCOUNT = '************8821';

/** Independent statement of the tail-4 rule: only the last 4 characters survive, length is kept. */
function expectedTail4(value: string): { masked: string; length: number } {
  return { masked: '*'.repeat(value.length - 4) + value.slice(-4), length: value.length };
}

describe('maskAccountNumber — tail-4 masking with preserved length', () => {
  it('masks a 16-digit account number to 12 stars plus the last 4 digits', () => {
    const masked = maskAccountNumber(ACCOUNT);
    expect(masked).toBe(MASKED_ACCOUNT);
    expect(masked).toBe(expectedTail4(ACCOUNT).masked);
  });

  it('preserves the input length exactly (16 characters in, 16 out)', () => {
    expect(maskAccountNumber(ACCOUNT)).toHaveLength(16);
    expect(maskAccountNumber(ACCOUNT)).toHaveLength(ACCOUNT.length);
  });

  it('is idempotent for already-masked input', () => {
    expect(maskAccountNumber('****8821')).toBe('****8821');
    expect(maskAccountNumber(maskAccountNumber(ACCOUNT))).toBe(maskAccountNumber(ACCOUNT));
  });

  it('returns short input unchanged instead of throwing', () => {
    expect(() => maskAccountNumber('8821')).not.toThrow();
    expect(maskAccountNumber('8821')).toBe('8821');
  });

  it('keeps only the last 4 characters readable and never yields the full input', () => {
    const masked = maskAccountNumber(ACCOUNT);
    expect(masked).not.toBe(ACCOUNT);
    expect(masked).not.toContain(ACCOUNT);
    expect(masked.slice(-4)).toBe(ACCOUNT.slice(-4));
    expect(masked.slice(0, -4)).toBe('*'.repeat(ACCOUNT.length - 4));
  });
});

describe('maskCardNumber — same rule as account numbers', () => {
  it('masks a long card number to 12 stars plus the last 4 digits', () => {
    const masked = maskCardNumber(ACCOUNT);
    expect(masked).toBe(MASKED_ACCOUNT);
    expect(masked).toHaveLength(ACCOUNT.length);
  });

  it('is idempotent for already-masked card input', () => {
    expect(maskCardNumber('****8821')).toBe('****8821');
    expect(maskCardNumber(maskCardNumber(ACCOUNT))).toBe(maskCardNumber(ACCOUNT));
  });

  it('returns short card input unchanged instead of throwing', () => {
    expect(() => maskCardNumber('8821')).not.toThrow();
    expect(maskCardNumber('8821')).toBe('8821');
  });

  it('keeps only the last 4 characters readable and never yields the full input', () => {
    const masked = maskCardNumber(ACCOUNT);
    expect(masked).not.toBe(ACCOUNT);
    expect(masked).not.toContain(ACCOUNT);
    expect(masked.slice(-4)).toBe(ACCOUNT.slice(-4));
    expect(masked.slice(0, -4)).toBe('*'.repeat(ACCOUNT.length - 4));
  });

  it('agrees with maskAccountNumber on the same value', () => {
    expect(maskCardNumber(ACCOUNT)).toBe(maskAccountNumber(ACCOUNT));
  });
});

describe('maskPhone — prefix + **** + suffix', () => {
  it('keeps the first 3 and last 4 digits of a mobile number', () => {
    const masked = maskPhone('13812345678');
    expect(masked).toBe('138****5678');
    expect(masked.slice(0, 3)).toBe('138');
    expect(masked.slice(-4)).toBe('5678');
  });

  it('never yields the full original phone number', () => {
    const masked = maskPhone('13812345678');
    expect(masked).not.toBe('13812345678');
    expect(masked).not.toContain('13812345678');
    expect(masked).toContain('****');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['the empty string', ''],
  ])('renders an absent value (%s) as an empty string, not stars', (_label, input) => {
    expect(maskPhone(input)).toBe('');
  });

  it('is idempotent for already-masked phone input', () => {
    expect(maskPhone('138****5678')).toBe('138****5678');
  });
});

describe('lib/phone.ts re-exports the single masking implementation', () => {
  it('exposes the exact same maskPhone function reference as lib/mask.ts', () => {
    expect(maskPhoneFromPhoneModule).toBe(maskPhone);
  });

  it('produces identical output through both import paths', () => {
    expect(maskPhoneFromPhoneModule('13812345678')).toBe(maskPhone('13812345678'));
  });
});
