'use client';

/**
 * `actions.ts` — client-side fetch helpers for the `./app` API routes.
 *
 * This module is the browser's ONLY way to drive banking actions: it never executes a banking op
 * itself, it POSTs to the routes owned by `./app` and returns the parsed `ChatTurnResponse`.
 *
 * Contract notes (see `@/app/api/_lib/http.ts` + `_lib/types.ts`):
 *  - `POST /api/chat` streams `text/event-stream` in the default mode: one `data: <JSON>\n\n` frame
 *    per `AgentStreamEvent`, terminated by `data: {"type":"done"}\n\n`. A `?stream=0` /
 *    `Accept: application/json` request gets the JSON envelope `{ ok:true, data: ChatTurnResponse }`.
 *  - The action routes (confirm/verify/cancel) return `{ ok:true, data: ActionResponse }` or the
 *    error envelope `{ ok:false, error:{ code, message } }`. A DOMAIN failure (e.g. a wrong MFA code)
 *    is a normal `200` with `data.ok === false` + a safe `data.message` — NOT an HTTP error.
 *  - `GET /api/tasks/:id` returns `{ ok:true, data: TaskPlan }` (or `404` for an unknown id).
 *
 * Hard rules: these helpers NEVER throw. Every failure (network, parse, `!response.ok`, domain error)
 * surfaces as an `{ type:'error'; message }` event folded into the returned `ChatTurnResponse`, and
 * the message is always SAFE (never a raw stack / internals). `fetchTaskPlan` instead resolves to
 * `undefined` on ANY failure (a refresh-recovery read is best-effort, never a user-facing error).
 */
import type { AgentStreamEvent, ChatTurnRequest, ChatTurnResponse } from '@/lib/contracts/agent';
import type { TaskPlan } from '@/lib/contracts/task';

export interface ChatEndpoints {
  chat: string; // default '/api/chat'
  confirm: (actionId: string) => string; // default `/api/actions/${id}/confirm`
  verify: (actionId: string) => string; // default `/api/actions/${id}/verify`
  cancel: (actionId: string) => string; // default `/api/actions/${id}/cancel`
  task: (id: string) => string; // default `/api/tasks/${id}` — read ONE persisted plan
}

export const DEFAULT_ENDPOINTS: ChatEndpoints = {
  chat: '/api/chat',
  confirm: (actionId) => `/api/actions/${actionId}/confirm`,
  verify: (actionId) => `/api/actions/${actionId}/verify`,
  cancel: (actionId) => `/api/actions/${actionId}/cancel`,
  task: (id) => `/api/tasks/${id}`,
};

/** Generic, user-facing failure text used when no safer message is available. */
const GENERIC_ERROR = '请求失败，请稍后重试';

/** JSON request headers for the plain (non-streaming) action routes. */
const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/**
 * Normalize ANY throwable into a SAFE, single-line user-facing message.
 * Never returns a raw stack trace.
 */
function safeMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  const firstLine = raw.split('\n')[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : GENERIC_ERROR;
}

/** Wrap a session id + safe message into a failed `ChatTurnResponse`. */
function failure(sessionId: string, message: string): ChatTurnResponse {
  return { sessionId, events: [{ type: 'error', message }] };
}

/** The `sessionId` of the first `session` event in a stream, if any. */
function firstSessionId(events: AgentStreamEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'session') return event.sessionId;
  }
  return undefined;
}

/**
 * Decode ONE SSE frame (`data: <JSON>`, possibly multi-line) into an event.
 * Returns `undefined` for malformed/ignored frames (defensive — never throws).
 */
function parseSseFrame(frame: string): AgentStreamEvent | undefined {
  const dataLines = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).replace(/^ /, ''));
  if (dataLines.length === 0) return undefined;
  const payload = dataLines.join('\n').trim();
  if (payload === '') return undefined;
  try {
    const parsed: unknown = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && typeof (parsed as { type?: unknown }).type === 'string') {
      return parsed as AgentStreamEvent;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a `text/event-stream` body into an ordered `AgentStreamEvent[]`.
 * Frames are blank-line (`\n\n`) separated; parsing stops after the `done` event.
 */
async function readSseStream(body: ReadableStream<Uint8Array>): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;

  while (!finished) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseSseFrame(frame);
      if (event) {
        events.push(event);
        if (event.type === 'done') {
          finished = true;
          break;
        }
      }
      boundary = buffer.indexOf('\n\n');
    }

    if (done) {
      break;
    }
    if (finished) {
      void reader.cancel().catch(() => undefined);
      break;
    }
  }

  // Flush any trailing frame that arrived without a terminating blank line.
  if (!finished && buffer.trim() !== '') {
    const event = parseSseFrame(buffer);
    if (event) events.push(event);
  }

  return events;
}

/**
 * Split the app envelope `{ ok, data | error }` from a bare payload.
 * A body without an `ok` discriminant is treated as a bare payload (`{ data: body }`).
 */
function unwrapEnvelope(json: unknown): { data?: unknown; errorMessage?: string } {
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    if (record.ok === false) {
      const error = record.error;
      const message =
        error && typeof error === 'object' ? (error as Record<string, unknown>).message : undefined;
      return { errorMessage: typeof message === 'string' ? message : GENERIC_ERROR };
    }
    if (record.ok === true) {
      return { data: record.data };
    }
  }
  return { data: json };
}

/** Narrow an unknown payload to a `TaskPlan` (id + nodes + results discriminator). */
function asTaskPlan(value: unknown): TaskPlan | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.id === 'string' && Array.isArray(record.nodes) && Array.isArray(record.results)
    ? (value as TaskPlan)
    : undefined;
}

/** Narrow an unknown payload to `{ sessionId?, events? }` (used for bare `ChatTurnResponse`s). */
function normalizeTurn(value: unknown): { sessionId?: string; events?: AgentStreamEvent[] } {
  if (!value || typeof value !== 'object') return {};
  const record = value as Record<string, unknown>;
  return {
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
    events: Array.isArray(record.events) ? (record.events as AgentStreamEvent[]) : undefined,
  };
}

/** Best-effort safe message from a non-OK response body. */
async function errorMessageFromResponse(res: Response): Promise<string> {
  try {
    const json: unknown = await res.json();
    const { errorMessage } = unwrapEnvelope(json);
    if (errorMessage) return errorMessage;
  } catch {
    /* fall through to the generic message */
  }
  return `${GENERIC_ERROR}（${res.status}）`;
}

/**
 * `GET /api/tasks/:id` — load ONE persisted plan.
 *
 * Used for refresh recovery: after a page reload the live plan is rebuilt from the server rather
 * than from the (empty) in-memory message list. NEVER throws and NEVER surfaces an error to the UI:
 * a non-OK response, an error envelope, a malformed body or any thrown exception all resolve to
 * `undefined` (a best-effort read — the chat stays usable without it).
 */
export async function fetchTaskPlan(
  id: string,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<TaskPlan | undefined> {
  try {
    const res = await fetch(endpoints.task(id), { method: 'GET', headers: { Accept: 'application/json' } });
    if (!res.ok) return undefined;

    const json: unknown = await res.json();
    const { data, errorMessage } = unwrapEnvelope(json);
    if (errorMessage) return undefined;

    return asTaskPlan(data);
  } catch {
    return undefined;
  }
}

/**
 * `POST /api/chat` — one agent turn.
 * Streams SSE by default (folding every frame into `events`), otherwise parses the JSON envelope.
 */
export function sendChatTurn(
  req: ChatTurnRequest,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<ChatTurnResponse> {
  const fallbackSession = req.sessionId ?? '';
  return (async () => {
    try {
      const res = await fetch(endpoints.chat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify(req),
      });

      if (!res.ok) {
        return failure(fallbackSession, await errorMessageFromResponse(res));
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && res.body) {
        const events = await readSseStream(res.body);
        return { sessionId: firstSessionId(events) ?? fallbackSession, events };
      }

      const json: unknown = await res.json();
      const { data, errorMessage } = unwrapEnvelope(json);
      if (errorMessage) {
        return failure(fallbackSession, errorMessage);
      }
      const { sessionId, events } = normalizeTurn(data);
      const turnEvents = events ?? [];
      return {
        sessionId: firstSessionId(turnEvents) ?? sessionId ?? fallbackSession,
        events: turnEvents,
      };
    } catch (e) {
      return failure(fallbackSession, safeMessage(e));
    }
  })();
}

/**
 * POST an action (confirm/verify/cancel) and normalise the response.
 *
 * The action routes return `{ ok:true, data: ActionResponse }` (or the error envelope), but a bare
 * `ChatTurnResponse` is also tolerated. When the DOMAIN outcome failed and no `error` event is
 * present, one is appended so the UI can surface the reason (e.g. a wrong MFA code).
 */
async function postAction(url: string, body: Record<string, unknown>): Promise<ChatTurnResponse> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      return failure('', await errorMessageFromResponse(res));
    }

    const json: unknown = await res.json();
    const { data, errorMessage } = unwrapEnvelope(json);
    if (errorMessage) {
      return failure('', errorMessage);
    }

    const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const events = Array.isArray(record.events) ? [...(record.events as AgentStreamEvent[])] : [];
    const domainOk = record.ok;
    const message = typeof record.message === 'string' ? record.message : undefined;

    const hasErrorEvent = events.some((event) => event.type === 'error');
    if (domainOk === false && !hasErrorEvent) {
      events.push({ type: 'error', message: message ?? GENERIC_ERROR });
    }

    return { sessionId, events };
  } catch (e) {
    return failure('', safeMessage(e));
  }
}

/** `POST /api/actions/:id/confirm` — execute a YELLOW (or already-verified RED) pending action. */
export function confirmAction(
  actionId: string,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<ChatTurnResponse> {
  return postAction(endpoints.confirm(actionId), {});
}

/** `POST /api/actions/:id/verify` — submit the MFA code for a RED pending action. */
export function verifyAction(
  actionId: string,
  code: string,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<ChatTurnResponse> {
  return postAction(endpoints.verify(actionId), { code });
}

/** `POST /api/actions/:id/cancel` — cancel a pending action. */
export function cancelAction(
  actionId: string,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<ChatTurnResponse> {
  return postAction(endpoints.cancel(actionId), {});
}
