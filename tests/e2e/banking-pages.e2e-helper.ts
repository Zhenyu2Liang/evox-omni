import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { captureScreenshot, getDeveloperJson, gotoAgent, waitFor, waitForElementHydration, withPage } from './helpers';

/** Saved contacts persist across browsers; page mutations are audited; products remain read-only. */
export async function journeyBankingPages(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    if (await page.locator('a[href="/actions"]').count()) throw new Error('Navigation still exposes a separate approvals page');
    await page.locator('a[href="/contacts"]:visible').click();
    await page.waitForURL('**/contacts');
    await waitForElementHydration(page, '[data-contact-form] input[name="name"]');
    const form = page.locator('[data-contact-form]');
    await form.locator('[name="name"]').fill('Ada Example');
    await form.locator('[name="phone"]').fill('13812345678');
    await form.locator('[name="bank"]').fill('Demo Bank');
    await form.locator('[name="remark"]').fill('Demo recipient');
    await form.getByRole('button', { name: t('pages.contacts.save'), exact: true }).click();
    await page.getByRole('status').filter({ hasText: t('pages.contacts.saved') }).waitFor();
    const saved = page.locator('[data-contact-id]').filter({ hasText: 'Ada Example' });
    await saved.waitFor();
    if (!(await saved.innerText()).includes('138****5678')) throw new Error('The saved contact phone is not masked');
    const id = await saved.getAttribute('data-contact-id');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await saved.waitFor();
    await withPage(browser, async second => {
      await second.goto(`${baseUrl}/contacts`);
      await second.locator(`[data-contact-id="${id}"]`).waitFor();
    });
    await waitForElementHydration(page, '[data-contact-form] input[name="name"]');
    await saved.getByRole('button', { name: t('pages.contacts.delete'), exact: true }).click();
    const dialog = page.locator('[data-contact-delete-dialog][open]');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: t('app.cancel'), exact: true }).click();
    await saved.waitFor();
    await saved.getByRole('button', { name: t('pages.contacts.delete'), exact: true }).click();
    await dialog.getByRole('button', { name: t('pages.contacts.confirmDelete'), exact: true }).click();
    await waitFor(async () => await saved.count() === 0, { description: 'Confirmed contact deletion is visible' });
    const audit = await getDeveloperJson<{ entries: Array<{ toolName: string; userId?: string; status: string }> }>(`${baseUrl}/api/audit`);
    for (const name of ['add_contact', 'delete_contact']) {
      if (!audit.entries.some(entry => entry.toolName === name && entry.userId && entry.status === 'success')) {
        throw new Error(`The contact mutation is missing its audit: ${name}`);
      }
    }
    await page.locator('a[href="/investments"]:visible').click();
    await page.waitForURL('**/investments');
    await page.locator('[data-investment-products]').waitFor();
    const productText = await page.locator('[data-investment-products]').innerText();
    if (!productText.includes('R1') || !productText.includes('%') || !productText.includes('1,000.00')) {
      throw new Error('Investment products are missing risk, rate or exact minimum amount');
    }
    await page.locator('[data-investment-holdings]').waitFor();
    await captureScreenshot(page, 'investment-products-desktop');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) {
        throw new Error(`Investment page overflows at ${width}px`);
      }
    }
    await captureScreenshot(page, 'investment-products-mobile');
    return 'Separate approval navigation is removed; contact add/delete persists across reload and browsers with masked phones and audits; investment products show exact money, rates and risk without mobile overflow.';
  }, { label: 'banking-pages' });
}
