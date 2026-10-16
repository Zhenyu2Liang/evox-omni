import type { Browser } from 'playwright-core';
import type { AuditEntry } from '../../lib/contracts/audit';
import type { ActivityRecord } from '../../lib/contracts/activity';
import { createTranslator } from '../../lib/i18n/shared';
import { assertLatestHistory, loadHistoryUntil, renderedHistory } from './history-assertions.e2e-helper';
import { approvalHistory, assertApprovalDock, assertApprovalDockFitsViewport, assertApprovalExecuted, assertReadOnlyApprovalHistory } from './approval-ux.e2e-helper';
import { SELECTORS, assistantTexts, captureScreenshot, fetchPendingActions, getJson, getDeveloperJson, gotoAgent,
  submitChat, submitMfa, waitFor, waitForComposerHydration, waitForMfaCard, withPage } from './helpers';

interface CardSnapshot { cards: Array<{ id: string; type: string; numberMasked: string; status: string }> }

/** The exact seeded card set the journey freezes: one ACTIVE CREDIT, DEBIT and VIRTUAL card. */
const SEEDED_CARDS = [
  { id: 'card_credit', type: 'CREDIT', numberMasked: '****6688' },
  { id: 'card_debit', type: 'DEBIT', numberMasked: '****8821' },
  { id: 'card_virtual', type: 'VIRTUAL', numberMasked: '****7788' },
] as const;

/** Three independent authorization challenges, owner-scoped audit and historical plan placement. */
export async function journeyMultiCardFreeze(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await gotoAgent(page, baseUrl);
    const original = await getJson<CardSnapshot>(`${baseUrl}/api/cards`);
    // Assert the fixture BY TYPE/ID, not a bare count: exactly the three seeded cards, each ACTIVE.
    if (original.cards.length !== SEEDED_CARDS.length ||
        original.cards.some(card => !SEEDED_CARDS.some(seeded => seeded.id === card.id))) {
      throw new Error('The isolated fixture must contain exactly the three seeded cards');
    }
    for (const seeded of SEEDED_CARDS) {
      const card = original.cards.find(row => row.id === seeded.id);
      if (!card || card.type !== seeded.type || card.numberMasked !== seeded.numberMasked || card.status !== 'ACTIVE') {
        throw new Error(`The isolated fixture is missing the active ${seeded.type} card ${seeded.numberMasked} (${seeded.id})`);
      }
    }
    await submitChat(page, 'Plan and freeze all my bank cards');
    await waitForMfaCard(page);
    const first = await waitFor(async () => (await fetchPendingActions(baseUrl))
      .find(action => action.toolName === 'freeze_card' && action.status === 'awaiting_mfa') || false,
    { description: 'The first freeze awaits independent strong verification' });
    if (first.tier !== 'RED') throw new Error('A card freeze is not strongly verified');
    await assertApprovalDock(page, first.id, 'mfa');
    await page.setViewportSize({ width: 390, height: 844 });
    await assertApprovalDockFitsViewport(page, first.id);
    await captureScreenshot(page, 'multi-card-freeze-mfa-dock-mobile');
    await page.setViewportSize({ width: 1440, height: 1100 });
    await page.locator(SELECTORS.mfaInput).fill('111111');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await waitForMfaCard(page);
    await assertApprovalDock(page, first.id, 'mfa');
    if (await page.locator(SELECTORS.mfaInput).inputValue() !== '') throw new Error('Reload persisted an unsubmitted verification secret');
    if ((await getJson<CardSnapshot>(`${baseUrl}/api/cards`)).cards.some(card => card.status !== 'ACTIVE')) {
      throw new Error('A card changed before verification');
    }
    await submitMfa(page, '000000');
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'The wrong-code response settles' });
    if ((await getJson<CardSnapshot>(`${baseUrl}/api/cards`)).cards.some(card => card.status !== 'ACTIVE')) {
      throw new Error('A wrong code froze a card');
    }
    await assertApprovalDock(page, first.id, 'mfa');
    if (await approvalHistory(page, first.id).getAttribute('data-status') !== 'awaiting_mfa') {
      throw new Error('A failed code marked the historical approval as complete');
    }
    await submitMfa(page, '123456');
    const second = await waitFor(async () => (await fetchPendingActions(baseUrl))
      .find(action => action.id !== first.id && action.toolName === 'freeze_card' && action.status === 'awaiting_mfa') || false,
    { description: 'The second card requires a separate verification challenge', timeoutMs: 90_000 });
    if (second.tier !== 'RED') throw new Error('The first approval authorized the second card');
    const partial = await getJson<CardSnapshot>(`${baseUrl}/api/cards`);
    if (partial.cards.filter(card => card.status === 'FROZEN').length !== 1) throw new Error('The first authorization did not freeze exactly one card');
    await waitForMfaCard(page);
    await assertApprovalExecuted(page, first.id, 'awaiting_mfa');
    await assertApprovalDock(page, second.id, 'mfa');
    if (await page.locator(SELECTORS.mfaInput).inputValue() !== '') throw new Error('The second request inherited the first verification code');
    await submitMfa(page, '123456');
    const third = await waitFor(async () => (await fetchPendingActions(baseUrl))
      .find(action => action.id !== first.id && action.id !== second.id && action.toolName === 'freeze_card' && action.status === 'awaiting_mfa') || false,
    { description: 'The third card requires its own independent verification challenge', timeoutMs: 90_000 });
    if (third.tier !== 'RED') throw new Error('An earlier approval authorized the third card');
    const partialTwo = await getJson<CardSnapshot>(`${baseUrl}/api/cards`);
    if (partialTwo.cards.filter(card => card.status === 'FROZEN').length !== 2) throw new Error('The second authorization did not freeze exactly two cards');
    await waitForMfaCard(page);
    await assertApprovalExecuted(page, second.id, 'awaiting_mfa');
    await assertApprovalDock(page, third.id, 'mfa');
    if (await page.locator(SELECTORS.mfaInput).inputValue() !== '') throw new Error('The third request inherited an earlier verification code');
    await submitMfa(page, '123456');
    await waitFor(async () => (await getJson<CardSnapshot>(`${baseUrl}/api/cards`)).cards.every(card => card.status === 'FROZEN') &&
      await page.locator(SELECTORS.composer).isEnabled(), { description: 'All three independently authorized freezes are complete' });
    await assertApprovalExecuted(page, third.id, 'awaiting_mfa');
    if (await page.locator(SELECTORS.approvalRequest).count()) throw new Error('Completed card freezes leave an actionable request in the dock');
    const history = await getJson<{ entries: ActivityRecord[] }>(`${baseUrl}/api/activity`);
    const completed = history.entries.filter(entry => entry.type === 'card_freeze' && entry.status === 'completed');
    if (completed.length !== 3 || completed.some(entry => entry.verification !== 'passed')) {
      throw new Error('Business history is missing one of the independently verified card freezes');
    }
    await page.goto(`${baseUrl}/activity`);
    await page.locator('[data-operation-history]').waitFor();
    const businessText = await page.locator('main').innerText();
    if (!businessText.includes(t('pages.activity.type.card_freeze')) || businessText.includes('freeze_card')) {
      throw new Error('Normal business history is missing freezes or exposes technical tool names');
    }
    if (await page.locator('a[href="/audit"]:visible').count()) throw new Error('Normal navigation exposes technical audits');
    const audits = await getDeveloperJson<{ entries: AuditEntry[] }>(`${baseUrl}/api/audit?toolName=freeze_card&status=success`);
    if (audits.entries.length !== 3 || audits.entries.some(entry => entry.riskLevel !== 'RED' || !entry.mfaRequired || !entry.userId)) {
      throw new Error('The audit read model is missing one of the verified card freezes');
    }
    await gotoAgent(page, baseUrl);
    await waitForComposerHydration(page);
    const plans = page.locator('[data-message-role="tool"] [data-chat-card-type="plan"]');
    await loadHistoryUntil(page, async () => await plans.count() > 0);
    await assertApprovalExecuted(page, first.id, 'awaiting_mfa');
    await assertApprovalExecuted(page, second.id, 'awaiting_mfa');
    await assertApprovalExecuted(page, third.id, 'awaiting_mfa');
    if (await plans.count() !== 1) throw new Error('Refresh did not restore exactly one historical plan');
    const before = (await assistantTexts(page)).length;
    await submitChat(page, 'Hello');
    await waitFor(async () => (await assistantTexts(page)).length > before && await page.locator(SELECTORS.composer).isEnabled(),
      { description: 'An unrelated conversation completes after the plan' });
    const positioned = await plans.first().evaluate(element => {
      const owner = element.closest('[data-message-role="tool"]');
      const lastUser = [...document.querySelectorAll('[data-message-role="user"]')].at(-1);
      return Boolean(owner && lastUser && (owner.compareDocumentPosition(lastUser) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    if (!positioned || await page.locator('[data-chat-card-type="plan"]').count() !== 1) {
      throw new Error('The completed plan is pinned after the new conversation');
    }
    const beforeReload = await renderedHistory(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, beforeReload);
    await loadHistoryUntil(page, async () => await plans.count() > 0);
    await assertApprovalExecuted(page, first.id, 'awaiting_mfa');
    await assertApprovalExecuted(page, second.id, 'awaiting_mfa');
    await assertApprovalExecuted(page, third.id, 'awaiting_mfa');
    await assertReadOnlyApprovalHistory(page);
    if (await plans.count() !== 1 || await page.getByRole('button', { name: t('cards.plan.control.pause'), exact: true }).count()) {
      throw new Error('Reload resurrected completed workflow controls');
    }
    if (errors.length) throw new Error(errors.join('; '));
    await captureScreenshot(page, 'multi-card-freeze-history');
    await page.locator('[data-developer-toggle]:visible').click();
    await page.locator('a[href="/audit"]:visible').waitFor();
    await page.goto(`${baseUrl}/audit`);
    await page.locator('[data-developer-audit]').waitFor();
    if (!(await page.locator('main').innerText()).includes('freeze_card')) throw new Error('Developer audit cannot inspect completed freezes');
    await page.locator('[data-developer-toggle]:visible').click();
    await page.waitForURL('**/agent');
    return 'Three cards each require a separate RED challenge in a mobile-safe dock outside the transcript; pending reload preserves the request without its code, wrong codes retain pending status, successful verification dismisses each request and preserves read-only approval transitions; completed plans keep their original message placement.';
  }, { label: 'multi-card-freeze' });
}
