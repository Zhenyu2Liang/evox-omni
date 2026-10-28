import type { Browser, Page } from 'playwright-core';
import { createTranslator } from '../../lib/i18n/shared';
import prompts from './conversation.zh-CN.json';
import regressions from '../fixtures/dialogue-regressions.zh-CN.json';
import advisory from '../fixtures/advisory-policy.zh-CN.json';
import incomplete from '../fixtures/incomplete-reply.zh-CN.json';
import { assertLatestHistory, renderedHistory } from './history-assertions.e2e-helper';
import { moneyToCents } from '../../lib/money';
import { withDb } from './live-virtual-card.e2e-helper';

/** Topic isolation must still allow an explicitly resumed request to reach a fresh human gate. */
export async function journeyExplicitDraftResume(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
    const ledger = await fetchLedger(baseUrl);
    await completedReply(page, prompts.draftTransfer);
    const chat = await completedReply(page, prompts.smallTalk);
    if (chat.includes(prompts.recipient) || (await fetchPendingActions(baseUrl)).length) {
      throw new Error('Small talk revived the unsubmitted draft');
    }
    await submitChat(page, '请继续刚才给张伟的转账，金额明确为201.37元，从默认活期账户付款，请现在发起并等待我确认。');
    await waitForConfirmCard(page, 90_000);
    const actionId = await page.locator(SELECTORS.approvalRequest).getAttribute('data-action-id');
    if (!actionId) throw new Error('The explicitly resumed request has no fresh authorization');
    const row = await withDb(db => db.pendingAction.findUniqueOrThrow({ where: { id: actionId } }));
    const args = JSON.parse(row.argsJson);
    if (row.toolName !== 'transfer_money' || args.contactId !== 'contact_zhangwei' || moneyToCents(args.amount) !== 20137n) {
      throw new Error('Explicit resumption changed its recipient or amount');
    }
    if ((await fetchDashboardSummary(baseUrl)).checkingBalance !== balance) throw new Error('Resumption paid before confirmation');
    await captureScreenshot(page, 'explicit-draft-resumption-confirmation');
    await clickConfirm(page);
    await waitFor(async () => moneyToCents((await fetchDashboardSummary(baseUrl)).checkingBalance) === moneyToCents(balance) - 20137n,
      { timeoutMs: 120_000, description: 'Explicitly resumed transfer commits once after confirmation' });
    const change = diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions);
    if (change.added.length !== 1 || change.removed.length) throw new Error('Explicit resumption produced duplicate or missing ledger entries');
    return `A suspended draft stayed inactive during small talk; explicit resumption created ${actionId} for Zhang Wei / 201.37, with one confirmed debit.`;
  }, { label: 'explicit-draft-resumption' });
}
import { SELECTORS, assistantTexts, captureScreenshot, diffLedger, fetchCards, fetchDashboardSummary,
  fetchLedger, fetchPendingActions, getJson, gotoAgent, submitChat, waitFor, waitForComposerHydration,
  clickConfirm, waitForConfirmCard, withPage } from './helpers';

/** Wait for the completed message rather than accepting an initial streaming fragment. */
async function completedReply(page: Page, request: string): Promise<string> {
  const read = async () => waitFor(async () => {
    try { return await assistantTexts(page); }
    catch (error) {
      // Development hot reload can replace the document during a read. Never retry a POST.
      if (error instanceof Error && error.message.includes('Execution context was destroyed')) return false;
      throw error;
    }
  }, { timeoutMs: 10000, description: 'Assistant text is readable after document navigation' });
  const before = (await read()).length;
  await submitChat(page, request);
  await waitFor(async () => (await read()).length > before &&
    await page.locator(SELECTORS.composer).isEnabled() &&
    Boolean((await read()).at(-1)?.trim()), {
    timeoutMs: 120_000,
    description: 'A completed conversational answer is rendered',
  });
  return (await read()).at(-1)!.trim();
}

/** Exercise the user's exact advice request, including a first-time gated query. */
export async function journeySubscriptionAdvice(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await gotoAgent(page, baseUrl);
    const ledger = await fetchLedger(baseUrl);
    const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
    const subscriptions = await getJson<unknown>(`${baseUrl}/api/subscriptions`);
    await submitChat(page, advisory.advice[0]);
    await waitForConfirmCard(page, 120_000);
    const before = await fetchPendingActions(baseUrl);
    if (before.length !== 1 || before[0].toolName !== 'list_subscriptions') {
      throw new Error('Advice created a mutation or an unrelated authorization');
    }
    await clickConfirm(page);
    await waitFor(async () => {
      const answer = (await assistantTexts(page)).at(-1) ?? '';
      return await page.locator(SELECTORS.composer).isEnabled() &&
        answer.includes(regressions.fitnessName) && /315[.]3(?:0)?/.test(answer.replaceAll(',', '')) && answer.length > 100;
    }, { timeoutMs: 120_000, description: 'Confirmed query resumes the original advice question' });
    const answer = (await assistantTexts(page)).at(-1)!;
    const timeline = await page.locator('[data-message-role]').evaluateAll(elements => elements.map(element => ({
      role: element.getAttribute('data-message-role'), text: element.textContent ?? '',
    })));
    const resultIndex = timeline.findIndex(entry => entry.role === 'tool' && entry.text.includes('Netflix') && entry.text.includes('188.50'));
    const analysisIndex = timeline.findLastIndex(entry => entry.role === 'assistant' && entry.text.includes(regressions.fitnessName) && entry.text.includes('315.30'));
    if (resultIndex < 0 || analysisIndex <= resultIndex) throw new Error('The subscription tool result did not precede the assistant analysis as an independent entry.');
    if (answer.includes(regressions.oldFallback) || /"guidance"\s*:|<think>|"tool_calls"\s*:/.test(answer)) {
      throw new Error('Advice leaked a protocol or was replaced by a generic warning');
    }
    if ((await fetchPendingActions(baseUrl)).length || JSON.stringify(await getJson<unknown>(`${baseUrl}/api/subscriptions`)) !== JSON.stringify(subscriptions) ||
      (await fetchDashboardSummary(baseUrl)).checkingBalance !== balance || diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions).added.length) {
      throw new Error('Read-only advice changed banking data or opened another operation');
    }
    const followUp = await completedReply(page, advisory.advice[1]);
    if (!followUp.includes(regressions.fitnessName) || followUp.length < 100 ||
        (await fetchPendingActions(baseUrl)).length) throw new Error('Advice lost the existing query context');
    const transcript = await renderedHistory(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, transcript);
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    await captureScreenshot(page, 'subscription-advice-confirmation-and-context');
    return 'The exact advice request obtains only a confirmed query, immediately produces analysis without another user message, reuses its context on follow-up, preserves full replies after reload, and performs no banking mutation.';
  }, { label: 'subscription-advice-confirmation-and-context' });
}

/** Preserve the fraud-choice context and require a complete response without guessing a card. */
export async function journeyCompleteFraudDiscussion(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await gotoAgent(page, baseUrl);
    const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
    const ledger = await fetchLedger(baseUrl);
    const cards = await fetchCards(baseUrl);
    const replies: string[] = [];
    for (const question of [incomplete.anomalyQuery, incomplete.refundQuestion, incomplete.labelledChoiceQuestion, incomplete.choice]) {
      const answer = await completedReply(page, question);
      if (!answer.trim()) throw new Error('The completed assistant message has no displayable text');
      replies.push(answer);
    }
    // Completion is proven by persisted provider transport evidence in the parent scenario.
    // An English/Chinese phrase list cannot prove that the model understood the choice.
    if ((await fetchPendingActions(baseUrl)).length ||
        JSON.stringify(await fetchCards(baseUrl)) !== JSON.stringify(cards) ||
        (await fetchDashboardSummary(baseUrl)).checkingBalance !== balance ||
        diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions).added.length) {
      throw new Error('An unspecified fraud discussion froze a guessed card or changed the ledger');
    }
    const transcript = await renderedHistory(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, transcript);
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    await captureScreenshot(page, 'complete-fraud-choice-discussion');
    return 'Anomaly, refund clarification and the contextual B choice preserve complete provider text after reload; no guessed card is frozen and no financial authorization or ledger change occurs.';
  }, { label: 'complete-fraud-choice-discussion' });
}

/** Signed input, conversational recall and follow-up analysis share the actual persistent UI path. */
export async function journeyDialogueRegressions(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await gotoAgent(page, baseUrl);
    const ledger = await fetchLedger(baseUrl);
    const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
    const subscriptions = await getJson<unknown>(`${baseUrl}/api/subscriptions`);
    const invalid = await completedReply(page, regressions.negativeTransfer);
    if (!invalid.includes('-10') || !/(?:不能|无法|无效|不支持|不允许|拒绝|正数|大于\s*0|invalid|cannot|can't|not valid|positive|greater than\s*0)/i.test(invalid)) {
      throw new Error(`Negative amount was not rejected: ${invalid}`);
    }
    if (invalid.includes(regressions.missingAmount) || await page.locator('[data-chat-card-type="contacts"]').count() ||
      (await fetchPendingActions(baseUrl)).length) throw new Error('Negative money became a missing amount, a lookup or an authorization');
    const recall = await completedReply(page, regressions.recallQuestion);
    if (!/(?:[-\u2212\uff0d]\s*10|\u8d1f\s*(?:10|\u5341))/.test(recall.replaceAll('*', ''))) {
      throw new Error(`Recall lost the negative sign: ${recall}`);
    }
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    const afterReload = await completedReply(page, regressions.recallAfterReload);
    if (!/(?:[-\u2212\uff0d]\s*10|\u8d1f\s*(?:10|\u5341))/.test(afterReload.replaceAll('*', ''))) {
      throw new Error(`Recall after reload lost the signed original request: ${afterReload}`);
    }
    await submitChat(page, regressions.subscriptionQuery);
    await waitForConfirmCard(page);
    await clickConfirm(page);
    await waitFor(async () => Boolean(await page.locator('[data-chat-card-type="subscriptions"]').count()) &&
      await page.locator(SELECTORS.composer).isEnabled(), { description: 'The explicitly confirmed subscription query completes' });
    const analysis = await completedReply(page, regressions.analysisFollowUp);
    if (analysis.includes(regressions.oldFallback) || !analysis.includes(regressions.fitnessName) ||
      !/315[.]3(?:0)?/.test(analysis.replaceAll(',', '')) || analysis.length < 80) {
      throw new Error(`Follow-up analysis was lost or omitted the prior subscription data: ${analysis}`);
    }
    const main = await page.locator('main').innerText();
    if (main.includes('This message asks for conversation or explanation') || main.includes('Do not resume an earlier write')) {
      throw new Error('Internal model correction leaked into ordinary conversation');
    }
    if ((await fetchPendingActions(baseUrl)).length ||
      await page.getByRole('button', { name: t('cards.confirm'), exact: true }).count() ||
      await page.locator(SELECTORS.mfaInput).count() ||
      JSON.stringify(await getJson<unknown>(`${baseUrl}/api/subscriptions`)) !== JSON.stringify(subscriptions) ||
      (await fetchDashboardSummary(baseUrl)).checkingBalance !== balance ||
      diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions).added.length) {
      throw new Error('Recall or advice created an authorization or changed banking data');
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    await captureScreenshot(page, 'signed-amount-memory-and-subscription-analysis');
    return 'Negative money is refused before a lookup or model write; exact signed wording survives recall and reload; previous subscription results support natural analysis without generic safety prose, new authorizations, data changes or browser errors.';
  }, { label: 'signed-amount-memory-and-subscription-analysis' });
}

/** Natural conversation cannot authorize a write, revive a draft or become an execution failure. */
export async function journeyNaturalConversation(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await gotoAgent(page, baseUrl);
    const ledger = await fetchLedger(baseUrl);
    const balance = (await fetchDashboardSummary(baseUrl)).checkingBalance;
    const cards = await fetchCards(baseUrl);
    const schedules = await getJson<unknown>(`${baseUrl}/api/schedules`);
    const planCount = await page.getByText(t('cards.plan.title'), { exact: true }).count();
    const actions = await fetchPendingActions(baseUrl);
    if (actions.length) throw new Error('The conversation fixture starts with unfinished authorization');

    await completedReply(page, prompts.draftTransfer);
    const questions = [prompts.fundingQuestion, prompts.smallTalk, prompts.scheduleQuestion];
    const answers: string[] = [];
    for (const request of questions) {
      const reply = await completedReply(page, request);
      answers.push(reply);
      if (prompts.failurePhrases.some(phrase => reply.includes(phrase)) ||
        /```json|"(?:tool_calls|arguments|role|content)"\s*:/.test(reply) || /^[\[{]/.test(reply)) {
        throw new Error(`Conversation was replaced by an execution warning or protocol object: ${reply}`);
      }
      if (/\b(?:sourceAccountId|CHECKING|REMINDER|PAYMENT|TRANSFER|create_scheduled_task|transfer_money)\b/.test(reply)) {
        throw new Error(`An ordinary answer exposes internal parameter or tool identifiers: ${reply}`);
      }
      if (prompts.abandonedDraftPhrases.some(phrase => reply.includes(phrase))) {
        throw new Error(`An ordinary answer solicits parameters for an abandoned draft: ${reply}`);
      }
      if ([prompts.smallTalk, prompts.scheduleQuestion].includes(request) && reply.includes(prompts.recipient)) {
        throw new Error(`An unrelated topic still mentions the old draft recipient: ${reply}`);
      }
      if (await page.getByRole('button', { name: t('cards.confirm'), exact: true }).count() ||
        await page.locator(SELECTORS.mfaInput).count() ||
        await page.getByText(t('cards.plan.title'), { exact: true }).count() !== planCount ||
        (await fetchPendingActions(baseUrl)).length) {
        throw new Error('A conversational question created an authorization or workflow');
      }
    }
    const funding = answers[0];
    // Equivalent Chinese account-choice wording must not turn a correct live answer into a failure.
    const explicitChoice = funding.includes(prompts.explicitAccount) || /选定|选择|选用/.test(funding);
    if (![prompts.checkingAccount, prompts.defaultAccount].every(word => funding.includes(word)) || !explicitChoice) {
      throw new Error(`The funding explanation omits the checking default or explicit account choice: ${funding}`);
    }
    if (!answers[2].includes(prompts.scheduledTask) ||
      !prompts.supportedAnswers.some(word => answers[2].includes(word))) {
      throw new Error(`The scheduled-task capability question is not answered: ${answers[2]}`);
    }
    if (new Set(answers).size !== answers.length) throw new Error('Distinct questions repeat one generic answer');

    // A later bare amount cannot silently complete the transfer draft abandoned by conversation.
    await completedReply(page, prompts.amountOnly);
    if ((await fetchPendingActions(baseUrl)).length || await page.locator(SELECTORS.mfaInput).count() ||
      await page.getByRole('button', { name: t('cards.confirm'), exact: true }).count()) {
      throw new Error('An amount-only message resumed the abandoned transfer draft');
    }
    const transcript = await renderedHistory(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await assertLatestHistory(page, baseUrl, transcript);
    await captureScreenshot(page, 'natural-conversation-before-transfer');

    await submitChat(page, prompts.completeTransfer);
    await waitForConfirmCard(page, 120_000);
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), {
      timeoutMs: 120_000, description: 'The complete transfer request parks for confirmation',
    });
    const pending = await fetchPendingActions(baseUrl);
    if (pending.length !== 1 || pending[0].toolName !== 'transfer_money' || pending[0].tier !== 'YELLOW') {
      throw new Error('An explicit transfer no longer creates the expected gated operation');
    }
    if (!(await page.locator('main').innerText()).includes(prompts.recipient)) {
      throw new Error('The transfer confirmation omits its recipient');
    }
    const difference = diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions);
    if (difference.added.length || difference.removed.length ||
      (await fetchDashboardSummary(baseUrl)).checkingBalance !== balance ||
      JSON.stringify(await fetchCards(baseUrl)) !== JSON.stringify(cards) ||
      JSON.stringify(await getJson<unknown>(`${baseUrl}/api/schedules`)) !== JSON.stringify(schedules)) {
      throw new Error('Conversation or an unconfirmed transfer changed banking data');
    }
    await page.getByRole('button', { name: t('cards.cancel'), exact: true }).click();
    await waitFor(async () => (await fetchPendingActions(baseUrl)).length === 0 &&
      await page.locator(SELECTORS.composer).isEnabled(), {
      timeoutMs: 120_000, description: 'Cancelling the transfer leaves no authorization for later journeys',
    });
    if ((await fetchDashboardSummary(baseUrl)).checkingBalance !== balance ||
      diffLedger(ledger.transactions, (await fetchLedger(baseUrl)).transactions).added.length) {
      throw new Error('Cancelling the unconfirmed transfer moved money');
    }
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    return 'Funding explanation, small talk and scheduled-task capability questions produce distinct natural answers; no writes, plans or authorization appear; an old draft is not resumed; refresh preserves answers; a later explicit transfer still requires confirmation; no browser errors.';
  }, { label: 'natural-conversation-and-financial-boundary' });
}
