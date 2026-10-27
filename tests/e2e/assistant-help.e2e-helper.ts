import type { Browser, Page } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { GUIDE_SEEN_KEY } from '../../components/help/guide-preference';
import { SELECTORS, captureScreenshot, getJson, submitChat, waitFor, waitForComposerHydration, withPage } from './helpers';

const t = createTranslator('zh-CN');
const guide = '[data-assistant-guide]';
const example = '[data-help-example]';
const trigger = '[data-assistant-help-trigger]:visible';

async function waitForGuidePreference(page: Page) {
  await page.locator(`${guide}[data-guide-ready="true"]`).waitFor({ state: 'attached' });
}

async function assertModalFits(page: Page) {
  const box = await page.locator(guide).boundingBox();
  const viewport = page.viewportSize()!;
  if (!box || box.x < 0 || box.y < 0 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1) {
    throw new Error('Usage help extends outside the viewport');
  }
  if (await page.locator(guide).evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error('Help has horizontal overflow');
  const footer = await page.locator(guide).getByRole('button', { name: t('help.begin'), exact: true }).boundingBox();
  if (!footer || footer.y < 0 || footer.y + footer.height > viewport.height) throw new Error('The help footer is outside the viewport');
}

/** Frontend-only checks; optional model exercise sends one read-only query through the real UI. */
export async function journeyAssistantHelp(browser: Browser, baseUrl: string, options: { exerciseModel?: boolean } = {}): Promise<string> {
  await withPage(browser, async page => {
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(new URL(request.url()).pathname); });
    const ledger = JSON.stringify(await getJson(`${baseUrl}/api/bills`));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded' });
    await page.locator(guide).waitFor({ state: 'visible' });
    await waitForComposerHydration(page);
    await waitFor(async () => await page.locator(`${example}:enabled`).count() === 6, { description: 'Six examples become available after restoration' });
    if (!await page.locator(guide).evaluate(el => el.matches(':modal'))) throw new Error('The guide does not make its background inert');
    await assertModalFits(page);
    await captureScreenshot(page, 'help-desktop-first-visit');
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press('Tab');
      if (!await page.locator(guide).evaluate(el => el.contains(document.activeElement))) throw new Error('Keyboard focus escaped help');
    }
    await page.keyboard.press('Escape');
    await page.locator(guide).waitFor({ state: 'hidden' });
    await waitFor(async () => await page.evaluate(key => localStorage.getItem(key), GUIDE_SEEN_KEY) === '1', { description: 'Escape remembers dismissal' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGuidePreference(page);
    if (await page.locator(guide).isVisible()) throw new Error('Dismissed help reopened after refresh');

    await page.locator(trigger).click();
    await page.locator(guide).getByRole('button', { name: t('help.close'), exact: true }).click();
    if (!await page.locator(trigger).evaluate(el => el === document.activeElement)) throw new Error('Closing help did not restore focus to its trigger');
    await page.locator(SELECTORS.composer).fill('Keep this unsent draft');
    await page.locator(trigger).click();
    if (await page.locator(`${example}:enabled`).count()) throw new Error('Help can overwrite an existing draft');
    await page.keyboard.press('Escape');
    if (await page.locator(SELECTORS.composer).inputValue() !== 'Keep this unsent draft') throw new Error('Help lost the draft');
    await page.locator(SELECTORS.composer).fill('');
    await page.locator(trigger).click();
    await page.locator('[data-help-example="accounts"]').click();
    await page.locator(guide).waitFor({ state: 'hidden' });
    if (await page.locator(SELECTORS.composer).inputValue() !== t('help.feature.accounts.example')) throw new Error('An example did not reach the composer');
    if (!await page.locator(SELECTORS.composer).evaluate(el => el === document.activeElement)) throw new Error('Example selection did not focus the composer');
    if (posts.length) throw new Error(`Opening help or selecting an example submitted a request: ${posts.join(', ')}`);
    await page.locator(SELECTORS.composer).fill('');

    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 390, height: 480 }]) {
      await page.setViewportSize(size);
      if (await page.locator(trigger).count() !== 1) throw new Error('The phone does not have exactly one visible help entry');
      await page.locator(trigger).click();
      await assertModalFits(page);
      const body = page.locator('[data-assistant-guide-body]');
      await body.evaluate(el => { el.scrollTop = el.scrollHeight; });
      if (!await body.getByText(t('help.demoTitle'), { exact: true }).isVisible()) throw new Error('Help cannot scroll to the demo boundary');
      await captureScreenshot(page, `help-mobile-${size.width}-${size.height}`);
      await page.locator(guide).getByRole('button', { name: t('help.begin'), exact: true }).click();
      if (!await page.locator(SELECTORS.composer).evaluate(el => el === document.activeElement)) throw new Error('Get started did not return focus to the composer');
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('link', { name: t('app.cards'), exact: true }).click();
    await page.waitForURL('**/cards');
    await waitFor(async () => await page.locator(trigger).count() === 0, { description: 'The cards page has no chat-specific help entry' });
    await page.getByRole('link', { name: t('app.assistant'), exact: true }).click();
    await page.waitForURL('**/agent');
    await waitForGuidePreference(page);
    if (await page.locator(guide).isVisible()) throw new Error('Client navigation reopened dismissed help');
    await page.locator('[data-locale-switcher]:visible').selectOption('en');
    await page.getByRole('button', { name: 'Usage help', exact: true }).click();
    await page.getByRole('heading', { name: 'Start a banking task in your own words', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Close usage help', exact: true }).click();
    await page.locator('[data-locale-switcher]:visible').selectOption('zh-CN');
    if (JSON.stringify(await getJson(`${baseUrl}/api/bills`)) !== ledger) throw new Error('Help changed financial records');
    if (posts.length) throw new Error('Help or navigation submitted a business request');

    if (options.exerciseModel) {
      await submitChat(page, '查询活期账户余额');
      await page.locator(trigger).click();
      if (await page.locator(`${example}:enabled`).count()) throw new Error('Examples remain enabled during a model request');
      await page.locator(guide).getByRole('button', { name: t('help.close'), exact: true }).click();
      await waitFor(async () => await page.locator('[data-tool-status="success"]').count() > 0 && await page.locator(SELECTORS.composer).isEnabled(), { timeoutMs: 120000, description: 'A real model query completes after onboarding' });
      await page.locator(trigger).click();
      await page.locator(guide).getByRole('button', { name: t('help.close'), exact: true }).click();
      if (JSON.stringify(await getJson(`${baseUrl}/api/bills`)) !== ledger) throw new Error('The help query changed the ledger');
    }
  }, { label: 'assistant-help-first-visit', firstVisit: true });

  await withPage(browser, async page => {
    await page.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage blocked', 'SecurityError'); } }));
    await page.goto(`${baseUrl}/agent`, { waitUntil: 'domcontentloaded' });
    await page.locator(guide).waitFor({ state: 'visible' });
    await page.locator(guide).getByRole('button', { name: t('help.close'), exact: true }).click();
    await waitFor(async () => (await page.context().cookies()).some(cookie => cookie.name === 'banking_guide_seen' && cookie.value === '1'), { description: 'Dismissal falls back to a cookie' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForGuidePreference(page);
    if (await page.locator(guide).isVisible()) throw new Error('Cookie fallback failed to remember dismissal');
    await page.locator(trigger).click();
    await page.locator(guide).waitFor({ state: 'visible' });
    await page.locator(guide).getByRole('button', { name: t('help.begin'), exact: true }).click();
  }, { label: 'assistant-help-storage-fallback', firstVisit: true });
  return 'First visit opens help; Escape, close and Get started dismiss it; reload/navigation stay closed; manual reopening and keyboard focus work; six examples fill without sending or overwriting drafts; phone/short viewports fit; translations and cookie fallback work; financial records unchanged.';
}
