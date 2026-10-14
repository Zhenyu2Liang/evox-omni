import type { Browser } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { assertLatestHistory, loadHistoryUntil, renderedHistory } from './history-assertions.e2e-helper';
import { approvalHistory, assertApprovalDock, assertApprovalDockFitsViewport, assertApprovalExecuted, assertChatBubbleAlignment, assertReadOnlyApprovalHistory } from './approval-ux.e2e-helper';
import { SELECTORS, assistantTexts, captureScreenshot, clickConfirm, gotoAgent, submitChat, waitFor,
  waitForComposerHydration, waitForConfirmCard, withPage } from './helpers';

/** Exercise authorization, later turns and reload against the real event transport and DOM. */
export async function journeyToolLifecycle(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    await submitChat(page, t('chat.suggestion.subscription.prompt'));
    await waitForConfirmCard(page);
    const actionId = await page.locator(SELECTORS.approvalRequest).getAttribute('data-action-id');
    if (!actionId) throw new Error('The subscription approval has no persisted identity');
    await assertApprovalDock(page, actionId, 'confirmation');
    const blocked = page.locator('[data-message-role="tool"] [data-tool-status="blocked"][data-tool-call-id]');
    await blocked.first().waitFor();
    const callId = await blocked.last().getAttribute('data-tool-call-id');
    if (!callId) throw new Error('The gated subscription read has no call identity');
    const messageId = await blocked.last().evaluate(element => element.closest('[data-message-role="tool"]')?.getAttribute('data-message-id'));
    if (!messageId) throw new Error('The gated subscription read has no owning tool message');
    const owner = page.locator(`[data-message-role="tool"][data-message-id="${messageId}"]`);
    const activity = owner.locator(`[data-tool-call-id="${callId}"]`);
    await page.setViewportSize({ width: 390, height: 844 });
    await assertApprovalDockFitsViewport(page, actionId);
    await captureScreenshot(page, 'subscription-approval-dock-mobile');
    await page.setViewportSize({ width: 390, height: 480 });
    await assertApprovalDockFitsViewport(page, actionId);
    await captureScreenshot(page, 'subscription-approval-dock-keyboard-height');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await waitForConfirmCard(page);
    await assertApprovalDock(page, actionId, 'confirmation');
    await loadHistoryUntil(page, async () => await activity.count() > 0);
    await clickConfirm(page);
    await waitFor(async () => (await activity.getAttribute('data-tool-status')) === 'success', {
      description: 'The original gated tool becomes successful in its historical message',
    });
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'Authorization continuation is complete' });
    await assertApprovalExecuted(page, actionId, 'pending');
    if (await page.locator(SELECTORS.approvalRequest).count()) throw new Error('A settled subscription still occupies the approval dock');
    if (await page.getByRole('button', { name: t('cards.confirm'), exact: true }).count()) {
      throw new Error('The executed subscription read still offers confirmation');
    }
    if ((await activity.textContent())?.includes('list_subscriptions')) throw new Error('The known tool name was not localized');
    const subscriptions = owner.locator('[data-chat-card-type="subscriptions"]');
    await subscriptions.last().waitFor();
    if (await subscriptions.count() !== 1 || await page.locator('[data-chat-card-type="subscriptions"]').count() !== 1) {
      throw new Error('Authorization misplaced or duplicated the subscription result card');
    }
    if (!(await subscriptions.last().textContent())?.includes('Netflix')) throw new Error('The authorized subscription data was not rendered as a business card');
    if (await page.locator('[data-tool-diagnostics]').count()) throw new Error('Normal mode rendered developer diagnostics');
    await activity.scrollIntoViewIfNeeded();
    await captureScreenshot(page, 'subscription-confirmed-tool');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await assertChatBubbleAlignment(page);
    await page.locator(SELECTORS.assistantText).last().scrollIntoViewIfNeeded();
    await captureScreenshot(page, 'subscription-chat-desktop-alignment');
    await subscriptions.last().scrollIntoViewIfNeeded();
    await captureScreenshot(page, 'subscription-results-normal');
    await page.setViewportSize({ width: 390, height: 844 });
    await subscriptions.last().scrollIntoViewIfNeeded();
    const withinViewport = await subscriptions.last().evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
    });
    if (!withinViewport) throw new Error('The subscription result card overflows a mobile viewport');
    await captureScreenshot(page, 'subscription-results-mobile');
    await page.setViewportSize({ width: 1440, height: 1100 });

    await page.evaluate(previousCall => {
      const state = window as Window & { staleToolFlash?: boolean; toolObserver?: MutationObserver };
      state.staleToolFlash = false;
      state.toolObserver = new MutationObserver(() => {
        const rows = document.querySelectorAll('[data-live-tool-activity] [data-tool-call-id]');
        if ([...rows].some(row => row.getAttribute('data-tool-call-id') === previousCall)) state.staleToolFlash = true;
      });
      state.toolObserver.observe(document.body, { childList: true, subtree: true, attributes: true });
    }, callId);
    for (const request of ['Hello', 'Check my account balances']) {
      const before = (await assistantTexts(page)).length;
      await submitChat(page, request);
      await waitFor(async () => (await assistantTexts(page)).length > before && await page.locator(SELECTORS.composer).isEnabled(), {
        description: 'The later conversation completes without old tool activity',
      });
    }
    const flashed = await page.evaluate(() => {
      const state = window as Window & { staleToolFlash?: boolean; toolObserver?: MutationObserver };
      state.toolObserver?.disconnect();
      return state.staleToolFlash;
    });
    if (flashed) throw new Error('A settled subscription call flashed in a later turn');
    const beforeReload = await renderedHistory(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, beforeReload);
    await loadHistoryUntil(page, async () => await activity.count() > 0 && await subscriptions.count() > 0);
    await assertApprovalExecuted(page, actionId, 'pending');
    if (await approvalHistory(page, actionId).count() !== 1) throw new Error('Reload lost the original subscription approval receipt');
    await assertReadOnlyApprovalHistory(page);
    if (await activity.getAttribute('data-tool-status') !== 'success') throw new Error('Reload restored a stale tool status');
    if (await page.locator('[data-message-role="tool"] [data-tool-status="started"], [data-message-role="tool"] [data-tool-status="updated"]').count()) {
      throw new Error('The settled history contains a running tool after reload');
    }
    await subscriptions.last().waitFor();
    if (await subscriptions.count() !== 1 || await page.locator('[data-chat-card-type="subscriptions"]').count() !== 1) {
      throw new Error('Reload misplaced or duplicated the authorized subscription result card');
    }
    await page.locator('[data-developer-toggle]:visible').click();
    const diagnostics = activity.locator('[data-tool-diagnostics]');
    await diagnostics.waitFor();
    await diagnostics.locator('summary').click();
    if (!(await diagnostics.textContent())?.includes('list_subscriptions')) throw new Error('Developer diagnostics did not show the recorded tool name');
    if ((await diagnostics.locator('[data-tool-arguments]').textContent())?.trim() !== '{}') throw new Error('Developer diagnostics did not restore the recorded subscription arguments');
    await activity.scrollIntoViewIfNeeded();
    await captureScreenshot(page, 'subscription-developer-details');
    await page.locator('[data-developer-toggle]:visible').click();
    await waitFor(async () => await page.locator('[data-tool-diagnostics]').count() === 0, { description: 'Disabling developer mode removes technical details from the conversation' });
    const screenshot = await captureScreenshot(page, 'subscription-tool-lifecycle');
    return `Subscription approval stays outside the transcript, fits mobile and survives pending reload; confirmation dismisses the dock and preserves previous/current states in a read-only receipt; results remain business cards and later turns never flash stale activity. Screenshot: ${screenshot ?? 'unavailable'}`;
  }, { label: 'subscription-tool-lifecycle' });
}
