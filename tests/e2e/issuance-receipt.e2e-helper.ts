import type { Page } from 'playwright-core';
import { withDb } from './live-virtual-card.e2e-helper';
import { waitFor, waitForComposerHydration } from './helpers';

/** The full number comes only from the verified browser endpoint, with no model/history copy. */
export async function assertIssuanceReceipt(page: Page, baseUrl: string, actionId: string, cardId: string): Promise<void> {
  const fullNumber = await withDb(async db => (await db.card.findUniqueOrThrow({ where: { id: cardId }, select: { numberFull: true } })).numberFull);
  if (!fullNumber) throw new Error('The issued card has no persisted number');
  const receipt = page.locator(`[data-issued-card-number][data-issued-card-id="${cardId}"]`);
  await waitFor(async () => await receipt.count() === 1 && (await receipt.locator('[data-full-card-number]').textContent().catch(() => '')) === fullNumber,
    { timeoutMs: 60_000, description: 'The original verified issuance displays the new full number' });
  const response = await page.request.get(`${baseUrl}/api/actions/${actionId}/card-number`);
  if (response.status() !== 200 || response.headers()['cache-control'] !== 'no-store' || (await response.json()).data.cardNumber !== fullNumber) {
    throw new Error('The browser receipt differs from the stored issuance');
  }
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl });
  await receipt.getByRole('button', { name: '复制卡号', exact: true }).click();
  await receipt.getByRole('button', { name: '已复制', exact: true }).waitFor();
  if (await page.evaluate(() => navigator.clipboard.readText()) !== fullNumber) throw new Error('The copy button did not copy the new number');
  await page.screenshot({ path: 'logs/receipt-fix-20261027-issued-card.png', fullPage: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForComposerHydration(page);
  await waitFor(async () => await receipt.count() === 1 && (await receipt.locator('[data-full-card-number]').textContent().catch(() => '')) === fullNumber,
    { timeoutMs: 60_000, description: 'Reload restores one issuance receipt without duplication' });
  const leaked = await withDb(async db => ({
    requests: await db.modelRequest.count({ where: { OR: [{ inputJson: { contains: fullNumber } }, { resultJson: { contains: fullNumber } }] } }),
    sessions: await db.agentSession.count({ where: { stateJson: { contains: fullNumber } } }),
  }));
  if (leaked.requests || leaked.sessions) throw new Error('The complete card number entered model requests or saved conversation history');
}
