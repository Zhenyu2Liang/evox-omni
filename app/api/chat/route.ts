/**
 * POST /api/chat — drive one agent turn.
 *
 * Contract:
 *  - Body: `ChatTurnRequest` = `{ sessionId?: string; message: string }` (validated with
 *    `chatTurnRequestSchema`). `sessionId` may be omitted on the first turn.
 *  - Mode (query `?stream=` or `Accept` header), validated with `chatQuerySchema`:
 *      - default / `?stream=1` → `text/event-stream`: each `AgentStreamEvent` is written as one
 *        SSE frame (`data: <JSON>\n\n`), terminated by `data: {"type":"done"}\n\n`. A mid-turn
 *        failure emits `{"type":"error","message":<safe>}` then `done`.
 *      - `?stream=0` or `Accept: application/json` → `200 { ok:true, data: ChatTurnResponse }`
 *        where `data = { sessionId, events: AgentStreamEvent[] }`.
 *  - Delegates to the agent runtime `runTurn({ sessionId, message, userId }, onEvent?)`
 *    (`@/agent`). On the first turn the route sets the `banking_session` cookie.
 *
 * STUB (Genesis architecture pass): body not implemented yet.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { AppError } from '@/lib/errors';
// Agent runtime contract (owner: `@/agent`).
import { runTurn, resumeTurn } from '@/agent';
import type { ChatTurnResponse } from '@/lib/contracts/agent';

/** Request body schema for `POST /api/chat` (`ChatTurnRequest`). */
export const chatTurnRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type ChatTurnBody = z.infer<typeof chatTurnRequestSchema>;

/** Query schema: `?stream=0|1` (default streaming). */
export const chatQuerySchema = z.object({
  stream: z.enum(['0', '1']).optional(),
});
export type ChatQuery = z.infer<typeof chatQuerySchema>;

export async function POST(_req: NextRequest): Promise<Response> {
  throw new AppError('INTERNAL', 'not implemented');
}

void runTurn;
void resumeTurn;
export type { ChatTurnResponse };
