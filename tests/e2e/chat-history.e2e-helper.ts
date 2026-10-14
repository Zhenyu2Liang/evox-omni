import type { Browser, Page } from 'playwright-core';
import type { ChatMessage } from '../../lib/contracts/agent';
import { createTranslator } from '../../lib/i18n/shared';
import { SELECTORS, captureScreenshot, gotoAgent, readDemoSessionId, waitFor, waitForComposerHydration, withPage } from './helpers';

/** This fixture changes only the isolated browser database's conversation archive. */
async function seedHistory(sessionId: string): Promise<ChatMessage[]> {
  if (!/(?:^|[/\\])e2e\.db$/.test(process.env.DATABASE_URL ?? '')) throw new Error('History fixtures require the isolated E2E database.');
  const { createDatabaseClient } = await import('../../lib/db/database');
  const db = createDatabaseClient();
  try {
    const row = await db.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
    const saved = JSON.parse(row.stateJson) as Record<string, unknown>;
    const messages: ChatMessage[] = Array.from({ length: 45 }, (_, index) => ({
      id: `history-fixture-${index}`, role: index % 2 ? 'assistant' : 'user', timestamp: Date.now() - (45 - index) * 1000,
      content: index === 43 ? '**Complete archived reply**\n\n' + 'An archived paragraph remains complete.\n\n'.repeat(80) : `Archived message ${index}.`,
    }));
    await db.agentSession.update({ where: { id: sessionId }, data: {
      stateJson: JSON.stringify({ ...saved, transcript: messages }), revision: { increment: 1 },
    } });
    return messages;
  } finally { await db.$disconnect(); }
}

async function ids(page: Page): Promise<string[]> {
  return page.locator('[data-message-id]').evaluateAll(rows => rows.map(row => row.getAttribute('data-message-id')!));
}

async function topAnchor(page: Page): Promise<{ id: string; offset: number }> {
  return page.locator('[data-chat-scroll]').evaluate(list => {
    const top = list.getBoundingClientRect().top;
    const row = [...list.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > top)!;
    return { id: row.dataset.messageId!, offset: row.getBoundingClientRect().top - top };
  });
}

/** Exercise twenty-row pages, full replies, scroll anchoring and stale-response fencing. */
export async function journeyChatHistory(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    const fixture = await seedHistory(await readDemoSessionId(page));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'Archive restoration completes' });
    if (JSON.stringify(await ids(page)) !== JSON.stringify(fixture.slice(25).map(row => row.id))) throw new Error('The first view does not contain exactly the latest twenty archive rows');
    if ((await page.locator('[data-message-id="history-fixture-43"]').innerText()).match(/An archived paragraph/g)?.length !== 80) throw new Error('A long archived reply was trimmed');
    const scroll = page.locator('[data-chat-scroll]');
    if (!await scroll.evaluate(list => list.scrollHeight - list.scrollTop - list.clientHeight < 3)) throw new Error('The initial twenty messages did not scroll to the latest');
    await page.locator(SELECTORS.composer).fill('Keep this unsent draft');
    await scroll.evaluate(list => { list.scrollTop = 0; });
    await page.route('**/api/chat/history?**', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' }), { times: 1 });
    await page.locator('[data-load-history]').click();
    await page.getByText(t('chat.history.failed'), { exact: true }).waitFor();
    if ((await ids(page)).length !== 20) throw new Error('A failed history request removed loaded messages');
    const anchor = await topAnchor(page);
    await page.getByRole('button', { name: t('chat.history.retry'), exact: true }).click();
    await waitFor(async () => (await ids(page)).length === 40, { description: 'Retry prepends twenty earlier rows' });
    const restored = await page.locator(`[data-message-id="${anchor.id}"]`).evaluate(row =>
      row.getBoundingClientRect().top - row.closest('[data-chat-scroll]')!.getBoundingClientRect().top);
    if (Math.abs(restored - anchor.offset) > 3) throw new Error('Prepending a page moved the reading anchor');
    if (await page.locator(SELECTORS.composer).inputValue() !== 'Keep this unsent draft') throw new Error('Pagination cleared the composer draft');
    await page.locator('[data-locale-switcher]:visible').first().selectOption('en');
    await waitFor(async () => await page.locator('html').getAttribute('lang') === 'en', { description: 'The history view changes language' });
    if ((await ids(page)).length !== 40 || await page.locator(SELECTORS.composer).inputValue() !== 'Keep this unsent draft') throw new Error('Changing language reset loaded history or draft');
    await page.locator('[data-developer-toggle]:visible').click();
    await page.locator('[data-developer-tools]:visible').waitFor();
    if ((await ids(page)).length !== 40) throw new Error('Developer mode changed the displayed page size');
    await scroll.evaluate(list => { list.scrollTop = 0; });
    await page.locator('[data-load-history]').click();
    await page.locator('[data-history-complete]').waitFor();
    if (JSON.stringify(await ids(page)) !== JSON.stringify(fixture.map(row => row.id))) throw new Error('Earlier pages contain missing or duplicated archive rows');
    await withPage(browser, async second => {
      await gotoAgent(second, baseUrl);
      if (JSON.stringify(await ids(second)) !== JSON.stringify(fixture.slice(25).map(row => row.id))) throw new Error('A second browser does not share the archive or received more than twenty initial rows');
      if (await second.locator('[data-developer-toggle]:visible').getAttribute('aria-checked') !== 'false') throw new Error('Developer preference leaked to another browser');
    });

    // Delay delivery of the actual server response so the reader can scroll during generation.
    let releaseTurn!: () => void;
    let receivedTurn!: () => void;
    const heldTurn = new Promise<void>(resolve => { releaseTurn = resolve; });
    const serverTurn = new Promise<void>(resolve => { receivedTurn = resolve; });
    await page.route('**/api/chat', async route => {
      const response = await route.fetch(); receivedTurn(); await heldTurn; await route.fulfill({ response });
    }, { times: 1 });
    await page.locator(SELECTORS.composer).fill('Hello');
    await page.getByRole('button', { name: createTranslator('en')('chat.composer.send'), exact: true }).click();
    await serverTurn;
    await scroll.evaluate(list => { list.scrollTop = 0; list.dispatchEvent(new Event('scroll')); });
    releaseTurn();
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'The delayed server turn settles' });
    await page.getByRole('button', { name: createTranslator('en')('chat.history.newMessages'), exact: true }).waitFor();
    if (await scroll.evaluate(list => list.scrollTop > 10)) throw new Error('New content forced the reader to the bottom');
    await page.locator('[data-chat-latest]').click();
    if (!await scroll.evaluate(list => list.scrollHeight - list.scrollTop - list.clientHeight < 3)) throw new Error('Back to latest did not reach the new reply');
    await page.locator('a[href="/overview"]:visible').click();
    await page.waitForURL('**/overview');
    const refreshed = page.waitForResponse(response => response.request().isNavigationRequest() && new URL(response.url()).pathname === '/agent');
    await page.locator('[data-developer-refresh]:visible').click();
    await refreshed;
    await waitForComposerHydration(page);
    if ((await ids(page)).length !== 20) throw new Error('Developer refresh did not reopen the latest twenty records');
    await page.setViewportSize({ width: 390, height: 844 });
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) throw new Error('History view exceeds the mobile viewport');
    await captureScreenshot(page, 'chat-history-mobile');
    await page.setViewportSize({ width: 1440, height: 960 });

    // A reset navigates to a fresh generation while an older read response is still in flight.
    let releasePage!: () => void;
    let receivedPage!: () => void;
    const heldPage = new Promise<void>(resolve => { releasePage = resolve; });
    const serverPage = new Promise<void>(resolve => { receivedPage = resolve; });
    await page.route('**/api/chat/history?**', async route => {
      const response = await route.fetch(); receivedPage(); await heldPage;
      await route.fulfill({ response }).catch(() => undefined);
    }, { times: 1 });
    await scroll.evaluate(list => { list.scrollTop = 0; });
    await page.locator('[data-load-history]').click();
    await serverPage;
    await page.locator('[data-developer-clear]:visible').click();
    const resetDialog = page.locator('[data-developer-reset-dialog][open]');
    await resetDialog.waitFor();
    await resetDialog.locator('[data-developer-confirm-clear]').click();
    await waitFor(async () => (await ids(page)).length === 0 && await page.locator(SELECTORS.composer).isEnabled(), { description: 'Reset displays a fresh empty conversation' });
    releasePage();
    await page.request.get(`${baseUrl}/api/chat/history`);
    if ((await ids(page)).length !== 0) throw new Error('A delayed history page entered the reset generation');
    await withPage(browser, async second => {
      await gotoAgent(second, baseUrl);
      if ((await ids(second)).length) throw new Error('Another browser revived the cleared archive generation');
    });
    return 'Latest twenty messages render complete replies; earlier pages preserve anchors, drafts and preferences; failures retry without loss; new content offers a latest button; refresh and another browser use bounded history; a reset fences delayed pages.';
  }, { label: 'chat-history-pagination' });
}
