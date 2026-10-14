import { z } from 'zod';
import type { ChatMessage } from './contracts/agent';
import { CHAT_HISTORY_PAGE_SIZE, type ChatHistoryIdentity, type ChatHistoryPage } from './contracts/chat-history';
import { AppError } from './errors';

const cursorSchema = z.object({
  version: z.literal(1),
  sessionId: z.string().min(1),
  userId: z.string().min(1),
  historyGeneration: z.string().min(1),
  revision: z.number().int().nonnegative(),
  anchorId: z.string().min(1),
}).strict();

function cursorFor(identity: ChatHistoryIdentity, anchorId: string): string {
  return Buffer.from(JSON.stringify({ version: 1, ...identity, anchorId }), 'utf8').toString('base64url');
}

function cursorAnchor(cursor: string, identity: ChatHistoryIdentity): string {
  let parsed: z.infer<typeof cursorSchema>;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid cursor encoding.');
    const decoded = Buffer.from(cursor, 'base64url');
    if (decoded.toString('base64url') !== cursor) throw new Error('Invalid cursor encoding.');
    parsed = cursorSchema.parse(JSON.parse(decoded.toString('utf8')));
  } catch {
    throw new AppError('VALIDATION', 'Invalid conversation history cursor.');
  }
  if (parsed.sessionId !== identity.sessionId || parsed.userId !== identity.userId ||
      parsed.historyGeneration !== identity.historyGeneration || parsed.revision > identity.revision) {
    throw new AppError('CONFLICT', 'The conversation history changed. Reload the conversation.');
  }
  return parsed.anchorId;
}

/** Slice only the read projection; original conversation records remain untouched. */
export function selectChatHistoryPage(
  messages: readonly ChatMessage[],
  identity: ChatHistoryIdentity,
  options: { cursor?: string; limit?: number } = {},
): ChatHistoryPage {
  const limit = options.limit ?? CHAT_HISTORY_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_HISTORY_PAGE_SIZE) {
    throw new AppError('VALIDATION', 'Conversation history page size must be between 1 and 20.');
  }
  let end = messages.length;
  if (options.cursor !== undefined) {
    const anchor = cursorAnchor(options.cursor, identity);
    const matches = messages.flatMap((message, index) => message.id === anchor ? [index] : []);
    if (matches.length !== 1) throw new AppError('CONFLICT', 'The conversation history changed. Reload the conversation.');
    end = matches[0];
  }
  const start = Math.max(0, end - limit);
  const selected = messages.slice(start, end);
  return {
    messages: selected,
    hasMore: start > 0,
    ...(start > 0 && selected.length > 0 ? { nextCursor: cursorFor(identity, selected[0].id) } : {}),
    revision: identity.revision,
    historyGeneration: identity.historyGeneration,
  };
}
