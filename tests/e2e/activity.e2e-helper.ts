import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import type { ActivityRecord } from '../../lib/contracts/activity';
import { captureScreenshot, getJson, gotoAgent, waitFor, waitForElementHydration, withPage } from './helpers';

const PRIVATE_MARKER = 'AuditInternalRecipientMarker';

/** Ordinary history is a closed business projection; audit details require an explicit preference. */
export async function journeyOperationHistory(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    const toggle = () => page.locator('[data-developer-toggle]:visible');
    if (await toggle().getAttribute('aria-checked') !== 'false') throw new Error('The new browser unexpectedly enables developer mode');
    if (await page.locator('a[href="/audit"]:visible').count()) throw new Error('Technical audits appear in ordinary navigation');
    await page.locator('a[href="/activity"]:visible').waitFor();
    const saved = await page.request.post(`${baseUrl}/api/contacts`, { data: {
      name: PRIVATE_MARKER, phone: '13912349876', bank: 'Demo Bank', remark: 'Private audit arguments',
    } });
    if (saved.status() !== 201) throw new Error(`Fixture contact was not saved: ${await saved.text()}`);
    const contactId = (await saved.json()).data.contact.id as string;
    const removed = await page.request.delete(`${baseUrl}/api/contacts/${contactId}`, { data: { confirm: true } });
    if (!removed.ok()) throw new Error(`Fixture contact was not deleted: ${await removed.text()}`);
    const history = await getJson<{ entries: ActivityRecord[] }>(`${baseUrl}/api/activity`);
    if (!history.entries.some(entry => entry.type === 'contact_add' && entry.status === 'completed') ||
      !history.entries.some(entry => entry.type === 'contact_delete' && entry.status === 'completed')) {
      throw new Error('Business history lacks the saved contact operations');
    }
    for (const entry of history.entries) {
      if (Object.keys(entry).sort().join(',') !== 'id,status,timestamp,type,verification') {
        throw new Error('The public operation API exposes additional execution fields');
      }
    }
    const serverFormats: Record<string, string>[] = [{}, { RSC: '1' }];
    for (const headers of serverFormats) {
      const blocked = await page.request.get(`${baseUrl}/audit`, { headers });
      const text = await blocked.text();
      if (text.includes(PRIVATE_MARKER) || text.includes('Private audit arguments') || text.includes('data-developer-audit')) {
        throw new Error('Disabled developer audit exposes server-rendered evidence');
      }
    }
    const blockedApi = await page.request.get(`${baseUrl}/api/audit`);
    if (blockedApi.status() !== 403 || (await blockedApi.text()).includes(PRIVATE_MARKER)) {
      throw new Error('Disabled developer audit API is readable');
    }
    await page.goto(`${baseUrl}/audit`);
    await page.getByText(t('app.developerRequired'), { exact: true }).waitFor();
    await page.goto(`${baseUrl}/activity`);
    await page.locator('[data-operation-history]').waitFor();
    const business = await page.locator('main').innerText();
    for (const internal of [PRIVATE_MARKER, 'add_contact', 'delete_contact', 'toolArgs', 'toolResult', 'Private audit arguments']) {
      if (business.includes(internal)) throw new Error(`Ordinary history leaks ${internal}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-operation-history]').waitFor();
    await waitForElementHydration(page, '[data-developer-toggle]');
    await toggle().click();
    await page.locator('a[href="/audit"]:visible').waitFor();
    await page.goto(`${baseUrl}/audit`);
    await page.locator('[data-developer-audit]').waitFor();
    if (!(await page.locator('main').innerText()).includes('add_contact')) throw new Error('Developer audit lacks the raw tool identity');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-developer-audit]').waitFor();
    await withPage(browser, async second => {
      await second.goto(`${baseUrl}/activity`);
      await second.locator('[data-operation-history]').waitFor();
      if (await second.locator('a[href="/audit"]:visible').count()) throw new Error('Developer preference leaked to a second browser');
      if ((await second.locator('main').innerText()).includes(PRIVATE_MARKER)) throw new Error('A second browser received raw audit data');
    });
    await waitForElementHydration(page, '[data-developer-toggle]');
    await toggle().click();
    await page.waitForURL('**/agent');
    await waitFor(async () => await page.locator('a[href="/audit"]:visible').count() === 0, { description: 'Disabling developer mode removes audit navigation' });
    await page.goto(`${baseUrl}/activity`);
    await page.locator('[data-operation-history]').waitFor();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error(`Operation history overflows at ${width}px`);
    }
    await captureScreenshot(page, 'operation-history-mobile');
    return 'Ordinary operation history omits tool internals; raw audit HTML/RSC/API is gated; developer opt-in survives reload, remains browser-local, and disabling exits audit; mobile business records fit 320px.';
  }, { label: 'operation-history' });
}
