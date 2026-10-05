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
 *  - `GET /api/tasks/:id` returns `{ ok:true, data: TaskPlan }` (or `404` for an unknown id); the SAME
 *    URL accepts `POST { action }` to steer a running plan (`pause`/`resume`/`cancel`/`retry`).
 *  - `GET /api/actions` returns the caller-session's NON-TERMINAL `PendingAction`s. Its exact body
 *    shape is not frozen, so `fetchPendingActions` consumes it TOLERANTLY (a top-level array OR
 *    `{ actions: [...] }`, rows that are `PendingAction`-like or summary-view).
 *
 * Hard rules: these helpers NEVER throw. Every failure (network, parse, `!response.ok`, domain error)
 * surfaces as an `{ type:'error'; message }` event folded into the returned `ChatTurnResponse`, and
 * the message is always SAFE (never a raw stack / internals). The best-effort reads (`fetchTaskPlan`,
 * `controlTask`, `fetchPendingActions`) instead resolve to `undefined` / `[]` on ANY failure — a
 * recovery/refresh read is never a user-facing error.
 */
import type { AgentStreamEvent, ChatTurnRequest, ChatTurnResponse } from '@/lib/contracts/agent';
import type { RiskLevel } from '@/lib/contracts/risk';
import type { PendingActionStatus, PendingActionSummary } from '@/lib/contracts/security';
import type { TaskPlan } from '@/lib/contracts/task';
import type { ToolName } from '@/lib/contracts/tools';
// Type-only: the card node owns `TaskControlAction`; a type import is erased at build time, so this
// never pulls the (client) card components into this module's runtime graph.
import type { TaskControlAction } from './cards';

export interface ChatEndpoints {
  chat: string; // default '/api/chat'
  confirm: (actionId: string) => string; // default `/api/actions/${id}/confirm`
  verify: (actionId: string) => string; // default `/api/actions/${id}/verify`
  cancel: (actionId: string) => string; // default `/api/actions/${id}/cancel`
  task: (id: string) => string; // default `/api/tasks/${id}` — read/control ONE persisted plan
  actions: string; // default '/api/actions' — list the session's non-terminal pending actions
}

export const DEFAULT_ENDPOINTS: ChatEndpoints = {
  chat: '/api/chat',
  confirm: (actionId) => `/api/actions/${actionId}/confirm`,
  verify: (actionId) => `/api/actions/${actionId}/verify`,
  cancel: (actionId) => `/api/actions/${actionId}/cancel`,
  task: (id) => `/api/tasks/${id}`,
  actions: '/api/actions',
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
 * `POST /api/tasks/:id` — steer a running plan's EXECUTION (`pause`/`resume`/`cancel`/`retry`).
 *
 * The same URL as `fetchTaskPlan` (GET reads, POST controls). Returns the plan snapshot AFTER the
 * control, or `undefined` on ANY failure (non-ok / error envelope / malformed body / throw). NEVER
 * throws: a failed control is surfaced by the caller as a safe UI `error`, never a raw exception.
 */
export async function controlTask(
  id: string,
  action: TaskControlAction,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<TaskPlan | undefined> {
  try {
    const res = await fetch(endpoints.task(id), {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ action }),
    });
    if (!res.ok) return undefined;

    const json: unknown = await res.json();
    const { data, errorMessage } = unwrapEnvelope(json);
    if (errorMessage) return undefined;

    return asTaskPlan(data);
  } catch {
    return undefined;
  }
}

/** One actionable, non-terminal `PendingAction` recovered for refresh restore. */
export interface PendingActionRef {
  id: string;
  status: PendingActionStatus;
  tier: RiskLevel;
  requiresMfa: boolean;
  summary: PendingActionSummary;
}

/** Coerce an untrusted value to a `RiskLevel`, falling back when it is not one of the three tiers. */
function asRiskLevel(value: unknown, fallback: RiskLevel): RiskLevel {
  return value === 'GREEN' || value === 'YELLOW' || value === 'RED' ? value : fallback;
}

/** Coerce an untrusted `fields` value to the frozen `PendingActionSummary['fields']` shape. */
function normalizeFields(value: unknown): Array<{ label: string; value: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((field): field is Record<string, unknown> => Boolean(field) && typeof field === 'object')
    .map((field) => ({ label: String(field.label ?? ''), value: String(field.value ?? '') }));
}

/**
 * The `toolName` for a normalised summary. A `PendingAction` always carries one; a malformed row
 * that does not gets `''` (a display-only placeholder — the summary never drives execution; the
 * server owns the truth via the action id).
 */
function summaryToolName(row: Record<string, unknown>, source?: Record<string, unknown>): ToolName {
  const candidate = source?.toolName ?? row.toolName;
  return (typeof candidate === 'string' ? candidate : '') as ToolName;
}

/** Build a `PendingActionSummary` from a `PendingAction`-like row (tolerant of a summary-view row). */
function extractSummary(
  row: Record<string, unknown>,
  tier: RiskLevel,
  requiresMfa: boolean,
): PendingActionSummary {
  const raw = row.summary && typeof row.summary === 'object' ? (row.summary as Record<string, unknown>) : undefined;
  // A summary-view row carries the summary fields on the row itself.
  const source = raw && typeof raw.title === 'string' ? raw : typeof row.title === 'string' ? row : undefined;
  if (!source) {
    return { title: '需要安全验证', toolName: summaryToolName(row), tier, fields: [], requiresMfa };
  }
  return {
    title: source.title as string,
    toolName: summaryToolName(row, source),
    tier: asRiskLevel(source.tier, tier),
    fields: normalizeFields(source.fields),
    requiresMfa: source.requiresMfa === true || requiresMfa,
    ...(typeof source.amount === 'number' ? { amount: source.amount } : {}),
    ...(typeof source.mfaHint === 'string' ? { mfaHint: source.mfaHint } : {}),
  };
}

/**
 * Map ONE untrusted `PendingAction`-like row to a `PendingActionRef`, or `undefined` when it is not
 * an actionable non-terminal action (missing id, or a terminal/`locked` status).
 */
function toPendingActionRef(row: unknown): PendingActionRef | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const record = row as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.length > 0 ? record.id : undefined;
  if (id === undefined) return undefined;

  const status = record.status;
  if (status !== 'pending' && status !== 'awaiting_mfa') return undefined;

  const rawSummary = record.summary;
  const summaryRecord =
    rawSummary && typeof rawSummary === 'object' ? (rawSummary as Record<string, unknown>) : undefined;
  const tier = asRiskLevel(record.tier ?? record.riskLevel ?? summaryRecord?.tier, 'YELLOW');
  const requiresMfa = record.requiresMfa === true || summaryRecord?.requiresMfa === true;

  return { id, status, tier, requiresMfa, summary: extractSummary(record, tier, requiresMfa) };
}

/**
 * `GET /api/actions` — the caller-session's NON-TERMINAL pending actions, for ACTIVE refresh restore.
 *
 * Consumed TOLERANTLY (the route's exact shape is not frozen): accepts a top-level array or
 * `{ actions: [...] }`, and each row may be a `PendingAction` or a summary-view row. Only ACTIONABLE
 * rows are kept (`pending` / `awaiting_mfa`); terminal (`confirmed`/`executed`/`failed`/`cancelled`)
 * and `locked` rows are dropped, as are rows missing an id. NEVER throws — a failed/aborted read
 * resolves to `[]` (best-effort).
 */
export async function fetchPendingActions(
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<PendingActionRef[]> {
  try {
    const res = await fetch(endpoints.actions, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return [];

    const json: unknown = await res.json();
    const { data, errorMessage } = unwrapEnvelope(json);
    if (errorMessage) return [];

    const rows = Array.isArray(data)
      ? data
      : data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).actions)
        ? ((data as Record<string, unknown>).actions as unknown[])
        : [];

    const refs: PendingActionRef[] = [];
    for (const row of rows) {
      const ref = toPendingActionRef(row);
      if (ref) refs.push(ref);
    }
    return refs;
  } catch {
    return [];
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
 * `ChatTurnResponse` is also tolerated. `data.ok` is the DOMAIN outcome (a failed action is a normal
 * `200` with `ok:false`), so the event list must carry the signal the reducer folds:
 *
 *  - ESCALATION / MFA prompt (`requiresMfa && tier==='RED'`, not yet executed, NOT a failed verify):
 *    a YELLOW confirm escalated to RED, or a RED action that still needs a code. The UI must switch to
 *    the MFA card for the SAME `actionId` — never dead-end on an error. We ensure an `mfa_required`
 *    event is present (synthesised when the server omitted one) and do NOT append a spurious `error`
 *    for this non-error prompt. The reducer turns `mfa_required` into the MFA `pendingAction`.
 *  - Otherwise a `domainOk === false` outcome with no `error` event gets one appended so the UI can
 *    surface the reason — e.g. a WRONG MFA code, which the verify route legitimately reports as
 *    `ok:false` + `status:'awaiting_mfa'` + `mfaResult:'failed'` with an EMPTY event list.
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
    const actionId = typeof record.actionId === 'string' ? record.actionId : undefined;
    const tier = typeof record.tier === 'string' ? record.tier : undefined;
    const status = typeof record.status === 'string' ? record.status : undefined;
    const requiresMfa = record.requiresMfa === true;
    const mfaResult = typeof record.mfaResult === 'string' ? record.mfaResult : undefined;

    const executed = domainOk === true || status === 'executed' || status === 'confirmed';

    // ESCALATION / MFA prompt (see doc comment). A WRONG code (`mfaResult === 'failed'`) is a real
    // failure and intentionally falls through to the error-appending branch below.
    if (requiresMfa && tier === 'RED' && !executed && mfaResult !== 'failed') {
      const hasMfaEvent = events.some((event) => event.type === 'mfa_required');
      if (!hasMfaEvent && actionId !== undefined) {
        events.push({ type: 'mfa_required', actionId });
      }
      return { sessionId, events };
    }

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
