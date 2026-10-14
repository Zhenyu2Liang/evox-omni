import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { loadSession } from '@/agent/session';
import { conversationHistoryGeneration, readChatHistoryPage } from '@/app/agent/history';
import { CHAT_HISTORY_PAGE_SIZE } from '@/lib/contracts/chat-history';
import { AppError } from '@/lib/errors';
import { errorResponse, jsonResponse, parseQuery } from '../../_lib/http';
import { requireIdentity } from '../../_lib/session';

const querySchema = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.coerce.number().int().min(1).max(CHAT_HISTORY_PAGE_SIZE).optional(),
}).strict();

/** Browser parameters cannot select another user's or another session's history. */
export async function GET(req: NextRequest): Promise<Response> {
  try {
    const options = parseQuery(querySchema, req);
    const identity = await requireIdentity(req);
    const snapshot = await loadSession(identity.sessionId);
    if (!snapshot || snapshot.userId !== identity.userId) throw new AppError('NOT_FOUND', 'Conversation not found.');
    const page = await readChatHistoryPage(snapshot, options);
    const current = await loadSession(identity.sessionId);
    if (!current || current.userId !== identity.userId ||
        conversationHistoryGeneration(current) !== page.historyGeneration) {
      throw new AppError('CONFLICT', 'The conversation history changed. Reload the conversation.');
    }
    return jsonResponse(page, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
