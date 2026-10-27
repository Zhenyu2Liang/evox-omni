import type { Browser, Page } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { SELECTORS, assistantTexts, captureScreenshot, fetchDashboardSummary, fetchLedger, getJson, gotoAgent, submitChat, submitMfa, waitFor, waitForMfaCard, withPage } from './helpers';

const t = createTranslator('zh-CN');
const panel = '[data-unlock-panel]';

async function assertNormal(page: Page) {
  await page.locator(`${panel}[data-unlock-locked="false"]`).waitFor();
  if ((await page.locator('[data-security-current-state]').innerText()) !== t('security.reset.currentNormal')) throw new Error('The current unrestricted state is unclear');
  if (await page.locator('[data-lock-reason]').count()) throw new Error('Old account restriction is presented as current');
  if (await page.locator('[data-unlock-guidance]').getAttribute('open') !== null) throw new Error('Normal status still expands the unlocking workflow');
  if (await page.locator(SELECTORS.unlockCodeInput).isVisible()) throw new Error('An unrestricted account is asked to enter a code by default');
}

/** Same real UI assertions run offline and against the real provider; no transfer is executed. */
export async function journeyCharcoalSecurity(browser: Browser, baseUrl: string, options: { identity?: boolean } = {}): Promise<string> {
  return withPage(browser, async page => {
    const ledger = JSON.stringify(await fetchLedger(baseUrl));
    const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
    await page.setViewportSize({ width: 1440, height: 960 });
    await gotoAgent(page, baseUrl);
    const activeLink = page.locator('aside a[aria-current="page"]');
    if (await activeLink.evaluate(el => getComputedStyle(el).color) !== 'rgb(119, 87, 75)') throw new Error('Normal navigation does not use warm neutral text');
    if (await page.locator('[data-assistant-help-trigger]:visible').evaluate(el => getComputedStyle(el).color) !== 'rgb(119, 87, 75)') throw new Error('The help entry does not use warm neutral text');
    await captureScreenshot(page, 'charcoal-assistant');
    await page.goto(`${baseUrl}/security`, { waitUntil: 'networkidle' });
    await assertNormal(page);
    await captureScreenshot(page, 'security-normal-clean');
    await page.goto(`${baseUrl}/bills`, { waitUntil: 'networkidle' });
    const bars = page.getByRole('group', { name: t('chart.categories'), exact: true });
    const bar = bars.locator('g[role="img"]').first();
    if (await bar.locator('rect').evaluate(el => getComputedStyle(el).fill) !== 'rgb(111, 158, 154)') throw new Error('The first bar does not use the teal series colour');
    await bar.focus();
    await waitFor(async () => await bar.locator('rect').evaluate(el => getComputedStyle(el).fill) === 'rgb(200, 56, 60)', { description: 'Keyboard focus highlights only the selected bar in brand red' });
    await bar.press('Tab');
    await page.mouse.move(0, 0);
    const slices = await page.getByRole('group', { name: t('chart.shares'), exact: true }).locator('circle[tabindex]').evaluateAll(nodes => nodes.map(node => node.getAttribute('stroke')));
    if (slices.length < 5 || new Set(slices).size !== slices.length || slices.some(color => ['#C8383C', '#B42318'].includes(color ?? ''))) throw new Error('Category colours repeat or borrow warning/brand reds');
    await page.getByRole('heading', { name: t('pages.bills.title'), exact: true }).click();
    await page.mouse.move(0, 0);
    await waitFor(async () => await bars.locator('g[role="img"] rect').evaluateAll(nodes => nodes.every(node => {
      const hex = node.getAttribute('fill')?.match(/[a-f\d]{2}/gi);
      return hex?.length === 3 && getComputedStyle(node).fill === `rgb(${hex.map(part => parseInt(part, 16)).join(', ')})`;
    })), { description: 'Unselected chart bars return to their category colours' });
    await captureScreenshot(page, 'charcoal-bills');

    await gotoAgent(page, baseUrl);
    if (options.identity) {
      const before = (await assistantTexts(page)).length;
      await submitChat(page, '你叫什么名字？请用一句话介绍自己。');
      await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled() && (await assistantTexts(page)).length > before, { timeoutMs: 120000, description: 'The real assistant introduces itself' });
      const introduction = (await assistantTexts(page)).slice(before).join('\n');
      if (!/融序|RONGXU/i.test(introduction)) throw new Error('The real model did not introduce the Rongxu identity');
    }
    await submitChat(page, '给张伟转3000元');
    await waitForMfaCard(page, 120000);
    const actionId = await page.locator(SELECTORS.approvalRequest).getAttribute('data-action-id');
    if (!actionId) throw new Error('No real pending action was created');
    for (let attempt = 1; attempt <= 3; attempt++) {
      const response = page.waitForResponse(res => res.url().endsWith(`/api/actions/${actionId}/verify`) && res.request().method() === 'POST');
      await submitMfa(page, '000000');
      await response;
      await waitFor(async () => {
        const state = await getJson<{ circuitBreaker: { failures: number; locked: boolean } }>(`${baseUrl}/api/security`);
        return state.circuitBreaker.failures === attempt && state.circuitBreaker.locked === (attempt === 3);
      }, { description: `Verification attempt ${attempt} settles without transferring money` });
    }
    await page.goto(`${baseUrl}/security`, { waitUntil: 'networkidle' });
    await page.locator(`${panel}[data-unlock-locked="true"]`).waitFor();
    if ((await page.locator('[data-security-current-state]').innerText()) !== t('security.reset.currentLocked')) throw new Error('The active account restriction is missing');
    if (await page.locator('[data-unlock-guidance]').getAttribute('open') === null) throw new Error('The restricted account hides the required recovery workflow');
    await captureScreenshot(page, 'security-currently-restricted');
    const resetForm = page.locator(panel).locator('form');
    await page.locator(SELECTORS.unlockCodeInput).fill('000000');
    await resetForm.getByRole('button', { name: t('security.reset.unlock'), exact: true }).click();
    await page.locator('[data-unlock-status="error"]').waitFor();
    if ((await page.locator(panel).getAttribute('data-unlock-locked')) !== 'true') throw new Error('A wrong reset code cleared the restriction');
    await page.locator(SELECTORS.unlockCodeInput).fill('123456');
    await resetForm.getByRole('button', { name: t('security.reset.unlock'), exact: true }).click();
    await page.locator('[data-unlock-status="success"]').waitFor();
    await assertNormal(page);
    if ((await page.locator('[data-unlock-impact]').innerText()).indexOf(t('security.reset.historicalImpact', { count: 1 })) < 0) throw new Error('Historical operation locks are confused with the current account restriction');
    const lockedRecord = page.locator(`[data-locked-action-id="${actionId}"]`);
    await lockedRecord.waitFor();
    await lockedRecord.getByText(t('cards.amount'), { exact: true }).waitFor();
    if ((await lockedRecord.innerText()).includes('Transfer money after')) throw new Error('The security record still exposes an untranslated static policy title');
    const record = await getJson<{ lockedActions: { actionId: string }[] }>(`${baseUrl}/api/security`);
    if (!record.lockedActions.some(action => action.actionId === actionId)) throw new Error('Unlocking the account changed the original terminal operation');
    await page.reload({ waitUntil: 'networkidle' });
    await assertNormal(page);
    await captureScreenshot(page, 'security-normal-with-history');
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Security history overflows the phone viewport');
    await captureScreenshot(page, 'security-normal-with-history-mobile');
    if (JSON.stringify(await fetchLedger(baseUrl)) !== ledger || (await fetchDashboardSummary(baseUrl)).checkingBalance !== balance) throw new Error('The lock/unlock presentation test changed funds or ledger records');
    return 'Muted navigation/help/chart defaults; distinct category colours and red focused bars; normal, restricted and normal-with-history security states agree with server facts; wrong unlock denied, correct unlock retains terminal action; reload/mobile work; balances and ledger unchanged.';
  }, { label: 'charcoal-and-security-state' });
}
