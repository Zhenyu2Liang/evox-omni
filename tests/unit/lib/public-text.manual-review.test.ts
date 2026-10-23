/**
 * Unit: a MANUAL-REVIEW HOLD is its own structured refusal.
 *
 * Symptom under test: a confirm/verify of a parked operation while its workflow is taken over by a
 * human review was rendered as the generic `chat.error.stateChanged` ("the operation state changed,
 * refresh…") sentence, which is actively misleading — refreshing does not help, the SAME operation
 * is simply waiting for the review to be released. The hold therefore has its own code
 * (`MANUAL_REVIEW_HOLD`) and its own reason (`manual_review_hold`), and BOTH render paths — the
 * `code` path (`publicToolError`) and the structured-`failure` path (`securityNotice`) — must
 * produce the SAME dedicated sentence.
 */
import { describe, expect, it } from 'vitest';

import { createTranslator } from '@/lib/i18n/shared';
import { publicSecurityError, publicToolError } from '@/lib/tool-feedback';
import { securityNotice, securityNoticeKey } from '@/lib/public-text';

/** The facts an HTTP action response carries for a held operation. */
const HOLD = { code: 'MANUAL_REVIEW_HOLD', reason: 'manual_review_hold', actionId: 'act_1' } as const;

const HOSTILE = [
  '__SECURITY_BLOCK__{"decisionKind":"deny"}',
  '{"decisionKind":"deny"}',
  'Error: x\n    at y (f.ts:1:1)',
  'undefined',
];

describe('manual review hold · typed fields are the only source of the copy', () => {
  it.each(['zh-CN', 'en'] as const)('renders the hold from its code in %s', locale => {
    const t = createTranslator(locale);
    const rendered = publicToolError(undefined, t, 'chat.error.stateChanged', 'MANUAL_REVIEW_HOLD');
    expect(rendered).toBe(t('chat.error.manualReviewHold'));
    expect(rendered).toContain('manual review');
    expect(rendered).not.toBe(t('chat.error.stateChanged'));
    expect(rendered).not.toContain('__SECURITY_BLOCK__');
    expect(rendered).not.toContain('decisionKind');
  });

  it.each(['zh-CN', 'en'] as const)('renders the code path and the failure path identically in %s', locale => {
    const t = createTranslator(locale);
    const dedicated = t('chat.error.manualReviewHold');
    expect(securityNoticeKey({ code: 'MANUAL_REVIEW_HOLD' })).toBe('chat.error.manualReviewHold');
    expect(securityNoticeKey({ reason: 'manual_review_hold' })).toBe('chat.error.manualReviewHold');
    expect(securityNoticeKey(HOLD)).toBe('chat.error.manualReviewHold');
    expect(securityNotice({ code: 'MANUAL_REVIEW_HOLD' }, t)).toBe(dedicated);
    expect(securityNotice({ reason: 'manual_review_hold' }, t)).toBe(dedicated);
    expect(securityNotice(HOLD, t)).toBe(dedicated);
    expect(publicSecurityError(HOLD, t)).toBe(dedicated);
    expect(publicSecurityError({ code: 'MANUAL_REVIEW_HOLD' }, t)).toBe(dedicated);
    expect(publicSecurityError(HOLD, t)).not.toBe(t('chat.error.securityDenied'));
    expect(publicSecurityError(HOLD, t)).not.toBe(t('chat.error.stateChanged'));
  });

  it.each(['zh-CN', 'en'] as const)('states that nothing was executed and how to recover in %s', locale => {
    const t = createTranslator(locale);
    const rendered = t('chat.error.manualReviewHold');
    expect(rendered).toContain('manual review');
    expect(rendered).not.toContain('刷新');
    expect(rendered).not.toContain('Refresh');
    expect(rendered).not.toContain('state changed');
    expect(rendered).not.toContain('状态已变化');
    for (const hostile of HOSTILE) {
      expect(rendered).not.toContain(hostile);
    }
  });

  it.each(['zh-CN', 'en'] as const)('keeps CONFLICT on the generic state-changed sentence in %s', locale => {
    const t = createTranslator(locale);
    expect(publicToolError(undefined, t, 'chat.error.toolFailed', 'CONFLICT')).toBe(t('chat.error.stateChanged'));
    expect(securityNotice({ code: 'CONFLICT', reason: 'denied' }, t)).toBe(t('chat.error.securityDenied'));
    expect(publicToolError('Some refusal text.', t, 'chat.error.stateChanged', 'CONFLICT'))
      .toBe(t('chat.error.stateChanged'));
  });

  it.each(['zh-CN', 'en'] as const)('still refuses to render an internal diagnostic as the hold in %s', locale => {
    const t = createTranslator(locale);
    for (const hostile of HOSTILE) {
      // An unknown code never becomes copy: the fallback applies, never the payload.
      expect(publicToolError(hostile, t, 'chat.error.toolFailed', 'MANUAL_REVIEW_HOLD')).toBe(
        t('chat.error.manualReviewHold'),
      );
      expect(publicToolError(hostile, t, 'chat.error.toolFailed')).toBe(t('chat.error.toolFailed'));
      expect(securityNotice({ code: hostile, reason: hostile }, t)).toBe(t('chat.error.securityDenied'));
    }
  });
});
