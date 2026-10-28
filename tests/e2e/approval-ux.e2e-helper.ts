import type { Locator, Page } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import { SELECTORS, waitFor } from './helpers';

const translate = createTranslator('zh-CN');

/** Locate approval surfaces by persisted identity, never by transcript order. */
export function approvalRequest(page: Page, actionId: string): Locator {
  return page.locator(`${SELECTORS.approvalRequest}[data-action-id="${actionId}"]`);
}

export function approvalHistory(page: Page, actionId: string): Locator {
  return page.locator(`[data-approval-history="true"][data-action-id="${actionId}"]`);
}

/** Verify the actionable dock is separate from read-only transcript receipts. */
export async function assertApprovalDock(page: Page, actionId: string, kind: 'confirmation' | 'mfa'): Promise<void> {
  const request = approvalRequest(page, actionId);
  await request.waitFor({ state: 'visible' });
  if (await request.getAttribute('data-kind') !== kind) throw new Error('The approval dock shows the wrong verification requirement');
  if (!await request.evaluate(element => !element.closest('[data-chat-scroll]') && !element.closest('[data-message-role]'))) {
    throw new Error('An actionable approval request is inside the message transcript');
  }
  await assertReadOnlyApprovalHistory(page);
}

export async function assertReadOnlyApprovalHistory(page: Page): Promise<void> {
  const messages = page.locator('[data-chat-scroll] [data-message-role]');
  if (await messages.locator(`input[aria-label="${translate('cards.mfa.label')}"], [data-approval-request="true"]`).count()) {
    throw new Error('The transcript contains an actionable verification request');
  }
  for (const name of [translate('cards.confirm'), translate('cards.verify')]) {
    if (await messages.getByRole('button', { name, exact: true }).count()) throw new Error('A historical message still offers authorization');
  }
  if (await page.locator('[data-approval-history="true"]').locator('button, input, form').count()) {
    throw new Error('An approval receipt contains interactive controls');
  }
}

/** A settled request disappears while the original operation retains both approval stages. */
export async function assertApprovalExecuted(page: Page, actionId: string, previous: 'pending' | 'awaiting_mfa'): Promise<void> {
  const history = approvalHistory(page, actionId);
  await waitFor(async () => await approvalRequest(page, actionId).count() === 0 &&
    await history.getAttribute('data-status') === 'executed', { description: 'The request closes and its original receipt records execution' });
  if (await history.count() !== 1) throw new Error('The operation has duplicated approval history');
  const before = history.locator('[data-approval-stage="previous"]');
  const after = history.locator('[data-approval-stage="current"]');
  if (await before.getAttribute('data-stage-status') !== previous || await after.getAttribute('data-stage-status') !== 'executed') {
    throw new Error('The approval history lost its previous or current state');
  }
  await assertReadOnlyApprovalHistory(page);
}

export async function assertApprovalDockFitsViewport(page: Page, actionId: string): Promise<void> {
  const request = approvalRequest(page, actionId);
  let lastMeasurement: unknown;
  let fittingSamples = 0;
  try {
    await waitFor(async () => {
      const measurement = await request.evaluate((element, composerSelector) => {
        const requestBounds = element.getBoundingClientRect();
        const composer = document.querySelector(composerSelector)?.closest('form');
        const composerBounds = composer?.getBoundingClientRect();
        const controls = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
        return {
          fits: [requestBounds, composerBounds].every(bounds => bounds !== undefined &&
            bounds.left >= 0 && bounds.right <= window.innerWidth && bounds.top >= 0 && bounds.bottom <= window.innerHeight) &&
            controls.length > 0 && controls.every(bounds => bounds.left >= requestBounds.left && bounds.right <= requestBounds.right &&
              bounds.top >= requestBounds.top && bounds.bottom <= requestBounds.bottom) &&
            document.documentElement.scrollWidth <= window.innerWidth,
          request: requestBounds.toJSON(), composer: composerBounds?.toJSON(),
          viewport: { width: window.innerWidth, height: window.innerHeight },
          documentWidth: document.documentElement.scrollWidth,
        };
      }, SELECTORS.composer);
      lastMeasurement = measurement;
      fittingSamples = measurement.fits ? fittingSamples + 1 : 0;
      return fittingSamples >= 2;
    }, { timeoutMs: 5_000, description: 'Responsive approval dock and composer both settle inside the viewport' });
  } catch (cause) {
    throw new Error(`The approval request or composer did not fit: ${JSON.stringify(lastMeasurement)}; ${String(cause)}`, { cause });
  }
}

/** Role labels and avatars must not turn the assistant prose into a full-width panel. */
export async function assertChatBubbleAlignment(page: Page): Promise<void> {
  const assistant = page.locator('[data-message-role="assistant"]').last().locator(':scope > div > div').first();
  const user = page.locator('[data-message-role="user"] [data-message-content="true"]').last();
  await assistant.waitFor();
  await user.waitFor();
  const assistantBounds = await assistant.evaluate(element => {
    const bubble = element.getBoundingClientRect();
    const row = element.closest('[data-message-role]')!.getBoundingClientRect();
    return { left: bubble.left, right: bubble.right, width: bubble.width, rowWidth: row.width };
  });
  const userBounds = await user.evaluate(element => {
    const bubble = element.parentElement!.getBoundingClientRect();
    return { left: bubble.left, right: bubble.right };
  });
  if (assistantBounds.width >= assistantBounds.rowWidth * 0.95 || assistantBounds.left >= userBounds.left ||
    assistantBounds.right >= userBounds.right) {
    throw new Error('Desktop chat does not distinguish a narrower left assistant bubble from the right user bubble');
  }
}
