import type { Browser, Page } from 'playwright-core';
import {
  SELECTORS,
  captureScreenshot,
  diffLedger,
  fetchLedger,
  waitFor,
  waitForComposerHydration,
  withPage,
} from './helpers';

async function assertViewportFit(page: Page): Promise<void> {
  await waitFor(async () => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    const composer = await page.locator(SELECTORS.composer).boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    return !overflow && composer !== null && composer.y >= 0 && composer.y + composer.height <= height;
  }, { timeoutMs: 5_000, description: 'The workspace fits the viewport and the composer remains visible' });
}

/** Exercise the default landing, HTTP-compatible IDs, IME handling and responsive navigation. */
export async function journeyAssistantWorkspace(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    await page.context().addCookies([{ name: 'banking_locale', value: 'en', url: baseUrl }]);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const chatRequests: string[] = [];
    const identityReadFailures: number[] = [];
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname;
      if (pathname === '/api/actions' && response.status() >= 400) identityReadFailures.push(response.status());
    });
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat') {
        chatRequests.push(request.postData() ?? '');
      }
    });
    // Localhost is secure by browser convention; emulate the missing API on a LAN HTTP origin.
    await page.addInitScript(() => {
      Object.defineProperty(window.crypto, 'randomUUID', { value: undefined, configurable: true });
    });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForURL('**/agent');
    await waitForComposerHydration(page);
    const iconHref = await page.locator('head link[rel="icon"]').first().getAttribute('href');
    if (!iconHref || !(await page.request.get(new URL(iconHref, baseUrl).href)).ok()) {
      throw new Error('The application icon is missing or cannot be loaded');
    }
    const composer = page.locator(SELECTORS.composer);
    await waitFor(async () => await composer.isEnabled(), { description: 'Conversation restoration completed' });
    if (await page.evaluate(() => typeof window.crypto.randomUUID !== 'undefined')) {
      throw new Error('The HTTP crypto fallback was not exercised');
    }
    const sidebar = page.getByRole('complementary', { name: 'Workspace sidebar' });
    await sidebar.getByRole('link', { name: 'AI assistant', exact: true }).waitFor({ state: 'visible' });
    await assertViewportFit(page);
    await captureScreenshot(page, 'assistant-desktop');
    if (identityReadFailures.length) throw new Error('The anonymous welcome made an unauthorized restoration request');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertViewportFit(page);
    const welcomeHeading = await page.getByRole('heading', { level: 2 }).boundingBox();
    if (!welcomeHeading || welcomeHeading.y < 64 || welcomeHeading.y > 450) {
      throw new Error('The mobile welcome scrolled past its heading before a conversation started');
    }
    const lastSuggestion = await page.getByRole('button', { name: 'Plan a transfer', exact: false }).boundingBox();
    const inputBounds = await composer.boundingBox();
    if (!lastSuggestion || !inputBounds || lastSuggestion.y + lastSuggestion.height >= inputBounds.y) {
      throw new Error('The mobile welcome hides the last suggestion behind the composer');
    }
    await captureScreenshot(page, 'assistant-mobile-welcome');
    await page.setViewportSize({ width: 1440, height: 960 });

    const before = await fetchLedger(baseUrl);
    await page.getByRole('button', { name: 'Check balances', exact: false }).click();
    await waitFor(async () => await composer.inputValue() === 'Check my account balances', {
      description: 'The selected suggestion is rendered in the draft',
    });
    if (chatRequests.length !== 0) {
      throw new Error('Selecting a suggestion must fill the draft without sending it');
    }
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    if (await composer.inputValue() !== 'Check my account balances' || chatRequests.length !== 0) {
      throw new Error('IME candidate confirmation submitted or cleared the draft');
    }
    await composer.press('Shift+Enter');
    if (!(await composer.inputValue()).includes('\n') || chatRequests.length !== 0) {
      throw new Error('Shift+Enter did not preserve a multiline draft');
    }
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await waitFor(async () => {
      const replies = await page.locator(SELECTORS.assistantText).allTextContents();
      return replies.some(text => text.trim().length > 0) && await composer.isEnabled();
    }, { description: 'A grounded balance reply is rendered' });
    const submittedRequests = [...chatRequests];
    if (submittedRequests.length !== 1) throw new Error('A single submission created multiple chat requests');
    const request = JSON.parse(submittedRequests[0]) as { requestId?: string };
    if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(request.requestId ?? '')) {
      throw new Error('The browser did not send a valid UUID v4 admission ID');
    }
    const after = await fetchLedger(baseUrl);
    const change = diffLedger(before.transactions, after.transactions);
    if (change.added.length || change.removed.length) throw new Error('A balance suggestion modified the ledger');
    await captureScreenshot(page, 'assistant-desktop-conversation');

    await sidebar.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.waitForURL('**/overview');
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    await captureScreenshot(page, 'overview-desktop');
    await sidebar.getByRole('link', { name: 'Bills', exact: true }).click();
    await page.waitForURL('**/bills');
    await page.getByRole('heading', { name: 'Bills', exact: true }).waitFor();
    const trend = page.getByRole('group', { name: 'Monthly spending trend' });
    const point = trend.locator('g[tabindex="0"]').first();
    await point.focus();
    const pointName = await point.getAttribute('aria-label');
    const tooltip = page.getByRole('tooltip');
    await tooltip.waitFor();
    if (!pointName || !(await tooltip.innerText()).includes(pointName.split(': ')[1])) {
      throw new Error('The chart keyboard tooltip lost the original exact financial label');
    }
    await page.keyboard.press('Escape');
    await tooltip.waitFor({ state: 'hidden' });
    await captureScreenshot(page, 'bills-desktop');
    await sidebar.getByRole('link', { name: 'AI assistant', exact: true }).click();
    await page.waitForURL('**/agent');
    await waitForComposerHydration(page);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await assertViewportFit(page);
      const opener = page.getByRole('button', { name: 'Open navigation', exact: true });
      await opener.click();
      const dialog = page.getByRole('dialog', { name: 'Workspace navigation' });
      await dialog.waitFor({ state: 'visible' });
      const focusInside = await page.evaluate(() => document.querySelector('dialog[open]')?.contains(document.activeElement));
      if (!focusInside) throw new Error('Mobile navigation did not take keyboard focus');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      if (!await opener.evaluate(element => element === document.activeElement)) {
        throw new Error('Closing navigation did not restore focus');
      }
      await captureScreenshot(page, `assistant-mobile-${width}`);
    }

    await page.setViewportSize({ width: 390, height: 480 });
    await waitFor(async () => {
      const input = await composer.boundingBox();
      return input !== null && input.y + input.height <= 480;
    }, { description: 'The composer follows the reduced viewport height' });
    await assertViewportFit(page);
    await captureScreenshot(page, 'assistant-mobile-short-viewport');
    await page.setViewportSize({ width: 390, height: 844 });

    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Workspace navigation' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await dialog.waitFor({ state: 'hidden' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await dialog.getByRole('link', { name: 'Overview', exact: true }).click();
    await page.waitForURL('**/overview');
    await dialog.waitFor({ state: 'hidden' });
    if (await page.evaluate(() => document.body.style.overflow === 'hidden')) {
      throw new Error('Navigation left the page scroll-locked');
    }
    await captureScreenshot(page, 'overview-mobile');
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    return 'Root opens the assistant; UUID fallback sends once; suggestions and IME preserve drafts; grouped sidebar and 390/320px mobile navigation work; balance read leaves the ledger unchanged';
  }, { label: 'assistant-workspace' });
}
