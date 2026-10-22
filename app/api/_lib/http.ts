/**
 * app/api/_lib/http.ts — shared handler plumbing for every API route.
 *
 * This module is the ONE place that knows the response envelope, the `AppError` → HTTP status
 * mapping, and the SSE frame format. Route handlers stay thin: `validate (zod) → delegate →
 * serialize`, using these helpers so the transport contract never drifts between routes.
 *
 * It contains NO business logic (no permission/risk decisions, no money math, no Prisma) — those
 * live in `@/security`, `@/lib/money`, `@/banking-sdk`. Wiring the helpers fully here keeps the
 * frozen envelope concrete and centralizes the "never leak internals / never leak the MFA code"
 * rule (see `mapAppError`).
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import { AppError, type ErrorCode } from '@/lib/errors';
import type { ApiFailure, ApiSuccess } from './types';

/** Frozen mapping from `AppError.code` to the HTTP status the edge returns. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  VALIDATION: 400,
  NOT_FOUND: 404,
  SECURITY_DENIED: 403,
  MFA_FAILED: 403,
  CIRCUIT_OPEN: 423,
  MFA_LOCKED: 423,
  INSUFFICIENT_FUNDS: 422,
  LIMIT_EXCEEDED: 422,
  CONFLICT: 409,
  TOOL_FAILED: 502,
  INTERNAL: 500,
};

/** Wrap a payload in the success envelope: `{ ok: true, data }`. */
export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

/** Build the failure envelope: `{ ok: false, error: { code, message } }`. */
export function fail(error: { code: ErrorCode; message: string }): ApiFailure {
  return { ok: false, error };
}

/**
 * Normalize ANY throwable into `{ status, body }`.
 *
 * - An `AppError` keeps its `code` and message (already safe).
 * - A non-`AppError` becomes `INTERNAL` with a GENERIC message — raw exception text, stack
 *   traces, Prisma errors and the MFA code must never reach a response body.
 */
export function mapAppError(e: unknown): { status: number; body: ApiFailure } {
  const appError = AppError.from(e);
  const message = appError.code === 'INTERNAL' ? 'Internal error' : appError.message;
  return { status: STATUS_BY_CODE[appError.code] ?? 500, body: fail({ code: appError.code, message }) };
}

/** Success response: JSON body of the success envelope. */
export function jsonResponse<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(ok(data), init);
}

/** Error response: maps any throwable to the failure envelope + correct HTTP status. */
export function errorResponse(e: unknown): NextResponse {
  const { status, body } = mapAppError(e);
  return NextResponse.json(body, { status });
}

/**
 * Parse + validate a JSON request body against a zod schema.
 * Throws `AppError('VALIDATION')` on malformed JSON or a schema mismatch.
 */
export async function parseBody<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new AppError('VALIDATION', 'Request body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Invalid request body', parsed.error.issues);
  }
  return parsed.data;
}

/**
 * Parse + validate an OPTIONAL JSON request body.
 *
 * Identical to {@link parseBody} except that an ABSENT or EMPTY body is treated as `{}` instead of a
 * validation error — for handlers whose every field is optional (e.g. `POST /api/security/reset`,
 * whose body may carry an optional verification code, so a body-less POST still gets a proper
 * response instead of a `400`). Malformed JSON or a schema mismatch still throws
 * `AppError('VALIDATION')`, exactly like {@link parseBody}.
 */
export async function parseOptionalBody<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  const raw = await req.text();
  const body = raw.trim() === '' ? '{}' : raw;
  // Re-wrap the already-read raw body so the shared `parseBody` owns the JSON + schema validation.
  return parseBody(
    schema,
    new Request(req.url, { method: 'POST', body, headers: { 'content-type': 'application/json' } }),
  );
}

/**
 * Parse + validate the URL search params against a zod schema.
 * Throws `AppError('VALIDATION')` on a schema mismatch.
 */
export function parseQuery<T>(schema: z.ZodType<T>, req: Request): T {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new AppError('VALIDATION', 'Invalid query parameters', parsed.error.issues);
  }
  return parsed.data;
}

/** Headers sent with every SSE response (`POST /api/chat` streaming mode). */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
};

/** Encode one payload as a single SSE frame: `data: <JSON>\n\n`. */
export function sseFrame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Wrap a byte stream as a `text/event-stream` Response. */
export function sseResponse(stream: ReadableStream<Uint8Array>, init?: ResponseInit): Response {
  return new Response(stream, {
    ...init,
    headers: { ...SSE_HEADERS, ...(init?.headers ?? {}) },
  });
}
