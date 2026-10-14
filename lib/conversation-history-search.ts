import type { ChatMessage } from './contracts/agent';
import type { ConversationHistoryMatch, ConversationHistorySearch, ConversationHistorySearchPage } from './contracts/chat-history';
import { AppError } from './errors';

/** Search original user/assistant wording; cards and tool evidence are not conversation quotations. */
export function selectConversationHistoryMatches(messages: readonly ChatMessage[],
  request: ConversationHistorySearch): ConversationHistorySearchPage {
  const query = request.query.trim().toLowerCase();
  const limit = request.limit ?? 20;
  const end = request.beforeIndex ?? messages.length;
  if (!query || query.length > 256 || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
      !Number.isInteger(end) || end < 0 || end > messages.length) {
    throw new AppError('VALIDATION', 'Invalid conversation history search.');
  }
  const newest: ConversationHistoryMatch[] = [];
  let hasMore = false;
  for (let index = end - 1; index >= 0; index--) {
    const message = messages[index];
    if ((message.role !== 'user' && message.role !== 'assistant') || !message.content.toLowerCase().includes(query)) continue;
    if (newest.length === limit) {
      hasMore = true;
      break;
    }
    newest.push({ messageId: message.id, role: message.role, text: message.content, index, timestamp: message.timestamp });
  }
  const matches = newest.reverse();
  return { matches, hasMore, ...(hasMore ? { nextBeforeIndex: matches[0].index } : {}) };
}
