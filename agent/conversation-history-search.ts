import { loadSession } from './session';
import type { ConversationHistorySearch, ConversationHistorySearchPage } from '@/lib/contracts/chat-history';
import { selectConversationHistoryMatches } from '@/lib/conversation-history-search';
import { AppError } from '@/lib/errors';

/** Trusted runtime identity fixes the archive scope; model arguments cannot select another owner. */
export async function searchConversationHistory(input: ConversationHistorySearch & {
  userId: string; sessionId: string;
}): Promise<ConversationHistorySearchPage> {
  const snapshot = await loadSession(input.sessionId);
  if (!snapshot || snapshot.userId !== input.userId) throw new AppError('NOT_FOUND', 'Conversation not found.');
  return selectConversationHistoryMatches(snapshot.transcript, input);
}
