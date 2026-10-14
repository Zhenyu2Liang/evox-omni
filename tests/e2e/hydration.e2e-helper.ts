import type { Browser, Page } from 'playwright-core';
import { SELECTORS, waitFor, waitForComposerHydration, withPage } from './helpers';
import { createTranslator } from '../../lib/i18n/shared';

/** Run before React starts; emulate an external browser integration modifying the root element. */
const ROOT_ATTRIBUTE_SCRIPT = `
  (() => {
    const apply = () => {
      if (!document.documentElement) return false;
      document.documentElement.setAttribute('data-redeviation-bs-uid', 'hydration-regression');
      return true;
    };
    if (!apply()) {
      const observer = new MutationObserver(() => {
        if (apply()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  })();
`;

const BODY_ATTRIBUTE_SCRIPT = `
  (() => {
    const apply = () => {
      if (!document.body) return false;
      document.body.setAttribute('data-hydration-child-probe', 'unmatched-child');
      return true;
    };
    if (!apply()) {
      const observer = new MutationObserver(() => {
        if (apply()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
  })();
`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** Verify root-attribute tolerance without concealing errors from the application subtree. */
export async function journeyHydration(browser: Browser, baseUrl: string): Promise<string> {
  for (const injectAttribute of [false, true]) {
    await withPage(browser, async page => {
      const errors = collectErrors(page);
      if (injectAttribute) await page.addInitScript(ROOT_ATTRIBUTE_SCRIPT);
      const response = await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded' });
      if (!response || !response.ok()) throw new Error('The anonymous assistant page did not load');
      const html = await response.text();
      if (html.includes('data-redeviation-bs-uid')) throw new Error('The external attribute appeared in the server response');
      await waitForComposerHydration(page);
      const injectedValue = await page.locator('html').getAttribute('data-redeviation-bs-uid');
      if ((injectedValue === 'hydration-regression') !== injectAttribute) {
        throw new Error('The browser-side root-attribute fixture was not applied');
      }
      const draft = 'Keep this draft without submitting a banking request.';
      const composer = page.locator(SELECTORS.composer);
      await composer.fill(draft);
      const language = page.locator('[data-locale-switcher="true"]:visible').first();
      await language.selectOption('en');
      await page.getByRole('heading', { name: createTranslator('en')('app.assistant'), exact: true }).waitFor();
      await waitFor(async () => await language.isEnabled(), { description: 'The language refresh has completed' });
      if (await composer.inputValue() !== draft) throw new Error('Hydration discarded the conversation draft');
      if (errors.length) throw new Error(`Browser errors (${injectAttribute ? 'injected' : 'clean'}): ${errors.join('; ')}`);
    }, { label: injectAttribute ? 'hydration-external-root-attribute' : 'hydration-clean-browser' });
  }
  await withPage(browser, async page => {
    const errors = collectErrors(page);
    await page.addInitScript(BODY_ATTRIBUTE_SCRIPT);
    await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await page.locator(SELECTORS.composer).fill('Check that descendant hydration diagnostics are still active.');
    await waitFor(async () => errors.some(message => /hydrat/i.test(message) && message.includes('data-hydration-child-probe')), {
      description: 'A descendant attribute mismatch still reports a hydration diagnostic',
    });
  }, { label: 'hydration-descendant-diagnostics' });
  return 'Clean and externally modified root elements hydrate without console errors; language switching and drafts work; descendant mismatches still report diagnostics';
}
