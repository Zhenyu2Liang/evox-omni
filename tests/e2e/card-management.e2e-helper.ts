import type { Browser } from 'playwright-core';
import type { CardChange } from '../../lib/contracts/card-management';
import type { AuditEntry } from '../../lib/contracts/audit';
import guidance from '../../agent/messages/conversation.zh-CN.json';
import { createTranslator } from '../../lib/i18n/shared';
import { SELECTORS, assistantTexts, captureScreenshot, diffLedger, fetchCards, fetchLedger, fetchPendingActions,
  getJson, getDeveloperJson, gotoAgent, submitChat, submitMfa, waitFor, waitForElementHydration, waitForMfaCard,
  withPage } from './helpers';
import { assertApprovalDock } from './approval-ux.e2e-helper';

/**
 * Card RECORD changes: physical DEBIT/CREDIT issuance and deletion stay on the manual cards page
 * (surviving refresh, never an Agent mutation). Virtual-card APPLICATION is now an Agent capability —
 * the request becomes a RED `apply_virtual_card` awaiting strong verification instead of a redirect.
 */
export async function journeyCardManagement(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${baseUrl}/cards`);
    await waitForElementHydration(page, '[data-card-add] button');
    const original = await fetchCards(baseUrl);
    const ledger = await fetchLedger(baseUrl);
    if (await page.locator('main a[href="/agent"]').count()) throw new Error('The cards page still redirects management to chat');
    await page.locator('[data-card-add] button').click();
    const dialog = page.locator('[data-card-change-dialog][open]');
    await dialog.waitFor();
    const add = dialog.locator('[data-card-add-form]');
    await add.locator('[name="type"]').selectOption('CREDIT');
    await add.locator('[name="creditLimit"]').fill('200.37');
    await add.locator('[name="monthlyLimit"]').fill('100.23');
    await add.getByRole('button', { name: t('pages.cards.review'), exact: true }).click();
    await dialog.locator('[data-card-verification-form]').waitFor();
    const id = await dialog.getAttribute('data-card-change-id');
    if (!id) throw new Error('The manual proposal has no persisted identity');
    if ((await fetchCards(baseUrl)).length !== original.length) throw new Error('A proposal created a card before verification');
    const verify = dialog.getByRole('button', { name: t('pages.cards.verify'), exact: true });
    await dialog.locator('[name="code"]').fill('123456');
    if (!await verify.isDisabled()) throw new Error('Verification does not require reviewing details');
    await dialog.locator('[name="confirmed"]').check();
    await dialog.locator('[name="code"]').fill('000000');
    await verify.click();
    await dialog.getByRole('alert').waitFor();
    if ((await fetchCards(baseUrl)).length !== original.length) throw new Error('A wrong code created a card');

    // Page-specific pending operations must not occupy the conversation's confirmation surface.
    await gotoAgent(page, baseUrl);
    if (await page.locator(SELECTORS.mfaInput).count()) throw new Error('A manual card proposal leaked into chat');
    const chatActions = await getJson<unknown[]>(`${baseUrl}/api/actions`);
    if (chatActions.length) throw new Error('Agent actions contain a manual card proposal');

    // Virtual-card APPLICATION is now an Agent capability: it becomes a RED `apply_virtual_card`
    // awaiting strong verification, not a redirect to the manual page.
    const beforeVirtual = (await assistantTexts(page)).length;
    await submitChat(page, 'Create a virtual card');
    await waitForMfaCard(page);
    const virtual = await waitFor(async () => (await fetchPendingActions(baseUrl))
      .find(action => action.toolName === 'apply_virtual_card' && action.status === 'awaiting_mfa') || false,
    { description: 'The Agent parks the virtual-card application for strong verification' });
    if (virtual.tier !== 'RED') throw new Error('A virtual-card application is not strongly verified');
    await assertApprovalDock(page, virtual.id, 'mfa');
    if ((await assistantTexts(page)).slice(beforeVirtual).some(text => text.includes(guidance.card_management_required))) {
      throw new Error('The Agent redirected virtual-card application to the manual page');
    }
    await submitMfa(page, '000000');
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'The wrong-code response settles' });
    if ((await fetchCards(baseUrl)).length !== original.length) throw new Error('A wrong code issued a virtual card');
    await assertApprovalDock(page, virtual.id, 'mfa');
    await page.locator(SELECTORS.approvalRequest).getByRole('button', { name: t('cards.cancel'), exact: true }).click();
    await waitFor(async () => await page.locator(SELECTORS.approvalRequest).count() === 0,
      { description: 'Cancelling the virtual-card request settles without a card' });
    if ((await fetchCards(baseUrl)).length !== original.length) throw new Error('A cancelled virtual-card request issued a card');

    // Physical card issuance/deletion stays manual-only and never becomes an Agent mutation.
    const beforeDelete = (await assistantTexts(page)).length;
    await submitChat(page, 'Delete my debit card');
    await waitFor(async () => (await assistantTexts(page)).length > beforeDelete &&
      (await assistantTexts(page)).at(-1)?.includes(guidance.card_management_required) === true &&
      await page.locator(SELECTORS.composer).isEnabled(), { description: 'Agent directs physical card deletion to the manual page' });
    if ((await fetchCards(baseUrl)).length !== original.length) throw new Error('The Agent changed cards');
    await page.goto(`${baseUrl}/cards`);
    const pending = page.locator(`[data-card-pending-change-id="${id}"]`);
    await pending.waitFor();
    await pending.getByRole('button').click();
    await dialog.locator('[name="confirmed"]').check();
    await dialog.locator('[name="code"]').fill('123456');
    await verify.click();
    await waitFor(async () => await dialog.count() === 0 && (await fetchCards(baseUrl)).length === original.length + 1,
      { description: 'The verified manual card appears exactly once' });
    const created = (await fetchCards(baseUrl)).find(card => !original.some(previous => previous.id === card.id));
    if (!created) throw new Error('The added card is missing');
    const tile = page.locator(`[data-card-id="${created.id}"]`);
    await tile.locator('[data-card-details] > summary').click();
    const text = await tile.innerText();
    if (!text.includes('200.37') || !text.includes('100.23')) throw new Error('The page rounded card limits');
    const replay = await page.request.post(`${baseUrl}/api/cards/changes/${id}/verify`, { data: { code: '123456' } });
    if (!replay.ok() || (await fetchCards(baseUrl)).length !== original.length + 1) throw new Error('Verification replay created another card');

    await tile.locator('[data-card-delete] button').click();
    await dialog.getByRole('button', { name: t('pages.cards.review'), exact: true }).click();
    await dialog.locator('[data-card-verification-form]').waitFor();
    await dialog.getByRole('button', { name: t('pages.cards.cancelChange'), exact: true }).click();
    await waitFor(async () => await dialog.count() === 0, { description: 'Cancelling deletion settles without deleting the card' });
    if (!(await fetchCards(baseUrl)).some(card => card.id === created.id)) throw new Error('Cancelling deleted the card');
    await tile.locator('[data-card-delete] button').click();
    await dialog.getByRole('button', { name: t('pages.cards.review'), exact: true }).click();
    await dialog.locator('[data-card-verification-form]').waitFor();
    const deletionId = await dialog.getAttribute('data-card-change-id');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(`[data-card-pending-change-id="${deletionId}"]`).getByRole('button').click();
    await dialog.locator('[name="confirmed"]').check();
    await dialog.locator('[name="code"]').fill('123456');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    const reviewBounds = await dialog.boundingBox();
    if (!reviewBounds || reviewBounds.y < 0 || reviewBounds.y + reviewBounds.height > 844) {
      throw new Error('The card review dialog does not fit the mobile viewport');
    }
    await captureScreenshot(page, 'manual-card-delete-mobile-review');
    await verify.click();
    await waitFor(async () => !(await fetchCards(baseUrl)).some(card => card.id === created.id), { description: 'The reviewed card deletion commits' });
    const audits = await getDeveloperJson<{ entries: AuditEntry[] }>(`${baseUrl}/api/audit?status=success`);
    for (const operation of ['manual_add_card', 'manual_delete_card']) {
      const entries = audits.entries.filter(entry => entry.toolName === operation);
      if (entries.length !== 1 || entries[0].riskLevel !== 'RED' || entries[0].mfaResult !== 'success') {
        throw new Error(`The manual change has missing or duplicate success audits: ${operation}`);
      }
    }
    const changes = diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions);
    if (changes.added.length || changes.removed.length) throw new Error('Card record management changed the financial ledger');
    await page.setViewportSize({ width: 390, height: 844 });
    await waitFor(async () => await dialog.count() === 0, { description: 'Deletion closes the review dialog' });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('Cards overflow a mobile viewport');
    const navigationBounds = await page.locator('header').first().boundingBox();
    const titleBounds = await page.locator('main h1').boundingBox();
    const addBounds = await page.locator('[data-card-add] button').boundingBox();
    if (!navigationBounds || !titleBounds || !addBounds ||
      titleBounds.y < navigationBounds.y + navigationBounds.height ||
      addBounds.y < navigationBounds.y + navigationBounds.height) {
      throw new Error('Mobile navigation overlaps the card heading or management buttons');
    }
    await captureScreenshot(page, 'manual-card-management-mobile');
    await page.goto(`${baseUrl}/schedules`);
    if (await page.locator('main a[href="/agent"]').count()) throw new Error('Scheduled tasks still show the generic confirmation redirect');
    const remaining = await getJson<{ changes: CardChange[] }>(`${baseUrl}/api/cards/changes`);
    if (remaining.changes.length) throw new Error('Finished card changes still appear as pending');
    if (errors.length) throw new Error(errors.join('; '));
    return 'Manual card addition/deletion require reviewed details and separate MFA; wrong codes/cancellation do not mutate; refresh resumes; repeats preserve one receipt/audit; Agent virtual-card application is RED-verified while physical creation/deletion stay manual; schedule redirect is removed.';
  }, { label: 'manual-card-management' });
}
