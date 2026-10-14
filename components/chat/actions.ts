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
 *  - The action routes (confirm/verify/cancel/recover) return `{ ok:true, data: ActionResponse }` or
 *    the error envelope `{ ok:false, error:{ code, message } }`. A DOMAIN failure (e.g. a wrong MFA
 *    code) is a normal `200` with `data.ok === false` + a safe `data.message` — NOT an HTTP error.
 *  - `GET /api/tasks/:id` returns `{ ok:true, data: TaskPlan }` (or `404` for an unknown id); the SAME
 *    URL accepts `POST { action }` to steer a running plan (`pause`/`resume`/`cancel`/`retry`).
 *  - `GET /api/actions` returns the caller-session's attention rows: LIVE decisions (`pending` /
 *    `awaiting_mfa`), an in-flight `confirmed` row, a recoverable result-less `confirmed` wedge, and a
 *    terminal `needs_reconciliation` row. The response is `{ ok:true, data: [...] }`; each row
 *    supplies its complete summary, policy fields and explicit server `attention` classification.
 *    Malformed rows are discarded without reconstructing missing values or inventing controls.
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
import { isCatalogToolName } from '@/lib/contracts/tool-catalog';
import { createRequestId, RequestIdUnavailableError } from './request-id';
import { isAgentStreamEvent, isTaskPlan } from './transport-validation';
import type { ErrorCode } from '@/lib/errors';
// Type-only: the card node owns `TaskControlAction` + `AttentionClass`; a type import is erased at
// build time, so this never pulls the (client) card components into this module's runtime graph.
import type { AttentionClass, TaskControlAction } from './cards';

export interface ChatEndpoints {
  chat: string; // default '/api/chat'
  confirm: (actionId: string) => string; // default `/api/actions/${id}/confirm`
  verify: (actionId: string) => string; // default `/api/actions/${id}/verify`
  cancel: (actionId: string) => string; // default `/api/actions/${id}/cancel`
  recover: (actionId: string) => string; // default `/api/actions/${id}/recover`
  task: (id: string) => string; // default `/api/tasks/${id}` — read/control ONE persisted plan
  actions: string; // default '/api/actions' — list the session's non-terminal pending actions
  history?: string; // default '/api/chat/history' — paginated display, independent of model memory
}

export const DEFAULT_ENDPOINTS: ChatEndpoints = {
  chat: '/api/chat',
  confirm: (actionId) => `/api/actions/${actionId}/confirm`,
  verify: (actionId) => `/api/actions/${actionId}/verify`,
  cancel: (actionId) => `/api/actions/${actionId}/cancel`,
  recover: (actionId) => `/api/actions/${actionId}/recover`,
  task: (id) => `/api/tasks/${id}`,
  actions: '/api/actions',
  history: '/api/chat/history',
};

/** Generic, user-facing failure text used when no safer message is available. */
const GENERIC_ERROR = '请求失败，请稍后重试';

/** JSON request headers for the plain (non-streaming) action routes. */
const JSON_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

/** Terminal `PendingActionStatus` values: the action is SETTLED, so the UI must show a fact, not controls. */
const TERMINAL_ACTION_STATUSES: readonly PendingActionStatus[] = [
  'executed',
  'failed',
  'cancelled',
  'locked',
  'needs_reconciliation',
];

/** Current action response states, including decisions and terminal outcomes. */
const ACTION_STATUSES: readonly PendingActionStatus[] = [
  'pending', 'awaiting_mfa', 'confirmed', 'executed', 'failed', 'cancelled', 'locked', 'needs_reconciliation',
];

function asActionStatus(value: unknown): PendingActionStatus | undefined {
  return typeof value === 'string' && (ACTION_STATUSES as readonly string[]).includes(value)
    ? value as PendingActionStatus : undefined;
}

/**
 * Preserve a known browser capability error without exposing arbitrary runtime details.
 * Server-authored business errors are decoded separately from the current API envelope.
 */
function safeMessage(e: unknown): string {
  return e instanceof RequestIdUnavailableError ? e.message : GENERIC_ERROR;
}

/** Wrap a session id + safe message into a failed `ChatTurnResponse`. */
function failure(sessionId: string, message: string, code?: ErrorCode): ChatTurnResponse {
  return { sessionId, events: [{ type: 'error', message, ...(code ? { code } : {}) }] };
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
 * Ignores non-data frames; malformed payloads become a safe format error.
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
    return isAgentStreamEvent(parsed) ? parsed : { type: 'error', message: 'chat.error.invalidResponse' };
  } catch {
    return { type: 'error', message: 'chat.error.invalidResponse' };
  }
}

/**
 * Read a `text/event-stream` body into an ordered `AgentStreamEvent[]`.
 * SSE line endings may be LF, CRLF or CR, including across byte chunks. A done frame terminates
 * transport only after every started assistant message has supplied its authoritative end.
 */
async function readSseStream(body: ReadableStream<Uint8Array>, onEvent?: (event: AgentStreamEvent) => void): Promise<AgentStreamEvent[]> {
  const events: AgentStreamEvent[] = [];
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let finished = false;
  let trailingCr = false;
  const openMessages = new Set<string>();

  const appendDecoded = (text: string) => {
    if (!text) return;
    if (trailingCr && text.startsWith('\n')) text = text.slice(1);
    if (!text) { trailingCr = false; return; }
    trailingCr = text.endsWith('\r');
    buffer += text.replace(/\r\n|\r/g, '\n');
  };

  const publish = (event: AgentStreamEvent) => {
    if (event.type === 'message_start' && (event.message.role === 'assistant' || event.message.role === 'tool')) {
      openMessages.add(event.message.id);
    }
    if (event.type === 'message_end') openMessages.delete(event.message.id);
    if (event.type === 'done' && openMessages.size) {
      const error: AgentStreamEvent = { type: 'error', message: 'The response stream ended before completion. Inspect the saved run before retrying.' };
      events.push(error); onEvent?.(error);
    }
    events.push(event);
    onEvent?.(event);
    if (event.type === 'done') finished = true;
  };

  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (value) appendDecoded(decoder.decode(value, { stream: true }));
      if (done) appendDecoded(decoder.decode());

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event) {
          publish(event);
          if (finished) break;
        }
        boundary = buffer.indexOf('\n\n');
      }

      if (done) break;
      if (finished) {
        void reader.cancel().catch(() => undefined);
        break;
      }
    }

    // Flush a final frame without a terminating blank line, including a final done event.
    if (!finished && buffer.trim() !== '') {
      const event = parseSseFrame(buffer);
      if (event) publish(event);
    }

    if (!finished) publish({ type: 'error', message: 'The response stream ended before completion. Inspect the saved run before retrying.' });
  } catch {
    // A failed read must retain every frame already published, including the durable run identity.
    publish({ type: 'error', message: 'The response stream was interrupted. Inspect the saved run before retrying.' });
  } finally {
    reader.releaseLock();
  }

  return events;
}

/**
 * Decode only the current app envelope `{ ok, data | error }`.
 * A raw payload or malformed envelope is a contract failure.
 */
function unwrapEnvelope(json: unknown): { data?: unknown; errorMessage?: string; errorCode?: ErrorCode } {
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    if (record.ok === false) {
      const error = record.error;
      if (!error || typeof error !== 'object' || Array.isArray(error)) return { errorMessage: GENERIC_ERROR };
      const detail = error as Record<string, unknown>;
      const code = typeof detail.code === 'string' && ['VALIDATION', 'NOT_FOUND', 'INSUFFICIENT_FUNDS', 'LIMIT_EXCEEDED',
        'SECURITY_DENIED', 'MFA_FAILED', 'CIRCUIT_OPEN', 'CONFLICT', 'TOOL_FAILED', 'INTERNAL'].includes(detail.code) ? detail.code as ErrorCode : undefined;
      return { errorMessage: code && typeof detail.message === 'string' && detail.message.trim()
        ? detail.message : GENERIC_ERROR, ...(code ? { errorCode: code } : {}) };
    }
    if (record.ok === true && Object.prototype.hasOwnProperty.call(record, 'data')) {
      return { data: record.data };
    }
  }
  return { errorMessage: GENERIC_ERROR };
}

/** Narrow an unknown payload to a `TaskPlan` (id + nodes + results discriminator). */
function asTaskPlan(value: unknown): TaskPlan | undefined {
  return isTaskPlan(value) ? value : undefined;
}

/** Narrow the decoded current response payload to its session and events. */
function normalizeTurn(value: unknown): ChatTurnResponse | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '' ||
      !Array.isArray(record.events) || !record.events.every(isAgentStreamEvent) ||
      (record.runId !== undefined && (typeof record.runId !== 'string' || record.runId.trim() === ''))) return;
  return {
    sessionId: record.sessionId,
    ...(typeof record.runId === 'string' ? { runId: record.runId } : {}),
    events: record.events as AgentStreamEvent[],
  };
}

/** Best-effort safe message from a non-OK response body. */
async function errorFromResponse(res: Response): Promise<{ message: string; code?: ErrorCode }> {
  try {
    const json: unknown = await res.json();
    const { errorMessage, errorCode } = unwrapEnvelope(json);
    if (errorMessage) return { message: errorMessage, ...(errorCode ? { code: errorCode } : {}) };
  } catch {
    /* fall through to the generic message */
  }
  return { message: `${GENERIC_ERROR}（${res.status}）` };
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

/**
 * One attention row recovered for refresh restore. A row is either ACTIONABLE (`pending` /
 * `awaiting_mfa`) or an OUT-OF-BAND row (`confirmed` with an active lease, a result-less
 * `confirmed` wedge the server can recover, or a terminal `needs_reconciliation`): the out-of-band
 * rows have no confirm/MFA path but are surfaced so the user sees their state and — where the server
 * allows it — can trigger the recovery entry. `attention` tells the UI which treatment to apply.
 */
export interface PendingActionRef {
  id: string;
  status: PendingActionStatus;
  tier: RiskLevel;
  requiresMfa: boolean;
  summary: PendingActionSummary;
  /** How the chat surface must treat this row (see `AttentionClass`). */
  attention: AttentionClass;
}

/** Attention restoration is optional and must not block the composer indefinitely. */
export const PENDING_ACTION_READ_TIMEOUT_MS = 5000;

/** Accept only one of the current policy tiers. */
function asRiskLevel(value: unknown): RiskLevel | undefined {
  return value === 'GREEN' || value === 'YELLOW' || value === 'RED' ? value : undefined;
}

/** The current server attention classifications. */
const ATTENTION_CLASSES: readonly AttentionClass[] = [
  'decision',
  'processing',
  'recoverable',
  'reconciliation',
];

/** Coerce an untrusted `attention` value to an `AttentionClass`, else `undefined`. */
function asAttentionClass(value: unknown): AttentionClass | undefined {
  return typeof value === 'string' && (ATTENTION_CLASSES as readonly string[]).includes(value)
    ? (value as AttentionClass)
    : undefined;
}

/** Verify a complete server summary against the row's current identity and policy. */
function extractSummary(row: Record<string, unknown>, tier: RiskLevel, requiresMfa: boolean): PendingActionSummary | undefined {
  const raw = row.summary;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const summary = raw as Record<string, unknown>;
  if (typeof summary.title !== 'string' || summary.title.trim() === '' ||
      typeof summary.toolName !== 'string' || !isCatalogToolName(summary.toolName) ||
      summary.toolName !== row.toolName || summary.tier !== tier || summary.requiresMfa !== requiresMfa ||
      !Array.isArray(summary.fields) || !summary.fields.every(field => field !== null && typeof field === 'object' &&
        typeof field.label === 'string' && typeof field.value === 'string') ||
      (summary.actionId !== undefined && summary.actionId !== row.id) ||
      (summary.amount !== undefined && typeof summary.amount !== 'string') ||
      (summary.mfaHint !== undefined && typeof summary.mfaHint !== 'string')) return;
  return raw as PendingActionSummary;
}

/**
 * Validate one current server row as a `PendingActionRef`, or `undefined` when it must be
 * dropped (missing id, or a status that is neither actionable nor one of the out-of-band states).
 *
 * Retained statuses: `pending` / `awaiting_mfa` (actionable), `confirmed` (an in-flight OR a
 * recoverable result-less wedge) and `needs_reconciliation` (terminal, human-settled). Every other
 * non-actionable status (`executed` / `failed` / `cancelled` / `locked`) is dropped.
 */
function toPendingActionRef(row: unknown): PendingActionRef | undefined {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
  const record = row as Record<string, unknown>;
  const id = typeof record.id === 'string' && record.id.trim().length > 0 ? record.id : undefined;
  if (id === undefined) return undefined;

  const status = record.status;
  if (
    status !== 'pending' &&
    status !== 'awaiting_mfa' &&
    status !== 'confirmed' &&
    status !== 'needs_reconciliation'
  ) {
    return undefined;
  }

  const tier = asRiskLevel(record.tier);
  const attention = asAttentionClass(record.attention);
  if (tier === undefined || attention === undefined || typeof record.requiresMfa !== 'boolean') return;
  if ((status === 'pending' || status === 'awaiting_mfa') && attention !== 'decision') return;
  if (status === 'confirmed' && attention === 'decision') return;
  if (status === 'needs_reconciliation' && attention !== 'reconciliation') return;
  const summary = extractSummary(record, tier, record.requiresMfa);
  if (summary === undefined) return;
  return { id, status, tier, requiresMfa: record.requiresMfa, summary, attention };
}

/**
 * `GET /api/actions` — the caller-session's actions that need the user's attention, for refresh
 * restore.
 *
 * Accepts only the current success envelope containing an array of complete rows. ACTIONABLE rows
 * (`pending` / `awaiting_mfa`) AND out-of-band rows (`confirmed` in-flight/recoverable,
 * `needs_reconciliation`) are retained (the latter carry no confirm/MFA path but must be SHOWN so the
 * user sees the state and can reconcile/recover); the other terminal statuses (`executed` / `failed`
 * / `cancelled`) and `locked` rows are dropped, as are rows missing an id. NEVER throws — a
 * failed/aborted read resolves to `[]` (best-effort).
 */
export async function fetchPendingActions(
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
  signal?: AbortSignal,
): Promise<PendingActionRef[]> {
  if (signal?.aborted) return [];
  const abort = new AbortController();
  const cancel = () => abort.abort();
  let resolveCancelled!: (refs: PendingActionRef[]) => void;
  const cancelled = new Promise<PendingActionRef[]>(resolve => { resolveCancelled = resolve; });
  const onCancelled = () => resolveCancelled([]);
  abort.signal.addEventListener('abort', onCancelled, { once: true });
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(cancel, PENDING_ACTION_READ_TIMEOUT_MS);
  // Race the whole read, including JSON decoding. Some transports ignore cancellation, but a
  // late response must still never keep a mount-time restoration promise pending forever.
  const read = async (): Promise<PendingActionRef[]> => { try {
    const res = await fetch(endpoints.actions, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: abort.signal,
    });
    if (!res.ok) return [];

    const json: unknown = await res.json();
    const { data, errorMessage } = unwrapEnvelope(json);
    if (errorMessage) return [];

    if (!Array.isArray(data)) return [];

    const refs: PendingActionRef[] = [];
    for (const row of data) {
      const ref = toPendingActionRef(row);
      if (ref) refs.push(ref);
    }
    return refs;
  } catch {
    return [];
  } };
  try { return await Promise.race([read(), cancelled]); }
  finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
    abort.signal.removeEventListener('abort', onCancelled);
  }
}

/**
 * `POST /api/chat` — one agent turn.
 * Streams SSE by default (folding every frame into `events`), otherwise parses the JSON envelope.
 */
export function sendChatTurn(
  req: ChatTurnRequest,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
  onEvent?: (event: AgentStreamEvent) => void,
): Promise<ChatTurnResponse> {
  const fallbackSession = req.sessionId ?? '';
  return (async () => {
    try {
      const requestId = req.requestId ?? createRequestId();
      const res = await fetch(endpoints.chat, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream, application/json',
        },
        body: JSON.stringify({ ...req, requestId }),
      });

      if (!res.ok) {
        const error = await errorFromResponse(res);
        return failure(fallbackSession, error.message, error.code);
      }

      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream') && res.body) {
        const events = await readSseStream(res.body, onEvent);
        const sessionEvent = events.find(event => event.type === 'session');
        return { sessionId: firstSessionId(events) ?? fallbackSession,
          ...(sessionEvent?.type === 'session' && sessionEvent.runId ? { runId: sessionEvent.runId } : {}), events };
      }

      const json: unknown = await res.json();
      const { data, errorMessage, errorCode } = unwrapEnvelope(json);
      if (errorMessage) {
        return failure(fallbackSession, errorMessage, errorCode);
      }
      const turn = normalizeTurn(data);
      if (!turn) return failure(fallbackSession, GENERIC_ERROR);
      const { sessionId, runId, events: turnEvents } = turn;
      for (const event of turnEvents) onEvent?.(event);
      return {
        sessionId: firstSessionId(turnEvents) ?? sessionId ?? fallbackSession,
        ...(runId ? { runId } : {}),
        events: turnEvents,
      };
    } catch (e) {
      return failure(fallbackSession, safeMessage(e));
    }
  })();
}

/**
 * POST an action (confirm/verify/cancel/recover) and normalise the response.
 *
 * The action routes return `{ ok:true, data: ActionResponse }` or the error envelope.
 * `data.ok` is the DOMAIN outcome (a failed action is a normal
 * `200` with `ok:false`), so the event list must carry the signal the reducer folds:
 *
 *  - ESCALATION / MFA prompt (`requiresMfa && tier==='RED'`, not yet executed, NOT a failed verify):
 *    a YELLOW confirm escalated to RED, or a RED action that still needs a code. The UI must switch to
 *    the MFA card for the SAME `actionId` — never dead-end on an error. We ensure an `mfa_required`
 *    event is present ONLY for explicit pending/awaiting_mfa states (synthesised when omitted),
 *    and do NOT append a spurious `error`
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
      const error = await errorFromResponse(res);
      return failure('', error.message, error.code);
    }

    const json: unknown = await res.json();
    const { data, errorMessage, errorCode } = unwrapEnvelope(json);
    if (errorMessage) {
      return failure('', errorMessage, errorCode);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) return failure('', GENERIC_ERROR);
    const record = data as Record<string, unknown>;
    const status = asActionStatus(record.status);
    const tier = asRiskLevel(record.tier);
    if (typeof record.sessionId !== 'string' || record.sessionId.trim() === '' ||
        typeof record.actionId !== 'string' || record.actionId.trim() === '' ||
        typeof record.ok !== 'boolean' || typeof record.requiresMfa !== 'boolean' ||
        typeof record.message !== 'string' || status === undefined || tier === undefined ||
        !Array.isArray(record.events) || !record.events.every(isAgentStreamEvent) ||
        (record.mfaResult !== undefined && record.mfaResult !== 'success' && record.mfaResult !== 'failed' && record.mfaResult !== 'not_required')) {
      return failure('', GENERIC_ERROR);
    }
    const sessionId = record.sessionId;
    const actionId = record.actionId;
    const domainOk = record.ok;
    const requiresMfa = record.requiresMfa;
    const message = record.message;
    const mfaResult = record.mfaResult;
    let events = [...record.events] as AgentStreamEvent[];

    const executed = domainOk === true || status === 'executed' || status === 'confirmed';
    const awaitingDecision = status === 'pending' || status === 'awaiting_mfa';
    // A historical RED requirement is not a new verification decision. Preserve events for any
    // DIFFERENT action parked by a resumed plan, but never reopen this action's terminal card.
    if (!awaitingDecision) {
      events = events.filter(event => event.type !== 'mfa_required' || event.actionId !== actionId);
    }

    // ESCALATION / MFA prompt (see doc comment). A WRONG code (`mfaResult === 'failed'`) is a real
    // failure and intentionally falls through to the error-appending branch below.
    if (awaitingDecision && requiresMfa && tier === 'RED' && !executed && mfaResult !== 'failed') {
      const hasMfaEvent = events.some((event) => event.type === 'mfa_required');
      if (!hasMfaEvent) {
        events.push({ type: 'mfa_required', actionId });
      }
      return { sessionId, events };
    }

    const hasErrorEvent = events.some((event) => event.type === 'error');
    if (domainOk === false && !hasErrorEvent) {
      events.push({ type: 'error', message });
    }

    // Accepted authorization dismisses the request while its historical record tracks execution.
    if (status === 'confirmed' || TERMINAL_ACTION_STATUSES.includes(status)) {
      events.push({
        type: 'action_settled',
        actionId,
        status,
        message,
      });
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

/**
 * `POST /api/actions/:id/recover` — the user-facing RECOVERY entry for an out-of-band action.
 *
 * The route re-checks ownership (cookie/session) and settles a `confirmed` result-less wedge (or a
 * `needs_reconciliation` row) through the gateway's authorized path — the browser never replays a
 * banking op itself. Normalised through the SAME `postAction` helper, so a failure is a safe event
 * list (never a raw throw).
 */
export function recoverAction(
  actionId: string,
  endpoints: ChatEndpoints = DEFAULT_ENDPOINTS,
): Promise<ChatTurnResponse> {
  return postAction(endpoints.recover(actionId), {});
}
