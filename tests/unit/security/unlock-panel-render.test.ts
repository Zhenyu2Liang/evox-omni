/**
 * `app/security/UnlockPanel.tsx` — the ONE runtime unlock entry of the Security Center.
 *
 * WHY THIS SPEC EXISTS: `/security` (`app/security/page.tsx`) is an async Server Component that
 * awaits `cookies()` / `requireIdentity()` / the DB, so it cannot be called from a Node test. The
 * page renders `UnlockPanel` UNCONDITIONALLY (both breaker states), which makes the panel the
 * unit-testable proxy for the page's unlock surface.
 *
 * PAGE-LEVEL INVARIANTS — KEEP STABLE, the browser suite keys off them:
 *   - the panel root carries `data-unlock-panel` (plus `data-unlock-locked` / `-failures` /
 *     `-max-attempts` / `-locked-actions` for the authoritative state),
 *   - the verification-code input's `aria-label` equals the `security.reset.codeLabel` catalog
 *     value (zh-CN: `6 位验证码`),
 *   - the panel exists in the UNLOCKED state too, so any e2e "no developer code input" assertion
 *     must scope itself to the developer-only reset area instead of the whole page.
 *
 * UNLOCK SEMANTICS NOTICE (prose pinned by `./unlock-panel-notice.test.ts`, not here):
 *   the panel renders all four `security.reset.*` facts straight from
 *   `lib/i18n/messages/business.zh-CN.json`: `lockReason` (interpolated from the authoritative
 *   breaker state), `lockedActionState`, `reinitiate` (「解锁后需重新发起并重新确认，原操作不会自动执行。」)
 *   and `recovery`. The re-initiate sentence sits in the `<p>` carrying `data-unlock-reinitiate`, in
 *   BOTH breaker states — pinned by `./unlock-panel-notice.test.ts`; THIS spec owns the panel
 *   attributes (`data-unlock-panel` / `-locked` / `-failures` / `-max-attempts` / `-locked-actions` /
 *   `-impact` / `-status`), the single code-input shape and the no-internal-diagnostic boundary.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UnlockPanel } from '@/app/security/UnlockPanel';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { createTranslator } from '@/lib/i18n/shared';
import { MFA_CODE } from '@/lib/constants';

// `UnlockPanel` is a client component calling `useRouter`; it is inert outside the bundler.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));

const t = createTranslator('zh-CN');

const LOCKED = { locked: true, failures: 3, maxAttempts: 3, lockedActionCount: 1 } as const;
const UNLOCKED = { locked: false, failures: 0, maxAttempts: 3, lockedActionCount: 0 } as const;

/** Server-render the panel at the product's default locale (the page's Chinese demo default). */
function render(props: {
  locked: boolean;
  failures: number;
  maxAttempts: number;
  lockedActionCount: number;
}): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: 'zh-CN',
      children: createElement(UnlockPanel, { ...props }),
    }),
  );
}

/**
 * React separates adjacent text children with `<!-- -->` comments in static markup.
 * Strip them before asserting prose so the assertions target what the user reads.
 */
function text(markup: string): string {
  return markup.replace(/<!-- -->/g, '');
}

describe('security-center unlock panel render contract', () => {
  it('renders the authoritative lock attributes and the locked-action impact block', () => {
    const markup = render(LOCKED);

    expect(markup).toContain('data-unlock-panel');
    expect(markup).toContain('data-unlock-locked="true"');
    expect(markup).toContain('data-unlock-failures="3"');
    expect(markup).toContain('data-unlock-max-attempts="3"');
    expect(markup).toContain('data-unlock-locked-actions="1"');

    // The impact block explains WHAT stays locked, with the locked-action count as its fact.
    expect(markup).toContain('data-unlock-impact="1"');
    const impact = markup.slice(markup.indexOf('data-unlock-impact="1"'));
    expect(text(impact)).toContain(t('security.breaker.lockedDescription'));
    expect(text(impact)).toContain(`${t('pages.activity.status.locked')} · 1`);
  });

  it('states the lock reason and the unlock explanation using the real catalog values', () => {
    const markup = render(LOCKED);

    // Lock reason: the breaker tripped after `maxAttempts` consecutive failures.
    expect(markup).toContain(t('security.breaker.lockedDescription'));
    // Why the operation is stuck, and where the user must go.
    expect(markup).toContain(t('chat.error.actionLocked'));
    // The breaker explanation the panel always shows.
    expect(markup).toContain(t('pages.security.unlockDescription'));

    // The re-initiate half of the unlock semantics, pinned to the value actually rendered.
    const reinitiate = '请在安全中心解除限制后重新发起操作';
    expect(t('chat.error.actionLocked')).toContain(reinitiate);
    expect(text(markup)).toContain(reinitiate);
  });

  it('renders exactly one verification-code input labelled by the catalog code label, plus submit', () => {
    const markup = render(LOCKED);
    const codeLabel = t('security.reset.codeLabel');
    expect(codeLabel).toBe('6 位验证码');

    // ONE code entry — the page must never offer a second credential path here.
    expect(markup.match(/<input/g)).toHaveLength(1);
    // The selector the browser suite keys off.
    expect(markup.match(new RegExp(`aria-label="${codeLabel}"`, 'g'))).toHaveLength(1);
    expect(markup).toContain('name="verificationCode"');
    expect(markup).toContain('inputMode="numeric"');
    expect(markup).toContain('autoComplete="one-time-code"');
    expect(markup).toContain('maxLength="6"');

    // Submit affordance, plus the persistent live region that will announce the result.
    expect(markup).toContain('type="submit"');
    expect(text(markup)).toContain(t('security.reset.unlock'));
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-unlock-status="idle"');
  });

  it('leaks no internal diagnostic and never prints the demo verification code', () => {
    const markup = render(LOCKED);

    for (const forbidden of [
      '__SECURITY_BLOCK__',
      '{"decisionKind"',
      'Error:',
      '<script',
      'undefined',
      '[object Object]',
      MFA_CODE,
    ]) {
      expect(markup).not.toContain(forbidden);
    }
    expect(markup).not.toMatch(/\n\s+at\s/);
    expect(markup).not.toMatch(/\bat\s+[A-Za-z0-9_$./\\-]+:\d+/);
    expect(MFA_CODE).toBe('123456');
  });

  it('still renders while the account is unlocked — without the locked-action impact block', () => {
    const markup = render(UNLOCKED);

    // This is exactly why the browser suite must scope its "no developer code input" assertion:
    // the runtime unlock entry is present in both states.
    expect(markup).toContain('data-unlock-panel');
    expect(markup).toContain('data-unlock-locked="false"');
    expect(markup).toContain('data-unlock-failures="0"');
    expect(markup).toContain('data-unlock-max-attempts="3"');
    expect(markup).toContain('data-unlock-locked-actions="0"');
    expect(markup).not.toContain('data-unlock-impact');
    expect(text(markup)).not.toContain(t('security.breaker.lockedDescription'));

    // The same code input (and submit affordance) exists while unlocked.
    expect(markup.match(/<input/g)).toHaveLength(1);
    expect(markup).toContain(`aria-label="${t('security.reset.codeLabel')}"`);
    expect(markup).toContain('type="submit"');
  });
});
