import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { E2E_DB_URL, SELECTORS, captureScreenshot, clickConfirm, diffLedger, fetchLedger, gotoAgent, submitChat,
  waitFor, waitForConfirmCard, withPage } from './helpers';
import { createDatabaseClient } from '../../lib/db/database';

/** Real transfer authorization plus fixed card-state fixtures, all in the isolated E2E DB. */
export async function journeyResultPriority(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    const ledger = await fetchLedger(baseUrl);
    await gotoAgent(page, baseUrl);
    await submitChat(page, '给张伟转200元');
    await waitForConfirmCard(page);
    await clickConfirm(page);
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled() &&
      await page.locator('[data-compact-result-explanation]').count() > 0, { description: 'Confirmed transfer settles with a compact explanation' });
    const explanation = page.locator('[data-compact-result-explanation]').last();
    const details = explanation.locator('[data-result-explanation]');
    if (await details.getAttribute('open') !== null) throw new Error('Successful repeated prose is expanded by default');
    const steps = page.locator('[data-completed-approval-details]').last();
    if (await steps.getAttribute('open') !== null || await steps.locator('[data-approval-progress]').isVisible()) throw new Error('Completed steps still occupy the default result view');
    await details.locator('summary').click();
    if (!(await details.innerText()).includes('¥200.00') || !(await details.innerText()).includes('张伟')) throw new Error('The original transfer facts are missing from the disclosure');
    await details.locator('summary').click();
    await captureScreenshot(page, 'compact-successful-result');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('[data-compact-result-explanation]').last().waitFor();
    if (await page.locator('[data-compact-result-explanation] details').last().getAttribute('open') !== null) throw new Error('Refresh expands the redundant explanation');

    // Presentation fixtures are not proof of a model's card intent routing or card authorization.
    const fixtureDb = createDatabaseClient(E2E_DB_URL);
    try {
      await fixtureDb.card.update({ where: { id: 'card_credit' }, data: { status: 'LOST' } });
      await fixtureDb.card.update({ where: { id: 'card_debit' }, data: { status: 'FROZEN' } });
    } finally { await fixtureDb.$disconnect(); }
    await page.goto(`${baseUrl}/cards`, { waitUntil: 'networkidle' });
    const history = page.locator('[data-card-history]');
    await history.waitFor();
    if (await history.getAttribute('open') !== null) throw new Error('Lost cards are expanded before current cards');
    const currentIds = await page.locator('[data-current-cards] [data-card-id]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-card-id')));
    if (currentIds.join() !== 'card_virtual,card_debit') throw new Error(`Active/frozen card priority is incorrect: ${currentIds.join()}`);
    if (!await page.locator('[data-current-cards] [data-card-id="card_debit"]').isVisible()) throw new Error('A reversible frozen card disappeared into history');
    await history.locator('summary').first().click();
    await history.locator('[data-card-id="card_credit"]').waitFor({ state: 'visible' });
    await captureScreenshot(page, 'current-and-historical-cards');
    await history.locator('summary').first().click();
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${baseUrl}/investments`, { waitUntil: 'networkidle' });
      const holdings = await page.locator('[data-investment-holdings]').boundingBox();
      const products = await page.locator('[data-investment-products]').boundingBox();
      if (!holdings || !products || holdings.y >= products.y) throw new Error('Current holdings do not precede product discovery');
      await page.goto(`${baseUrl}/cards`, { waitUntil: 'networkidle' });
      if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error(`Card grouping overflows at ${width}px`);
      await captureScreenshot(page, `current-cards-${width}`);
    }
    await page.goto(`${baseUrl}/bills`, { waitUntil: 'networkidle' });
    if (await page.getByRole('group', { name: t('chart.trend'), exact: true }).count() !== 1 ||
      await page.getByRole('img', { name: t('chart.sparkline'), exact: true }).count()) throw new Error('The bill page still repeats the trend');
    const added = diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions).added;
    if (added.length !== 1 || added[0].amount !== '-200.00' || added[0].direction !== 'DEBIT') throw new Error('The confirmed transfer did not produce exactly one ¥200 debit');
    return 'Holdings precede products; ACTIVE/FROZEN/LOST fixtures retain correct visibility; a real confirmed transfer collapses and restores its explanation; one bill trend; exactly one ¥200 debit.';
  }, { label: 'current-assets-and-compact-results' });
}
