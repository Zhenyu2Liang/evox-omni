/**
 * POST /api/chat — drive one agent turn.
 *
 * Contract:
 *  - Body: `ChatTurnRequest` = `{ sessionId?: string; message: string }` (validated with the
 *    non-exported `chatTurnRequestSchema`). `sessionId` may be omitted on the first turn.
 *  - Mode (query `?stream=` or `Accept` header), validated with `chatQuerySchema`:
 *      - default / `?stream=1` → `text/event-stream`: each `AgentStreamEvent` is written as one
 *        SSE frame (`data: <JSON>\n\n`), terminated by `data: {"type":"done"}\n\n`. A mid-stream
 *        failure emits `{"type":"error","message":<safe>}` then `done`.
 *      - `?stream=0` or `Accept: application/json` → `200 { ok:true, data: ChatTurnResponse }`
 *        where `data = { sessionId, events: AgentStreamEvent[] }`.
 *  - Delegates to `runTurn` with a persist-first event sink. Streaming publishes each event after
 *    the runtime journal commits it; the JSON mode returns the same ordered presentation events.
 *    `requestId` binds a retried request to its original run within the fixed demo session.
 *  - Identity is the server-configured demo user and its persistent `demo:${userId}` session.
 *    Cookies and query parameters cannot select another workspace. An optional body `sessionId`
 *    is a consistency assertion; a mismatch returns `409 CONFLICT` before a turn is admitted.
 *  - Page opening creates or loads the same demo workspace in every browser. This route has no
 *    login requirement and never issues an authentication cookie. Language cookies are preferences.
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runTurn } from '@/agent';
import type { ChatTurnResponse } from '@/lib/contracts/agent';
import { AppError } from '@/lib/errors';
import {
  errorResponse,
  jsonResponse,
  mapAppError,
  parseBody,
  parseQuery,
  sseFrame,
  sseResponse,
} from '../_lib/http';
import { requireIdentity } from '../_lib/session';

/** Request body schema for `POST /api/chat` (`ChatTurnRequest`). */
const chatTurnRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  requestId: z.string().min(1).max(128).optional(),
  message: z.string().min(1).max(4000),
});
export type ChatTurnBody = z.infer<typeof chatTurnRequestSchema>;

/** Query schema: `?stream=0|1` (default streaming). */
const chatQuerySchema = z.object({
  stream: z.enum(['0', '1']).optional(),
});
export type ChatQuery = z.infer<typeof chatQuerySchema>;

const encoder = new TextEncoder();

/** Default to streaming unless `?stream=0` or the client explicitly asks for JSON. */
function wantsStream(req: NextRequest, stream: '0' | '1' | undefined): boolean {
  if (stream === '0') return false;
  const accept = req.headers.get('accept') ?? '';
  return !accept.includes('application/json');
}

export async function POST(req: NextRequest): Promise<Response> {
  try {
    const payload = await parseBody(chatTurnRequestSchema, req);
    const { stream } = parseQuery(chatQuerySchema, req);

    const identity = await requireIdentity(req);
    // A supplied identity is a consistency assertion, never a workspace selection mechanism.
    if (payload.sessionId !== undefined && payload.sessionId !== identity.sessionId) {
      throw new AppError('CONFLICT', 'The conversation changed. Reload the page and try again.');
    }

    if (!wantsStream(req, stream)) {
      const result = await runTurn({ sessionId: identity.sessionId, requestId: payload.requestId, message: payload.message });
      return jsonResponse<ChatTurnResponse>(result);
    }
    let connected = true;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const result = await runTurn({ sessionId: identity.sessionId, requestId: payload.requestId, message: payload.message }, {
            onEvent(event) { if (connected) controller.enqueue(encoder.encode(sseFrame(event))); },
          });
          if (connected && result.events.at(-1)?.type !== 'done') controller.enqueue(encoder.encode(sseFrame({ type: 'done' })));
        } catch (e) {
          // A mid-turn failure never leaks the raw exception (or the MFA code): the centralized
          // `mapAppError` yields a safe message, then the stream is terminated cleanly.
          const { message: safe } = mapAppError(e).body.error;
          if (connected) {
            controller.enqueue(encoder.encode(sseFrame({ type: 'error', message: safe })));
            controller.enqueue(encoder.encode(sseFrame({ type: 'done' })));
          }
        }
        if (connected) controller.close();
      },
      cancel() { connected = false; },
    });

    return sseResponse(body);
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ChatTurnResponse };
