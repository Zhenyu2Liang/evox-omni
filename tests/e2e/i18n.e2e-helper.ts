import type { Browser, Page } from 'playwright-core';
import { createTranslator, LOCALE_COOKIE, type Locale } from '../../lib/i18n/shared';
import {
  SELECTORS,
  captureScreenshot,
  fetchLedger,
  waitFor,
  waitForComposerHydration,
  waitForElementHydration,
  withPage,
} from './helpers';

const LANGUAGE_SWITCHER = '[data-locale-switcher="true"]:visible';
const MESSAGE_SELECTOR = '[data-message-id]';

async function assertLocale(page: Page, locale: Locale): Promise<void> {
  await waitFor(async () => {
    const language = await page.locator('html').getAttribute('lang');
    const selected = await page.locator(LANGUAGE_SWITCHER).first().inputValue();
    return language === locale && selected === locale;
  }, { description: `The document and visible language switcher use ${locale}` });
}

async function changeLocale(page: Page, locale: Locale): Promise<void> {
  const control = page.locator(LANGUAGE_SWITCHER).first();
  await waitForElementHydration(page, '[data-locale-switcher="true"]');
  await waitFor(async () => await control.isEnabled(), { description: 'The language switcher is ready' });
  await control.selectOption(locale);
  await assertLocale(page, locale);
  await waitFor(async () => await control.isEnabled(), { description: 'Server-rendered translations have refreshed' });
}

async function readMessageIds(page: Page): Promise<string[]> {
  return page.locator(MESSAGE_SELECTOR).evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id') ?? ''));
}

async function assertHistory(page: Page, expected: string[]): Promise<void> {
  await waitFor(async () => JSON.stringify(await readMessageIds(page)) === JSON.stringify(expected), {
    description: 'Persisted message identities remain unchanged',
  });
}

/** Verify localized server pages and navigation without resubmitting banking operations. */
export async function journeyI18n(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    const chinese = createTranslator('zh-CN');
    const english = createTranslator('en');
    const errors: string[] = [];
    const apiPosts: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const pathname = new URL(request.url()).pathname;
      if (request.method() === 'POST' && pathname.startsWith('/api/')) apiPosts.push(pathname);
    });
    // Exercise an English browser preference with no saved application language.
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
      Object.defineProperty(navigator, 'languages', { configurable: true, value: ['en-US', 'en'] });
    });
    const before = await fetchLedger(baseUrl);
    await page.setViewportSize({ width: 1440, height: 960 });
    const initialResponse = await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    if (!initialResponse || !/<html[^>]*lang="zh-CN"/.test(await initialResponse.text())) {
      throw new Error('The initial server response must render Chinese before hydration');
    }
    await page.waitForURL('**/agent');
    await waitForComposerHydration(page);
    await assertLocale(page, 'zh-CN');
    await page.getByRole('heading', { name: chinese('app.assistant'), exact: true }).waitFor();
    const sidebar = page.getByRole('complementary', { name: chinese('app.sidebar') });
    await sidebar.getByRole('link', { name: chinese('app.overview'), exact: true }).waitFor({ state: 'visible' });
    await captureScreenshot(page, 'i18n-chinese-assistant-desktop');

    await page.setViewportSize({ width: 390, height: 844 });
    await assertLocale(page, 'zh-CN');
    await waitFor(async () => {
      const bounds = await page.locator(SELECTORS.composer).boundingBox();
      return bounds !== null && bounds.y + bounds.height <= 844;
    }, { description: 'The mobile viewport has resized before capturing its layout' });
    await captureScreenshot(page, 'i18n-chinese-assistant-mobile');
    await page.getByRole('button', { name: chinese('app.openNavigation'), exact: true }).click();
    const chineseDialog = page.getByRole('dialog', { name: chinese('app.mobileNavigation'), exact: true });
    await chineseDialog.waitFor({ state: 'visible' });
    await chineseDialog.getByRole('link', { name: chinese('app.overview'), exact: true }).waitFor();
    await chineseDialog.getByRole('button', { name: chinese('app.closeNavigation'), exact: true }).click();
    await chineseDialog.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 1440, height: 960 });

    const composer = page.locator(SELECTORS.composer);
    await waitFor(async () => await composer.isEnabled(), { description: 'The initial conversation is ready' });
    await composer.fill(chinese('chat.suggestion.balance.prompt'));
    await page.getByRole('button', { name: chinese('chat.composer.send'), exact: true }).click();
    await page.getByText(chinese('cards.balance.title'), { exact: true }).first().waitFor();
    await waitFor(async () => await composer.isEnabled(), { description: 'The balance read has completed' });
    if (apiPosts.length !== 1 || apiPosts[0] !== '/api/chat') {
      throw new Error('A single balance read must submit exactly one chat request');
    }
    // Establish the canonical persisted identities before testing refresh and locale changes.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await waitFor(async () => await composer.isEnabled(), { description: 'The saved conversation has restored' });
    const messageIds = await readMessageIds(page);
    if (messageIds.length < 2 || messageIds.some(id => id.length === 0) || new Set(messageIds).size !== messageIds.length) {
      throw new Error('The conversation must expose distinct persisted message identities');
    }
    const draft = 'Keep this draft while changing the application language.';
    await composer.fill(draft);
    await changeLocale(page, 'en');
    await page.getByRole('heading', { name: english('app.assistant'), exact: true }).waitFor();
    if (await composer.inputValue() !== draft) throw new Error('Changing language discarded the unsent draft');
    await assertHistory(page, messageIds);
    await captureScreenshot(page, 'i18n-english-assistant-desktop');

    await page.getByRole('complementary', { name: english('app.sidebar') })
      .getByRole('link', { name: english('app.overview'), exact: true }).click();
    await page.waitForURL('**/overview');
    await page.getByRole('heading', { name: english('pages.overview.title'), exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertLocale(page, 'en');
    await page.getByRole('heading', { name: english('pages.overview.title'), exact: true }).waitFor();
    const savedLocale = (await page.context().cookies()).find(cookie => cookie.name === LOCALE_COOKIE);
    if (savedLocale?.value !== 'en') throw new Error('The English preference was not persisted');

    await changeLocale(page, 'zh-CN');
    await page.getByRole('heading', { name: chinese('pages.overview.title'), exact: true }).waitFor();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertLocale(page, 'zh-CN');
    await page.getByRole('heading', { name: chinese('pages.overview.title'), exact: true }).waitFor();
    await page.getByRole('complementary', { name: chinese('app.sidebar') })
      .getByRole('link', { name: chinese('app.assistant'), exact: true }).click();
    await page.waitForURL('**/agent');
    await waitForComposerHydration(page);
    await assertHistory(page, messageIds);

    await page.setViewportSize({ width: 390, height: 844 });
    await changeLocale(page, 'en');
    await page.getByRole('button', { name: english('app.openNavigation'), exact: true }).click();
    const englishDialog = page.getByRole('dialog', { name: english('app.mobileNavigation'), exact: true });
    await englishDialog.waitFor({ state: 'visible' });
    await englishDialog.getByRole('link', { name: english('app.overview'), exact: true }).waitFor();
    await englishDialog.getByRole('button', { name: english('app.closeNavigation'), exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await englishDialog.waitFor({ state: 'hidden' });
    await changeLocale(page, 'zh-CN');
    await assertHistory(page, messageIds);
    await captureScreenshot(page, 'i18n-chinese-assistant-mobile-history');
    const after = await fetchLedger(baseUrl);
    if (JSON.stringify(before.transactions) !== JSON.stringify(after.transactions)) {
      throw new Error('Locale changes or the balance read modified transaction records');
    }
    if (apiPosts.length !== 1 || apiPosts[0] !== '/api/chat') {
      throw new Error(`Locale changes resubmitted an operation: ${apiPosts.join(', ')}`);
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    return 'Chinese defaults despite an English browser preference; desktop and mobile switching translates server pages, persists across reloads, preserves drafts and message identities, and submits no additional banking operation';
  }, { label: 'i18n-locale-switching' });
}
