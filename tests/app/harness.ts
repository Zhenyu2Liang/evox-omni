/**
 * tests/app/harness.ts — shared HTTP plumbing for the REAL-application-entry specs.
 *
 * These specs drive the REAL Next.js App Router route handlers: they import a route's exported
 * `POST`/`GET` function and invoke it with a REAL `NextRequest` — NOT the in-process
 * re-implementation in `tests/helpers/scenario.ts`, and NOT any mock pipeline. The app runs on the
 * deterministic mock model (`tests/setup.ts` forces `LLM_MODE=mock`), so the whole production stack
 * (route → `@/agent` runtime → tools → security gateway → SDK → SQLite) runs offline. Only the
 * model is scripted.
 *
 * TEST-ONLY infrastructure: URL builders, request invokers and SSE readers. It contains NO business
 * logic and does NOT re-implement the response envelope (building stays in `app/api/_lib/http.ts`).
 * Route modules are NEVER imported here — each spec imports the handler(s) it drives and passes them
 * in, so this module stays importable by every app-entry spec (chat / actions / tasks) and free of
 * load-order coupling. SSE frames follow `sseFrame()` in `@/app/api/_lib/http` (`data: <JSON>\n\n`).
 *
 * IDENTITY IS COOKIE-ONLY. The app derives the trusted caller identity from the HttpOnly
 * `banking_session` cookie (`app/api/_lib/session#resolveIdentity`); a `?sessionId=` query param is
 * IGNORED for every authorization decision. The invokers therefore carry identity as a `Cookie`
 * header (the `sessionId` / `cookie` option), NOT as a query param.
 */
import { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/constants';
import type { AgentStreamEvent } from '@/lib/contracts/agent';
import type { IdRouteContext } from '@/app/api/_lib/types';

/** Base origin for every constructed request URL (route handlers read `new URL(req.url)`). */
export const BASE_URL = 'http://localhost';

/**
 * A Next.js route handler. Single-`(req)` handlers (e.g. `POST /api/chat`) are assignable because a
 * function with fewer parameters is assignable to one with more — the extra `ctx` is simply unused.
 */
export type RouteHandler = (req: NextRequest, ctx: IdRouteContext) => Response | Promise<Response>;

/**
 * Per-request options: extra headers, the dynamic-route context, an origin override, and the
 * COOKIE-ONLY identity.
 *
 * - `sessionId` — shorthand that emits `Cookie: banking_session=<id>`. Omitting it sends NO cookie
 *   (the route fails closed with `403 SECURITY_DENIED` on a write/auth route).
 * - `cookie` — a raw `Cookie` header value; wins over `sessionId` when both are supplied.
 */
export interface HttpOptions {
  headers?: Record<string, string>;
  ctx?: IdRouteContext;
  base?: string;
  /** Trusted identity shorthand: emits `Cookie: <SESSION_COOKIE>=<id>`. */
  sessionId?: string;
  /** Raw `Cookie` header value (takes precedence over `sessionId`). */
  cookie?: string;
}

/** The captured result of invoking a route handler. */
export interface HttpResult<T = unknown> {
  status: number;
  ok: boolean;
  /** Best-effort parsed JSON body (undefined for a non-JSON / SSE response). */
  data: T | undefined;
  headers: Headers;
  /** The live `Response` — its body stays UNCONSUMED when the content type is not JSON. */
  res: Response;
}

/** Build the `Cookie` header value carrying the `banking_session` id. */
export function sessionCookie(sessionId: string): string {
  return `${SESSION_COOKIE}=${sessionId}`;
}

/* ---------------------------------------------------------------------------- URL builders */

/** Build a relative `path?query` string, dropping `undefined` params (base is applied on invoke). */
function withQuery(path: string, query: Record<string, string | undefined>): string {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

/** `POST /api/chat` URL. `stream` picks the mode. Identity is carried in the body / cookie, not here. */
export function chatUrl(opts: { stream?: 0 | 1 } = {}): string {
  return withQuery('/api/chat', {
    stream: opts.stream === undefined ? undefined : String(opts.stream),
  });
}

/** `POST /api/actions/[id]/{confirm|verify|cancel}` URL. Identity comes from the cookie. */
export function actionUrl(id: string, action: 'confirm' | 'verify' | 'cancel'): string {
  return `/api/actions/${encodeURIComponent(id)}/${action}`;
}

/** `/api/tasks/[id]` URL (`GET` reads, `POST` controls). Identity comes from the cookie. */
export function taskUrl(id: string): string {
  return `/api/tasks/${encodeURIComponent(id)}`;
}

/** `GET /api/tasks` URL. Identity comes from the cookie. */
export function tasksUrl(): string {
  return '/api/tasks';
}

/** The Next.js 15 dynamic-route context for a `/…/[id]` handler. */
export function idCtx(id: string): IdRouteContext {
  return { params: Promise.resolve({ id }) };
}

/* ------------------------------------------------------------------------------ invokers */

/** Invoke a handler with a JSON `POST` body. */
export function postJson<T = unknown>(
  handler: RouteHandler,
  path: string,
  body: unknown,
  opts: HttpOptions = {},
): Promise<HttpResult<T>> {
  return invoke<T>(
    handler,
    path,
    {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...opts.headers },
    },
    opts,
  );
}

/** Invoke a handler with a raw `POST` body (e.g. malformed JSON for the transport-failure specs). */
export function postRaw<T = unknown>(
  handler: RouteHandler,
  path: string,
  rawBody: string,
  opts: HttpOptions = {},
): Promise<HttpResult<T>> {
  return invoke<T>(
    handler,
    path,
    {
      method: 'POST',
      body: rawBody,
      headers: { 'content-type': 'application/json', ...opts.headers },
    },
    opts,
  );
}

/** Invoke a handler with a `GET` request. */
export function getJson<T = unknown>(
  handler: RouteHandler,
  path: string,
  opts: HttpOptions = {},
): Promise<HttpResult<T>> {
  return invoke<T>(handler, path, { method: 'GET', headers: { ...opts.headers } }, opts);
}

/**
 * The request fields the invokers build. Deliberately a narrow shape (no DOM `signal`) so it stays
 * assignable to `NextRequest`'s stricter `RequestInit`, whose `signal` does not allow `null`.
 */
interface RequestSpec {
  method: string;
  body?: string;
  headers: Record<string, string>;
}

async function invoke<T>(
  handler: RouteHandler,
  path: string,
  init: RequestSpec,
  opts: HttpOptions,
): Promise<HttpResult<T>> {
  // Cookie-only identity: fold the `sessionId` shorthand (or a raw `cookie`) into a `Cookie` header.
  const headers: Record<string, string> = { ...init.headers };
  const cookie = opts.cookie ?? (opts.sessionId !== undefined ? sessionCookie(opts.sessionId) : undefined);
  if (cookie !== undefined) headers.cookie = cookie;

  const req = new NextRequest((opts.base ?? BASE_URL) + path, { ...init, headers });
  const res = await handler(req, opts.ctx ?? idCtx(''));
  const contentType = res.headers.get('content-type') ?? '';
  // Only JSON responses are parsed here; an SSE body is left UNCONSUMED for `readSse`.
  const data = contentType.includes('application/json') ? ((await res.json()) as T) : undefined;
  return { status: res.status, ok: res.ok, data, headers: res.headers, res };
}

/* --------------------------------------------------------------------------------- SSE */

/** The raw JSON payload of each SSE frame (`data: <json>`), in stream order. */
export async function readSseFrames(res: Response): Promise<string[]> {
  const text = await res.text();
  const frames: string[] = [];
  for (const block of text.split('\n\n')) {
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) frames.push(line.slice('data:'.length).trim());
    }
  }
  return frames;
}

/** Parse a streaming `text/event-stream` response body into its ordered `AgentStreamEvent`s. */
export async function readSse(res: Response): Promise<AgentStreamEvent[]> {
  const frames = await readSseFrames(res);
  return frames.map((frame) => JSON.parse(frame) as AgentStreamEvent);
}
