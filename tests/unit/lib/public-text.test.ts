/**
 * Unit: `@/lib/public-text` — the ONE funnel that turns internal diagnostics into public text.
 *
 * Nothing that smells like an internal diagnostic (the opaque block-reason marker, raw JSON,
 * a stack trace, `undefined`, `[object Object]`) may ever reach the user. Only catalog-owned i18n
 * text, allow-listed exact messages and allow-listed regexes are rendered; everything else falls
 * back to a catalog message. Structured refusals are rendered from their TYPED fields, never from
 * string matching.
 */
import { describe, expect, it } from 'vitest';

import { createTranslator } from '@/lib/i18n/shared';
import { publicToolError } from '@/lib/tool-feedback';
import { isInternalDiagnostic, safePublicText, securityNotice } from '@/lib/public-text';

const HOSTILE_INPUTS = [
  '__SECURITY_BLOCK__{"decisionKind":"deny"}',
  '__SECURITY_BLOCK__{"actionId":"pa_1","decisionKind":"require_mfa"}',
  '{"decisionKind":"deny"}',
  '{"attemptsLeft":0,"maxAttempts":3}',
  'TypeError: cannot read properties of undefined\n    at foo (file.ts:1:1)',
  'Error: internal provider exploded',
  'undefined',
  '[object Object]',
];

describe('public-text · internal diagnostics never reach the user', () => {
  it.each(['zh-CN', 'en'] as const)('classifies internal diagnostics in %s', locale => {
    const t = createTranslator(locale);
    for (const input of HOSTILE_INPUTS) {
      expect(isInternalDiagnostic(input)).toBe(true);
      expect(safePublicText(input, t, 'chat.error.toolFailed')).toBe(t('chat.error.toolFailed'));
      expect(publicToolError(input, t)).toBe(t('chat.error.toolFailed'));
    }
  });

  it('never echoes the raw diagnostic text back', () => {
    const t = createTranslator('zh-CN');
    for (const input of HOSTILE_INPUTS) {
      const rendered = safePublicText(input, t, 'chat.error.toolFailed');
      expect(rendered).not.toContain('__SECURITY_BLOCK__');
      expect(rendered).not.toContain('decisionKind');
      expect(rendered).not.toContain('at foo');
      expect(rendered).toBe(t('chat.error.toolFailed'));
    }
    expect(safePublicText(undefined, t, 'chat.error.toolFailed')).toBe(t('chat.error.toolFailed'));
  });

  it('keeps allow-listed business errors localizable', () => {
    const t = createTranslator('en');
    expect(publicToolError('Insufficient funds: balance 10.00 < amount 20.00', t)).toBe(
      t('chat.error.insufficientFunds', { balance: '10.00', amount: '20.00' }),
    );
    expect(safePublicText('Insufficient funds: balance 10.00 < amount 20.00', t, 'chat.error.toolFailed')).toBe(
      t('chat.error.insufficientFunds', { balance: '10.00', amount: '20.00' }),
    );
    expect(isInternalDiagnostic('Insufficient funds: balance 10.00 < amount 20.00')).toBe(false);
    expect(isInternalDiagnostic('Transfer amount must be positive.')).toBe(false);
    expect(isInternalDiagnostic(undefined)).toBe(false);
  });
});

describe('public-text · structured security notices', () => {
  it.each(['zh-CN', 'en'] as const)('renders retryable verification failures with the remaining attempts in %s', locale => {
    const t = createTranslator(locale);
    expect(securityNotice({ code: 'MFA_FAILED', reason: 'mfa_code_invalid', attemptsLeft: 2 }, t)).toBe(
      t('chat.error.verificationRemaining', { count: 2 }),
    );
  });

  it.each(['zh-CN', 'en'] as const)('renders the terminal lock from typed fields in %s', locale => {
    const t = createTranslator(locale);
    const exhausted = securityNotice(
      { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', attemptsLeft: 0, maxAttempts: 3 },
      t,
    );
    expect(exhausted).toBe(t('chat.error.actionLocked'));
    expect(exhausted.length).toBeGreaterThan(0);
    expect(securityNotice({ code: 'CIRCUIT_OPEN', reason: 'circuit_open' }, t)).toBe(t('chat.error.securityLocked'));
    expect(securityNotice({ code: 'CIRCUIT_OPEN', reason: 'mfa_session_locked' }, t)).toBe(t('chat.error.securityLocked'));
    expect(securityNotice({ code: 'SECURITY_DENIED', reason: 'denied' }, t)).toBe(t('chat.error.securityDenied'));
  });

  it('renders a locked security event without any internal payload', () => {
    const t = createTranslator('zh-CN');
    expect(securityNotice({ kind: 'locked', code: 'CIRCUIT_OPEN', reason: 'circuit_open' }, t)).toBe(
      t('chat.error.securityLocked'),
    );
    expect(securityNotice({ kind: 'locked', code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', attemptsLeft: 0 }, t)).toBe(
      t('chat.error.actionLocked'),
    );
  });
});
