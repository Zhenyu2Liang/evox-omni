import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { assertLatestHistory, renderedHistory } from './history-assertions.e2e-helper';
import { SELECTORS, assistantTexts, captureScreenshot, diffLedger, fetchLedger, getJson, gotoAgent,
  submitChat, waitFor, waitForComposerHydration, withPage } from './helpers';

/** Normal history persists; developer reset clears shared chat without touching bank or run evidence. */
export async function journeyDeveloperMode(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    const toggle = () => page.locator('[data-developer-toggle]:visible');
    if (await toggle().getAttribute('aria-checked') !== 'false') throw new Error('Developer mode is not disabled by default');
    if (await page.locator('a[href="/runs"]:visible').count()) throw new Error('Normal navigation exposes runtime diagnostics');
    await page.goto(`${baseUrl}/runs`);
    await page.getByText(t('app.developerRequired'), { exact: true }).waitFor();
    await gotoAgent(page, baseUrl);
    await submitChat(page, 'Hello');
    await waitFor(async () => (await assistantTexts(page)).length > 0 && await page.locator(SELECTORS.composer).isEnabled(), { description: 'A normal conversation is persisted' });
    const history = await renderedHistory(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, history);
    const before = await fetchLedger(baseUrl);
    await toggle().click();
    await page.locator('a[href="/runs"]:visible').waitFor();
    await page.locator('[data-developer-refresh]:visible').click();
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, history);
    await page.locator('[data-developer-clear]:visible').click();
    const dialog = page.locator('[data-developer-reset-dialog][open]');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: t('app.cancel'), exact: true }).click();
    await assertLatestHistory(page, baseUrl, history);
    await page.locator('[data-developer-clear]:visible').click();
    await dialog.locator('[data-developer-confirm-clear]').click();
    await waitFor(async () => await page.locator('[data-developer-reset-dialog][open]').count() === 0 &&
      (await assistantTexts(page)).length === 0 && await page.locator(SELECTORS.composer).isEnabled(), { description: 'Developer clear loads an empty conversation' });
    const runs = await getJson<{ runs: unknown[] }>(`${baseUrl}/api/runs`);
    if (!runs.runs.length) throw new Error('Developer clear deleted durable run evidence');
    const changed = diffLedger(before.transactions, (await fetchLedger(baseUrl)).transactions);
    if (changed.added.length || changed.removed.length) throw new Error('Developer clear changed the ledger');
    await submitChat(page, 'Hello');
    await waitFor(async () => (await assistantTexts(page)).length > 0 && await page.locator(SELECTORS.composer).isEnabled(), { description: 'Chat works after reset' });
    const fresh = await renderedHistory(page);
    await withPage(browser, async second => {
      await gotoAgent(second, baseUrl);
      await assertLatestHistory(second, baseUrl, fresh);
      if (await second.locator('[data-developer-toggle]:visible').getAttribute('aria-checked') !== 'false') throw new Error('Developer preference leaked into another browser');
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: t('app.openNavigation'), exact: true }).click();
    await page.locator('[data-developer-clear]:visible').click();
    await dialog.waitFor();
    if (await page.locator('#mobile-navigation').getAttribute('open') !== null) throw new Error('Mobile navigation did not close before reset confirmation');
    await dialog.getByRole('button', { name: t('app.cancel'), exact: true }).click();
    await page.getByRole('button', { name: t('app.openNavigation'), exact: true }).click();
    await toggle().click();
    await waitFor(async () => await page.locator('a[href="/runs"]:visible').count() === 0, { description: 'Disabling developer mode hides its navigation on mobile' });
    await captureScreenshot(page, 'developer-mode-mobile');
    return 'Normal chat survives refresh; developer tools are opt-in; clear requires confirmation, resets shared context, preserves ledger/run evidence, and works through the mobile modal.';
  }, { label: 'developer-mode' });
}
