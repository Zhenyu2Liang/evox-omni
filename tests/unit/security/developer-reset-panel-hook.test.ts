/**
 * `app/security/ResetBreakerButton.tsx` — the developer-only breaker maintenance entry.
 *
 * WHY THIS SPEC EXISTS: the browser suite can currently only reach this widget through a structural
 * selector (`div:has(> button[data-developer-breaker-reset])`), which breaks the moment the wrapper
 * gains a class, an extra node or a reordering. The widget exposes a stable panel hook
 * (`data-developer-breaker-reset-panel`) so browser assertions can scope themselves to it — a
 * distinction that matters because `UnlockPanel` is present in BOTH breaker states and for
 * non-developers too, so "there is no developer reset here" must be scoped, not page-wide.
 *
 * Rendered with `react-dom/server` and the real providers (`DeveloperModeProvider` gates the widget,
 * `LocaleProvider` supplies the catalog) — no DOM environment needed.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ResetBreakerButton } from '@/app/security/ResetBreakerButton';
import { DeveloperModeProvider } from '@/lib/developer-mode/DeveloperModeProvider';
import { LocaleProvider } from '@/lib/i18n/LocaleProvider';
import { createTranslator } from '@/lib/i18n/shared';

// Both providers consult the Next router (`useRouter` / `usePathname`); inert outside the bundler.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/security',
}));

const t = createTranslator('zh-CN');

function render(enabled: boolean): string {
  return renderToStaticMarkup(
    createElement(LocaleProvider, {
      initialLocale: 'zh-CN',
      children: createElement(DeveloperModeProvider, {
        initialEnabled: enabled,
        children: createElement(ResetBreakerButton, {}),
      }),
    }),
  );
}

describe('developer breaker reset widget hooks', () => {
  it('exposes a stable panel hook wrapping the reset button in developer mode', () => {
    const markup = render(true);

    expect(markup).toContain('data-developer-breaker-reset-panel');
    expect(markup).toContain('data-developer-breaker-reset');

    // The panel hook must wrap the button, so `[data-developer-breaker-reset-panel]` scoping works.
    const region = markup.slice(markup.indexOf('data-developer-breaker-reset-panel'));
    const panel = region.slice(0, region.indexOf('</div>'));
    expect(panel.startsWith('data-developer-breaker-reset-panel')).toBe(true);
    expect(panel).toContain('data-developer-breaker-reset');

    // The developer-only copy lives inside the panel too.
    expect(markup.replace(/<!-- -->/g, '')).toContain(t('security.reset.developerOnly'));
  });

  it('renders nothing at all without developer mode — including the panel hook', () => {
    const markup = render(false);

    expect(markup).toBe('');
    expect(markup).not.toContain('data-developer-breaker-reset-panel');
    expect(markup).not.toContain('data-developer-breaker-reset');
  });
});