import type { Browser } from 'playwright-core';
import { SELECTORS, assistantTexts, diffLedger, fetchLedger, gotoAgent, readDemoSessionId, submitChat, waitFor, waitForComposerHydration, withPage } from './helpers';
import guidance from '../../agent/messages/conversation.zh-CN.json';
import { renderInvalidAmountResponse } from '../../agent/providers/mock/invalid-amount-response';
import { assertLatestHistory, renderedHistory } from './history-assertions.e2e-helper';

/** Separate browser profiles share one persisted conversation and cannot select another user. */
export async function journeySharedDemo(browser: Browser, baseUrl: string): Promise<string> {
  return withPage(browser, async first => {
    const errors: string[] = [];
    first.on('pageerror', error => errors.push(error.message));
    await gotoAgent(first, baseUrl);
    const sessionId = await readDemoSessionId(first);
    const before = await fetchLedger(baseUrl);
    const turns = [
      { request: 'Hello', response: guidance.greeting },
      { request: '\u662f-200\u5143\uff0c\u4e0d\u662f200', response: renderInvalidAmountResponse('\u662f-200\u5143\uff0c\u4e0d\u662f200') },
      { request: '\u7ed9\u6211\u5361\u589e\u52a0200\u5143', response: guidance.card_operation_ambiguous },
      { request: 'Confirm', response: guidance.confirmation_in_chat },
    ];
    for (const turn of turns) {
      const priorReplyCount = (await assistantTexts(first)).length;
      await submitChat(first, turn.request);
      await waitFor(async () => {
        const replies = await assistantTexts(first);
        return replies.length > priorReplyCount && replies.at(-1)?.trim() === turn.response.trim() &&
          await first.locator(SELECTORS.composer).isEnabled();
      }, {
        description: `The conversation advances with distinct guidance for ${turn.request}`,
      });
    }
    const change = diffLedger(before.transactions, (await fetchLedger(baseUrl)).transactions);
    if (change.added.length || change.removed.length) throw new Error('Conversational clarification changed the financial ledger');
    if ((await first.context().cookies()).some(cookie => cookie.name === 'banking_session')) {
      throw new Error('The shared demo still requires a browser identity cookie');
    }
    const afterTurns = await assistantTexts(first);
    const renderedAfterTurns = await renderedHistory(first);
    if (new Set(afterTurns).size < 4 || afterTurns.some(text => text.includes('\uff08\u7cfb\u7edf\u6821\u6b63\uff09'))) {
      throw new Error('The conversation fell back into repeated correction text');
    }
    await withPage(browser, async second => {
      await second.context().addCookies([{ name: 'banking_session', value: 'another-browser-session', url: baseUrl }]);
      await gotoAgent(second, baseUrl);
      if (await readDemoSessionId(second) !== sessionId) throw new Error('Another browser selected a different demo conversation');
      await assertLatestHistory(second, baseUrl, renderedAfterTurns);
      await submitChat(second, 'Check my account balances');
      await second.getByText('\u8d26\u6237\u4f59\u989d', { exact: true }).first().waitFor();
      await waitFor(async () => await second.locator(SELECTORS.composer).isEnabled(), { description: 'The shared balance read is complete' });
    }, { label: 'shared-demo-second-browser' });
    await first.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(first);
    await assertLatestHistory(first, baseUrl);
    await first.getByText('\u8d26\u6237\u4f59\u989d', { exact: true }).first().waitFor();
    if (await readDemoSessionId(first) !== sessionId) throw new Error('Reload changed the shared demo conversation');
    if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
    return 'Browsers share a server-selected conversation without login; greetings, negative corrections, ambiguous card changes and confirmation advance distinctly; a later balance query works and clarification never changes the ledger';
  }, { label: 'shared-demo-dialogue' });
}
