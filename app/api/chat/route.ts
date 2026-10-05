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
 *  - Delegates to the agent runtime `runTurn({ sessionId, message })` (`@/agent`). `runTurn`
 *    resolves the demo user internally and returns the FULL ordered event list (there is no
 *    `onEvent` sink), so streaming writes the returned events as SSE frames.
 *  - IDENTITY IS COOKIE-ONLY. The turn's session comes ONLY from the `banking_session` cookie
 *    (`resolveSessionId`); it is NEVER taken from the request body. A body `sessionId` that
 *    DISAGREES with the cookie — INCLUDING the case where there is no cookie — is rejected with
 *    `409 CONFLICT` and no cookie is set, so a body `sessionId` can never select or mint a session
 *    (it can never exchange a foreign session id for an authorization cookie).
 *  - On EVERY successful response the route sets the `banking_session` cookie to `res.sessionId`
 *    — the session actually used, never a body-supplied id.
 *
 * Thin by design: `validate (zod) → delegate → serialize`.
 */
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { runTurn } from '@/agent';
import { SESSION_COOKIE } from '@/lib/constants';
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
import { resolveSessionId } from '../_lib/session';

/** Request body schema for `POST /api/chat` (`ChatTurnRequest`). */
const chatTurnRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1),
});
export type ChatTurnBody = z.infer<typeof chatTurnRequestSchema>;

/** Query schema: `?stream=0|1` (default streaming). */
const chatQuerySchema = z.object({
  stream: z.enum(['0', '1']).optional(),
});
export type ChatQuery = z.infer<typeof chatQuerySchema>;

const encoder = new TextEncoder();

/** Build the `banking_session` Set-Cookie value for a turn's session id. */
function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`;
}

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

    // SECURITY CHOKEPOINT — identity is cookie-only. The session comes SOLELY from the trusted
    // `banking_session` cookie; a body `sessionId` is never trusted for identity. If the body
    // disagrees with the cookie (INCLUDING "no cookie present"), refuse with 409 and set NO
    // cookie. Otherwise an attacker holding their OWN valid cookie could pass a VICTIM's
    // sessionId in the body and receive the victim's authorization cookie back (session
    // takeover), then confirm the victim's parked actions.
    const cookieSessionId = resolveSessionId(req);
    if (payload.sessionId !== undefined && payload.sessionId !== cookieSessionId) {
      throw new AppError('CONFLICT', '会话标识不匹配，请刷新后重试。');
    }

    const res = await runTurn({ sessionId: cookieSessionId, message: payload.message });
    const cookie = sessionCookie(res.sessionId);

    if (!wantsStream(req, stream)) {
      return jsonResponse<ChatTurnResponse>(res, { headers: { 'Set-Cookie': cookie } });
    }

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        try {
          for (const evt of res.events) controller.enqueue(encoder.encode(sseFrame(evt)));
          // runTurn already appends a trailing done event; only add our own terminator
          // when the runtime did not (robust against future changes to the list).
          const last = res.events[res.events.length - 1];
          if (last?.type !== 'done') controller.enqueue(encoder.encode(sseFrame({ type: 'done' })));
        } catch (e) {
          // A mid-turn failure never leaks the raw exception (or the MFA code): the centralized
          // `mapAppError` yields a safe message, then the stream is terminated cleanly.
          const { message: safe } = mapAppError(e).body.error;
          controller.enqueue(encoder.encode(sseFrame({ type: 'error', message: safe })));
          controller.enqueue(encoder.encode(sseFrame({ type: 'done' })));
        }
        controller.close();
      },
    });

    return sseResponse(body, { headers: { 'Set-Cookie': cookie } });
  } catch (e) {
    return errorResponse(e);
  }
}

export type { ChatTurnResponse };
