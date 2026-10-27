import type { Browser, Page } from 'playwright-core';
import type { CardView } from '../../banking-sdk';
import type { ChatMessage } from '../../lib/contracts/agent';
import { createTranslator } from '../../lib/i18n/shared';
import { SELECTORS, captureScreenshot, getJson, gotoAgent, readDemoSessionId, waitFor, waitForComposerHydration, withPage } from './helpers';

/** Only the isolated browser fixture archive changes; balances, cards and ledger rows stay intact. */
async function seedLayoutHistory(sessionId: string, cards: CardView[]): Promise<void> {
  if (!/(?:^|[/\\])e2e\.db$/.test(process.env.DATABASE_URL ?? '')) throw new Error('Layout fixtures require the isolated E2E database.');
  const { createDatabaseClient } = await import('../../lib/db/database');
  const db = createDatabaseClient();
  try {
    const row = await db.agentSession.findUniqueOrThrow({ where: { id: sessionId } });
    const saved = JSON.parse(row.stateJson);
    const transcript: ChatMessage[] = Array.from({ length: 36 }, (_, index) => {
      const id = `layout-${index}`;
      const timestamp = Date.UTC(2026, 9, 25 + Math.floor(index / 12), 4, index % 12);
      return index < 34 ? { id, timestamp, role: index % 2 ? 'assistant' : 'user', content: `Archived layout message ${index}.` }
        : { id, timestamp, role: 'tool', content: '', cards: [{ type: 'cards', data: index === 34 ? [cards[0]] : cards }],
          toolEvents: [{ messageId: id, toolCallId: `layout-call-${index}`, toolName: 'get_cards', status: 'success' }] };
    });
    await db.agentSession.update({ where: { id: sessionId }, data: { stateJson: JSON.stringify({ ...saved, transcript }), revision: { increment: 1 } } });
  } finally { await db.$disconnect(); }
}

async function assertBoundedWorkspace(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 2000));
  const bounds = await page.evaluate(() => ({ scroll: window.scrollY, height: document.documentElement.scrollHeight,
    viewport: window.innerHeight, width: document.documentElement.scrollWidth, viewportWidth: window.innerWidth }));
  if (bounds.scroll !== 0 || bounds.height > bounds.viewport + 1 || bounds.width > bounds.viewportWidth) throw new Error(`The chat leaks outer scroll space: ${JSON.stringify(bounds)}`);
  const composer = await page.locator(SELECTORS.composer).boundingBox();
  if (!composer || composer.y < 0 || composer.y + composer.height > bounds.viewport) throw new Error('The composer is outside the visible workspace');
}

export async function journeyChatLayout(browser: Browser, baseUrl: string): Promise<string> {
  const t = createTranslator('zh-CN');
  return withPage(browser, async page => {
    await gotoAgent(page, baseUrl);
    const sessionId = await readDemoSessionId(page);
    const cards = (await getJson<{ cards: CardView[] }>(`${baseUrl}/api/cards`)).cards;
    const ledger = JSON.stringify(await getJson(`${baseUrl}/api/bills`));
    await seedLayoutHistory(sessionId, cards);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposerHydration(page);
    await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'Layout history restoration completes' });
    await page.setViewportSize({ width: 1280, height: 900 });
    await assertBoundedWorkspace(page);
    const days = () => page.locator('[data-chat-day]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-chat-day')));
    if (JSON.stringify(await days()) !== JSON.stringify(['2026-10-26', '2026-10-27'])) throw new Error('The initial page has missing or repeated date separators');
    const single = page.locator('[data-message-id="layout-34"]');
    const multiple = page.locator('[data-message-id="layout-35"]');
    if ((await single.boundingBox())!.width > 449 || (await multiple.boundingBox())!.width <= (await single.boundingBox())!.width + 100) throw new Error('A single bank card has not narrowed independently of multi-card results');
    if (await single.locator('[data-bank-card-grid]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length) !== 1) throw new Error('The single-card result keeps an empty grid column');
    if (await multiple.locator('[data-bank-card-grid]').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length) !== 2) throw new Error('Multiple cards no longer use a desktop grid');
    await single.scrollIntoViewIfNeeded();
    await captureScreenshot(page, 'layout-single-card-desktop');
    const scroll = page.locator('[data-chat-scroll]');
    await scroll.evaluate(el => { el.scrollTop = 0; });
    await page.locator(SELECTORS.composer).fill('Keep this unsent layout draft');
    await page.locator('[data-load-history]').click();
    await waitFor(async () => await page.locator('[data-message-id]').count() === 36, { description: 'Earlier dated messages load' });
    if (JSON.stringify(await days()) !== JSON.stringify(['2026-10-25', '2026-10-26', '2026-10-27'])) throw new Error('History pagination repeats or loses a date separator');
    if (await page.locator(SELECTORS.composer).inputValue() !== 'Keep this unsent layout draft') throw new Error('Loading dated history erased the draft');
    await scroll.evaluate(el => { el.scrollTop = 0; });
    const point = (await scroll.boundingBox())!;
    await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
    await page.mouse.wheel(0, 500);
    await waitFor(async () => await scroll.evaluate(el => el.scrollTop > 0), { description: 'The message area still scrolls internally' });
    for (const height of [844, 480]) {
      await page.setViewportSize({ width: 390, height });
      await assertBoundedWorkspace(page);
      if (await page.locator('[data-chat-page-header]').isVisible() || await page.locator('h1:visible').count() !== 1) throw new Error('The phone repeats its assistant title');
      await captureScreenshot(page, `layout-mobile-${height}`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/cards`, { waitUntil: 'networkidle' });
    await page.evaluate(() => window.scrollTo(0, 500));
    if (await page.evaluate(() => window.scrollY) === 0) throw new Error('The chat scroll lock leaked into the cards page');
    await page.getByRole('button', { name: t('app.openNavigation'), exact: true }).click();
    await page.locator('#mobile-navigation').getByRole('link', { name: t('app.assistant'), exact: true }).click();
    await waitFor(async () => await page.locator('[data-chat-workspace="true"]').count() === 1, { description: 'Client navigation restores the fixed chat workspace' });
    await assertBoundedWorkspace(page);
    if (JSON.stringify(await getJson(`${baseUrl}/api/bills`)) !== ledger) throw new Error('A layout-only journey changed the ledger');
    return 'Desktop and phone have no outer blank scroll; messages scroll internally; single cards fit their content; mobile has one title; dates survive pagination without duplicates; drafts and ordinary page scrolling remain intact; ledger unchanged.';
  }, { label: 'chat-layout-and-date-separators' });
}
