/**
 * Unit: `AppError` separates the INTERNAL message (logs, diagnostics) from a PUBLIC-SAFE one.
 *
 * `app/api/**` and `channels/weixin/**` render `AppError` text to the user, so an exception message
 * that carries an internal payload (`__SECURITY_BLOCK__…`, raw JSON, a stack trace) must never be
 * offered as public text: `publicMessage` is `undefined` then and the caller renders a catalog
 * fallback, while `message` and `detail` keep the original diagnostic for the logs.
 */
import { describe, expect, it } from 'vitest';

import { createTranslator } from '@/lib/i18n/shared';
import { AppError } from '@/lib/errors';
import { isInternalDiagnostic, publicErrorMessage } from '@/lib/public-text';

const HOSTILE = [
  '__SECURITY_BLOCK__{"decisionKind":"deny"}',
  '{"decisionKind":"deny"}',
  'Error: x\n    at y (f.ts:1:1)',
  'undefined',
  '[object Object]',
];

const BUSINESS_MESSAGE = 'Transfer amount must be positive.';

describe('AppError · internal diagnostic stays internal', () => {
  it.each(HOSTILE)('derives no public message from an internal diagnostic: %j', hostile => {
    expect(isInternalDiagnostic(hostile)).toBe(true);
    const original = new Error(hostile);
    const error = AppError.from(original);
    expect(error.message).toBe(hostile);
    expect(error.detail).toBe(original);
    expect(error.code).toBe('INTERNAL');
    expect(error.publicMessage).toBeUndefined();
  });

  it.each(['zh-CN', 'en'] as const)('renders the catalog fallback for a diagnostic in %s', locale => {
    const t = createTranslator(locale);
    for (const hostile of HOSTILE) {
      const rendered = publicErrorMessage(AppError.from(new Error(hostile)), t);
      expect(rendered).toBe(t('chat.error.toolFailed'));
      expect(rendered).not.toContain('__SECURITY_BLOCK__');
      expect(rendered).not.toContain('decisionKind');
      expect(rendered).not.toContain('at y');
      expect(rendered).not.toContain('[object Object]');
    }
  });

  it('sanitises a non-Error value and a directly constructed AppError identically', () => {
    const fromString = AppError.from(HOSTILE[0]);
    expect(fromString.message).toBe(HOSTILE[0]);
    expect(fromString.detail).toBeUndefined();
    expect(fromString.publicMessage).toBeUndefined();
    const direct = new AppError('INTERNAL', HOSTILE[1], { private: true });
    expect(direct.message).toBe(HOSTILE[1]);
    expect(direct.detail).toEqual({ private: true });
    expect(direct.publicMessage).toBeUndefined();
  });
});

describe('AppError · an ordinary business message stays renderable', () => {
  it.each(['zh-CN', 'en'] as const)('keeps and localises the business message in %s', locale => {
    const t = createTranslator(locale);
    const error = AppError.from(new Error(BUSINESS_MESSAGE));
    expect(error.publicMessage).toBe(BUSINESS_MESSAGE);
    expect(error.message).toBe(BUSINESS_MESSAGE);
    expect(publicErrorMessage(error, t)).toBe(t('chat.error.positiveTransfer'));
    expect(publicErrorMessage(error, t)).not.toBe(t('chat.error.toolFailed'));
  });

  it('renders a catalog-owned AppError message as its own key', () => {
    const t = createTranslator('zh-CN');
    const error = new AppError('MFA_LOCKED', t('chat.error.actionLocked'), { locked: true });
    expect(error.publicMessage).toBe(t('chat.error.actionLocked'));
    expect(publicErrorMessage(error, t)).toBe(t('chat.error.actionLocked'));
  });
});

describe('AppError.from / publicErrorMessage · contracts preserved', () => {
  it('returns an existing AppError unchanged', () => {
    const error = new AppError('VALIDATION', BUSINESS_MESSAGE, { field: 'amount' });
    expect(AppError.from(error)).toBe(error);
  });

  it('falls back to the catalog for missing or unknown text', () => {
    const t = createTranslator('en');
    expect(publicErrorMessage(undefined, t)).toBe(t('chat.error.toolFailed'));
    expect(publicErrorMessage(new Error('provider exploded'), t)).toBe(t('chat.error.toolFailed'));
    expect(publicErrorMessage('__SECURITY_BLOCK__{"decisionKind":"deny"}', t)).toBe(t('chat.error.toolFailed'));
    expect(publicErrorMessage(new Error('provider exploded'), t, 'chat.error.operationNotStarted')).toBe(
      t('chat.error.operationNotStarted'),
    );
  });
});
