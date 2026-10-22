/**
 * `app/security/UnlockPanel.tsx` — the mandatory unlock-semantics notice.
 *
 * WHY THIS SPEC EXISTS: the panel used to carry only two prose paragraphs
 * (`pages.security.unlockDescription` + `chat.error.actionLocked`), which explain THAT operations stay
 * locked and WHERE to lift the limit, but never that clearing the breaker is not a recovery: the
 * original operation stays terminal, nothing is retried or executed automatically, and the user must
 * start the request again and confirm it again. `security.reset.lockReason` /
 * `security.reset.lockedActionState` / `security.reset.reinitiate` / `security.reset.recovery` supply
 * those four facts; this spec pins them to the DOM.
 *
 * UNIT-TESTABLE PROXY: `/security` (`app/security/page.tsx`) is an async Server Component awaiting
 * `cookies()` / the DB, so the panel is rendered here directly (same harness as
 * `./unlock-panel-render.test.ts`).
 *
 * The `data-unlock-reinitiate` hook is the browser suite's anchor: it must exist in BOTH breaker
 * states and must carry the whole sentence.
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

/** The literal sentence users must read; pinned verbatim so a paraphrase cannot slip in. */
const REINITIATE = '解锁后需重新发起并重新确认，原操作不会自动执行。';

const LOCKED = { locked: true, failures: 3, maxAttempts: 3, lockedActionCount: 1 } as const;
const UNLOCKED = { locked: false, failures: 0, maxAttempts: 3, lockedActionCount: 0 } as const;

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

/** React separates adjacent text children with `<!-- -->` in static markup, so assert what is read. */
function text(markup: string): string {
  return markup.replace(/<!-- -->/g, '');
}

describe('security-center unlock panel semantics notice', () => {
  it('renders all four security.reset semantics values while the account is locked', () => {
    const prose = text(render(LOCKED));

    // Lock reason, interpolated from the authoritative breaker state.
    expect(prose).toContain(t('security.reset.lockReason', { count: 3, max: 3 }));
    expect(prose).toContain('连续验证失败 3 / 3 次');
    // Current state of the already-locked operation.
    expect(prose).toContain(t('security.reset.lockedActionState'));
    // The mandatory re-initiate notice, verbatim.
    expect(prose).toContain(t('security.reset.reinitiate'));
    expect(prose).toContain(REINITIATE);
    // How the security center actually unlocks, and what that does (and does not) clear.
    expect(prose).toContain(t('security.reset.recovery'));
  });

  it('tags the mandatory re-initiate paragraph with data-unlock-reinitiate', () => {
    const markup = render(LOCKED);
    expect(markup).toContain('data-unlock-reinitiate');

    // The hook must sit on the element that CARRIES the sentence, not on a sibling.
    const region = text(markup.slice(markup.indexOf('data-unlock-reinitiate')));
    const element = region.slice(0, region.indexOf('</p>') + '</p>'.length);
    expect(element).toContain(REINITIATE);
  });

  it('interpolates the lock-reason template instead of leaking placeholders', () => {
    // The catalog template really is parameterised ...
    expect(t('security.reset.lockReason')).toContain('{count}');
    expect(t('security.reset.lockReason')).toContain('{max}');

    // ... and a different authoritative state renders different numbers, with no residue.
    const prose = text(render({ locked: true, failures: 2, maxAttempts: 5, lockedActionCount: 0 }));
    expect(prose).toContain(t('security.reset.lockReason', { count: 2, max: 5 }));
    expect(prose).toContain('连续验证失败 2 / 5 次');
    expect(prose).not.toContain('{count}');
    expect(prose).not.toContain('{max}');
  });

  it('keeps every pre-existing unlock hook in both breaker states', () => {
    const locked = render(LOCKED);
    for (const hook of [
      'data-unlock-panel',
      'data-unlock-locked="true"',
      'data-unlock-failures="3"',
      'data-unlock-max-attempts="3"',
      'data-unlock-locked-actions="1"',
      'data-unlock-impact="1"',
      'data-unlock-status="idle"',
      'data-unlock-reinitiate',
    ]) {
      expect(locked).toContain(hook);
    }

    const unlocked = render(UNLOCKED);
    for (const hook of [
      'data-unlock-panel',
      'data-unlock-locked="false"',
      'data-unlock-failures="0"',
      'data-unlock-max-attempts="3"',
      'data-unlock-locked-actions="0"',
      'data-unlock-status="idle"',
      'data-unlock-reinitiate',
    ]) {
      expect(unlocked).toContain(hook);
    }
    expect(unlocked).not.toContain('data-unlock-impact');
  });

  it('states the unlock semantics while unlocked too, but no lock reason', () => {
    const prose = text(render(UNLOCKED));

    // The semantics are not a locked-only decoration: both states carry the re-initiate contract.
    expect(prose).toContain(REINITIATE);
    expect(prose).toContain(t('security.reset.recovery'));
    expect(prose).toContain(t('security.reset.lockedActionState'));
    // A lock reason without a lock would be a false fact.
    expect(prose).not.toContain('锁定原因：');
    expect(prose).not.toContain('{count}');
  });

  it('leaks no internal diagnostic and never prints the demo verification code', () => {
    for (const props of [LOCKED, UNLOCKED]) {
      const markup = render(props);

      for (const forbidden of [
        '__SECURITY_BLOCK__',
        '{"decisionKind"',
        'Error:',
        'undefined',
        '[object Object]',
        MFA_CODE,
      ]) {
        expect(markup).not.toContain(forbidden);
      }
      expect(markup).not.toMatch(/\n\s+at\s/);
    }
  });
});