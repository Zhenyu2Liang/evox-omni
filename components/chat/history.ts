import type { ChatMessage } from '@/lib/contracts/agent';
import { CHAT_HISTORY_PAGE_SIZE, type ChatHistoryPage } from '@/lib/contracts/chat-history';
import { isChatMessage } from './transport-validation';

/** A history fetch fills missing rows; loaded messages retain newer streamed cards and statuses. */
export function prependHistoryMessages(current: readonly ChatMessage[], older: readonly ChatMessage[]): ChatMessage[] {
  const loaded = new Set(current.map(message => message.id));
  const unseen = new Map<string, ChatMessage>();
  for (const message of older) if (!loaded.has(message.id) && !unseen.has(message.id)) unseen.set(message.id, message);
  return [...unseen.values(), ...current];
}

export type ChatHistoryState = Omit<ChatHistoryPage, 'messages'>;

/** A reset changes the generation; appends may increase the revision without invalidating a page. */
export function acceptsHistoryPage(history: ChatHistoryState | undefined, page: ChatHistoryPage): boolean {
  return history !== undefined && history.historyGeneration === page.historyGeneration;
}

export function mergeHistoryPage<T extends { messages: ChatMessage[]; history?: ChatHistoryState }>(state: T, page: ChatHistoryPage): T {
  if (!acceptsHistoryPage(state.history, page)) return state;
  return { ...state, messages: prependHistoryMessages(state.messages, page.messages), history: {
    hasMore: page.hasMore, nextCursor: page.nextCursor,
    revision: Math.max(state.history!.revision, page.revision), historyGeneration: page.historyGeneration,
  } };
}

export function isChatHistoryPage(value: unknown): value is ChatHistoryPage {
  if (!value || typeof value !== 'object') return false;
  const page = value as ChatHistoryPage;
  return Array.isArray(page.messages) && page.messages.length <= CHAT_HISTORY_PAGE_SIZE && page.messages.every(isChatMessage) &&
    typeof page.hasMore === 'boolean' && Number.isSafeInteger(page.revision) && page.revision >= 0 &&
    typeof page.historyGeneration === 'string' && page.historyGeneration.length > 0 &&
    (page.hasMore ? typeof page.nextCursor === 'string' && page.nextCursor.length > 0 : page.nextCursor === undefined);
}

export interface ScrollAnchor { id: string; offset: number; }

/** Use the first visible message rather than total height, which also changes during streaming. */
export function captureHistoryAnchor(container: HTMLElement): ScrollAnchor | undefined {
  const top = container.getBoundingClientRect().top;
  for (const row of container.querySelectorAll<HTMLElement>('[data-message-id]')) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > top) return { id: row.dataset.messageId!, offset: bounds.top - top };
  }
  return undefined;
}

export function restoreHistoryAnchor(container: HTMLElement, anchor: ScrollAnchor): void {
  const row = [...container.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.dataset.messageId === anchor.id);
  if (row) container.scrollTop += row.getBoundingClientRect().top - container.getBoundingClientRect().top - anchor.offset;
}
