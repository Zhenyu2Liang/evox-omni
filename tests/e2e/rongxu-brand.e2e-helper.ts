import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { SELECTORS, captureScreenshot, fetchLedger, gotoAgent, waitFor, withPage } from './helpers';

/** Brand changes are checked on real pages without sending a banking request. */
export async function journeyRongxuBrand(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    const posts: string[] = [];
    page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
    const ledger = JSON.stringify(await fetchLedger(baseUrl));
    await page.setViewportSize({ width: 1440, height: 960 });
    await gotoAgent(page, baseUrl);
    if (await page.title() !== t('app.brandTitle')) throw new Error('The browser title has not adopted RONGXU');
    const brand = page.locator('aside [data-brand-link]');
    if (!await brand.getByText('融序', { exact: true }).isVisible() || !await brand.getByText('RONGXU', { exact: true }).isVisible()) throw new Error('The sidebar is missing the bilingual brand');
    await waitFor(async () => await brand.locator('img').evaluate(img => (img as HTMLImageElement).naturalWidth > 0), { description: 'The extracted X asset is loaded' });
    const accent = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-banking-accent').trim().toLowerCase());
    if (accent !== '#c8383c') throw new Error(`The application accent is not the logo red: ${accent}`);
    if (!await page.getByText(t('app.slogan'), { exact: true }).first().isVisible()) throw new Error('The brand slogan is missing');
    const icon = await page.locator('head link[rel="icon"]').first().getAttribute('href');
    if (!icon || !(await page.request.get(new URL(icon, baseUrl).href)).ok()) throw new Error('The new favicon is not available');
    await captureScreenshot(page, 'rongxu-brand-desktop');
    await page.locator('[data-assistant-help-trigger]:visible').click();
    await page.getByRole('heading', { name: t('help.title'), exact: true }).waitFor();
    await captureScreenshot(page, 'rongxu-brand-guide');
    await page.getByRole('button', { name: t('help.close'), exact: true }).click();

    for (const route of ['overview', 'cards', 'investments']) {
      await page.goto(`${baseUrl}/${route}`, { waitUntil: 'networkidle' });
      if (await page.title() !== t('app.brandTitle')) throw new Error(`Brand metadata differs on ${route}`);
      await captureScreenshot(page, `rongxu-brand-${route}`);
    }
    await gotoAgent(page, baseUrl);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`The new brand overflows at ${width}px`);
      const input = (await page.locator(SELECTORS.composer).boundingBox())!;
      if (input.y + input.height > 844) throw new Error('The composer no longer fits below the brand header');
      await page.getByRole('button', { name: t('app.openNavigation'), exact: true }).click();
      const menu = page.locator('#mobile-navigation');
      await menu.locator('[data-brand-mark]').waitFor({ state: 'visible' });
      await captureScreenshot(page, `rongxu-brand-mobile-${width}`);
      await menu.getByRole('button', { name: t('app.closeNavigation'), exact: true }).click();
    }

    // Measure the original vector geometry after browser rendering, ensuring that no X stroke is cropped.
    await page.goto(`${baseUrl}/brand/rongxu-x.svg`, { waitUntil: 'load' });
    const shape = await page.evaluate(() => {
      const svg = document.querySelector('svg') as unknown as SVGSVGElement;
      const box = svg.getBBox(); const view = svg.viewBox.baseVal;
      return { paths: svg.querySelectorAll('path').length,
        cropped: box.x < view.x || box.y < view.y || box.x + box.width > view.x + view.width || box.y + box.height > view.y + view.height,
        fills: Array.from(svg.querySelectorAll('path')).map(path => path.getAttribute('fill')) };
    });
    if (shape.paths !== 18 || shape.cropped || shape.fills.some(fill => fill !== '#373435' && fill !== '#C8383C')) throw new Error(`The original X is incomplete or recolored: ${JSON.stringify(shape)}`);
    await page.setViewportSize({ width: 360, height: 320 });
    await captureScreenshot(page, 'rongxu-extracted-x');
    if (posts.length || JSON.stringify(await fetchLedger(baseUrl)) !== ledger) throw new Error('Brand verification submitted a business request or changed the ledger');
    return 'Original 18-path transparent X is uncropped; bilingual brand, slogan, favicon and red/charcoal theme display on chat, help and business pages; mobile 390/320 layouts fit; no business POST or ledger changes.';
  }, { label: 'rongxu-brand-and-responsive-pages' });
}
