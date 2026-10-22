/**
 * Unit: a TERMINAL MFA lock must be rendered from the SERVER's structured fields.
 *
 * Symptom under test: after the third wrong verification code the user saw the generic fallback
 * (`chat.error.toolFailed`) instead of the lock reason, and the gateway's internal marker
 * (`__SECURITY_BLOCK__{"decisionKind":"deny"}`) was at risk of being shown. The main path is the
 * typed refusal (`code` / `reason` / `attemptsLeft`); the exact gateway sentences are only a
 * compatibility path for already-persisted text, and NO internal diagnostic may ever be rendered.
 */
import { describe, expect, it } from 'vitest';

import { createTranslator } from '@/lib/i18n/shared';
import { publicSecurityError, publicToolError } from '@/lib/tool-feedback';
import { securityNotice, securityNoticeKey } from '@/lib/public-text';

/** The exact sentences the authorization outcome carries (`security/security-gateway.ts`). */
const GATEWAY = {
  /** `lockedOutcome` — terminal lock of the action itself. */
  lockedOutcome: '当前会话已触发安全熔断，操作已被拒绝。请前往安全中心解除限制后再试。',
  /** `gatewayDecide` deny branch — session-wide circuit breaker. */
  highRiskBlocked: '当前会话已触发安全熔断，高风险操作已被锁定。请前往安全中心解除限制后再试。',
  /** Exhausted verification attempts (operation level, still `CIRCUIT_OPEN` as the wire code). */
  attemptsExhausted: '验证码错误次数过多，本会话高风险操作已被锁定。请前往安全中心解除限制后再试。',
};

const HOSTILE = [
  '__SECURITY_BLOCK__{"decisionKind":"deny"}',
  '{"decisionKind":"deny"}',
  'Error: x\n    at y (f.ts:1:1)',
  'undefined',
  '[object Object]',
];

const LOCKED_FAILURE = { code: 'MFA_LOCKED', reason: 'mfa_attempts_exhausted', attemptsLeft: 0, maxAttempts: 3 } as const;

describe('structured MFA lock · typed fields are the main path', () => {
  it.each(['zh-CN', 'en'] as const)('renders an exhausted verification as a locked action in %s', locale => {
    const t = createTranslator(locale);
    expect(securityNoticeKey(LOCKED_FAILURE)).toBe('chat.error.actionLocked');
    expect(securityNotice(LOCKED_FAILURE, t)).toBe(t('chat.error.actionLocked'));
    expect(publicSecurityError(LOCKED_FAILURE, t)).toBe(t('chat.error.actionLocked'));
    expect(publicSecurityError(LOCKED_FAILURE, t)).not.toBe(t('chat.error.toolFailed'));
    expect(publicToolError('whatever the server said', t, 'chat.error.toolFailed', 'MFA_LOCKED')).toBe(
      t('chat.error.actionLocked'),
    );
  });

  it.each(['zh-CN', 'en'] as const)('keeps the session breaker distinct from the action lock in %s', locale => {
    const t = createTranslator(locale);
    expect(securityNoticeKey({ code: 'CIRCUIT_OPEN', reason: 'circuit_open' })).toBe('chat.error.securityLocked');
    expect(securityNoticeKey({ code: 'CIRCUIT_OPEN', reason: 'mfa_session_locked' })).toBe(
      'chat.error.securityLocked',
    );
    expect(publicSecurityError({ code: 'CIRCUIT_OPEN', reason: 'circuit_open' }, t)).toBe(t('chat.error.securityLocked'));
    expect(publicSecurityError({ code: 'CIRCUIT_OPEN', reason: 'circuit_open' }, t)).not.toBe(
      publicSecurityError(LOCKED_FAILURE, t),
    );
  });

  it.each(['zh-CN', 'en'] as const)('forwards the remaining attempts of a retryable failure in %s', locale => {
    const t = createTranslator(locale);
    const failure = { code: 'MFA_FAILED', reason: 'mfa_code_invalid', attemptsLeft: 2, maxAttempts: 3 } as const;
    expect(securityNoticeKey(failure)).toBe('chat.error.verificationRemaining');
    expect(publicSecurityError(failure, t)).toBe(t('chat.error.verificationRemaining', { count: 2 }));
  });

  it.each(['zh-CN', 'en'] as const)('falls back to the denial notice without typed facts in %s', locale => {
    const t = createTranslator(locale);
    expect(securityNoticeKey(undefined)).toBe('chat.error.securityDenied');
    expect(securityNoticeKey({ code: 'SECURITY_DENIED', reason: 'denied' })).toBe('chat.error.securityDenied');
    expect(publicSecurityError(undefined, t)).toBe(t('chat.error.securityDenied'));
    expect(publicSecurityError({}, t)).toBe(t('chat.error.securityDenied'));
    expect(publicSecurityError(undefined, t, 'chat.error.toolFailed')).toBe(t('chat.error.toolFailed'));
  });
});

describe('gateway sentences · compatibility path for already-persisted text', () => {
  it.each(['zh-CN', 'en'] as const)('renders the terminal lock sentence as the action lock in %s', locale => {
    const t = createTranslator(locale);
    const rendered = publicToolError(GATEWAY.lockedOutcome, t, 'chat.error.toolFailed');
    expect(rendered).toBe(t('chat.error.actionLocked'));
    expect(rendered).not.toBe(t('chat.error.toolFailed'));
  });

  it.each(['zh-CN', 'en'] as const)('renders the session breaker sentence as the security lock in %s', locale => {
    const t = createTranslator(locale);
    const rendered = publicToolError(GATEWAY.highRiskBlocked, t, 'chat.error.toolFailed');
    expect(rendered).toBe(t('chat.error.securityLocked'));
    expect(rendered).not.toBe(t('chat.error.toolFailed'));
  });

  it.each(['zh-CN', 'en'] as const)('renders the exhausted-attempts sentence as the action lock in %s', locale => {
    const t = createTranslator(locale);
    const rendered = publicToolError(GATEWAY.attemptsExhausted, t, 'chat.error.toolFailed');
    expect(rendered).toBe(t('chat.error.actionLocked'));
    expect(rendered).not.toBe(t('chat.error.toolFailed'));
  });
});

describe('sanitisation does not regress', () => {
  it.each(['zh-CN', 'en'] as const)('never renders an internal diagnostic through the new entries in %s', locale => {
    const t = createTranslator(locale);
    for (const hostile of HOSTILE) {
      const structured = publicSecurityError({ code: hostile, reason: hostile, attemptsLeft: 0 }, t);
      expect(structured).toBe(t('chat.error.securityDenied'));
      const compat = publicToolError(hostile, t, 'chat.error.toolFailed');
      expect(compat).toBe(t('chat.error.toolFailed'));
      for (const rendered of [structured, compat, publicSecurityError(undefined, t)]) {
        expect(rendered).not.toContain('__SECURITY_BLOCK__');
        expect(rendered).not.toContain('decisionKind');
        expect(rendered).not.toContain('at y');
        expect(rendered).not.toContain('[object Object]');
      }
    }
  });
});
