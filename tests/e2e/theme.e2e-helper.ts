import type { Browser, Page } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { captureScreenshot, fetchLedger, gotoAgent, SELECTORS, submitChat, waitFor, waitForElementHydration, withPage } from './helpers';

const switcher = '[data-theme-switcher]:visible';
const background = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const DARK = 'rgb(25, 25, 28)';
const LIGHT = 'rgb(251, 248, 245)';
const t = createTranslator('zh-CN');

async function changeTheme(page: Page, value: string) {
  await waitForElementHydration(page, '[data-theme-switcher]');
  await page.locator(switcher).selectOption(value);
  await waitFor(async () => await page.locator('html').getAttribute('data-theme') === value, { description: `Theme changed to ${value}` });
}

/** Real UI checks use an isolated bank; appearance never authorizes a pending operation. */
export async function journeyTheme(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    const errors: string[] = [];
    const posts: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    const ledger = JSON.stringify(await fetchLedger(baseUrl));
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await gotoAgent(page, baseUrl);
    if (await background(page) !== DARK) throw new Error('System dark preference is not reflected before selection');
    await page.emulateMedia({ colorScheme: 'light' });
    if (await background(page) !== LIGHT) throw new Error('System appearance did not react to a preference change');
    await page.locator(SELECTORS.composer).fill('保留这段草稿');
    const initialPosts = posts.length;
    await changeTheme(page, 'dark');
    if (await page.locator(SELECTORS.composer).inputValue() !== '保留这段草稿' || posts.length !== initialPosts) throw new Error('Theme selection remounted the draft or submitted it');
    const response = await page.reload({ waitUntil: 'networkidle' });
    if (!response || !/<html[^>]*data-theme="dark"/.test(await response.text())) throw new Error('Saved appearance is not in the initial server HTML');
    if (await background(page) !== DARK) throw new Error('Dark preference did not persist');
    await waitFor(async () => await page.locator('aside [data-brand-mark]').evaluate(el => (el as HTMLImageElement).currentSrc.endsWith('/brand/omni-x-dark.svg')), { description: 'The legible dark logo is loaded' });

    const other = await page.context().newPage();
    try {
      await other.goto(`${baseUrl}/subscriptions`, { waitUntil: 'networkidle' });
      await waitForElementHydration(other, '[data-theme-switcher]');
      await changeTheme(page, 'light');
      await waitFor(async () => await background(other) === LIGHT, { description: 'Appearance follows a second tab without reloading it' });
      await changeTheme(page, 'dark');
    } finally { await other.close(); }

    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: width === 1440 ? 960 : 844 });
      for (const route of ['agent', 'overview', 'cards', 'investments', 'bills', 'subscriptions', 'contacts', 'schedules', 'activity', 'security']) {
        const result = await page.goto(`${baseUrl}/${route}`, { waitUntil: 'networkidle' });
        if (result?.status() !== 200 || await background(page) !== DARK) throw new Error(`Dark page failed: ${route}/${width}`);
        if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Dark layout overflows: ${route}/${width}`);
        if (route === 'bills') {
          const labels = await page.locator('main svg text').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill));
          if (!labels.length || labels.some(colour => colour !== 'rgb(189, 176, 167)')) throw new Error('Chart labels do not use the dark text palette');
          const focusable = page.getByRole('group', { name: t('chart.categories'), exact: true }).locator('g[role="img"]').first();
          await focusable.focus();
          const tooltip = page.getByRole('tooltip');
          await tooltip.waitFor();
          if (await tooltip.evaluate(el => getComputedStyle(el).backgroundColor) !== 'rgb(35, 35, 38)') throw new Error('The tooltip retained a bright surface');
          await focusable.press('Escape');
        }
        await captureScreenshot(page, `theme-dark-${route}-${width}`);
      }
    }
    // The same switch is available in the mobile drawer and stays keyboard-operable.
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await changeTheme(page, 'light');
    await page.getByRole('button', { name: '关闭导航', exact: true }).click();
    if (await background(page) !== LIGHT) throw new Error('The mobile switch did not change appearance');
    await page.setViewportSize({ width: 1440, height: 960 });
    await gotoAgent(page, baseUrl);
    await changeTheme(page, 'system');
    await page.emulateMedia({ colorScheme: 'dark' });
    if (await background(page) !== DARK) throw new Error('System mode did not resume');
    await page.locator('[data-assistant-help-trigger]:visible').click();
    if (await page.locator('[data-assistant-guide]').evaluate(el => getComputedStyle(el).backgroundColor) !== 'rgb(35, 35, 38)') throw new Error('The help dialog did not adapt');
    await captureScreenshot(page, 'theme-dark-help');
    await page.keyboard.press('Escape');

    await submitChat(page, '给张伟转200元');
    const approval = page.locator(SELECTORS.approvalRequest);
    await approval.waitFor();
    const actionId = await approval.getAttribute('data-action-id');
    if (!actionId) throw new Error('The pending operation has no identity');
    const postCount = posts.length;
    await changeTheme(page, 'light');
    await changeTheme(page, 'dark');
    if (await approval.getAttribute('data-action-id') !== actionId || posts.length !== postCount) throw new Error('Changing appearance recreated or authorized the operation');
    await captureScreenshot(page, 'theme-dark-pending-confirmation');
    await approval.getByRole('button', { name: '取消', exact: true }).click();
    await approval.waitFor({ state: 'hidden' });
    await submitChat(page, '给张伟转3000元');
    const code = page.locator(SELECTORS.mfaInput);
    await code.waitFor();
    await code.fill('000000');
    const mfaId = await approval.getAttribute('data-action-id');
    const mfaPosts = posts.length;
    await changeTheme(page, 'light');
    await changeTheme(page, 'dark');
    if (!mfaId || await approval.getAttribute('data-action-id') !== mfaId || await code.inputValue() !== '000000' || posts.length !== mfaPosts) throw new Error('Theme switching reset or submitted MFA');
    await captureScreenshot(page, 'theme-dark-mfa');
    await approval.getByRole('button', { name: '取消', exact: true }).click();
    await approval.waitFor({ state: 'hidden' });
    if (JSON.stringify(await fetchLedger(baseUrl)) !== ledger) throw new Error('The theme journey changed money or ledger records');
    if (errors.length) throw new Error(errors.join('; '));
    return 'Dark/light/system modes, OS changes, SSR persistence, cross-tab sync, draft and pending-action retention, 30 desktop/mobile page views, charts and dialogs passed; no funds moved.';
  }, { label: 'theme-appearance-and-persistence' });
}
