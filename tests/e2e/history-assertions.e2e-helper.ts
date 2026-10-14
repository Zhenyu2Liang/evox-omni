import type { Page } from 'playwright-core';
import type { ChatHistoryPage } from '../../lib/contracts/chat-history';
import { getJson, SELECTORS, waitFor } from './helpers';

export interface RenderedHistoryMessage { id: string; assistantText?: string; }

/** Capture full rendered prose by its persisted assistant identity, not by an assistant-only count. */
export function renderedHistory(page: Page): Promise<RenderedHistoryMessage[]> {
  return page.locator('[data-message-id]').evaluateAll(rows => rows.map(row => ({
    id: row.getAttribute('data-message-id')!,
    assistantText: row.querySelector<HTMLElement>('[data-assistant-content]')?.innerText,
  })));
}

/** A reload opens the latest twenty archival rows; empty prose entries are omitted. */
export async function assertLatestHistory(page: Page, baseUrl: string, before: readonly RenderedHistoryMessage[] = []): Promise<void> {
  await waitFor(async () => await page.locator(SELECTORS.composer).isEnabled(), { description: 'Pending-decision restoration completes before history comparison' });
  const history = await getJson<ChatHistoryPage>(`${baseUrl}/api/chat/history`);
  if (history.messages.length > 20) throw new Error('History API exceeded the initial twenty-message limit');
  const expected = history.messages.filter(message => message.content.length > 0 ||
    (message.role === 'tool' || message.role === 'system') &&
    ((message.toolEvents?.length ?? 0) > 0 || (message.cards?.length ?? 0) > 0));
  const actual = await renderedHistory(page);
  if (JSON.stringify(actual.map(message => message.id)) !== JSON.stringify(expected.map(message => message.id))) {
    throw new Error('The rendered persisted identities differ from the latest twenty-message page');
  }
  const prior = new Map(before.map(message => [message.id, message.assistantText]));
  for (const message of actual) {
    if (prior.has(message.id) && prior.get(message.id) !== message.assistantText) throw new Error(`Reload changed or trimmed the complete assistant reply ${message.id}`);
  }
  for (const message of expected) {
    if (message.role !== 'assistant' && message.content.length > 0) {
      const text = await page.locator(`[data-message-id="${message.id}"] [data-message-content="true"]`).textContent();
      if (text !== message.content) throw new Error(`Reload changed the literal archived wording ${message.id}`);
    }
  }
}

/** Load missing earlier pages when a scenario must inspect a specific original receipt or plan. */
export async function loadHistoryUntil(page: Page, predicate: () => Promise<boolean>): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts++) {
    if (await predicate()) return;
    const earlier = page.locator('[data-load-history]');
    if (!(await earlier.count()) || await earlier.isDisabled()) break;
    const oldIds = (await renderedHistory(page)).map(message => message.id).join(',');
    await earlier.click();
    await waitFor(async () => (await renderedHistory(page)).map(message => message.id).join(',') !== oldIds,
      { description: 'An older archive page renders before checking the original business receipt' });
  }
  if (!await predicate()) {
    const rows = await page.locator('[data-message-id]').evaluateAll(entries => entries.map(entry => ({
      id: entry.getAttribute('data-message-id'), role: entry.getAttribute('data-message-role'),
    })));
    throw new Error(`The expected historical UI entry was not found after loading available pages; rendered entries: ${JSON.stringify(rows)}`);
  }
}
