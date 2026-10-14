import type { ChatMessage } from './agent';

export const CHAT_HISTORY_PAGE_SIZE = 20;

export interface ChatHistoryPage {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor?: string;
  revision: number;
  historyGeneration: string;
}

export interface ChatHistoryIdentity {
  sessionId: string;
  userId: string;
  revision: number;
  historyGeneration: string;
}

export interface ConversationHistorySearch {
  query: string;
  limit?: number;
  beforeIndex?: number;
}

export interface ConversationHistoryMatch {
  messageId: string;
  role: 'user' | 'assistant';
  text: string;
  index: number;
  timestamp: number;
}

export interface ConversationHistorySearchPage {
  matches: ConversationHistoryMatch[];
  hasMore: boolean;
  nextBeforeIndex?: number;
}
